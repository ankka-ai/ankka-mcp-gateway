import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_REQUEST_TIMEOUT_MS, heldOriginMatcher } from '../tools/live-gateway-browser.mjs';
import { REQUEST_TIMEOUT_MS } from '../tools/live-gateway-api.mjs';
import { validateLiveBrowserOrigin, validateLiveBrowserRequest, validateLiveBootstrapOrigin, validateLiveHandoff } from '../tools/live-gateway-browser.mjs';

test('live browser API requests are confined to exact configured origins and lifecycle routes', () => {
  const origin = 'https://manage.example.com';
  assert.equal(validateLiveBrowserOrigin(origin), origin);
  assert.doesNotThrow(() => validateLiveBrowserRequest([origin], origin, '/api/team', 'GET'));
  for (const [target, path, method] of [
    ['https://foreign.example.com', '/api/team', 'GET'],
    [origin, '/api/team?token=secret', 'GET'],
    [origin, '/api/team/../../admin', 'POST'],
    [origin, '/api/unknown', 'GET'],
    [origin, '/api/team', 'PATCH'],
  ]) {
    assert.throws(() => validateLiveBrowserRequest([origin], target, path, method), { code: 'request_outside_lifecycle' });
  }
  for (const value of ['http://manage.example.com', 'https://user:secret@manage.example.com', `${origin}/path`, `${origin}?secret`]) {
    assert.throws(() => validateLiveBrowserOrigin(value), { code: 'origin_invalid' });
  }
});

test('bootstrap navigation requires the generated Worker identity and an exact workers.dev origin', () => {
  const installId = `acg-${'1'.repeat(24)}`;
  const workerName = `ankka-gateway-${installId}`;
  const provision = { installId, workerName, bootstrapOrigin: `https://${workerName}.synthetic.workers.dev` };
  assert.equal(validateLiveBootstrapOrigin(provision), provision.bootstrapOrigin);
  assert.equal(validateLiveBootstrapOrigin({ ...provision, bootstrapOrigin: `${provision.bootstrapOrigin}/` }), provision.bootstrapOrigin);
  for (const suffix of ['/path/', '//', '/?query=1', '/#fragment']) {
    assert.throws(() => validateLiveBootstrapOrigin({ ...provision, bootstrapOrigin: provision.bootstrapOrigin + suffix }), { code: 'origin_invalid' });
  }
  for (const changed of [
    { workerName: 'foreign-worker' },
    { bootstrapOrigin: 'https://foreign.example.com' },
    { bootstrapOrigin: `${provision.bootstrapOrigin}.example.com` },
    { installId: `acg-${'2'.repeat(24)}` },
  ]) assert.throws(() => validateLiveBootstrapOrigin({ ...provision, ...changed }), { code: 'bootstrap_identity_invalid' });
});

test('a lost callback counts only after the exact hosted completion handoff', () => {
  const origin = 'https://installer.example.com';
  const fragment = 'A'.repeat(48);
  assert.equal(validateLiveHandoff(`${origin}/teardown#${fragment}`, origin, '/teardown'), `${origin}/teardown#${fragment}`);
  for (const value of [
    `${origin}/teardown?result=recovery_required`, `${origin}/teardown`,
    `https://foreign.example.com/teardown#${fragment}`, `${origin}/result#${fragment}`,
    `${origin}/teardown?credential=hidden#${fragment}`,
  ]) assert.throws(() => validateLiveHandoff(value, origin, '/teardown'), { code: 'handoff_invalid' });
});

test('the browser runner waits for a gateway write as long as the API client does, since neither retries one', () => {
  assert.equal(BROWSER_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
  assert.ok(BROWSER_REQUEST_TIMEOUT_MS >= 120_000);
});

test('a held origin is matched only while held, so releasing it needs no route removal', () => {
  const hold = { origin: null };
  const matches = heldOriginMatcher(hold);
  const management = new URL('https://manage.example.com/__ankka/update#claim');
  assert.equal(matches(management), false);
  hold.origin = 'https://manage.example.com';
  assert.equal(matches(management), true);
  assert.equal(matches(new URL('https://installer.example.com/api/session')), false);
  hold.origin = null;
  // The update handoff after the Stage 2 consent must reach the real gateway page again.
  assert.equal(matches(management), false);
});
