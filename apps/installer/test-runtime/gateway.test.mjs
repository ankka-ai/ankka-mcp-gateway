import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './runtime.mjs';

test('production bootstrap routes run with the production DO and reject unauthenticated setup', async () => {
  const active = await createRuntime({ gateway: true });
  try {
    for (const [path, method, status] of [
      ['/__ankka/install', 'GET', 200], ['/unknown', 'GET', 404],
      ['/__ankka/install/setup', 'GET', 403], ['/__ankka/install/configuration', 'POST', 403],
    ]) {
      const r = await active.runtime.dispatchFetch('http://localhost' + path, { method });
      assert.equal(r.status, status, path);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    const r = await active.runtime.dispatchFetch('http://localhost/__ankka/install/status');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, 'INCOMPLETE');
    assert.equal(active.blockedRequests(), 0);
  } finally { await active.dispose(); }
});

test('an asynchronous DO rejection returns safe JSON instead of a platform HTML error', async () => {
  const active = await createRuntime({ gateway: true });
  try {
    const r = await active.runtime.dispatchFetch('http://localhost/fixture/rejected-configuration', { method: 'POST' });
    assert.equal(r.status, 503);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await r.json(), { schemaVersion: 1, error: 'bootstrap_unavailable' });
    assert.equal(active.blockedRequests(), 0);
  } finally { await active.dispose(); }
});
