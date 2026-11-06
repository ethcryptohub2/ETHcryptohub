import { pool, query } from './db';
import { TABLE_PAGE_SIZE } from './pagination';
import { AuthError, currentUser, type User } from './auth';
import {
  calculatePremiumExpiry,
  generateLicenseCode,
  licenseCodeHash,
  normalizeLicenseCode,
  statusFromDates,
  type SubscriptionStatus,
} from './subscription-utils';

export {
  calculatePremiumExpiry,
  generateLicenseCode,
  licenseCodeHash,
  normalizeLicenseCode,
  statusFromDates,
} from './subscription-utils';
export type { SubscriptionStatus } from './subscription-utils';

export interface SubscriptionEntitlement {
  id: string;
  status: SubscriptionStatus;
  hasPremiumAccess: boolean;
  planId: string | null;
  planName: string | null;
  planKey: string | null;
  trialStartedAt: string;
  trialExpiresAt: string;
  premiumStartedAt: string | null;
  premiumExpiresAt: string | null;
  activatedByCodeId: string | null;
  serverNow: string;
}

export class SubscriptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

function requiredLicensePepper(): string {
  const secret = process.env.AUTH_SECRET ?? '';
  if (secret.length < 32) throw new Error('AUTH_SECRET must contain at least 32 characters.');
  return secret;
}

export async function getSubscriptionEntitlement(userId: number): Promise<SubscriptionEntitlement> {
  const found = await query<SubscriptionEntitlement & { stored_status: SubscriptionStatus }>(
    `SELECT s.id::text, s.subscription_status AS stored_status,
            s.trial_started_at AS "trialStartedAt",
            s.trial_expires_at AS "trialExpiresAt",
            s.premium_started_at AS "premiumStartedAt",
            s.premium_expires_at AS "premiumExpiresAt",
            s.activated_by_code_id::text AS "activatedByCodeId",
            s.plan_id::text AS "planId",
            p.plan_name AS "planName", p.plan_key AS "planKey",
            CASE
              WHEN s.premium_expires_at > NOW() THEN 'PREMIUM_ACTIVE'
              WHEN s.premium_started_at IS NOT NULL THEN 'PREMIUM_EXPIRED'
              WHEN s.trial_expires_at > NOW() THEN 'FREE_TRIAL'
              ELSE 'TRIAL_EXPIRED'
            END AS status,
            (s.premium_expires_at > NOW() OR (s.premium_started_at IS NULL AND s.trial_expires_at > NOW())) AS has_premium_access,
            NOW() AS "serverNow"
       FROM public.subscriptions AS s
       LEFT JOIN public.subscription_plans AS p ON p.id = s.plan_id
      WHERE s.user_id = $1`,
    [userId],
  );
  const entitlement = found.rows[0];
  if (!entitlement) throw new Error('This account has no subscription record. Apply the subscriptions migration.');
  const status = statusFromDates(entitlement, Date.parse(entitlement.serverNow));
  if (status !== entitlement.stored_status) {
    const updated = await query(
      `WITH changed AS (
         UPDATE public.subscriptions
            SET subscription_status = $2, updated_at = NOW()
          WHERE user_id = $1 AND subscription_status <> $2
          RETURNING user_id, plan_id, subscription_status
       )
       INSERT INTO public.subscription_audit_log
         (user_id, event_type, plan_id, previous_status, new_status)
       SELECT user_id,
              CASE WHEN $2 IN ('TRIAL_EXPIRED', 'PREMIUM_EXPIRED')
                   THEN 'SUBSCRIPTION_EXPIRED' ELSE 'SUBSCRIPTION_STATUS_UPDATED' END,
              plan_id, $3, subscription_status
         FROM changed`,
      [userId, status, entitlement.stored_status],
    );
    void updated;
  }
  return {
    ...entitlement,
    status,
    hasPremiumAccess: status === 'FREE_TRIAL' || status === 'PREMIUM_ACTIVE',
  };
}

export async function requirePremiumUser(): Promise<{
  user: User;
  subscription: SubscriptionEntitlement;
}> {
  const user = await currentUser();
  if (!user) throw new AuthError(401, 'Sign in is required.');
  const subscription = await getSubscriptionEntitlement(user.id);
  if (!subscription.hasPremiumAccess) {
    throw new SubscriptionError(
      'SUBSCRIPTION_REQUIRED',
      'An active free trial or premium subscription is required.',
      403,
    );
  }
  return { user, subscription };
}

export async function getSubscriptionHistory(userId: number) {
  const [transactions, audit] = await Promise.all([
    query(
      `SELECT t.id::text, t.amount::text, t.currency, t.payment_status, t.payment_reference,
              t.transaction_type, t.previous_expiry, t.new_expiry, t.created_at,
              p.plan_name, p.duration_days
         FROM public.subscription_transactions AS t
         LEFT JOIN public.subscription_plans AS p ON p.id = t.plan_id
        WHERE t.user_id = $1
        ORDER BY t.created_at DESC LIMIT 100`,
      [userId],
    ),
    query(
      `SELECT a.id::text, a.event_type, a.previous_status, a.new_status, a.details, a.created_at,
              p.plan_name
         FROM public.subscription_audit_log AS a
         LEFT JOIN public.subscription_plans AS p ON p.id = a.plan_id
        WHERE a.user_id = $1
        ORDER BY a.created_at DESC LIMIT 100`,
      [userId],
    ),
  ]);
  return { transactions: transactions.rows, events: audit.rows };
}

async function consumeActivationAttempt(userId: number): Promise<void> {
  const result = await query<{ allowed: boolean }>(
    `INSERT INTO public.subscription_activation_attempts (user_id, window_started_at, attempt_count)
     VALUES ($1, date_trunc('minute', NOW()) - (EXTRACT(MINUTE FROM NOW())::integer % 15) * INTERVAL '1 minute', 1)
     ON CONFLICT (user_id, window_started_at) DO UPDATE
       SET attempt_count = public.subscription_activation_attempts.attempt_count + 1
       WHERE public.subscription_activation_attempts.attempt_count < 10
     RETURNING TRUE AS allowed`,
    [userId],
  );
  if (!result.rows[0]?.allowed) {
    throw new SubscriptionError('RATE_LIMITED', 'Too many activation attempts. Try again in 15 minutes.', 429);
  }
}

export async function activateLicenseCode(user: User, submittedCode: string) {
  const normalized = normalizeLicenseCode(submittedCode);
  if (!/^SMRT[A-Z0-9]{12}$/.test(normalized)) {
    throw new SubscriptionError('INVALID_CODE', 'Invalid activation code.');
  }
  await consumeActivationAttempt(user.id);
  const codeHash = licenseCodeHash(normalized, requiredLicensePepper());
  const client = await pool().connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const subscriptionResult = await client.query<{
      id: string;
      subscription_status: SubscriptionStatus;
      premium_started_at: string | null;
      premium_expires_at: string | null;
      trial_started_at: string;
      trial_expires_at: string;
      plan_id: string | null;
    }>(
      `SELECT id::text, subscription_status, premium_started_at, premium_expires_at,
              trial_started_at, trial_expires_at, plan_id::text
         FROM public.subscriptions WHERE user_id = $1 FOR UPDATE`,
      [user.id],
    );
    const subscription = subscriptionResult.rows[0];
    if (!subscription) throw new Error('This account has no subscription record. Apply the subscriptions migration.');
    const codeResult = await client.query<{
      id: string;
      plan_id: string;
      duration_days: number;
      purchase_price_usd: string;
      payment_reference: string | null;
      code_status: string;
      assigned_user_email: string | null;
      expires_at: string | null;
    }>(
      `SELECT id::text, plan_id::text, duration_days, purchase_price_usd::text, payment_reference,
              code_status, assigned_user_email, expires_at
         FROM public.license_codes WHERE code_hash = $1 FOR UPDATE`,
      [codeHash],
    );
    const code = codeResult.rows[0];
    if (!code) throw new SubscriptionError('INVALID_CODE', 'Invalid activation code.');
    if (code.code_status === 'REDEEMED') throw new SubscriptionError('CODE_REDEEMED', 'This activation code has already been redeemed.');
    if (code.code_status === 'REVOKED') throw new SubscriptionError('CODE_REVOKED', 'This activation code has been revoked.');
    const currentTime = await client.query<{ now: string }>('SELECT NOW() AS now');
    const now = currentTime.rows[0]!.now;
    const nowMs = Date.parse(now);
    if (code.expires_at && Date.parse(code.expires_at) <= nowMs) {
      await client.query("UPDATE public.license_codes SET code_status = 'EXPIRED' WHERE id = $1", [code.id]);
      await client.query('COMMIT');
      transactionOpen = false;
      throw new SubscriptionError('CODE_EXPIRED', 'This activation code has expired.');
    }
    if (code.assigned_user_email && code.assigned_user_email.toLowerCase() !== user.email.toLowerCase()) {
      throw new SubscriptionError('CODE_ASSIGNED', 'This activation code is assigned to another account.');
    }
    const planResult = await client.query<{
      id: string;
      plan_name: string;
      plan_key: string;
      duration_days: number;
      price_usd: string;
      is_active: boolean;
    }>(
      `SELECT id::text, plan_name, plan_key, duration_days, price_usd::text, is_active
         FROM public.subscription_plans WHERE id = $1 FOR SHARE`,
      [code.plan_id],
    );
    const plan = planResult.rows[0];
    if (!plan || !plan.is_active) throw new SubscriptionError('PLAN_UNAVAILABLE', 'The subscription plan is unavailable.');

    const currentPremiumExpiry = subscription.premium_expires_at
      ? Date.parse(subscription.premium_expires_at)
      : Number.NEGATIVE_INFINITY;
    const premiumIsActive = currentPremiumExpiry > nowMs;
    const expiresAt = calculatePremiumExpiry(nowMs, premiumIsActive ? currentPremiumExpiry : null, code.duration_days).toISOString();
    const previousStatus = subscription.subscription_status;
    const previousExpiry = subscription.premium_expires_at;
    const codeUpdate = await client.query(
      `UPDATE public.license_codes
          SET code_status = 'REDEEMED', redeemed_by_user_id = $2, redeemed_at = $3
        WHERE id = $1 AND code_status = 'UNUSED'`,
      [code.id, user.id, now],
    );
    if (codeUpdate.rowCount !== 1) throw new SubscriptionError('CODE_REDEEMED', 'This activation code has already been redeemed.');
    await client.query(
      `UPDATE public.subscriptions
          SET plan_id = $2, subscription_status = 'PREMIUM_ACTIVE',
              premium_started_at = CASE WHEN $3 THEN premium_started_at ELSE $4 END,
              premium_expires_at = $5, activated_by_code_id = $6, updated_at = $4
        WHERE user_id = $1`,
      [user.id, plan.id, premiumIsActive, now, expiresAt, code.id],
    );
    await client.query(
      `INSERT INTO public.subscription_transactions
      (user_id, plan_id, license_code_id, amount, currency, payment_status, payment_reference,
         transaction_type, previous_expiry, new_expiry)
     VALUES ($1, $2, $3, $4, 'USD', 'MANUAL_VERIFIED', $5,
             'LICENSE_REDEMPTION', $6, $7)`,
    [user.id, plan.id, code.id, code.purchase_price_usd, code.payment_reference, previousExpiry, expiresAt],
    );
    await client.query(
      `INSERT INTO public.subscription_audit_log
        (user_id, event_type, plan_id, previous_status, new_status, reference_id, details)
       VALUES ($1, $2, $3, $4, 'PREMIUM_ACTIVE', $5, $6::jsonb)`,
      [
        user.id,
        premiumIsActive ? 'PREMIUM_RENEWED' : 'PREMIUM_ACTIVATED',
        plan.id,
        previousStatus,
        code.id,
        JSON.stringify({ durationDays: code.duration_days, previousExpiry, newExpiry: expiresAt }),
      ],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return await getSubscriptionEntitlement(user.id);
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Subscription activation rollback failed:', rollbackError instanceof Error ? rollbackError.message : 'Unknown error');
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getAvailableSubscriptionPlans() {
  const result = await query(
    `SELECT id::text, plan_key, plan_name, duration_days, price_usd::text
       FROM public.subscription_plans
      WHERE is_active = TRUE AND plan_key <> 'FREE_TRIAL'
      ORDER BY duration_days`,
  );
  return result.rows;
}

export async function consumeSubscriptionAdminLimit(adminUserId: number, action: 'read' | 'write') {
  const maximum = action === 'read' ? 120 : 30;
  const result = await query<{ allowed: boolean }>(
    `INSERT INTO public.subscription_admin_rate_limits
       (admin_user_id, action, window_started_at, request_count)
     VALUES ($1, $2, date_trunc('minute', NOW()), 1)
     ON CONFLICT (admin_user_id, action, window_started_at) DO UPDATE
       SET request_count = public.subscription_admin_rate_limits.request_count + 1
       WHERE public.subscription_admin_rate_limits.request_count < $3
     RETURNING TRUE AS allowed`,
    [adminUserId, action, maximum],
  );
  if (!result.rows[0]?.allowed) {
    throw new SubscriptionError('RATE_LIMITED', 'Too many subscription administration requests. Wait a minute and retry.', 429);
  }
}

export async function generateLicenseCodes(input: {
  adminUserId: number;
  planId: string;
  count: number;
  assignedEmail: string | null;
  expiresAt: string | null;
  note: string | null;
  paymentReference: string | null;
}) {
  const planResult = await query<{
    id: string;
    plan_name: string;
    plan_key: string;
    duration_days: number;
    price_usd: string;
    is_active: boolean;
  }>(
    `SELECT id::text, plan_name, plan_key, duration_days, price_usd::text, is_active
       FROM public.subscription_plans WHERE id = $1`,
    [input.planId],
  );
  const plan = planResult.rows[0];
  if (!plan || !plan.is_active || plan.plan_key === 'FREE_TRIAL') {
    throw new SubscriptionError('PLAN_UNAVAILABLE', 'Choose an active premium plan.', 422);
  }
  const pepper = requiredLicensePepper();
  const assignedEmail = input.assignedEmail?.trim().toLowerCase() || null;
  const client = await pool().connect();
  const generated: Array<{ code: string; planName: string; durationDays: number }> = [];
  try {
    await client.query('BEGIN');
    for (let index = 0; index < input.count; index += 1) {
      let saved = false;
      for (let attempt = 0; attempt < 5 && !saved; attempt += 1) {
        const code = generateLicenseCode();
        const hash = licenseCodeHash(code, pepper);
        const result = await client.query<{ id: string }>(
          `INSERT INTO public.license_codes
            (code_hash, plan_id, duration_days, purchase_price_usd, payment_reference,
             assigned_user_email, expires_at, admin_note, created_by_admin_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (code_hash) DO NOTHING
           RETURNING id::text`,
          [hash, plan.id, plan.duration_days, plan.price_usd, input.paymentReference,
            assignedEmail, input.expiresAt, input.note, input.adminUserId],
        );
        if (result.rowCount) {
          generated.push({ code, planName: plan.plan_name, durationDays: plan.duration_days });
          saved = true;
        }
      }
      if (!saved) throw new Error('Could not generate a unique license code. Retry the request.');
    }
    if (input.paymentReference) {
      await client.query(
        `INSERT INTO public.subscription_audit_log
          (admin_user_id, event_type, plan_id, details)
         VALUES ($1, 'LICENSE_CODES_ISSUED', $2, $3::jsonb)`,
        [
          input.adminUserId,
          plan.id,
          JSON.stringify({ count: input.count, assignedEmail, paymentReference: input.paymentReference }),
        ],
      );
    } else {
      await client.query(
        `INSERT INTO public.subscription_audit_log
          (admin_user_id, event_type, plan_id, details)
         VALUES ($1, 'LICENSE_CODES_ISSUED', $2, $3::jsonb)`,
        [input.adminUserId, plan.id, JSON.stringify({ count: input.count, assignedEmail })],
      );
    }
    await client.query('COMMIT');
    return generated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeUnusedLicenseCode(adminUserId: number, codeId: string, reason: string | null) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; plan_id: string }>(
      `UPDATE public.license_codes
          SET code_status = 'REVOKED'
        WHERE id = $1 AND code_status = 'UNUSED'
          AND (expires_at IS NULL OR expires_at > NOW())
        RETURNING id::text, plan_id::text`,
      [codeId],
    );
    const code = result.rows[0];
    if (!code) throw new SubscriptionError('CODE_NOT_REVOCABLE', 'Code not found or already redeemed, expired, or revoked.', 409);
    await client.query(
      `INSERT INTO public.subscription_audit_log
        (admin_user_id, event_type, plan_id, reference_id, details)
       VALUES ($1, 'LICENSE_CODE_REVOKED', $2, $3, $4::jsonb)`,
      [adminUserId, code.plan_id, code.id, JSON.stringify({ reason })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listAdminSubscriptionData(input: {
  search: string;
  status: string;
  codeStatus: string;
  userPage: number;
  codePage: number;
}) {
  const offsetUsers = (input.userPage - 1) * TABLE_PAGE_SIZE;
  const offsetCodes = (input.codePage - 1) * TABLE_PAGE_SIZE;
  const [metrics, plans, users, userCount, codes, codeCount] = await Promise.all([
    query(
      `SELECT COUNT(DISTINCT u.id)::text AS total_users,
              COUNT(DISTINCT s.user_id) FILTER (WHERE s.trial_expires_at > NOW() AND s.premium_started_at IS NULL)::text AS free_trial_users,
              COUNT(DISTINCT s.user_id) FILTER (WHERE s.premium_expires_at > NOW())::text AS premium_active_users,
              COUNT(DISTINCT s.user_id) FILTER (WHERE s.premium_started_at IS NULL AND s.trial_expires_at <= NOW())::text AS expired_trial_users,
              COUNT(DISTINCT s.user_id) FILTER (WHERE s.premium_started_at IS NOT NULL AND s.premium_expires_at <= NOW())::text AS expired_premium_users,
              (SELECT COUNT(*)::text FROM public.license_codes) AS total_codes,
              (SELECT COUNT(*)::text FROM public.license_codes WHERE code_status = 'UNUSED' AND (expires_at IS NULL OR expires_at > NOW())) AS unused_codes,
              (SELECT COUNT(*)::text FROM public.license_codes WHERE code_status = 'REDEEMED') AS redeemed_codes,
              (SELECT COUNT(*)::text FROM public.license_codes WHERE code_status = 'EXPIRED' OR (code_status = 'UNUSED' AND expires_at <= NOW())) AS expired_codes,
              (SELECT COUNT(*)::text FROM public.license_codes WHERE code_status = 'REVOKED') AS revoked_codes
         FROM public.users AS u
         LEFT JOIN public.subscriptions AS s ON s.user_id = u.id`,
  ),
    query(
      `SELECT id::text, plan_key, plan_name, duration_days, price_usd::text, is_active, updated_at
         FROM public.subscription_plans ORDER BY duration_days`,
    ),
    query(
      `SELECT u.id, u.email, s.subscription_status AS stored_status,
              s.trial_started_at, s.trial_expires_at, s.premium_started_at, s.premium_expires_at,
              s.activated_by_code_id::text, s.plan_id::text, p.plan_name, p.plan_key,
              CASE
                WHEN s.premium_expires_at > NOW() THEN 'PREMIUM_ACTIVE'
                WHEN s.premium_started_at IS NOT NULL THEN 'PREMIUM_EXPIRED'
                WHEN s.trial_expires_at > NOW() THEN 'FREE_TRIAL'
                ELSE 'TRIAL_EXPIRED'
              END AS subscription_status
         FROM public.users AS u
         JOIN public.subscriptions AS s ON s.user_id = u.id
         LEFT JOIN public.subscription_plans AS p ON p.id = s.plan_id
        WHERE ($1 = '' OR u.email::text ILIKE '%' || $1 || '%' OR u.id::text = $1)
          AND ($2 = 'ALL' OR
             ($2 = 'FREE_TRIAL' AND s.premium_started_at IS NULL AND s.trial_expires_at > NOW()) OR
             ($2 = 'TRIAL_EXPIRED' AND s.premium_started_at IS NULL AND s.trial_expires_at <= NOW()) OR
             ($2 = 'PREMIUM_ACTIVE' AND s.premium_expires_at > NOW()) OR
             ($2 = 'PREMIUM_EXPIRED' AND s.premium_started_at IS NOT NULL AND s.premium_expires_at <= NOW()))
        ORDER BY s.updated_at DESC, u.id DESC LIMIT $4 OFFSET $3`,
      [input.search, input.status, offsetUsers, TABLE_PAGE_SIZE],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.users AS u
         JOIN public.subscriptions AS s ON s.user_id = u.id
        WHERE ($1 = '' OR u.email::text ILIKE '%' || $1 || '%' OR u.id::text = $1)
          AND ($2 = 'ALL' OR
             ($2 = 'FREE_TRIAL' AND s.premium_started_at IS NULL AND s.trial_expires_at > NOW()) OR
             ($2 = 'TRIAL_EXPIRED' AND s.premium_started_at IS NULL AND s.trial_expires_at <= NOW()) OR
             ($2 = 'PREMIUM_ACTIVE' AND s.premium_expires_at > NOW()) OR
             ($2 = 'PREMIUM_EXPIRED' AND s.premium_started_at IS NOT NULL AND s.premium_expires_at <= NOW()))`,
      [input.search, input.status],
    ),
    query(
      `SELECT c.id::text, c.plan_id::text, p.plan_name, c.duration_days, c.payment_reference, c.code_status,
              c.assigned_user_email::text, u.email AS redeemed_by_email, c.redeemed_at,
              c.expires_at, c.admin_note, c.created_at, creator.email AS created_by_email,
              (c.expires_at IS NOT NULL AND c.expires_at <= NOW() AND c.code_status = 'UNUSED') AS is_expired
         FROM public.license_codes AS c
         JOIN public.subscription_plans AS p ON p.id = c.plan_id
         LEFT JOIN public.users AS u ON u.id = c.redeemed_by_user_id
         LEFT JOIN public.users AS creator ON creator.id = c.created_by_admin_id
        WHERE ($1 = 'ALL' OR c.code_status = $1 OR ($1 = 'EXPIRED' AND c.code_status = 'UNUSED' AND c.expires_at <= NOW()))
          AND ($2 = '' OR c.assigned_user_email::text ILIKE '%' || $2 || '%' OR u.email::text ILIKE '%' || $2 || '%')
        ORDER BY c.created_at DESC, c.id DESC LIMIT $4 OFFSET $3`,
      [input.codeStatus, input.search, offsetCodes, TABLE_PAGE_SIZE],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM public.license_codes AS c
         LEFT JOIN public.users AS u ON u.id = c.redeemed_by_user_id
        WHERE ($1 = 'ALL' OR c.code_status = $1 OR ($1 = 'EXPIRED' AND c.code_status = 'UNUSED' AND c.expires_at <= NOW()))
          AND ($2 = '' OR c.assigned_user_email::text ILIKE '%' || $2 || '%' OR u.email::text ILIKE '%' || $2 || '%')`,
      [input.codeStatus, input.search],
    ),
  ]);
  return {
    metrics: metrics.rows[0],
    plans: plans.rows,
    users: users.rows,
    usersTotal: Number(userCount.rows[0]?.count ?? 0),
    codes: codes.rows,
    codesTotal: Number(codeCount.rows[0]?.count ?? 0),
  };
}

export async function updateSubscriptionPlans(adminUserId: number, updates: Array<{
  id: string;
  planName: string;
  durationDays: number;
  priceUsd: number;
  isActive: boolean;
}>) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    for (const plan of updates) {
      await client.query(
        `UPDATE public.subscription_plans
            SET plan_name = $2, duration_days = $3, price_usd = $4, is_active = $5, updated_at = NOW()
          WHERE id = $1 AND plan_key <> 'FREE_TRIAL'`,
        [plan.id, plan.planName, plan.durationDays, plan.priceUsd, plan.isActive],
      );
      await client.query(
        `INSERT INTO public.subscription_audit_log (admin_user_id, event_type, plan_id, details)
         VALUES ($1, 'SUBSCRIPTION_PLAN_UPDATED', $2, $3::jsonb)`,
        [adminUserId, plan.id, JSON.stringify(plan)],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function adjustPremiumAccess(input: {
  adminUserId: number;
  userId: number;
  action: 'extend' | 'complimentary';
  durationDays: number;
  planId: string | null;
  reason: string;
  paymentReference: string | null;
}) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const subscriptionResult = await client.query<{
      subscription_status: SubscriptionStatus;
      premium_started_at: string | null;
      premium_expires_at: string | null;
    }>(
      `SELECT subscription_status, premium_started_at, premium_expires_at
         FROM public.subscriptions WHERE user_id = $1 FOR UPDATE`,
      [input.userId],
    );
    const subscription = subscriptionResult.rows[0];
    if (!subscription) throw new SubscriptionError('USER_NOT_FOUND', 'User subscription was not found.', 404);
    const nowResult = await client.query<{ now: string }>('SELECT NOW() AS now');
    const now = nowResult.rows[0]!.now;
    const nowMs = Date.parse(now);
    const currentExpiry = subscription.premium_expires_at ? Date.parse(subscription.premium_expires_at) : Number.NEGATIVE_INFINITY;
    const premiumIsActive = currentExpiry > nowMs;
    const previousExpiry = subscription.premium_expires_at;
    const newExpiry = calculatePremiumExpiry(nowMs, premiumIsActive ? currentExpiry : null, input.durationDays).toISOString();
    const selectedPlanId = input.planId;
    if (selectedPlanId) {
      const selectedPlan = await client.query(
        `SELECT id FROM public.subscription_plans
          WHERE id = $1 AND is_active = TRUE AND plan_key <> 'FREE_TRIAL'`,
        [selectedPlanId],
      );
      if (!selectedPlan.rowCount) throw new SubscriptionError('PLAN_UNAVAILABLE', 'The selected premium plan is unavailable.', 422);
    }
    await client.query(
      `UPDATE public.subscriptions
          SET plan_id = COALESCE($2::bigint, plan_id),
              subscription_status = 'PREMIUM_ACTIVE',
              premium_started_at = CASE WHEN $3 THEN premium_started_at ELSE $4 END,
              premium_expires_at = $5, updated_at = $4
        WHERE user_id = $1`,
      [input.userId, selectedPlanId, premiumIsActive, now, newExpiry],
    );
    const eventType = input.action === 'complimentary' ? 'COMPLIMENTARY_PREMIUM_GRANTED' : 'PREMIUM_EXTENDED';
    const txType = input.action === 'complimentary' ? 'COMPLIMENTARY' : 'ADMIN_EXTENSION';
    await client.query(
      `INSERT INTO public.subscription_transactions
        (user_id, plan_id, amount, payment_status, payment_reference, transaction_type,
         previous_expiry, new_expiry, created_by_admin_id)
       VALUES ($1, $2, 0, 'COMPLIMENTARY', $3, $4, $5, $6, $7)`,
      [input.userId, selectedPlanId, input.paymentReference, txType, previousExpiry, newExpiry, input.adminUserId],
    );
    await client.query(
      `INSERT INTO public.subscription_audit_log
        (user_id, admin_user_id, event_type, plan_id, previous_status, new_status, details)
       VALUES ($1, $2, $3, $4, $5, 'PREMIUM_ACTIVE', $6::jsonb)`,
      [
        input.userId,
        input.adminUserId,
        eventType,
        selectedPlanId,
        subscription.subscription_status,
        JSON.stringify({ durationDays: input.durationDays, previousExpiry, newExpiry, reason: input.reason }),
      ],
    );
    await client.query('COMMIT');
    return await getSubscriptionEntitlement(input.userId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
