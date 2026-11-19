import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/sites.js';

test('notification-only bot acknowledges events without writing or retaining the request', async () => {
  const response = await worker.fetch(new Request('https://ritm.example/api/bitrix-bot/events', { method:'POST', body:'private event data' }), {}, {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('event endpoint has a readable health response and rejects other methods', async () => {
  const health = await worker.fetch(new Request('https://ritm.example/api/bitrix-bot/events'), {}, {});
  assert.equal(health.status,200);
  const unsupported = await worker.fetch(new Request('https://ritm.example/api/bitrix-bot/events',{method:'DELETE'}), {}, {});
  assert.equal(unsupported.status,405);
});
