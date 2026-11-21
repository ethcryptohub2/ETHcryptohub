import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovedDemoReadTransport, supportsApprovedDemoRead } from './admin-demo-read-transport.ts';

test('bounded Demo transport permits signed GET paths only, with no redirects or order targets', async () => {
  const requests = [];
  const statuses = [];
  const transport = createApprovedDemoReadTransport('BINANCE', new AbortController().signal, async (target, init) => {
    requests.push([target, init]);
    return Response.json({ fixture: true });
  }, status => statuses.push(status));
  await assert.rejects(transport('https://fapi.binance.com/fapi/v3/account'), /outside/);
  await assert.rejects(transport('https://demo-fapi.binance.com/fapi/v1/order'), /outside/);
  await assert.rejects(transport('https://demo-fapi.binance.com/fapi/v3/account', { method: 'POST' }), /outside/);
  assert.equal(supportsApprovedDemoRead('BITGET'), false);
  for (let count = 0; count < 3; count++) {
    const response = await transport('https://demo-fapi.binance.com/fapi/v3/account');
    assert.deepEqual(await response.json(), { fixture: true });
  }
  await assert.rejects(transport('https://demo-fapi.binance.com/fapi/v1/exchangeInfo'), /budget/);
  assert.deepEqual(statuses, [200, 200, 200]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(([, init]) => init.redirect === 'manual' && init.credentials === 'omit'));
});

test('OKX requires simulation mode and aborts the remainder on provider denial', async () => {
  let requests = 0;
  const transport = createApprovedDemoReadTransport('OKX', new AbortController().signal, async () => {
    requests++;
    return new Response('{}', { status: 403 });
  });
  const account = 'https://openapi.okx.com/api/v5/account/config';
  await assert.rejects(transport(account), /simulation mode/);
  assert.equal(requests, 0);
  await assert.rejects(transport(account, { headers: { 'x-simulated-trading': '1' } }), /HTTP 403/);
  await assert.rejects(transport('https://openapi.okx.com/api/v5/public/instruments'));
  assert.equal(requests, 1);
});

test('Demo transport bounds provider response bodies and closes an interrupted scope', async () => {
  const transport = createApprovedDemoReadTransport('GATE', new AbortController().signal, async () =>
    new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  const url = 'https://api-testnet.gateapi.io/api/v4/futures/usdt/accounts';
  await assert.rejects(transport(url), /byte limit/);
  await assert.rejects(transport(url), { name: 'AbortError' });
});
