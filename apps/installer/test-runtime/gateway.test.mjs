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

test('the management token step is served by the production DO only under the setup session, and a fresh shell reports no choice', async () => {
  const active = await createRuntime({ gateway: true });
  // A synthetic value in the account token form, assembled at run time.
  const pasted = 'cfat_' + 'Rk3v'.repeat(10) + '6f'.repeat(4);
  try {
    const step = 'http://localhost/__ankka/install/management-token';
    const body = JSON.stringify({ managementToken: pasted });
    const json = { 'content-type': 'application/json' };
    for (const [init, status, error] of [
      // No same-origin proof, then no setup session: neither reaches the step.
      [{ method: 'POST', headers: json, body }, 403, 'forbidden'],
      [{ method: 'POST', headers: { ...json, origin: 'https://bootstrap.example.com' }, body }, 403, 'bootstrap_session_required'],
      [{ method: 'POST', headers: { ...json, origin: 'https://bootstrap.example.com', cookie: '__Host-ankka_bootstrap_session=' + 'z'.repeat(43) }, body }, 410, 'bootstrap_unavailable'],
    ]) {
      const r = await active.runtime.dispatchFetch(step, init);
      const text = await r.text();
      assert.equal(r.status, status, text);
      assert.equal(JSON.parse(text).error, error);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(text.includes(pasted), false);
    }
    // The route takes a POST only; a read of it is not routed at all.
    assert.equal((await active.runtime.dispatchFetch(step)).status, 404);
    const status = await (await active.runtime.dispatchFetch('http://localhost/__ankka/install/status')).json();
    assert.deepEqual(Object.keys(status).sort(), ['failure', 'installId', 'ownershipPublicKey', 'release', 'role', 'schemaVersion', 'status']);
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
