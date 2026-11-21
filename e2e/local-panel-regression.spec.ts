import { expect, test, type Browser, type Page } from '@playwright/test';

const localTarget = process.env.SMARTEXIT_READONLY_LOCAL_URL;
test.skip(!localTarget, 'A loopback SmartExit URL is required.');

type NotificationMode = 'events' | 'empty' | 'error';
type Role = 'admin' | 'user';

async function fixture(browser: Browser, width: number, role: Role) {
  const target = new URL(localTarget!);
  expect(target.href).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  const context = await browser.newContext({ viewport: { width, height: 850 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'offline-fixture-session', value: 'fixture', url: target.href, httpOnly: true }]);
  let notificationMode: NotificationMode = 'events';
  let notificationDelay: Promise<void> | undefined;
  let logoutStatus = 200;
  let logoutRequests = 0;
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== target.origin) return route.abort();
    if (url.pathname === '/api/auth/logout' && request.method() === 'POST') {
      logoutRequests++;
      expect(request.headers()['x-csrf-token']).toBe('offline-fixture');
      return route.fulfill({
        status: logoutStatus,
        ...(logoutStatus === 200 && { headers: { 'Set-Cookie': 'offline-fixture-session=; Max-Age=0; Path=/; HttpOnly' } }),
        json: { data: { signedOut: logoutStatus === 200 } },
      });
    }
    if (request.method() !== 'GET') return route.abort();
    switch (url.pathname) {
      case '/api/auth/me':
        return route.fulfill({ json: { data: { role, email: `${role}@fixture.test` } } });
      case '/api/subscription':
        expect(url.searchParams.get('mode')).toBe('read-only');
        return route.fulfill({ json: { data: { subscription: {
          status: 'PREMIUM_ACTIVE', hasPremiumAccess: true, premiumExpiresAt: '2099-12-31T00:00:00Z',
        } } } });
      case '/api/news/unread':
        return route.fulfill({ json: { data: { unreadCount: 2 } } });
      case '/api/notifications':
        await notificationDelay;
        if (notificationMode === 'error') return route.fulfill({ status: 503, json: { error: 'offline test error' } });
        return route.fulfill({ json: { data: notificationMode === 'empty' ? { unreadCount: 0, notifications: [] } : {
          unreadCount: 1,
          notifications: [{ id: 1, created_at: '2026-11-20T00:00:00Z', event_type: 'NEW_SIGNAL', read_at: null, symbol: 'BTCUSDT' }],
        } } });
      case '/api/csrf':
        return route.fulfill({ json: { data: { csrfToken: 'offline-fixture' } } });
      default:
        return url.pathname.startsWith('/api/') ? route.abort() : route.continue();
    }
  });

  try {
    const page = await context.newPage();
    await page.goto(new URL('/login', target).href);
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // Mount the real shared header at a panel pathname without sending an authenticated page request.
    await page.evaluate((pathname) => window.history.pushState(null, '', pathname), role === 'admin' ? '/admin' : '/dashboard');
    const header = page.getByRole('banner', { name: 'Workspace header' });
    await expect(header).toContainText(role === 'admin' ? 'Admin portal' : 'Workspace');
    await expect(header.locator('.panel-topbar-count')).toHaveText('3');
    return {
      page, context, header,
      setNotifications: (mode: NotificationMode, delay?: Promise<void>) => { notificationMode = mode; notificationDelay = delay; },
      setLogoutStatus: (status: number) => { logoutStatus = status; },
      logoutRequests: () => logoutRequests,
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function expectInViewport(page: Page, locator: ReturnType<Page['locator']>, minimumSize = 0) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThanOrEqual(minimumSize);
  expect(bounds!.height).toBeGreaterThanOrEqual(minimumSize);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const role of ['admin', 'user'] as const) {
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    test(`${role} shared header controls at ${width}px`, async ({ browser }, testInfo) => {
      const { page, context, header } = await fixture(browser, width, role);
      try {
        const bell = header.getByRole('button', { name: 'Notifications', exact: true });
        const account = header.getByRole('button', { name: 'Account', exact: true });
        const navigation = header.locator('button[aria-label="Navigation"]');
        const accountPanel = header.getByRole('region', { name: 'Account' });
        const notifications = header.getByRole('region', { name: 'Notifications' });
        const drawer = page.getByRole('complementary', { name: 'Application navigation' });
        const theme = header.getByRole('button', { name: 'Switch to dark mode' });
        await expectInViewport(page, bell, 44);
        await expect(bell).toHaveAccessibleDescription('3 unread items');
        await expectInViewport(page, account, 44);
        await expectInViewport(page, theme, 44);
        await bell.focus();
        await page.keyboard.press('Enter');
        await expect(notifications.getByText('BTCUSDT · NEW SIGNAL')).toBeVisible();
        await expect(notifications.getByText('1 unread signal notification')).toBeVisible();
        await expectInViewport(page, notifications);
        await expect(accountPanel).toBeHidden();
        await expect(navigation).toHaveAttribute('aria-expanded', 'false');
        if (width === 320 || width === 390) await page.screenshot({ path: testInfo.outputPath('notifications-light.png') });
        await page.keyboard.press('Escape');
        await expect(notifications).toBeHidden();
        await expect(bell).toBeFocused();

        await theme.click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await bell.click();
        await account.click();
        await expect(notifications).toBeHidden();
        await expect(accountPanel.getByRole('button', { name: 'Log out' })).toBeVisible();
        await expectInViewport(page, accountPanel);
        if (width === 390 || width === 1440) await page.screenshot({ path: testInfo.outputPath('account-dark.png') });
        await page.mouse.click(2, page.viewportSize()!.height - 5);
        await expect(accountPanel).toBeHidden();

        if (width < 761) {
          await expectInViewport(page, navigation, 44);
          await bell.click();
          await navigation.click();
          await expect(notifications).toBeHidden();
          await expect(accountPanel).toBeHidden();
          await expect(drawer).toBeVisible();
          await expect(drawer.getByRole('button', { name: 'Close navigation' })).toBeFocused();
          await expect(drawer.getByRole('link', { name: 'Admin overview' })).toHaveCount(role === 'admin' ? 1 : 0);
          await account.click();
          await expect(drawer).toBeHidden();
          await expect(accountPanel).toBeVisible();
          await navigation.click();
          await expect(accountPanel).toBeHidden();
          await expect(drawer).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(drawer).toBeHidden();
          await expect(navigation).toBeFocused();
        } else {
          await expect(drawer).toBeVisible();
          await expect(drawer.getByRole('link', { name: 'Admin overview' })).toHaveCount(role === 'admin' ? 1 : 0);
          await expect(navigation).toBeHidden();
        }

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      } finally {
        await context.close();
      }
    });
  }
}

test('notification loading, error, retry and empty states are explicit', async ({ browser }) => {
  const { page, context, header, setNotifications } = await fixture(browser, 375, 'user');
  const release = Promise.withResolvers<void>();
  try {
    setNotifications('error', release.promise);
    await header.getByRole('button', { name: 'Notifications' }).click();
    const notifications = header.getByRole('region', { name: 'Notifications' });
    await expect(notifications.getByText('Loading recent notifications…')).toBeVisible();
    release.resolve();
    await expect(notifications.getByText('Recent notifications could not be loaded.')).toBeVisible();
    setNotifications('empty');
    await notifications.getByRole('button', { name: 'Retry' }).click();
    await expect(notifications.getByText('No recent signal notifications.')).toBeVisible();
    await expect(notifications.getByText('0 unread signal notifications')).toBeVisible();
    await expect(header.locator('.panel-topbar-count')).toHaveText('2');
    await page.mouse.click(2, page.viewportSize()!.height - 5);
    await expect(notifications).toBeHidden();
  } finally {
    release.resolve();
    await context.close();
  }
});

for (const [role, width] of [['admin', 1440], ['user', 320]] as const) {
  test(`${role} logout handles errors and redirects after local fixture clears its cookie`, async ({ browser }) => {
    const { page, context, header, setLogoutStatus, logoutRequests } = await fixture(browser, width, role);
    try {
      setLogoutStatus(503);
      await header.getByRole('button', { name: 'Account' }).click();
      await header.getByRole('button', { name: 'Log out' }).click();
      await expect(header.getByRole('alert')).toHaveText('Sign-out failed.');
      expect((await context.cookies()).some(({ name }) => name === 'offline-fixture-session')).toBe(true);

      setLogoutStatus(200);
      await header.getByRole('button', { name: 'Log out' }).click();
      await expect(page).toHaveURL(/\/login$/);
      expect((await context.cookies()).some(({ name }) => name === 'offline-fixture-session')).toBe(false);
      expect(logoutRequests()).toBe(2);
    } finally {
      await context.close();
    }
  });
}
