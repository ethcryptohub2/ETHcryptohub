import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { demoRiskAdmissionInputSchema, evaluateDemoRiskAdmission, type DemoRiskInput } from './demo-risk-admission';

type Connection = Pick<PoolClient, 'query' | 'release'>;
type Scope = DemoRiskInput['scope'];
type State = 'RESERVED' | 'DISPATCHING' | 'PROTECTED' | 'RECONCILIATION_REQUIRED' | 'CLOSED';
type Result =
  | { state: 'BLOCKED'; reasons: string[] }
  | { state: 'REPLAY'; reservationId: string }
  | { state: 'PROTECTED' | 'RECONCILIATION_REQUIRED'; reservationId: string };

const commandSchema = demoRiskAdmissionInputSchema.pick({ scope: true, account: true, intent: true }).extend({
  clientKey: z.string().regex(/^[A-Za-z0-9_-]{1,36}$/),
  signalId: z.string().regex(/^[1-9]\d{0,18}$/).refine(value => value.length < 19 || value <= '9223372036854775807'),
  quoteAsset: z.literal('USDT'),
}).strict();
type Command = z.infer<typeof commandSchema>;

export type DemoAutoDispatchDependencies = {
  connect(): Promise<Connection>;
  // Only a server-side exact Staging/deployment and execution approval may implement this port.
  authorize?(scope: Scope): Promise<boolean>;
  // The adapter must use the exact reserved entry and independently verify active protective orders.
  dispatch?(order: { reservationId: string; scope: Scope; clientKey: string; intent: Command['intent'] }): Promise<unknown>;
  now?: () => number;
};

const orderId = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const protectedResult = z.object({
  reservationId: z.string().uuid(),
  provider: commandSchema.shape.scope.shape.provider,
  environment: commandSchema.shape.scope.shape.environment,
  accountId: z.string().uuid(),
  clientKey: commandSchema.shape.clientKey,
  entryOrderId: orderId,
  stopOrderId: orderId,
  takeProfitOrderId: orderId,
  independentlyVerified: z.literal(true),
}).strict();

function scopeParams(scope: Scope) {
  return [scope.adminId, scope.provider, scope.environment, scope.accountId];
}

const scopeFilter = 'admin_user_id = $1 AND provider = $2 AND environment = $3 AND account_id = $4';

function blocked(...reasons: string[]): Result {
  return { state: 'BLOCKED', reasons };
}

function sumDecimals(left: string, right: string) {
  const scale = 10n ** 12n;
  const fixed = (value: string) => {
    const [whole, fractional = ''] = value.split('.');
    return BigInt(whole!) * scale + BigInt(fractional.padEnd(12, '0'));
  };
  const sum = fixed(left) + fixed(right);
  return `${sum / scale}.${(sum % scale).toString().padStart(12, '0')}`;
}

export function createDemoAutoDispatcher(dependencies: DemoAutoDispatchDependencies) {
  async function transaction<T>(operation: (connection: Connection) => Promise<T>) {
    const connection = await dependencies.connect();
    let discard: Error | undefined;
    try {
      await connection.query('BEGIN');
      await connection.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try { await connection.query('ROLLBACK'); }
      catch { discard = new Error('Demo reservation rollback failed'); }
      throw error;
    } finally {
      connection.release(discard);
    }
  }

  async function lockApproval(connection: Connection, scope: Scope) {
    const result = await connection.query<{ risk_policy: unknown; approval_identity: string }>(
      `SELECT a.risk_policy,
              jsonb_build_array(a.credential_id, a.approved_from, a.approved_until,
                                a.connectivity_verified_at, a.lifecycle_verified_at, a.risk_policy)::text AS approval_identity
         FROM smartexit_demo_auto.controls a
         JOIN public.admin_demo_exchange_credentials c
           ON c.id = a.credential_id AND c.admin_user_id = a.admin_user_id AND c.admin_scope = a.admin_scope
          AND c.provider = a.provider AND c.environment = a.environment
        WHERE a.admin_user_id = $1 AND a.provider = $2 AND a.environment = $3 AND a.account_id = $4
          AND a.enabled AND NOT a.stopped AND a.approved_from <= statement_timestamp() AND a.approved_until > statement_timestamp()
          AND c.is_enabled AND c.owner_confirmed_at IS NOT NULL AND c.revoked_at IS NULL
          AND c.updated_at <= LEAST(a.connectivity_verified_at, a.lifecycle_verified_at)
        FOR UPDATE OF a`,
      scopeParams(scope),
    );
    return result.rows[0];
  }

  async function audit(connection: Connection, id: string, state: State) {
    await connection.query('INSERT INTO smartexit_demo_auto.audit (reservation_id, state) VALUES ($1, $2)', [id, state]);
  }

  async function eligibleSignal(connection: Connection, signalId: string, intent: Command['intent']) {
    const signal = await connection.query(
      `SELECT id FROM public.market_signals WHERE id = $1 AND exchange = 'BINANCE' AND scanner_type = $2
          AND symbol = $3 AND side = $4 AND status = 'ACTIVE' AND entry_status = 'OPEN'
          AND initial_stop = $5::numeric AND $6::numeric BETWEEN entry_zone_low AND entry_zone_high
          AND entry_expires_at > statement_timestamp() AND expires_at > statement_timestamp()
          AND last_candle_close_at < statement_timestamp()`,
      [signalId, intent.strategy, intent.symbol, intent.side, intent.stop, intent.entry],
    );
    return signal.rows.length === 1;
  }

  return {
    // account must be freshly observed by the approved server adapter, never populated from a request body.
    async execute(value: unknown): Promise<Result> {
      const { authorize, dispatch } = dependencies;
      if (!authorize || !dispatch) return blocked('AUTO_DEMO_DISABLED');
      const parsed = commandSchema.safeParse(value);
      if (!parsed.success) return blocked('INVALID_AUTO_DEMO_COMMAND');
      const { scope, clientKey, signalId, account, intent } = parsed.data;
      if (!await authorize(scope).catch(() => false)) return blocked('AUTO_DEMO_DISABLED');
      const args = scopeParams(scope);
      const intentSha = createHash('sha256').update(JSON.stringify([signalId, intent])).digest('hex');
      const id = randomUUID();
      let reservation: Result | { state: 'DISPATCHING'; approvalIdentity: string };

      try {
        reservation = await transaction(async connection => {
          // Serializes all admission/dispatch reservations for the same approved provider account.
          const approval = await lockApproval(connection, scope);
          if (!approval?.approval_identity) return blocked('ACCOUNT_NOT_APPROVED_OR_STOPPED');
          const prior = (await connection.query<{ id: string; intent_sha: string }>(
            `SELECT id, intent_sha FROM smartexit_demo_auto.reservations
              WHERE ${scopeFilter} AND (client_key = $5 OR signal_id = $6)`,
            [...args, clientKey, signalId],
          )).rows;
          if (prior.length) return prior.length === 1 && prior[0]!.intent_sha === intentSha
            ? { state: 'REPLAY', reservationId: prior[0]!.id } : blocked('IDEMPOTENCY_CONFLICT');
          if (!await eligibleSignal(connection, signalId, intent)) return blocked('FUTURES_SIGNAL_UNAVAILABLE');
          const totals = (await connection.query<{ slots: number; day_orders: number; notional: string; risk: string }>(
            `SELECT (COUNT(*) FILTER (WHERE state <> 'CLOSED'))::integer AS slots,
                    (COUNT(*) FILTER (WHERE reserved_at >= date_trunc('day', statement_timestamp(), 'UTC')))::integer AS day_orders,
                    ROUND(CEIL(COALESCE(SUM(notional) FILTER (WHERE state <> 'CLOSED'), 0) * 1000000000000)
                      / 1000000000000, 12)::text AS notional,
                    ROUND(CEIL(COALESCE(SUM(maximum_loss) FILTER (WHERE state <> 'CLOSED'), 0) * 1000000000000)
                      / 1000000000000, 12)::text AS risk
               FROM smartexit_demo_auto.reservations WHERE ${scopeFilter}`,
            args,
          )).rows[0];
          if (!totals) return blocked('RESERVATION_STATE_UNAVAILABLE');
          // Conservatively count all unresolved reservations. Only venue-verified reconciliation may release them.
          const decision = evaluateDemoRiskAdmission({
            scope, now: dependencies.now?.() ?? Date.now(), policy: approval.risk_policy, intent,
            account: { ...account, reservedEntrySlots: account.reservedEntrySlots + totals.slots,
              admittedOrdersToday: account.admittedOrdersToday + totals.day_orders,
              reservedNotional: sumDecimals(account.reservedNotional, totals.notional),
              existingRisk: sumDecimals(account.existingRisk, totals.risk) },
          });
          if (!decision.allowed) return blocked(...decision.reasons);
          const approvalSha = createHash('sha256').update(approval.approval_identity).digest('hex');
          await connection.query(
            `INSERT INTO smartexit_demo_auto.reservations
                (admin_user_id, provider, environment, account_id, client_key, intent_sha, id, approval_sha,
                 symbol, strategy, direction, quantity, entry_price, stop_price, signal_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [...args, clientKey, intentSha, id, approvalSha, intent.symbol, intent.strategy,
              intent.side, intent.quantity, intent.entry, intent.stop, signalId],
          );
          await audit(connection, id, 'RESERVED');
          await connection.query("UPDATE smartexit_demo_auto.reservations SET state = 'DISPATCHING' WHERE id = $1 AND state = 'RESERVED'", [id]);
          await audit(connection, id, 'DISPATCHING');
          return { state: 'DISPATCHING', approvalIdentity: approval.approval_identity };
        });
      } catch {
        return blocked('RESERVATION_UNAVAILABLE');
      }
      if (reservation.state !== 'DISPATCHING') return reservation;

      let state: 'PROTECTED' | 'RECONCILIATION_REQUIRED' = 'RECONCILIATION_REQUIRED';
      try {
        // Check the stop and window again after the durable dispatch fence, before using the adapter.
        const stillAllowed = await transaction(async connection =>
          (await lockApproval(connection, scope))?.approval_identity === reservation.approvalIdentity &&
          await eligibleSignal(connection, signalId, intent));
        const authorized = stillAllowed && await authorize(scope);
        const dispatchTime = dependencies.now?.() ?? Date.now();
        if (authorized && dispatchTime >= account.observedAt && dispatchTime - account.observedAt <= 10_000 &&
            new Date(dispatchTime).toISOString().slice(0, 10) === account.utcDay) {
          const result = protectedResult.safeParse(await dispatch({ reservationId: id, scope, clientKey, intent }));
          if (result.success && result.data.reservationId === id && result.data.provider === scope.provider &&
              result.data.environment === scope.environment && result.data.accountId === scope.accountId &&
              result.data.clientKey === clientKey &&
              new Set([result.data.entryOrderId, result.data.stopOrderId, result.data.takeProfitOrderId]).size === 3) {
            state = 'PROTECTED';
          }
        }
      } catch {
        // Uncertain effects hold the reserved limits and block any automatic resubmission.
      }
      try {
        await transaction(async connection => {
          const updated = await connection.query(
            "UPDATE smartexit_demo_auto.reservations SET state = $2 WHERE id = $1 AND state = 'DISPATCHING'", [id, state],
          );
          if (updated.rowCount !== 1) throw new Error('Demo reservation state changed');
          await audit(connection, id, state);
        });
      } catch {
        state = 'RECONCILIATION_REQUIRED';
      }
      return { state, reservationId: id };
    },
  };
}
