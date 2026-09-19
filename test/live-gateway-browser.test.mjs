import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_REQUEST_TIMEOUT_MS, CALLBACK_CLOSE_WAIT_MS, NAVIGATION_FAILURES, SESSION_PROPAGATION_MS, receiptHopOf, refusedAtAccessEdge, TAB_REPLACEMENT_REASONS, browserDebugOutputEnabled, callbackTracker, handoffHoldAnswer, heldOriginMatcher, isHostedCallback, managementStepWordOf, navigationFailureOf, openLiveGatewayBrowser, rejectedSessionOutcome } from '../tools/live-gateway-browser.mjs';
import { REQUEST_TIMEOUT_MS } from '../tools/live-gateway-api.mjs';
import { INSTALLER_CONNECTION_TIMEOUT_MS, LiveGatewayBrowserError, landingOf, recordedReceiptOf, removalAttemptOf, validateLiveBrowserOrigin, validateLiveBrowserRequest, validateLiveBootstrapOrigin, validateLiveHandoff } from '../tools/live-gateway-browser.mjs';
import { removeLiveGateway } from '../tools/live-gateway-lifecycle.mjs';

const installerOrigin = 'https://installer.example.com';
const managementOrigin = 'https://manage.example.com';
const basics = { adminEmail: 'admin@example.com' };

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

test('the management step of setup is one route and one method, on a customer shell\'s workers.dev origin only', () => {
  const shell = `https://ankka-gateway-acg-${'7'.repeat(24)}.synthetic.workers.dev`;
  const origins = [installerOrigin, managementOrigin, shell];
  const step = '/__ankka/install/management-token';
  assert.doesNotThrow(() => validateLiveBrowserRequest(origins, shell, step, 'POST'));
  for (const [origin, path, method] of [
    // Never a read or another write, and nothing near the route.
    [shell, step, 'GET'], [shell, step, 'PUT'], [shell, step, 'DELETE'], [shell, step, 'PATCH'],
    [shell, `${step}/`, 'POST'], [shell, `${step}?skip=true`, 'POST'], [shell, `${step}#value`, 'POST'], [shell, '/__ankka/install/management-tokens', 'POST'],
    // Never the installer, which is hosted, never the installed gateway, and never a shell this run did not adopt.
    [installerOrigin, step, 'POST'], [managementOrigin, step, 'POST'], ['https://other.synthetic.workers.dev', step, 'POST'],
  ]) assert.throws(() => validateLiveBrowserRequest(origins, origin, path, method), { code: 'request_outside_lifecycle' });
  // An installer or gateway that were itself on workers.dev would still not be a shell this port adopted by identity;
  // the port's own method checks that, and the other setup routes stay what they were.
  assert.doesNotThrow(() => validateLiveBrowserRequest(origins, shell, '/__ankka/install/oauth/start', 'POST'));
});

test('Playwright\'s debug output counts as switched on for any DEBUG and for a PWDEBUG it does not read as off; the shell\'s word is read in its fixed vocabulary only', () => {
  for (const env of [{ DEBUG: 'pw:channel' }, { DEBUG: 'pw:*' }, { DEBUG: '*' }, { DEBUG: 'pw:api' }, { DEBUG: 'other-tool' }, { PWDEBUG: '1' }, { PWDEBUG: 'console' }, { DEBUG: '', PWDEBUG: 'true' }]) {
    assert.equal(browserDebugOutputEnabled(env), true, JSON.stringify(env));
  }
  for (const env of [{}, { DEBUG: '' }, { PWDEBUG: '' }, { PWDEBUG: '0' }, { PWDEBUG: 'false' }, { DEBUG: undefined, PWDEBUG: undefined }, { DEBUG_FILE: '/private/log' }]) {
    assert.equal(browserDebugOutputEnabled(env), false, JSON.stringify(env));
  }
  for (const word of ['held', 'installed', 'skipped', 'dropped']) assert.equal(managementStepWordOf({ schemaVersion: 1, managementCredential: word }), word);
  // The setup view's object, an absent key (the final runtime's status), and anything a shell might echo read as nothing.
  for (const answer of [null, undefined, {}, { managementCredential: null }, { managementCredential: { state: 'held' } }, { managementCredential: 'synthetic-management-token-value-0123456789' },
    { managementCredential: 'HELD' }, { managementCredential: ['held'] }, { status: 'held' }]) assert.equal(managementStepWordOf(answer), null);
});

test('the one lifecycle path with a query is the removal page\'s own progress read for one well-formed attempt, and nothing near it', () => {
  const origin = 'https://manage.example.com';
  const attempt = `attempt_${'A'.repeat(24)}`;
  const progress = '/__ankka/operation/teardown/progress';
  assert.doesNotThrow(() => validateLiveBrowserRequest([origin], origin, `${progress}?attempt=${attempt}`, 'GET'));
  assert.doesNotThrow(() => validateLiveBrowserRequest([origin], origin, `${progress}?attempt=attempt_${'a-Z_09'.repeat(4)}`, 'GET'));
  for (const [target, path, method] of [
    // A read only, on a configured origin only.
    [origin, `${progress}?attempt=${attempt}`, 'POST'], [origin, `${progress}?attempt=${attempt}`, 'PUT'], [origin, `${progress}?attempt=${attempt}`, 'DELETE'],
    ['https://foreign.example.com', `${progress}?attempt=${attempt}`, 'GET'],
    // Exactly one attempt of the gateway's own form, and no other query.
    [origin, progress, 'GET'], [origin, `${progress}?`, 'GET'], [origin, `${progress}?attempt=`, 'GET'],
    [origin, `${progress}?attempt=attempt_${'A'.repeat(23)}`, 'GET'], [origin, `${progress}?attempt=attempt_${'A'.repeat(25)}`, 'GET'],
    [origin, `${progress}?attempt=action_${'A'.repeat(24)}`, 'GET'], [origin, `${progress}?attempt=attempt_${'A'.repeat(23)}%`, 'GET'],
    [origin, `${progress}?attempt=${attempt}&token=secret`, 'GET'], [origin, `${progress}?token=secret&attempt=${attempt}`, 'GET'],
    [origin, `${progress}?attempt=${attempt}#fragment`, 'GET'], [origin, `${progress}/?attempt=${attempt}`, 'GET'],
    // Neither the page itself, nor its start route, nor any other route gains a query.
    [origin, `/__ankka/operation/teardown?attempt=${attempt}`, 'GET'], [origin, '/__ankka/operation/teardown', 'GET'],
    [origin, '/__ankka/operation/teardown/start', 'POST'], [origin, `/__ankka/operation/progress?attempt=${attempt}`, 'GET'],
    [origin, `/api/team?attempt=${attempt}`, 'GET'], [origin, `/api/teardown?attempt=${attempt}`, 'GET'],
    [origin, `/__ankka/install/status?attempt=${attempt}`, 'GET'],
  ]) {
    assert.throws(() => validateLiveBrowserRequest([origin], target, path, method), { code: 'request_outside_lifecycle' });
  }
});

test('the attempt is read from the removal page\'s own address only, and a recorded receipt only from a settled removal\'s link to the installer\'s receipt page', () => {
  const attempt = `attempt_${'A'.repeat(24)}`;
  const page = `${managementOrigin}/__ankka/operation/teardown`;
  assert.equal(removalAttemptOf(`${page}?attempt=${attempt}`, managementOrigin), attempt);
  assert.equal(removalAttemptOf(`${page}?attempt=${attempt}&result=removed`, managementOrigin), attempt);
  for (const value of [page, `${page}?result=recovery_required&reason=removal`, `${page}?attempt=attempt_short`, `${page}?attempt=${attempt}x`,
    `${page}/progress?attempt=${attempt}`, `${installerOrigin}/__ankka/operation/teardown?attempt=${attempt}`, `${installerOrigin}/teardown`,
    'chrome-error://chromewebdata/', '']) assert.equal(removalAttemptOf(value, managementOrigin), null);
  const receipt = JSON.stringify({ schemaVersion: 1, statement: 'synthetic signed receipt — ünïcode' });
  const fragment = Buffer.from(receipt, 'utf8').toString('base64url');
  const settled = { schemaVersion: 1, attemptId: attempt, status: 'settled', result: 'removed', reason: null, handoffUrl: `${installerOrigin}/teardown#${fragment}`, steps: [] };
  assert.equal(recordedReceiptOf(settled, installerOrigin), receipt);
  for (const progress of [
    { ...settled, status: 'removing' }, { ...settled, status: 'authorizing' },
    { ...settled, result: 'recovery_required', reason: 'removal', handoffUrl: null }, { ...settled, result: null },
    { ...settled, handoffUrl: null }, { ...settled, handoffUrl: `${installerOrigin}/teardown` },
    { ...settled, handoffUrl: `https://foreign.example.com/teardown#${fragment}` }, { ...settled, handoffUrl: `${managementOrigin}/teardown#${fragment}` },
    { ...settled, handoffUrl: `${installerOrigin}/manage#${fragment}` }, { ...settled, handoffUrl: `${installerOrigin}/teardown?next=x#${fragment}` },
    // A fragment that is not text is no receipt.
    { ...settled, handoffUrl: `${installerOrigin}/teardown#${Buffer.from(Array.from({ length: 48 }, () => 0xff)).toString('base64url')}` },
    null, undefined, {},
  ]) assert.equal(recordedReceiptOf(progress, installerOrigin), null);
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
    // Chrome's own error page, committed for an empty error response among others, is a landing of its own.
    ['chrome-error://chromewebdata/', { site: 'other', page: 'error', result: null, reason: null }],
    [`chrome-error://chromewebdata/?result=recovery_required&code=secret#${fragment}`, { site: 'other', page: 'error', result: null, reason: null }],
    ['chrome://newtab/', { site: 'other', page: 'other', result: null, reason: null }],
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


/** A document answer as the tab's response listener sees it. */
const documentAnswer = (url, status) => ({ url: () => url, status: () => status, headers: () => ({ server: 'cloudflare' }), request: () => ({ resourceType: () => 'document' }) });

/** A tab as the runner drives it, recording what the runner attaches. `outcomes` says what each navigation does:
 * `crashed`, `timeout`, `refused`, `discarded` (the target goes away under the navigation), `edge_refused` (the edge
 * answers an empty 403 and Chrome commits its own error page), `denied_page` (a 403 that carries a page) or null for
 * a shown page. `onAuthorize` plays what follows the removal review's button. */
function fakeTab(outcomes) {
  const tab = { listeners: {}, events: [], routes: [], timeouts: [], navigations: [], waits: [], closed: false, current: 'about:blank', onAuthorize: null };
  tab.on = (event, listener) => { tab.events.push(event); tab.listeners[event] = listener; };
  tab.route = async (matcher, handler) => { tab.routes.push({ matcher, handler }); };
  tab.setDefaultTimeout = (ms) => tab.timeouts.push(ms);
  tab.bringToFront = async () => { if (tab.closed) throw new Error('page.bringToFront: Target page, context or browser has been closed'); };
  tab.goto = async (href, options) => {
    tab.navigations.push(href); tab.waits.push(options?.waitUntil);
    const outcome = outcomes.shift() ?? null;
    if (outcome === 'discarded') { tab.closed = true; throw new Error('page.goto: Target page, context or browser has been closed'); }
    if (outcome === 'crashed') throw new Error('page.goto: Navigation failed because page crashed!');
    if (outcome === 'timeout') throw Object.assign(new Error('page.goto: Timeout 90000ms exceeded.'), { name: 'TimeoutError' });
    if (outcome === 'refused') throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://x/?secret');
    if (outcome === 'edge_refused') {
      tab.listeners.response(documentAnswer(href, 403)); tab.current = 'chrome-error://chromewebdata/';
      throw new Error(`page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at ${href}`);
    }
    tab.listeners.response?.(documentAnswer(href, outcome === 'denied_page' ? 403 : 200));
    tab.current = href;
  };
  tab.getByRole = () => ({ click: async () => { await tab.onAuthorize?.(tab); } });
  tab.url = () => tab.current;
  tab.isClosed = () => tab.closed;
  tab.close = async () => { tab.closed = true; };
  return tab;
}

/** A browser type whose one context hands out fake tabs, each with the navigation outcomes listed for it. `opened`
 * keeps the options an owned browser and its context were opened with, and any tracing the port started fails. */
function fakeBrowserType(outcomesPerTab) {
  const tabs = [], opened = [];
  const context = {
    pages: () => [],
    newPage: async () => { const tab = fakeTab(outcomesPerTab.shift() ?? []); tabs.push(tab); return tab; },
    request: { fetch: async () => assert.fail('no request is expected') },
    tracing: { start: async () => assert.fail('the port never records a trace'), startChunk: async () => assert.fail('the port never records a trace') },
    addCookies: async () => {}, clearCookies: async () => {},
    closed: false, close: async () => { context.closed = true; },
  };
  const browser = { contexts: () => [context], newContext: async (options) => { opened.push(options); return context; }, close: async () => {} };
  return { tabs, context, opened, browserType: { connectOverCDP: async () => browser, launch: async (options) => { opened.push(options); return browser; }, launchPersistentContext: async () => assert.fail('no profile is expected') } };
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
    assert.deepEqual(attached(first), { events: ['request', 'requestfinished', 'requestfailed', 'response'], timeouts: [30_000], routes: 2 });
    await runner.loseNextTeardownReceiptHop();
    assert.equal(first.routes.length, 3);
    // A hosted callback the first tab was still waiting for when it was lost.
    first.listeners.request({ url: () => `${managementOrigin}/__ankka/install/oauth/callback?code=secret&state=secret` });
    if (lost === 'discarded') first.closed = true;
    await runner.continueHandoff(handoff, 'update');
    assert.equal(tabs.length, 2);
    const [, second] = tabs;
    assert.deepEqual(attached(second), { events: ['request', 'requestfinished', 'requestfailed', 'response'], timeouts: [30_000], routes: 3 });
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

test('the test tab is replaced on purpose once the interception is spent: the new tab carries no interception route, the old one is closed, and the journal names the fixed reason', async () => {
  assert.deepEqual([...TAB_REPLACEMENT_REASONS], ['interruption_spent']);
  const handoff = `${managementOrigin}/__ankka/operation#${'A'.repeat(48)}`;
  const attached = (tab) => ({ events: tab.events, timeouts: tab.timeouts, routes: tab.routes.length });
  for (const browserConnection of ['chrome', undefined]) {
    const { tabs, context, browserType } = fakeBrowserType([[null], [null]]);
    const notices = [], events = [];
    const runner = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection, headless: true,
      notify: (notice) => notices.push(notice), checkpoint: async (event) => events.push(event), browserType });
    const [first] = tabs;
    await runner.loseNextTeardownReceiptHop();
    assert.equal(first.routes.length, 3);
    // The dropped receipt hop: the interception aborts the document navigation to the installer once and is spent.
    const answers = [];
    const route = {
      request: () => ({ resourceType: () => 'document' }),
      abort: async (code) => answers.push(`abort:${code}`), continue: async () => answers.push('continue'),
    };
    await first.routes[2].handler(route);
    assert.deepEqual(answers, ['abort:failed']);
    assert.equal(runner.interruptionObserved(), true);
    await runner.replaceTab('interruption_spent');
    assert.equal(tabs.length, 2);
    const [, second] = tabs;
    // Everything but the spent interception route: the replacement is the tab of a fresh process.
    assert.deepEqual(attached(second), { events: ['request', 'requestfinished', 'requestfailed', 'response'], timeouts: [30_000], routes: 2 });
    assert.equal(second.routes[1].matcher(new URL(`${installerOrigin}/api/bootstrap/handoff`)), true);
    assert.equal(second.routes.some((item) => item.matcher(new URL(`${installerOrigin}/teardown#${'B'.repeat(48)}`))), false);
    assert.equal(first.closed, true);
    assert.deepEqual(events, [{ stage: 'browser', status: 'tab_replaced', reason: 'interruption_spent' }]);
    assert.equal(notices.filter((notice) => notice.startsWith('Test tab replaced')).length, 1);
    // What follows runs in the replacement, and the landing is read from it.
    await runner.continueHandoff(handoff, 'update');
    assert.deepEqual(second.navigations, [handoff]);
    assert.deepEqual(first.navigations, []);
    assert.deepEqual(runner.landing(), { site: 'gateway', page: 'other', result: null, reason: null });
    // A reason outside the fixed vocabulary is refused before any tab is opened or journaled.
    await assert.rejects(runner.replaceTab('secret reason'), { code: 'tab_replacement_reason_invalid' });
    assert.equal(tabs.length, 2);
    assert.equal(events.length, 1);
    assert.equal(JSON.stringify([events, notices]).includes('B'.repeat(48)), false);
    await runner.close();
    assert.equal(second.closed, browserConnection === 'chrome');
    assert.equal(context.closed, browserConnection !== 'chrome');
  }
});

test('an attach Chrome refuses stops as browser_attach_failed, without the browser\'s error text', async () => {
  for (const failure of [
    new Error('browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222 secret'),
    Object.assign(new Error('browserType.connectOverCDP: Timeout 120000ms exceeded.'), { name: 'TimeoutError' }),
  ]) {
    const browserType = { connectOverCDP: async () => { throw failure; }, launch: async () => assert.fail('no launch is expected'), launchPersistentContext: async () => assert.fail('no profile is expected') };
    await assert.rejects(openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection: 'chrome', notify: () => {}, browserType }), (error) => {
      assert.equal(error.code, 'browser_attach_failed');
      assert.equal(error.navigation, null);
      assert.equal(error.message.includes('secret'), false);
      assert.equal(error.message.includes('Timeout'), false);
      return true;
    });
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

test('an installed session the Access edge refuses is put back from the cached token and the same request is sent once more', async () => {
  for (const [status, location, expected] of [
    [302, 'https://team.cloudflareaccess.com/cdn-cgi/access/login/manage.example.com?kid=secret', true],
    [303, 'https://team.cloudflareaccess.com/login', true],
    [302, 'https://manage.example.com/settings', false], [302, undefined, false], [302, 'http://[not-a-host', false],
    [401, 'https://team.cloudflareaccess.com/login', false], [200, 'https://team.cloudflareaccess.com/login', false],
  ]) assert.equal(refusedAtAccessEdge(status, location, managementOrigin), expected);
  const answer = (status, headers, body) => ({ status: () => status, headers: () => headers, body: async () => Buffer.from(JSON.stringify(body ?? {})), dispose: async () => {} });
  const login = { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/installer.example.com?kid=secret' };
  const json = { 'content-type': 'application/json' };
  for (const method of ['GET', 'POST']) {
    const { context, browserType } = fakeBrowserType([[null]]);
    const installs = [], notices = [], sent = [];
    // The session is installed at login; later the browser has lost the cookie and the edge redirects once.
    const answers = [answer(200, json, { schemaVersion: 1 }), answer(302, login), answer(200, json, { schemaVersion: 1, ok: true })];
    context.request.fetch = async (url, options) => { sent.push(`${options.method} ${new URL(url).pathname}`); return answers.shift(); };
    const runner = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection: 'chrome', headless: true,
      notify: (notice) => notices.push(notice), browserType,
      accessFactory: () => async (_context, origin, options = {}) => { installs.push({ origin, ...options }); } });
    await runner.login(installerOrigin);
    const result = await runner.request(installerOrigin, '/api/session', method === 'GET' ? {} : { method, body: {} });
    assert.deepEqual(result, { schemaVersion: 1, ok: true });
    assert.deepEqual(sent, ['GET /api/session', `${method} /api/session`, `${method} /api/session`]);
    // Forced, and never a login: the installer's session is not one the runner may start.
    assert.deepEqual(installs.filter((item) => item.force === true), [{ origin: installerOrigin, allowLogin: false, force: true }]);
    assert.equal(notices.filter((notice) => notice.startsWith('Access session put back')).length, 1);
    assert.equal(JSON.stringify(notices).includes('secret'), false);
    // A second refusal of the same request is final: nothing loops.
    answers.push(answer(302, login), answer(302, login));
    await assert.rejects(runner.request(installerOrigin, '/api/session'), { code: 'access_session_rejected' });
    await runner.close();
  }
});

test('the management step is answered with the setup page\'s own request, once, to the adopted shell only: the value stays in that body, no trace or recording exists to hold it, and only the shell\'s fixed word leaves', async () => {
  const installId = `acg-${'7'.repeat(24)}`;
  const provision = { installId, workerName: `ankka-gateway-${installId}`, bootstrapOrigin: `https://ankka-gateway-${installId}.synthetic.workers.dev` };
  const value = 'synthetic-management-token-value-0123456789';
  const answer = (status, body, headers = { 'content-type': 'application/json' }) => ({ status: () => status, headers: () => headers, body: async () => Buffer.from(JSON.stringify(body)), dispose: async () => {} });
  const { context, opened, browserType } = fakeBrowserType([[null]]);
  const notices = [], events = [], sent = [], answers = [];
  context.request.fetch = async (url, options) => { sent.push({ url, ...options }); const next = answers.shift(); if (next instanceof Error) throw next; return next; };
  const runner = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, headless: true, env: {},
    notify: (notice) => notices.push(notice), checkpoint: async (event) => events.push(event), browserType, accessFactory: () => async () => {} });
  // An owned browser and its context are opened with no recording of any kind, and no trace is ever started.
  assert.deepEqual(opened, [{ channel: 'chrome', headless: true, chromiumSandbox: true }, { acceptDownloads: false, serviceWorkers: 'block' }]);
  // A shell this run has not adopted is never sent anything, and neither is a provision that is not a shell's.
  await assert.rejects(runner.answerManagementStep(provision, value), { code: 'bootstrap_identity_invalid' });
  await assert.rejects(runner.answerManagementStep({ ...provision, bootstrapOrigin: installerOrigin }, value), { code: 'bootstrap_identity_invalid' });
  assert.equal(runner.adoptBootstrap(provision), provision.bootstrapOrigin);
  assert.equal(runner.managementStepWord(), null);
  // "Use this token": the page's request, with the value in its body and nowhere else.
  answers.push(answer(200, { schemaVersion: 1, managementCredential: 'held' }));
  assert.equal(await runner.answerManagementStep(provision, value), 'held');
  assert.equal(runner.managementStepWord(), 'held');
  // "Continue without a token".
  answers.push(answer(200, { schemaVersion: 1, managementCredential: 'skipped' }));
  assert.equal(await runner.answerManagementStep(provision), 'skipped');
  assert.deepEqual(sent.map((item) => ({ url: item.url, method: item.method, data: JSON.parse(item.data), type: item.headers['content-type'], origin: item.headers.origin, maxRedirects: item.maxRedirects })), [
    { url: `${provision.bootstrapOrigin}/__ankka/install/management-token`, method: 'POST', data: { managementToken: value }, type: 'application/json', origin: provision.bootstrapOrigin, maxRedirects: 0 },
    { url: `${provision.bootstrapOrigin}/__ankka/install/management-token`, method: 'POST', data: { skip: true }, type: 'application/json', origin: provision.bootstrapOrigin, maxRedirects: 0 },
  ]);
  // Like the page, the port trims the value and never sends an empty one; the shell alone judges its form.
  await assert.rejects(runner.answerManagementStep(provision, ' \n'), { code: 'management_token_unavailable' });
  await assert.rejects(runner.answerManagementStep(provision, 42), { code: 'management_token_unavailable' });
  assert.equal(sent.length, 2);
  answers.push(answer(200, { schemaVersion: 1, managementCredential: 'held' }));
  assert.equal(await runner.answerManagementStep(provision, ` ${value}\n`), 'held');
  assert.deepEqual(JSON.parse(sent.at(-1).data), { managementToken: value });
  // The value is in no URL and no header.
  assert.equal(JSON.stringify(sent.map((item) => [item.url, item.headers])).includes('synthetic-management'), false);
  // A refusal, a lost answer and an Access redirect leave as fixed codes; the request is never sent again, and a
  // shell that echoed the value where its word belongs gives it no way out.
  const failures = [];
  for (const [next, expected] of [
    [answer(400, { schemaVersion: 1, error: 'management_token_invalid', echoed: value }), { code: 'gateway_http_rejected', status: 400 }],
    [new Error(`apiRequestContext.fetch: socket hang up while sending ${value}`), { code: 'gateway_request_failed', status: null }],
    [answer(302, {}, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' }), { code: 'gateway_http_rejected', status: 302 }],
  ]) {
    answers.push(next);
    const before = sent.length;
    await assert.rejects(runner.answerManagementStep(provision, value), (error) => { failures.push(error); assert.equal(error.code, expected.code); assert.equal(error.status, expected.status); return true; });
    assert.equal(sent.length, before + 1);
  }
  answers.push(answer(200, { schemaVersion: 1, managementCredential: value }));
  assert.equal(await runner.answerManagementStep(provision, value), null);
  assert.equal(runner.managementStepWord(), 'held');
  for (const text of [JSON.stringify(notices), JSON.stringify(events), ...failures.flatMap((error) => [String(error), error.stack, JSON.stringify(error)])]) assert.equal(text.includes('synthetic-management'), false);
  await runner.close();

  // With Playwright's debug output switched on, which prints each message's body, the token is not sent at all; the
  // choice to continue without one carries no value and still goes.
  for (const env of [{ DEBUG: 'pw:channel' }, { PWDEBUG: '1' }]) {
    const traced = fakeBrowserType([[null]]);
    const requests = [];
    traced.context.request.fetch = async (url, options) => { requests.push(options.data); return answer(200, { schemaVersion: 1, managementCredential: 'skipped' }); };
    const refusing = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection: 'chrome', headless: true, env,
      notify: () => {}, browserType: traced.browserType, accessFactory: () => async () => {} });
    refusing.adoptBootstrap(provision);
    await assert.rejects(refusing.answerManagementStep(provision, value), { code: 'browser_debug_output_enabled' });
    assert.deepEqual(requests, []);
    assert.equal(await refusing.answerManagementStep(provision), 'skipped');
    assert.deepEqual(requests, ['{"skip":true}']);
    await refusing.close();
  }
});

test('the shell\'s word about the management step is kept from the progress page\'s own status polls on the adopted shell, never from a poll of the runner\'s', async () => {
  const installId = `acg-${'8'.repeat(24)}`;
  const provision = { installId, workerName: `ankka-gateway-${installId}`, bootstrapOrigin: `https://ankka-gateway-${installId}.synthetic.workers.dev` };
  const status = `${provision.bootstrapOrigin}/__ankka/install/status`;
  const { tabs, context, browserType } = fakeBrowserType([[null]]);
  context.request.fetch = async () => assert.fail('the runner adds no status poll of its own');
  const runner = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection: 'chrome', headless: true, env: {},
    notify: () => {}, browserType, accessFactory: () => async () => {} });
  /** A status poll of the page as the tab's response listener sees it. */
  const poll = (url, read) => ({ url: () => url, status: () => 200, headers: () => ({}), request: () => ({ resourceType: () => 'fetch' }), json: read });
  const heard = async (url, read) => { tabs[0].listeners.response(poll(url, read)); await new Promise((resolve) => setImmediate(resolve)); return runner.managementStepWord(); };
  const shell = (word) => async () => ({ schemaVersion: 1, role: 'customer-gateway-bootstrap', status: 'CONVERGING', managementCredential: word });
  // Before the shell is adopted its polls are nobody's.
  assert.equal(await heard(status, shell('held')), null);
  runner.adoptBootstrap(provision);
  assert.equal(await heard(status, shell('held')), 'held');
  assert.equal(await heard(status, shell('dropped')), 'dropped');
  // The final runtime's status carries no word, a cut poll reads nothing, and neither do an unknown word, another
  // path, or another origin: the last word stays.
  assert.equal(await heard(status, async () => ({ schemaVersion: 1, status: 'READY' })), 'dropped');
  assert.equal(await heard(status, async () => { throw new Error('Response body is unavailable'); }), 'dropped');
  assert.equal(await heard(status, shell('synthetic-management-token-value-0123456789')), 'dropped');
  assert.equal(await heard(`${provision.bootstrapOrigin}/__ankka/install/setup`, shell('held')), 'dropped');
  assert.equal(await heard(`${installerOrigin}/__ankka/install/status`, shell('held')), 'dropped');
  assert.equal(await heard(`${status}x`, shell('installed')), 'dropped');
  assert.equal(await heard(status, shell('installed')), 'installed');
  // A replaced tab is listened to like the first one.
  await runner.replaceTab('interruption_spent');
  tabs[1].listeners.response(poll(status, shell('dropped')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.managementStepWord(), 'dropped');
  await runner.close();
});

test('the answer to the receipt page navigation is kept in fixed fields only, for the installer document and nothing else', async () => {
  assert.deepEqual(receiptHopOf(403, { server: 'cloudflare', 'cf-mitigated': 'challenge', 'set-cookie': 'secret=1' }), { status: 403, server: 'cloudflare', mitigated: 'challenge' });
  assert.deepEqual(receiptHopOf(200, { server: 'Some Server/1.0 (secret)' }), { status: 200, server: null, mitigated: null });
  assert.deepEqual(receiptHopOf(9999, undefined), { status: null, server: null, mitigated: null });
  const { tabs, browserType } = fakeBrowserType([[null]]);
  const runner = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection: 'chrome', headless: true, notify: () => {}, browserType });
  assert.equal(runner.receiptHop(), null);
  const response = (url, type, status) => ({ url: () => url, status: () => status, headers: () => ({ server: 'cloudflare' }), request: () => ({ resourceType: () => type }) });
  const listener = tabs[0].listeners.response;
  listener(response(`${installerOrigin}/api/teardown`, 'fetch', 409));
  listener(response(`${managementOrigin}/teardown`, 'document', 200));
  listener(response(`${installerOrigin}/teardown`, 'script', 200));
  assert.equal(runner.receiptHop(), null);
  listener(response(`${installerOrigin}/teardown`, 'document', 403));
  assert.deepEqual(runner.receiptHop(), { status: 403, server: 'cloudflare', mitigated: null });
  await runner.close();
});

test('the load that opens the installer\'s own connection never stops the run: a refused or failed load is journaled in fixed fields, and an armed interception stays unspent', async () => {
  assert.ok(INSTALLER_CONNECTION_TIMEOUT_MS <= 60_000);
  for (const [outcome, expected] of [
    [null, { loaded: true, answer: { status: 200, server: 'cloudflare', mitigated: null } }],
    // The load is itself reused onto the gateway's connection: the edge's empty 403, Chrome's own error page.
    ['edge_refused', { loaded: false, answer: { status: 403, server: 'cloudflare', mitigated: null } }],
    // A refusal that carries a page commits like a load; the answer's status still says it was refused.
    ['denied_page', { loaded: false, answer: { status: 403, server: 'cloudflare', mitigated: null } }],
    ['refused', { loaded: false, answer: null }], ['timeout', { loaded: false, answer: null }], ['discarded', { loaded: false, answer: null }],
  ]) {
    const { tabs, browserType } = fakeBrowserType([[outcome, null]]);
    const notices = [], events = [];
    const runner = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection: 'chrome', headless: true,
      notify: (notice) => notices.push(notice), checkpoint: async (event) => events.push(event), browserType });
    await runner.loseNextTeardownReceiptHop();
    await runner.openInstallerConnection();
    // The origin's root, committed only: never the receipt page, which an armed interception would spend itself on.
    assert.deepEqual(tabs[0].navigations, [`${installerOrigin}/`]);
    assert.deepEqual(tabs[0].waits, ['commit']);
    assert.equal(tabs[0].routes[2].matcher(new URL(tabs[0].navigations[0])), false);
    assert.equal(runner.interruptionObserved(), false);
    assert.deepEqual(events, [{ stage: 'browser', status: 'installer_connection', ...expected }]);
    assert.equal(notices.length, 1);
    assert.equal(JSON.stringify([events, notices]).includes('secret'), false);
    // The receipt hop's own record is untouched by that load.
    assert.equal(runner.receiptHop(), null);
    await runner.close();
  }
});

test('the recorded receipt is read once, for the attempt the removal page followed in this round only, and the attempt never leaves the browser port', async () => {
  const attempt = `attempt_${'Q'.repeat(24)}`;
  const receipt = JSON.stringify({ schemaVersion: 1, statement: 'synthetic signed removal receipt' });
  const progress = { schemaVersion: 1, attemptId: attempt, status: 'settled', result: 'removed', reason: null, handoffUrl: `${installerOrigin}/teardown#${Buffer.from(receipt, 'utf8').toString('base64url')}`, steps: [] };
  const handoff = `${managementOrigin}/__ankka/operation/teardown#${'H'.repeat(48)}`;
  const { tabs, context, browserType } = fakeBrowserType([[null, null]]);
  const notices = [], events = [], sent = [];
  context.request.fetch = async (url, options) => {
    sent.push(`${options.method} ${url}`);
    return { status: () => 200, headers: () => ({ 'content-type': 'application/json; charset=utf-8' }), body: async () => Buffer.from(JSON.stringify(progress)), dispose: async () => {} };
  };
  const runner = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection: 'chrome', headless: true,
    notify: (notice) => notices.push(notice), checkpoint: async (event) => events.push(event), browserType });
  // No removal page was seen: nothing is asked.
  assert.equal(await runner.recordedReceipt(), null);
  assert.deepEqual(sent, []);
  // The consent lands on the removal page, whose address names the attempt; the page's hop is then refused.
  tabs[0].onAuthorize = (tab) => {
    tab.listeners.response(documentAnswer(`${managementOrigin}/__ankka/operation/teardown?attempt=${attempt}`, 200));
    tab.listeners.response(documentAnswer(`${installerOrigin}/teardown`, 403));
    tab.current = 'chrome-error://chromewebdata/';
  };
  await runner.continueHandoff(handoff, 'teardown');
  assert.deepEqual(runner.landing(), { site: 'other', page: 'error', result: null, reason: null });
  assert.deepEqual(runner.receiptHop(), { status: 403, server: 'cloudflare', mitigated: null });
  assert.equal(await runner.recordedReceipt(), receipt);
  assert.deepEqual(sent, [`GET ${managementOrigin}/__ankka/operation/teardown/progress?attempt=${attempt}`]);
  // The next round starts without the previous round's attempt or hop: neither can stand in for its own.
  tabs[0].onAuthorize = null;
  await runner.continueHandoff(handoff, 'teardown');
  assert.equal(runner.receiptHop(), null);
  assert.equal(await runner.recordedReceipt(), null);
  assert.equal(sent.length, 1);
  // An update handoff is no removal round and leaves the round's evidence alone.
  tabs[0].listeners.response(documentAnswer(`${installerOrigin}/teardown`, 403));
  await runner.continueHandoff(`${managementOrigin}/__ankka/operation#${'H'.repeat(48)}`, 'update');
  assert.deepEqual(runner.receiptHop(), { status: 403, server: 'cloudflare', mitigated: null });
  assert.equal(JSON.stringify([events, notices]).includes('attempt_'), false);
  assert.equal(JSON.stringify([events, notices]).includes('Q'.repeat(24)), false);
  await runner.close();
});

test('refusal observed, recovery by API, receipt saved: the real browser port and the real removal sequence journal fixed labels only, never the attempt', async () => {
  const attempt = `attempt_${'Q'.repeat(24)}`;
  const actionId = `action_${'A'.repeat(32)}`;
  const receipt = JSON.stringify({ schemaVersion: 1, statement: 'synthetic signed removal receipt' });
  const fragment = Buffer.from(receipt, 'utf8').toString('base64url');
  const handoffFragment = 'H'.repeat(48);
  const config = { installerOrigin, managementOrigin, basics: { ...basics, managementHostname: new URL(managementOrigin).hostname } };
  // The load ahead of the round is refused like the hop it is meant to help; the round still runs.
  const { tabs, context, browserType } = fakeBrowserType([['edge_refused', null]]);
  const notices = [], events = [], sent = [], imports = [];
  let held = null;
  const answer = (status, body) => ({ status: () => status, headers: () => ({ 'content-type': 'application/json; charset=utf-8' }), body: async () => Buffer.from(JSON.stringify(body)), dispose: async () => {} });
  context.request.fetch = async (url, options) => {
    const target = new URL(url);
    const route = `${options.method} ${target.origin === installerOrigin ? 'installer' : 'gateway'} ${target.pathname}`;
    sent.push(route + target.search);
    if (route === 'GET installer /api/teardown') return held === null ? answer(409, { error: 'teardown_unavailable' }) : answer(200, held);
    if (route === 'POST installer /api/teardown/import') {
      imports.push({ body: JSON.parse(options.data), journaled: events.length });
      held = { canAuthorize: true, hostname: config.basics.managementHostname, handoff: JSON.parse(options.data).handoff, revocationUnconfirmed: false, csrfToken: 'synthetic', steps: [] };
      return answer(200, { imported: true });
    }
    if (route === 'POST gateway /api/teardown-actions') return answer(200, { actionId, handoffUrl: `${managementOrigin}/__ankka/operation/teardown#${handoffFragment}` });
    if (route === `GET gateway /api/teardown-actions/${actionId}`) return answer(200, { status: 'recovery_required', failureCode: 'fresh_authorization_required' });
    if (route === 'GET gateway /__ankka/operation/teardown/progress' && target.search === `?attempt=${attempt}`) {
      return answer(200, { schemaVersion: 1, attemptId: attempt, status: 'settled', result: 'removed', reason: null, handoffUrl: `${installerOrigin}/teardown#${fragment}`, steps: [] });
    }
    // The test ends at the root consent, which is not its subject.
    if (route === 'POST installer /api/teardown/authorize') return answer(500, {});
    return assert.fail(`unexpected ${route}`);
  };
  const checkpoint = async (event) => events.push(event);
  const runner = await openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserConnection: 'chrome', headless: true,
    notify: (notice) => notices.push(notice), checkpoint, browserType });
  tabs[0].onAuthorize = (tab) => {
    tab.listeners.response(documentAnswer(`${managementOrigin}/__ankka/operation/teardown?attempt=${attempt}`, 200));
    tab.listeners.response(documentAnswer(`${installerOrigin}/teardown`, 403));
    tab.current = 'chrome-error://chromewebdata/';
  };
  // The runner's own waits, without their pauses: a wait with a deadline gives up after a few reads.
  const waitFor = async (read, accepts, { seconds } = {}) => {
    for (let attempts = 0; attempts < (seconds === undefined ? 1 : 3); attempts += 1) { const value = await read(); if (accepts(value)) return value; }
    throw new LiveGatewayBrowserError('interactive_step_timed_out');
  };
  await assert.rejects(removeLiveGateway({ config, browser: { ...runner, waitFor }, provider: {}, inventory: {}, checkpoint, phase: 'root' }), { code: 'gateway_http_rejected', status: 500 });
  const refusal = { status: 403, server: 'cloudflare', mitigated: null };
  assert.deepEqual(events, [
    { stage: 'dependency_removal', status: 'started' },
    { stage: 'dependency_removal', status: 'recorded', actionId },
    { stage: 'browser', status: 'installer_connection', loaded: false, answer: refusal },
    { stage: 'dependency_removal', status: 'recovery_required', actionId, failureCode: 'fresh_authorization_required',
      landing: { site: 'other', page: 'error', result: null, reason: null }, receiptHop: refusal, receiptImport: 'runner_after_edge_refusal' },
    { stage: 'root_removal', status: 'receipt_saved', handoff: receipt, revocationUnconfirmed: false },
    { stage: 'root_removal', status: 'started' },
  ]);
  // The gateway's record is read once, after the landing grace, and the round says how the receipt travels before
  // the import is written; the saved receipt is then imported as the runner always imports it.
  const progressReads = sent.filter((route) => route.startsWith('GET gateway /__ankka/operation/teardown/progress'));
  assert.deepEqual(progressReads, [`GET gateway /__ankka/operation/teardown/progress?attempt=${attempt}`]);
  assert.ok(sent.indexOf(progressReads[0]) > sent.lastIndexOf(`GET gateway /api/teardown-actions/${actionId}`));
  assert.ok(sent.indexOf(progressReads[0]) < sent.indexOf('POST installer /api/teardown/import'));
  assert.deepEqual(imports, [{ body: { handoff: receipt }, journaled: 4 }, { body: { handoff: receipt }, journaled: 5 }]);
  assert.deepEqual(tabs[0].navigations, [`${installerOrigin}/`, `${managementOrigin}/__ankka/operation/teardown#${handoffFragment}`]);
  // Beside the saved receipt, which the private journal has always kept, nothing of the hop is journaled or printed:
  // not the attempt, not the link's fragment, not the handoff's.
  const journal = JSON.stringify([events.map((event) => event.status === 'receipt_saved' ? { ...event, handoff: null } : event), notices]);
  for (const secret of ['attempt_', 'Q'.repeat(24), fragment, handoffFragment]) assert.equal(journal.includes(secret), false);
  assert.equal(JSON.stringify(events).includes('attempt_'), false);
  await runner.close();
});
