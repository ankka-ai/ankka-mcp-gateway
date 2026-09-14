import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_REQUEST_TIMEOUT_MS, CALLBACK_CLOSE_WAIT_MS, SESSION_PROPAGATION_MS, callbackTracker, handoffHoldAnswer, heldOriginMatcher, isHostedCallback, rejectedSessionOutcome } from '../tools/live-gateway-browser.mjs';
import { REQUEST_TIMEOUT_MS } from '../tools/live-gateway-api.mjs';
import { landingOf, validateLiveBrowserOrigin, validateLiveBrowserRequest, validateLiveBootstrapOrigin, validateLiveHandoff } from '../tools/live-gateway-browser.mjs';

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

test('the held handoff answer is the installer\'s own not-ready body, and nothing while released', () => {
  const hold = { active: false };
  assert.equal(handoffHoldAnswer(hold), null);
  hold.active = true;
  const answer = handoffHoldAnswer(hold);
  assert.equal(answer.status, 503);
  assert.deepEqual(JSON.parse(answer.body), { schemaVersion: 1, code: 'bootstrap_not_ready', status: 'not_ready', retryAfterMs: 3000, reason: 'runner_waits_for_shell' });
});

test('a landing is fixed labels only: site, page, and the removal page\'s result and reason words; never the fragment or other query values', () => {
  const origins = { installerOrigin: 'https://installer.example.com', managementOrigin: 'https://manage.example.com' };
  const fragment = 'A'.repeat(48);
  for (const [value, expected] of [
    [`https://installer.example.com/teardown#${fragment}`, { site: 'installer', page: 'receipt', result: null, reason: null }],
    ['https://manage.example.com/__ankka/operation/teardown?result=recovery_required&reason=removal', { site: 'gateway', page: 'removal', result: 'recovery_required', reason: 'removal' }],
    [`https://manage.example.com/__ankka/operation/teardown#${fragment}`, { site: 'gateway', page: 'removal', result: null, reason: null }],
    ['https://manage.example.com/__ankka/operation/teardown?result=recovery_required&reason=Not%20a%20word&code=secret', { site: 'gateway', page: 'removal', result: 'recovery_required', reason: null }],
    ['https://manage.example.com/__ankka/install/oauth/callback?code=secret&state=secret', { site: 'gateway', page: 'callback', result: null, reason: null }],
    ['https://dash.cloudflare.com/oauth2/auth?client_id=secret', { site: 'cloudflare', page: 'consent', result: null, reason: null }],
    ['https://installer.example.com/api/session?result=recovery_required', { site: 'installer', page: 'other', result: null, reason: null }],
    ['https://accounts.google.com/signin?reason=removal', { site: 'other', page: 'other', result: null, reason: null }],
    ['chrome-error://chromewebdata/', { site: 'other', page: 'other', result: null, reason: null }],
    ['', { site: 'other', page: 'other', result: null, reason: null }],
  ]) {
    const landing = landingOf(value, origins);
    assert.deepEqual(landing, expected);
    assert.equal(JSON.stringify(landing).includes('secret'), false);
    assert.equal(JSON.stringify(landing).includes(fragment), false);
  }
});

test('a pending hosted callback is known by request identity on the lifecycle\'s origins only, so a stop never cuts it', () => {
  const origins = ['https://installer.example.com', 'https://manage.example.com'];
  for (const value of [
    'https://manage.example.com/__ankka/install/oauth/callback?code=secret&state=secret',
    'https://installer.example.com/oauth/callback?code=secret&state=secret',
  ]) assert.equal(isHostedCallback(value, origins), true);
  for (const value of [
    'https://foreign.example.com/oauth/callback?code=secret', 'https://manage.example.com/api/status',
    'https://manage.example.com/__ankka/operation/teardown?result=recovery_required', 'https://dash.cloudflare.com/oauth2/auth', '',
  ]) assert.equal(isHostedCallback(value, origins), false);
  const tracker = callbackTracker(origins);
  const request = (url) => ({ url: () => url });
  const callback = request('https://manage.example.com/__ankka/install/oauth/callback?code=secret&state=secret');
  const read = request('https://manage.example.com/api/status');
  tracker.started(read);
  assert.equal(tracker.inFlight(), false);
  tracker.started(callback);
  assert.equal(tracker.inFlight(), true);
  tracker.ended(read);
  assert.equal(tracker.inFlight(), true);
  tracker.ended(callback);
  assert.equal(tracker.inFlight(), false);
  assert.ok(CALLBACK_CLOSE_WAIT_MS >= 600_000);
});

test('a refusal of a just-installed gateway session is retried inside the propagation window and final after it', () => {
  const installedAt = 1_000_000;
  for (const status of [302, 303, 401, 403]) {
    assert.equal(rejectedSessionOutcome({ status, installedAt, now: installedAt + SESSION_PROPAGATION_MS - 1 }), 'retry');
    assert.equal(rejectedSessionOutcome({ status, installedAt, now: installedAt + SESSION_PROPAGATION_MS }), 'rejected');
    // The installer's session has no window: its application is old and a refusal there is final at once.
    assert.equal(rejectedSessionOutcome({ status, installedAt: undefined, now: installedAt }), 'rejected');
  }
  for (const status of [200, 404, 409, 500]) assert.equal(rejectedSessionOutcome({ status, installedAt, now: installedAt }), null);
  assert.ok(SESSION_PROPAGATION_MS >= 5 * 60_000);
});
