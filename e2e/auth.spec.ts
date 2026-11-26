import { expect, test, type Browser, type Page } from '@playwright/test';

type TestRole = 'admin' | 'user';
type Identity = {
  id: number;
  email: string;
  role: TestRole;
};

const defaultPreviewUrl = process.env.SMARTEXIT_TEST_BASE_URL ?? 'https://smartexit-staging.onrender.com';

function credentials(role: TestRole) {
  const prefix = role === 'admin' ? 'SMARTEXIT_ADMIN_TEST' : 'SMARTEXIT_USER_TEST';
  const email = process.env[`${prefix}_EMAIL`];
  const password = process.env[`${prefix}_PASSWORD`];
  if (!email || !password) {
    throw new Error('The required test-account credentials are not available in the local secure store.');
  }
  return { email, password };
}

async function openLoginPage(page: Page) {
  const targetUrl = process.env.SMARTEXIT_TEST_ACCESS_URL
    ?? process.env.SMARTEXIT_TEST_BASE_URL
    ?? defaultPreviewUrl;

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  } catch {
    throw new Error('The configured functional-staging Preview could not be reached.');
  }

  let landedUrl: URL;
  try {
    landedUrl = new URL(page.url());
  } catch {
    throw new Error('The configured functional-staging Preview URL is invalid.');
  }
  const hostname = landedUrl.hostname.toLowerCase();
  if (hostname === 'vercel.com' || hostname.endsWith('.vercel.com')) {
    throw new Error('Vercel Deployment Protection is blocking the Preview. Store the existing Shareable Link with npm.cmd run setup:test-auth.');
  }
  if (
    landedUrl.protocol !== 'https:' ||
    hostname === 'cryptohub.vercel.app' ||
    hostname === 'cryptohub.app' ||
    (!hostname.endsWith('.vercel.app') && !hostname.endsWith('.onrender.com'))
  ) {
    throw new Error('The configured target is not an HTTPS staging environment. Production is not an E2E target.');
  }

  const origin = landedUrl.origin;
  try {
    await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
  } catch {
    throw new Error('The functional-staging login page could not be opened.');
  }
  if (await page.locator('input[name="email"]').count() !== 1) {
    throw new Error(
      'Vercel Deployment Protection is blocking the Preview. Store the existing Shareable Link with npm.cmd run setup:test-auth.',
    );
  }
  await expect(page.locator('input[name="password"]')).toBeVisible();
  return origin;
}

async function submitLogin(page: Page, email: string, password: string) {
  const emailInput = page.locator('input[name="email"]');
  const passwordInput = page.locator('input[name="password"]');
  const submitButton = page.getByRole('button', { name: 'Sign in' });

  await emailInput.waitFor({ state: 'visible' });
  await emailInput.fill(email);
  await passwordInput.waitFor({ state: 'visible' });
  await passwordInput.fill(password);
  await expect(passwordInput).toHaveValue(password);

  const [response] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/auth/login',
    ),
    submitButton.click(),
  ]);
  return response;
}

async function getIdentity(page: Page, origin: string) {
  const response = await page.request.get(`${origin}/api/auth/me`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { data: Identity | null };
  expect(body.data).not.toBeNull();
  return body.data as Identity;
}

async function signIn(page: Page, origin: string, role: TestRole) {
  const account = credentials(role);
  const response = await submitLogin(page, account.email.toUpperCase(), account.password);
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);
  await expect(page.getByRole('heading', { name: /Trading Dashboard/i })).toBeVisible();

  const identity = await getIdentity(page, origin);
  expect(identity.role).toBe(role);
  expect(identity.email.toLowerCase() === account.email.toLowerCase()).toBe(true);
  return identity;
}

async function revokeSession(page: Page, origin: string) {
  const hasSessionCookie = (await page.context().cookies(origin))
    .some((cookie) => cookie.name === 'ethcryptohub_session');
  if (!hasSessionCookie) {
    const identityResponse = await page.request.get(`${origin}/api/auth/me`);
    if (identityResponse.ok()) {
      const identityBody = await identityResponse.json() as { data: Identity | null };
      if (identityBody.data === null) return;
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const csrfResponse = await page.request.get(`${origin}/api/csrf`);
      if (!csrfResponse.ok()) continue;
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken?: string } };
      const token = csrfBody.data?.csrfToken;
      if (!token || !/^[a-f0-9]{64}$/.test(token)) continue;

      const logoutResponse = await page.request.post(`${origin}/api/auth/logout`, {
        headers: { Origin: origin, 'X-CSRF-Token': token },
      });
      if (!logoutResponse.ok()) continue;
      const logoutBody = await logoutResponse.json() as { data?: { signedOut?: boolean } };
      if (logoutBody.data?.signedOut !== true) continue;

      const sessionCookieRemains = (await page.context().cookies(origin))
        .some((cookie) => cookie.name === 'ethcryptohub_session');
      const identityResponse = await page.request.get(`${origin}/api/auth/me`);
      if (!identityResponse.ok() || sessionCookieRemains) continue;
      const identityBody = await identityResponse.json() as { data: Identity | null };
      if (identityBody.data !== null) continue;
      return;
    } catch {
      // Retry the app logout flow once; never fall back to direct session-store access.
    }
  }
  throw new Error('The test session could not be revoked through the app logout endpoint.');
}

async function withSignedInPage(
  page: Page,
  role: TestRole,
  verify: (origin: string, identity: Identity) => Promise<void>,
) {
  let origin: string | undefined;
  try {
    origin = await openLoginPage(page);
    const identity = await signIn(page, origin, role);
    await verify(origin, identity);
  } finally {
    if (origin) await revokeSession(page, origin);
  }
}

async function assertForgedUserIdCannotReadAdminData(
  skipTest: (description: string) => void,
  adminPage: Page,
  userPage: Page,
  origin: string,
  adminUserId: number,
  path: string,
  hasAdminOwnedEvidence: (data: unknown) => boolean,
) {
  const adminResponse = await adminPage.request.get(`${origin}${path}`);
  const userResponse = await userPage.request.get(`${origin}${path}`);
  expect(adminResponse.status()).toBe(200);
  expect(userResponse.status()).toBe(200);

  const adminBody = await adminResponse.json() as { data: unknown };
  const userBody = await userResponse.json() as { data: unknown };
  if (!hasAdminOwnedEvidence(adminBody.data)) {
    skipTest('No existing admin-owned record is available for this endpoint.');
    return;
  }

  const adminPayload = JSON.stringify(adminBody);
  const userPayload = JSON.stringify(userBody);
  if (adminPayload === userPayload) {
    skipTest('Existing account data does not distinguish the two accounts for this endpoint.');
    return;
  }

  const forgedResponse = await userPage.request.get(
    `${origin}${path}${path.includes('?') ? '&' : '?'}userId=${encodeURIComponent(String(adminUserId))}`,
  );
  expect(forgedResponse.status()).toBe(200);
  const forgedPayload = JSON.stringify(await forgedResponse.json());
  expect(forgedPayload === userPayload, 'forged userId must return only the signed-in user data').toBe(true);
  expect(forgedPayload !== adminPayload, 'forged userId must not return the existing admin-owned data').toBe(true);
}

async function withAdminAndUser(
  browser: Browser,
  userPage: Page,
  verify: (
    adminPage: Page,
    origin: string,
    adminUserId: number,
  ) => Promise<void>,
) {
  const adminContext = await browser.newContext();
  let adminPage: Page | undefined;
  let adminOrigin: string | undefined;
  let userOrigin: string | undefined;
  try {
    adminPage = await adminContext.newPage();
    adminOrigin = await openLoginPage(adminPage);
    const adminIdentity = await signIn(adminPage, adminOrigin, 'admin');

    userOrigin = await openLoginPage(userPage);
    const userIdentity = await signIn(userPage, userOrigin, 'user');
    expect(userOrigin).toBe(adminOrigin);
    expect(userIdentity.id !== adminIdentity.id).toBe(true);
    await verify(adminPage, userOrigin, adminIdentity.id);
  } finally {
    let cleanupFailed = false;
    if (adminPage && adminOrigin) {
      try {
        await revokeSession(adminPage, adminOrigin);
      } catch {
        cleanupFailed = true;
      }
    }
    if (userOrigin) {
      try {
        await revokeSession(userPage, userOrigin);
      } catch {
        cleanupFailed = true;
      }
    }
    await adminContext.close();
    if (cleanupFailed) {
      throw new Error('One or more test sessions could not be revoked through the app logout endpoint.');
    }
  }
}

test('admin: login persists across refresh and logout invalidates the session', async ({ page }) => {
  await withSignedInPage(page, 'admin', async (origin) => {
    const sessionCookie = (await page.context().cookies(origin))
      .find((cookie) => cookie.name === 'ethcryptohub_session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe('Strict');
    expect(sessionCookie?.secure).toBe(true);

    await page.reload();
    await expect(page.getByRole('heading', { name: /Trading Dashboard/i })).toBeVisible();
    expect((await getIdentity(page, origin)).role).toBe('admin');

    const accountButton = page.getByLabel('Account');
    if (await accountButton.isVisible()) {
      await accountButton.click();
    }
    const logoutButton = page.getByRole('button', { name: 'Log out' }).first();
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
    expect((await page.context().cookies(origin))
      .some((cookie) => cookie.name === 'ethcryptohub_session')).toBe(false);
    expect((await page.request.get(`${origin}/api/trading/settings`)).status()).toBe(401);
  });
});

test('admin: invalid password is rejected without creating a session', async ({ page }) => {
  const origin = await openLoginPage(page);
  const account = credentials('admin');
  const response = await submitLogin(page, account.email, 'invalid-e2e-password');

  expect(response.status()).toBe(401);
  await expect(page.locator('p[role="alert"]')).toHaveText('Email or password is incorrect.');
  expect((await page.context().cookies(origin))
    .some((cookie) => cookie.name === 'ethcryptohub_session')).toBe(false);
});

test('admin: authorized account reaches the Admin dashboard and API', async ({ page }) => {
  await withSignedInPage(page, 'admin', async (origin) => {
    await page.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /Admin Command Center/i })).toBeVisible();
    expect((await page.request.get(`${origin}/api/admin/users`)).status()).toBe(200);
  });
});

test('user: login persists across refresh and logout invalidates the session', async ({ page }) => {
  await withSignedInPage(page, 'user', async (origin) => {
    const sessionCookie = (await page.context().cookies(origin))
      .find((cookie) => cookie.name === 'ethcryptohub_session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe('Strict');
    expect(sessionCookie?.secure).toBe(true);

    await page.reload();
    await expect(page.getByRole('heading', { name: /Trading Dashboard/i })).toBeVisible();
    expect((await getIdentity(page, origin)).role).toBe('user');

    const accountButton = page.getByLabel('Account');
    if (await accountButton.isVisible()) {
      await accountButton.click();
    }
    const logoutButton = page.getByRole('button', { name: 'Log out' }).first();
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
    expect((await page.context().cookies(origin))
      .some((cookie) => cookie.name === 'ethcryptohub_session')).toBe(false);
    expect((await page.request.get(`${origin}/api/trading/settings`)).status()).toBe(401);
  });
});

test('user: Admin routes and APIs reject the non-admin account', async ({ page }) => {
  await withSignedInPage(page, 'user', async (origin) => {
    await page.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);
    expect((await page.request.get(`${origin}/api/admin/users`)).status()).toBe(403);
  });
});

test('user: profile lookup is scoped and trading history rejects forged user IDs', async ({ browser, page }) => {
  await withAdminAndUser(browser, page, async (_adminPage, userOrigin, adminUserId) => {
    const userIdentity = await getIdentity(page, userOrigin);
    expect(userIdentity.id !== adminUserId).toBe(true);

    const response = await page.request.get(
      `${userOrigin}/api/settings?userId=${encodeURIComponent(String(adminUserId))}`,
    );
    expect(response.status()).toBe(200);
    const body = await response.json() as { data: Identity };
    expect(body.data.id === userIdentity.id).toBe(true);
    expect(body.data.email.toLowerCase() === userIdentity.email.toLowerCase()).toBe(true);

    const executionHistory = await page.request.get(`${userOrigin}/api/trading/executions`);
    expect(executionHistory.status()).toBe(200);
    const forgedExecutionHistory = await page.request.get(
      `${userOrigin}/api/trading/executions?userId=${encodeURIComponent(String(adminUserId))}`,
    );
    expect(forgedExecutionHistory.status()).toBe(422);
  });
});

test('user: forged userId cannot read admin Bybit credentials', async ({ browser, page }) => {
  await withAdminAndUser(browser, page, (adminPage, origin, adminUserId) =>
    assertForgedUserIdCannotReadAdminData(
      (description) => test.skip(true, description),
      adminPage,
      page,
      origin,
      adminUserId,
      '/api/exchanges/credentials?exchange=BYBIT&environment=DEMO',
      (data) => typeof data === 'object' && data !== null &&
        'configured' in data && data.configured === true,
    ),
  );
});

test('user: forged userId cannot read admin Binance credentials', async ({ browser, page }) => {
  await withAdminAndUser(browser, page, (adminPage, origin, adminUserId) =>
    assertForgedUserIdCannotReadAdminData(
      (description) => test.skip(true, description),
      adminPage,
      page,
      origin,
      adminUserId,
      '/api/binance?environment=DEMO',
      (data) => typeof data === 'object' && data !== null &&
        'configured' in data && data.configured === true,
    ),
  );
});

test('user: forged userId cannot read admin subscription history', async ({ browser, page }) => {
  await withAdminAndUser(browser, page, (adminPage, origin, adminUserId) =>
    assertForgedUserIdCannotReadAdminData(
      (description) => test.skip(true, description),
      adminPage,
      page,
      origin,
      adminUserId,
      '/api/subscription/history',
      (data) => typeof data === 'object' && data !== null && (
        ('transactions' in data && Array.isArray(data.transactions) && data.transactions.length > 0) ||
        ('events' in data && Array.isArray(data.events) && data.events.length > 0)
      ),
    ),
  );
});
