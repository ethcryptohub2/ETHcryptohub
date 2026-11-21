import { expect, test } from '@playwright/test';

const approvalTarget = process.env.SMARTEXIT_READONLY_PREVIEW_URL || process.env.SMARTEXIT_READONLY_LOCAL_URL;
test.skip(!approvalTarget, 'An exact SmartExit deployment or loopback URL is required.');

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`read-only Preview auth and route guards at ${viewport.width}px`, async ({ browser }, info) => {
    const target = new URL(approvalTarget!);
    expect(target.origin).toMatch(/^(?:https:\/\/cryptohub-[a-z0-9]+-eth-cryptohub\.vercel\.app|http:\/\/127\.0\.0\.1:\d+)$/);
    expect(target.href).toBe(`${target.origin}/`);
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    try {
      await context.route('**/*', route => {
        const request = route.request();
        return request.method() === 'GET' && new URL(request.url()).origin === target.origin
          ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.name));
      const login = await page.goto(`${target.origin}/login`);
      expect(await page.getByTestId('login/email-input').count(),
        'Vercel Deployment Protection prevented application-level testing.').toBe(0);
      expect(login?.status()).toBe(200);
      await expect(page.locator('input[name="email"]')).toBeVisible();
      await expect(page.locator('input[name="password"]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: info.outputPath('public-login.png') });
      const signup = await page.goto(`${target.origin}/signup`);
      expect(signup?.status()).toBe(200);
      await expect(page).toHaveURL(`${target.origin}/signup`);
      await expect(page.locator('input[name="email"]')).toBeVisible();
      await expect(page.locator('input[name="password"]')).toBeVisible();
      for (const route of ['/dashboard', '/admin', '/admin/exchanges/testing', '/scanner',
        '/scanner?tab=scalping', '/scanner?tab=alpha', '/scanner/history?scannerType=HIGH_RISK']) {
        const response = await page.goto(`${target.origin}${route}`);
        expect(response?.status(), route).toBe(200);
        await expect(page, route).toHaveURL(`${target.origin}/login`);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
