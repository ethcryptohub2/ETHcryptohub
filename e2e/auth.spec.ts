import { expect, test, type Page } from '@playwright/test';

type TestRole = 'admin' | 'user';
type Identity = {
  id: number;
  email: string;
  role: TestRole;
};

const defaultPreviewUrl = 'https://cryptohub-git-functional-staging-eth-cryptohub.vercel.app';

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
    !hostname.endsWith('.vercel.app')
  ) {
    throw new Error('The configured target is not an HTTPS Vercel Preview. Production is not an E2E target.');
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
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/auth/login',
  );
  await page.getByRole('button', { name: 'Sign in' }).click();
  return responsePromise;
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
  await expect(page.getByRole('heading', { name: 'Market intelligence dashboard.' })).toBeVisible();

  const identity = await getIdentity(page, origin);
  expect(identity.role).toBe(role);
  expect(identity.email.toLowerCase()).toBe(account.email.toLowerCase());
  return identity;
}

test('admin: login persists across refresh and logout invalidates the session', async ({ page }) => {
  const origin = await openLoginPage(page);
  await signIn(page, origin, 'admin');

  const sessionCookie = (await page.context().cookies(origin))
    .find((cookie) => cookie.name === 'ethcryptohub_session');
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.sameSite).toBe('Strict');
  expect(sessionCookie?.secure).toBe(true);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Market intelligence dashboard.' })).toBeVisible();
  expect((await getIdentity(page, origin)).role).toBe('admin');

  const logoutButton = page.getByRole('button', { name: 'Log out' }).first();
  await expect(logoutButton).toBeVisible();
  await logoutButton.click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  expect((await page.context().cookies(origin))
    .some((cookie) => cookie.name === 'ethcryptohub_session')).toBe(false);
  expect((await page.request.get(`${origin}/api/trading/settings`)).status()).toBe(401);
});

test('admin: invalid password is rejected without creating a session', async ({ page }) => {
  const origin = await openLoginPage(page);
  const account = credentials('admin');
  const response = await submitLogin(page, account.email, 'invalid-e2e-password');

  expect(response.status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  expect((await page.context().cookies(origin))
    .some((cookie) => cookie.name === 'ethcryptohub_session')).toBe(false);
});

test('admin: authorized account reaches the Admin dashboard and API', async ({ page }) => {
  const origin = await openLoginPage(page);
  await signIn(page, origin, 'admin');

  await page.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Command center.' })).toBeVisible();
  expect((await page.request.get(`${origin}/api/admin/users`)).status()).toBe(200);
});

test('user: login persists across refresh and logout invalidates the session', async ({ page }) => {
  const origin = await openLoginPage(page);
  await signIn(page, origin, 'user');

  const sessionCookie = (await page.context().cookies(origin))
    .find((cookie) => cookie.name === 'ethcryptohub_session');
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.sameSite).toBe('Strict');
  expect(sessionCookie?.secure).toBe(true);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Market intelligence dashboard.' })).toBeVisible();
  expect((await getIdentity(page, origin)).role).toBe('user');

  const logoutButton = page.getByRole('button', { name: 'Log out' }).first();
  await expect(logoutButton).toBeVisible();
  await logoutButton.click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  expect((await page.context().cookies(origin))
    .some((cookie) => cookie.name === 'ethcryptohub_session')).toBe(false);
  expect((await page.request.get(`${origin}/api/trading/settings`)).status()).toBe(401);
});

test('user: Admin routes and APIs reject the non-admin account', async ({ page }) => {
  const origin = await openLoginPage(page);
  await signIn(page, origin, 'user');

  await page.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);
  expect((await page.request.get(`${origin}/api/admin/users`)).status()).toBe(403);
});

test('user: profile lookup remains bound to the signed-in user', async ({ browser, page }) => {
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    const adminOrigin = await openLoginPage(adminPage);
    await signIn(adminPage, adminOrigin, 'admin');
    const adminIdentity = await getIdentity(adminPage, adminOrigin);

    const userOrigin = await openLoginPage(page);
    await signIn(page, userOrigin, 'user');
    expect(userOrigin).toBe(adminOrigin);
    const userIdentity = await getIdentity(page, userOrigin);
    expect(userIdentity.id).not.toBe(adminIdentity.id);

    const response = await page.request.get(
      `${userOrigin}/api/settings?userId=${encodeURIComponent(String(adminIdentity.id))}`,
    );
    expect(response.status()).toBe(200);
    const body = await response.json() as { data: Identity };
    expect(body.data.id).toBe(userIdentity.id);
    expect(body.data.email.toLowerCase()).toBe(userIdentity.email.toLowerCase());
  } finally {
    await adminContext.close();
  }
});
