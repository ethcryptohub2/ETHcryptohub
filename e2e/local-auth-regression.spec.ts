import { expect, test } from '@playwright/test';

const localTarget = process.env.SMARTEXIT_READONLY_LOCAL_URL;
test.skip(!localTarget, 'A loopback SmartExit URL is required.');

test('repeated form submission issues only one login request while it is pending', async ({ browser }) => {
  const target = new URL(localTarget!);
  expect(target.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(target.href).toBe(`${target.origin}/`);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let loginRequests = 0;
  let csrfRequests = 0;
  const release = Promise.withResolvers<void>();
  try {
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== target.origin) return route.abort();
      if (url.pathname === '/api/csrf' && request.method() === 'GET') {
        csrfRequests++;
        return route.fulfill({ json: { data: { csrfToken: 'offline-fixture' } } });
      }
      if (url.pathname === '/api/auth/login' && request.method() === 'POST') {
        loginRequests++;
        await release.promise;
        return route.fulfill({ status: 401, json: { error: 'Offline sign-in declined.' } });
      }
      return request.method() === 'GET' ? route.continue() : route.abort();
    });

    const page = await context.newPage();
    await page.goto(`${target.origin}/login`);
    const form = page.locator('form');
    await form.locator('input[name="email"]').fill('fixture@example.test');
    await form.locator('input[name="password"]').fill('synthetic-password');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => loginRequests).toBe(1);
    await expect(form.getByRole('button', { name: 'Please wait…', exact: true })).toBeDisabled();

    await form.evaluate(node => {
      const formNode = node as HTMLFormElement;
      formNode.requestSubmit();
      formNode.requestSubmit();
    });
    release.resolve();
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('Offline sign-in declined.');
    await expect(form.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    expect(loginRequests).toBe(1);
    expect(csrfRequests).toBe(1);
  } finally {
    release.resolve();
    await context.close();
  }
});
