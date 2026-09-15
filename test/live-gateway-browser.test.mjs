import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_REQUEST_TIMEOUT_MS, CALLBACK_CLOSE_WAIT_MS, NAVIGATION_FAILURES, SESSION_PROPAGATION_MS, callbackTracker, handoffHoldAnswer, heldOriginMatcher, isHostedCallback, navigationFailureOf, openLiveGatewayBrowser, rejectedSessionOutcome } from '../tools/live-gateway-browser.mjs';
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
    // The removal page follows an attempt and records its result word; the attempt itself is never recorded.
    [`https://manage.example.com/__ankka/operation/teardown?attempt=attempt_${'A'.repeat(24)}`, { site: 'gateway', page: 'removal', result: null, reason: null }],
    [`https://manage.example.com/__ankka/operation/teardown?attempt=attempt_${'A'.repeat(24)}&result=removed`, { site: 'gateway', page: 'removal', result: 'removed', reason: null }],
    [`https://manage.example.com/__ankka/operation/teardown?attempt=attempt_${'A'.repeat(24)}&result=recovery_required&reason=interrupted`, { site: 'gateway', page: 'removal', result: 'recovery_required', reason: 'interrupted' }],
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
    assert.equal(JSON.stringify(landing).includes('attempt_'), false);
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
  // A callback cut with its tab can never end; a reset forgets it.
  tracker.started(callback);
  tracker.reset();
  assert.equal(tracker.inFlight(), false);
  assert.ok(CALLBACK_CLOSE_WAIT_MS >= 600_000);
});

test('a navigation failure is classified in fixed labels from the page state and the error shape, never from its text', () => {
  const timeout = () => Object.assign(new Error('page.goto: Timeout 90000ms exceeded.\nCall log:\n  - navigating to "https://x/?secret"'), { name: 'TimeoutError' });
  for (const [error, closed, expected] of [
    [timeout(), false, 'timeout'],
    [new Error('page.goto: Timeout 90000ms exceeded.'), false, 'timeout'],
    [new Error('page.goto: Target page, context or browser has been closed'), false, 'closed'],
    [Object.assign(new Error('closed'), { name: 'TargetClosedError' }), false, 'closed'],
    [new Error('Target closed'), false, 'closed'],
    [new Error('page.goto: Navigation failed because page crashed!'), false, 'crashed'],
    [new Error('page.goto: Target crashed [browser log]'), false, 'crashed'],
    [new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x/?secret'), false, 'other'],
    [new Error(), false, 'other'],
    [undefined, false, 'other'],
    // A page that reads closed decides on its own: the error that surfaced while it went away is not consulted.
    [timeout(), true, 'closed'],
    [undefined, true, 'closed'],
  ]) {
    const label = navigationFailureOf(error, { closed });
    assert.equal(label, expected);
    assert.ok(NAVIGATION_FAILURES.includes(label));
  }
  assert.equal(navigationFailureOf(new Error('Target closed')), 'closed');
  assert.deepEqual([...NAVIGATION_FAILURES], ['closed', 'crashed', 'timeout', 'other']);
});

const installerOrigin = 'https://installer.example.com';
const managementOrigin = 'https://manage.example.com';
const basics = { adminEmail: 'admin@example.com' };

/** A tab as the runner drives it, recording what the runner attaches. `outcomes` says what each navigation does:
 * `crashed`, `timeout`, `refused`, `discarded` (the target goes away under the navigation) or null for a shown page. */
function fakeTab(outcomes) {
  const tab = { listeners: {}, events: [], routes: [], timeouts: [], navigations: [], closed: false, current: 'about:blank' };
  tab.on = (event, listener) => { tab.events.push(event); tab.listeners[event] = listener; };
  tab.route = async (matcher, handler) => { tab.routes.push({ matcher, handler }); };
  tab.setDefaultTimeout = (ms) => tab.timeouts.push(ms);
  tab.bringToFront = async () => { if (tab.closed) throw new Error('page.bringToFront: Target page, context or browser has been closed'); };
  tab.goto = async (href) => {
    tab.navigations.push(href);
    const outcome = outcomes.shift() ?? null;
    if (outcome === 'discarded') { tab.closed = true; throw new Error('page.goto: Target page, context or browser has been closed'); }
    if (outcome === 'crashed') throw new Error('page.goto: Navigation failed because page crashed!');
    if (outcome === 'timeout') throw Object.assign(new Error('page.goto: Timeout 90000ms exceeded.'), { name: 'TimeoutError' });
    if (outcome === 'refused') throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://x/?secret');
    tab.current = href;
  };
  tab.url = () => tab.current;
  tab.isClosed = () => tab.closed;
  tab.close = async () => { tab.closed = true; };
  return tab;
}

/** A browser type whose one context hands out fake tabs, each with the navigation outcomes listed for it. */
function fakeBrowserType(outcomesPerTab) {
  const tabs = [];
  const context = {
    pages: () => [],
    newPage: async () => { const tab = fakeTab(outcomesPerTab.shift() ?? []); tabs.push(tab); return tab; },
    request: { fetch: async () => assert.fail('no request is expected') },
    addCookies: async () => {}, clearCookies: async () => {},
    closed: false, close: async () => { context.closed = true; },
  };
  const browser = { contexts: () => [context], newContext: async () => context, close: async () => {} };
  return { tabs, context, browserType: { connectOverCDP: async () => browser, launch: async () => browser, launchPersistentContext: async () => assert.fail('no profile is expected') } };
}

test('a tab the browser discarded or crashed is replaced in the same context with everything the runner attaches, and the navigation is retried once', async () => {
  const handoff = `${managementOrigin}/__ankka/operation#${'A'.repeat(48)}`;
  const attached = (tab) => ({ events: tab.events, timeouts: tab.timeouts, routes: tab.routes.length });
  // A borrowed tab is discarded while idle (the target is gone before the runner comes back to it); an owned tab
  // crashes under the navigation. Both read as a lost tab, not a lost browser.
  for (const [browserConnection, lost] of [['chrome', 'discarded'], [undefined, 'crashed']]) {
    const { tabs, context, browserType } = fakeBrowserType([[lost === 'crashed' ? 'crashed' : null], []]);
    const notices = [], events = [];
    const runner = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection, headless: true,
      notify: (notice) => notices.push(notice), checkpoint: async (event) => events.push(event), browserType });
    const [first] = tabs;
    assert.equal(tabs.length, 1);
    assert.deepEqual(attached(first), { events: ['request', 'requestfinished', 'requestfailed'], timeouts: [30_000], routes: 2 });
    await runner.loseNextTeardownReceiptHop();
    assert.equal(first.routes.length, 3);
    // A hosted callback the first tab was still waiting for when it was lost.
    first.listeners.request({ url: () => `${managementOrigin}/__ankka/install/oauth/callback?code=secret&state=secret` });
    if (lost === 'discarded') first.closed = true;
    await runner.continueHandoff(handoff, 'update');
    assert.equal(tabs.length, 2);
    const [, second] = tabs;
    assert.deepEqual(attached(second), { events: ['request', 'requestfinished', 'requestfailed'], timeouts: [30_000], routes: 3 });
    assert.deepEqual(second.navigations, [handoff]);
    assert.deepEqual(first.navigations, lost === 'discarded' ? [] : [handoff]);
    assert.equal(first.closed, true);
    assert.deepEqual(events, [{ stage: 'browser', status: 'tab_reopened', navigation: lost === 'discarded' ? 'closed' : 'crashed' }]);
    assert.equal(notices.filter((notice) => notice.startsWith('Test tab reopened')).length, 1);
    assert.equal(JSON.stringify([events, notices]).includes('A'.repeat(48)), false);
    // The landing is read from the replacement.
    assert.deepEqual(runner.landing(), { site: 'gateway', page: 'other', result: null, reason: null });
    // The replacement's routes are the runner's: the handoff hold answers the installer's not-ready body while held,
    // the held origin is consulted per request, and the armed interception matches the hop to the receipt page only.
    const answers = [];
    const route = { fulfill: async (answer) => answers.push(answer.status), continue: async () => answers.push('continue') };
    runner.holdHandoff(); await second.routes[1].handler(route); runner.releaseHandoff(); await second.routes[1].handler(route);
    assert.deepEqual(answers, [503, 'continue']);
    assert.equal(second.routes[1].matcher(new URL(`${installerOrigin}/api/bootstrap/handoff`)), true);
    assert.equal(second.routes[2].matcher(new URL(`${installerOrigin}/teardown`)), true);
    assert.equal(second.routes[2].matcher(new URL(`${managementOrigin}/__ankka/install/oauth/callback?code=secret`)), false);
    assert.equal(second.routes[0].matcher(new URL(`${managementOrigin}/__ankka/update`)), false);
    await runner.consent('https://dash.cloudflare.com/oauth2/auth?client_id=synthetic', async () => true, (value) => value === true, { holdOrigin: managementOrigin, keepHold: true });
    assert.equal(second.routes[0].matcher(new URL(`${managementOrigin}/__ankka/update`)), true);
    runner.release();
    assert.equal(second.routes[0].matcher(new URL(`${managementOrigin}/__ankka/update`)), false);
    // The callback cut with the first tab is not waited for: the stop closes what the runner owns at once.
    await runner.close();
    assert.equal(second.closed, browserConnection === 'chrome');
    assert.equal(context.closed, browserConnection !== 'chrome');
    assert.equal(notices.some((notice) => notice.includes('left open')), false);
  }
});

test('a navigation that fails otherwise, or whose replacement fails too, stops as navigation_failed with the fixed label and without a second replacement', async () => {
  for (const scenario of [
    // A refused connection is not a lost tab: no replacement, and the label says so.
    { outcomes: [['refused']], expected: 'other', tabs: 1, reopened: [] },
    // A crashed tab is replaced once; the replacement's own failure is the stop's label.
    { outcomes: [['crashed'], ['timeout']], expected: 'timeout', tabs: 2, reopened: ['crashed'] },
    { outcomes: [['crashed'], ['crashed']], expected: 'crashed', tabs: 2, reopened: ['crashed'] },
    // A tab gone with its context: no replacement can be opened, nothing is journaled, the label says closed.
    { outcomes: [['discarded']], contextGone: true, expected: 'closed', tabs: 1, reopened: [] },
  ]) {
    const { tabs, context, browserType } = fakeBrowserType(scenario.outcomes);
    const events = [];
    const runner = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection: 'chrome',
      notify: () => {}, checkpoint: async (event) => events.push(event), browserType });
    if (scenario.contextGone) context.newPage = async () => { throw new Error('browserContext.newPage: Target page, context or browser has been closed'); };
    await assert.rejects(runner.navigate(`${installerOrigin}/`), (error) => {
      assert.equal(error.code, 'navigation_failed');
      assert.equal(error.navigation, scenario.expected);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
    assert.equal(tabs.length, scenario.tabs);
    assert.deepEqual(events.map((event) => event.navigation), scenario.reopened);
  }
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
