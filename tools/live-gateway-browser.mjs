import { chromium } from 'playwright-core';
import * as v from 'valibot';
import { createLiveGatewayAccess, LiveGatewayAccessError } from './live-gateway-access.mjs';
import { LiveGatewayBrowserError, validateLiveBootstrapOrigin, validateLiveBrowserOrigin } from './live-gateway-origin.mjs';

export { LiveGatewayBrowserError, NAVIGATION_FAILURES, validateLiveBootstrapOrigin, validateLiveBrowserOrigin } from './live-gateway-origin.mjs';

const API_PATH = /^\/api\/(?:session(?:\/new)?|selection|plan|cleanup|bootstrap(?:\/handoff)?|status|sources(?:\/discover)?|source-actions(?:\/action_[A-Za-z0-9_-]{32})?|team|team-actions(?:\/action_[A-Za-z0-9_-]{32})?|update|update-actions(?:\/action_[A-Za-z0-9_-]{32})?|teardown-actions(?:\/action_[A-Za-z0-9_-]{32})?|teardown(?:\/import|\/authorize)?)$/u;
const BOOTSTRAP_PATH = /^\/__ankka\/install\/(?:status|setup|configuration|oauth\/start)$/u;
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/**
 * A gateway action applies Portal and Access policy changes before it answers, and a Team write has taken more than
 * thirty seconds live. A write is never retried, so the runner waits for it as long as the API client does.
 */
export const BROWSER_REQUEST_TIMEOUT_MS = 120_000;
/** A management Access application created minutes ago can still refuse a valid session at some edges while its
 * policy propagates; within this window after the session install such a refusal is retried, not final. */
export const SESSION_PROPAGATION_MS = 10 * 60_000;

/** What an authenticated origin's refusal means: null for an accepted status, `retry` inside the propagation
 * window of a just-installed session, `rejected` otherwise. */
export function rejectedSessionOutcome({ status, installedAt, now = Date.now() }) {
  if (![302, 303, 401, 403].includes(status)) return null;
  return installedAt !== undefined && now < installedAt + SESSION_PROPAGATION_MS ? 'retry' : 'rejected';
}
/** A hosted attempt lives ten minutes; an owned browser waits no longer than that for a pending callback on a stop. */
export const CALLBACK_CLOSE_WAIT_MS = 600_000;

/** The installer's own not-ready handoff answer, returned to the page while the hold is active; null otherwise. */
export function handoffHoldAnswer(hold) {
  if (!hold.active) return null;
  return { status: 503, contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ schemaVersion: 1, code: 'bootstrap_not_ready', status: 'not_ready', retryAfterMs: 3_000, reason: 'runner_waits_for_shell' }) };
}

/** Matches requests to the origin currently held (none when `hold.origin` is null); evaluated per request. */
export function heldOriginMatcher(hold) {
  return (url) => hold.origin !== null && url.origin === hold.origin;
}

export function validateLiveBrowserRequest(origins, origin, path, method) {
  if (!origins.includes(origin) || !(API_PATH.test(path) || BOOTSTRAP_PATH.test(path)) || !METHODS.has(method)) {
    throw new LiveGatewayBrowserError('request_outside_lifecycle');
  }
}

export function validateLiveHandoff(value, origin, path) {
  let url;
  try { url = new URL(value); } catch { throw new LiveGatewayBrowserError('handoff_invalid'); }
  if (url.origin !== origin || url.pathname !== path || url.search || url.username || url.password ||
      !/^#[A-Za-z0-9_-]{40,65536}$/u.test(url.hash)) throw new LiveGatewayBrowserError('handoff_invalid');
  return url.href;
}

const LANDING_WORD = /^[a-z_]{1,32}$/u;
const HOSTED_CALLBACK_PATH = /^\/(?:oauth\/callback|__ankka\/install\/oauth\/callback)$/u;

/** A hosted OAuth callback on one of the lifecycle's origins: its whole operation runs inside that one response. */
export function isHostedCallback(value, origins) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return origins.includes(url.origin) && HOSTED_CALLBACK_PATH.test(url.pathname);
}

/** Knows while a hosted callback's response is pending in the tab, since closing the tab then cuts the operation's
 * revoke and settlement. Requests are tracked by identity; their URLs are never kept. */
export function callbackTracker(origins) {
  const pending = new Set();
  return {
    started(request) { if (isHostedCallback(request.url(), origins)) pending.add(request); },
    ended(request) { pending.delete(request); },
    inFlight: () => pending.size > 0,
    /** Forgets every pending request: what a tab that is gone still had in flight can neither end nor be waited for. */
    reset() { pending.clear(); },
  };
}

/** Why a navigation failed, as one of NAVIGATION_FAILURES, from the page's state and the error's shape: a page that
 * reads closed or a closed target (Playwright's TargetClosedError, which a tab the browser discarded produces) is
 * `closed`, a crashed renderer `crashed`, an expired navigation `timeout`, anything else `other`. The error's text is
 * only matched, never kept: it can carry the URL. */
export function navigationFailureOf(error, { closed = false } = {}) {
  if (closed) return 'closed';
  const name = v.is(v.string(), error?.name) ? error.name : '';
  const message = v.is(v.string(), error?.message) ? error.message : '';
  if (name === 'TargetClosedError' || /Target closed|Target page, context or browser has been closed/u.test(message)) return 'closed';
  if (/Target crashed|page crashed/u.test(message)) return 'crashed';
  if (name === 'TimeoutError' || /Timeout \d+ms exceeded/u.test(message)) return 'timeout';
  return 'other';
}

/** Where the test tab is, in fixed labels only: the site, the lifecycle page it shows, and for the gateway's removal
 * page the `result` and `reason` words it was sent with. Never the fragment, which carries handoffs, and never a query
 * value outside that vocabulary. */
export function landingOf(value, { installerOrigin, managementOrigin }) {
  let url;
  try { url = new URL(value); } catch { return { site: 'other', page: 'other', result: null, reason: null }; }
  const site = url.origin === installerOrigin ? 'installer' : url.origin === managementOrigin ? 'gateway' :
    url.origin === 'https://dash.cloudflare.com' ? 'cloudflare' : 'other';
  const page = site === 'installer' && url.pathname === '/teardown' ? 'receipt' :
    site === 'gateway' && url.pathname === '/__ankka/operation/teardown' ? 'removal' :
    site === 'gateway' && url.pathname === '/__ankka/install/oauth/callback' ? 'callback' :
    site === 'cloudflare' && url.pathname === '/oauth2/auth' ? 'consent' : 'other';
  const word = (name) => {
    const item = page === 'removal' ? url.searchParams.get(name) : null;
    return item !== null && LANDING_WORD.test(item) ? item : null;
  };
  return { site, page, result: word('result'), reason: word('reason') };
}

/** An explicitly authorized Chrome connection borrows its context and owns only
 * a new tab. Never close that context or export browser storage, traces or HAR. */
export async function openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserProfile, browserConnection, headless = false, notify, checkpoint = async () => {}, browserType = chromium }) {
  const origins = [installerOrigin, managementOrigin].map(validateLiveBrowserOrigin);
  const accessCancellation = new AbortController();
  const installAccess = createLiveGatewayAccess({ origins, email: basics.adminEmail, notify, signal: accessCancellation.signal });
  // Origins whose Access session the runner installed, with the time of that install.
  const authenticated = new Map();
  if (browserConnection !== undefined && (browserConnection !== 'chrome' || browserProfile)) {
    throw new LiveGatewayBrowserError('browser_connection_invalid');
  }
  const borrowed = browserConnection === 'chrome';
  const browser = borrowed ? await browserType.connectOverCDP('chrome', { noDefaults: true, timeout: 120_000 }) :
    browserProfile ? null : await browserType.launch({ channel: 'chrome', headless, chromiumSandbox: true });
  const context = borrowed ? browser.contexts()[0] : browserProfile
    ? await browserType.launchPersistentContext(browserProfile, {
      channel: 'chrome', headless, chromiumSandbox: true, acceptDownloads: false, serviceWorkers: 'block',
      // A manually authenticated Chrome profile uses the real OS keychain.
      // Mock/basic stores cannot decrypt that profile's existing login cookies.
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
    })
    : await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
  const callbacks = callbackTracker(origins);
  // A held origin is answered locally so the browser never resolves a hostname whose record may not exist yet. The
  // route stays installed for the page's life and consults the held origin per request: releasing the hold changes
  // the variable, not the routes, because an attached browser can refuse to remove a route without saying so.
  const hold = { origin: null };
  const answerHeldOrigin = (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><title>Ankka lifecycle</title><p>Installation is finishing. The runner continues by API.</p>',
  });
  // The installer page hops to the new shell the moment the installer's own readiness probe passes, spending the
  // one-time handoff on that hop; an edge that does not serve the fresh Worker yet answers it 404 and the shell never
  // gets its session. While held, the page's handoff poll gets the installer's own not-ready answer and keeps polling.
  const handoffHold = { active: false };
  const isHandoffPoll = (url) => url.origin === installerOrigin && url.pathname === '/api/bootstrap/handoff';
  const answerHandoffPoll = (route) => {
    const answer = handoffHoldAnswer(handoffHold);
    return answer === null ? route.continue() : route.fulfill(answer);
  };
  let interrupted = false;
  let interruptionArmed = false;
  let interruptionError = null;
  let cancelled = false;
  const isTeardownCallback = (url) => url.origin === managementOrigin && url.pathname === '/__ankka/install/oauth/callback';
  async function loseTeardownCallbackResponse(route) {
    if (interrupted) { await route.continue(); return; }
    // Execute the genuine callback but lose its response at the browser.
    // Never save the code, cookie, grant, response body or redirect fragment.
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: 180_000 });
      if (response.status() !== 303) throw new LiveGatewayBrowserError('interruption_callback_incomplete');
      // A redirect to an error/recovery page is not completed dependency removal.
      validateLiveHandoff(response.headers().location, installerOrigin, '/teardown');
      interrupted = true;
      await route.abort('failed');
    } catch {
      interruptionError = new LiveGatewayBrowserError('interruption_callback_incomplete');
      await route.abort('failed').catch(() => {});
    } finally { await response?.dispose().catch(() => {}); }
  }

  /**
   * Everything the runner attaches to a tab, in one place so a replacement tab cannot drift from the first: the
   * default timeout, the callback tracker's listeners, the held-origin and handoff-hold routes, and the teardown
   * callback interception while it is armed and not yet spent. Routes are matched in reverse registration order.
   */
  async function attach(tab) {
    tab.setDefaultTimeout(30_000);
    tab.on('request', (request) => callbacks.started(request));
    tab.on('requestfinished', (request) => callbacks.ended(request));
    tab.on('requestfailed', (request) => callbacks.ended(request));
    await tab.route(heldOriginMatcher(hold), answerHeldOrigin);
    await tab.route(isHandoffPoll, answerHandoffPoll);
    if (interruptionArmed && !interrupted) await tab.route(isTeardownCallback, loseTeardownCallbackResponse);
  }
  let page = borrowed ? await context.newPage() : context.pages()[0] ?? await context.newPage();
  await attach(page);

  /**
   * A tab the browser discarded after minutes in the background (Chrome's Memory Saver) or whose renderer crashed
   * reads as a closed page. A new tab in the same context takes its place, with everything the runner attaches per
   * tab; the previous one is closed where the browser still lets the runner, and a discarded tab's placeholder stays
   * with the operator. What the previous tab still had in flight is forgotten: it can neither end nor be waited for.
   * The replacement is recorded in the journal with the failure that caused it.
   */
  async function reopen(failure) {
    const previous = page;
    let replacement;
    try {
      replacement = await context.newPage();
      await attach(replacement);
    } catch (error) { throw new LiveGatewayBrowserError('navigation_failed', null, navigationFailureOf(error)); }
    page = replacement;
    callbacks.reset();
    await previous.close().catch(() => {});
    await checkpoint({ stage: 'browser', status: 'tab_reopened', navigation: failure });
    notify('Test tab reopened: the browser had discarded or crashed the previous one. Keep the runner\'s tab active, or turn Chrome\'s Memory Saver off for an attended run.');
  }

  /** One attempt at showing the target in the current tab: null once it shows, else the failure's fixed label. */
  async function show(target) {
    try {
      await page.bringToFront();
      // The Cloudflare consent page is a heavy application; give any navigation well over the default 30 seconds.
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await page.bringToFront();
      if (page.url() === 'about:blank') throw new Error();
      const visibleOrigin = new URL(page.url()).origin;
      const location = visibleOrigin === installerOrigin ? 'isolated installer' :
        visibleOrigin === managementOrigin ? 'test gateway' :
        visibleOrigin === 'https://accounts.google.com' ? 'Google sign-in' :
        visibleOrigin === 'https://dash.cloudflare.com' ? 'Cloudflare sign-in or consent' : 'external sign-in';
      notify(`Active test tab: ${location}.`);
      return null;
    } catch (error) { return navigationFailureOf(error, { closed: page.isClosed() }); }
  }

  async function navigate(url) {
    const target = new URL(url);
    const consent = target.origin === 'https://dash.cloudflare.com' && target.pathname === '/oauth2/auth';
    if ((!origins.includes(target.origin) && !consent) || target.username || target.password) {
      throw new LiveGatewayBrowserError('navigation_outside_lifecycle');
    }
    let failure = await show(target);
    if (failure === 'closed' || failure === 'crashed') {
      // The tab is gone, not the browser: a replacement takes its place and the navigation is retried once.
      await reopen(failure);
      failure = await show(target);
    }
    if (failure !== null) throw new LiveGatewayBrowserError('navigation_failed', null, failure);
  }

  async function request(origin, path, { method = 'GET', body, csrfToken } = {}, authenticate = true) {
    validateLiveBrowserRequest(origins, origin, path, method);
    if (authenticated.has(origin)) await installAccess(context, origin);
    let response;
    try {
      const options = {
        method, maxRedirects: 0, timeout: BROWSER_REQUEST_TIMEOUT_MS,
        headers: { origin, accept: 'application/json' },
      };
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json';
        options.data = JSON.stringify(body);
      }
      if (csrfToken !== undefined) options.headers['x-csrf-token'] = csrfToken;
      response = await context.request.fetch(origin + path, options);
      const status = response.status();
      // Only a rejected read can bootstrap Access for a newly installed gateway.
      // Never repeat a write, and never forward a token across a redirect.
      const location = response.headers().location;
      if (authenticate && method === 'GET' && origin === managementOrigin &&
          [302, 303].includes(status) && location &&
          new URL(location, origin).hostname.endsWith('.cloudflareaccess.com')) {
        await installAccess(context, origin, { allowLogin: true });
        if (!authenticated.has(origin)) authenticated.set(origin, Date.now());
        await response.dispose(); response = null;
        return await request(origin, path, { method, body, csrfToken }, false);
      }
      if (authenticated.has(origin)) {
        // The gateway's application is minutes old right after an installation; a refusal of the fresh session there
        // is retried like any other rejected read until the window closes, and only the installer's is final at once.
        const outcome = rejectedSessionOutcome({ status, installedAt: origin === managementOrigin ? authenticated.get(origin) : undefined });
        if (outcome === 'retry') throw new LiveGatewayBrowserError('gateway_http_rejected', status);
        if (outcome === 'rejected') throw new LiveGatewayAccessError('access_session_rejected');
      }
      if (status !== 200) throw new LiveGatewayBrowserError('gateway_http_rejected', status);
      const bytes = await response.body();
      if (bytes.length > 512 * 1024) throw new LiveGatewayBrowserError('gateway_response_too_large');
      if (!response.headers()['content-type']?.includes('application/json')) {
        throw new LiveGatewayBrowserError('gateway_response_invalid');
      }
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error instanceof LiveGatewayBrowserError || error instanceof LiveGatewayAccessError) throw error;
      throw new LiveGatewayBrowserError('gateway_request_failed');
    } finally { await response?.dispose(); }
  }

  async function waitFor(read, accepts, { seconds = 600, instruction } = {}) {
    if (instruction) notify(instruction);
    const deadline = Date.now() + seconds * 1000;
    let lastNotice = '';
    while (Date.now() < deadline) {
      if (cancelled) throw new LiveGatewayBrowserError('validation_cancelled');
      if (interruptionError) throw interruptionError;
      try {
        const value = await read();
        if (accepts(value)) return value;
      } catch (error) {
        if (!(error instanceof LiveGatewayBrowserError) ||
            !['gateway_http_rejected', 'gateway_request_failed', 'gateway_response_invalid'].includes(error.code)) throw error;
        const notice = `Waiting for the test browser: ${error.code}${error.status === null ? '' : ` (${error.status})`}.`;
        if (notice !== lastNotice) { notify(notice); lastNotice = notice; }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new LiveGatewayBrowserError('interactive_step_timed_out');
  }

  return {
    request, navigate, waitFor,
    cancel() { cancelled = true; accessCancellation.abort(); },
    /** The tab's current landing in fixed labels; a closed tab lands nowhere. */
    landing() {
      let url;
      try { url = page.url(); } catch { url = ''; }
      return landingOf(url, { installerOrigin, managementOrigin });
    },
    async clearRemovalSession() {
      await context.clearCookies({ name: '__Host-ankka_gateway_teardown', domain: new URL(installerOrigin).hostname });
    },
    adoptBootstrap(provision) {
      const origin = validateLiveBootstrapOrigin(provision);
      if (!origins.includes(origin)) origins.push(origin);
      return origin;
    },
    async continueHandoff(value, kind) {
      const path = kind === 'teardown' ? '/__ankka/operation/teardown' : '/__ankka/operation';
      await navigate(validateLiveHandoff(value, managementOrigin, path));
      if (kind === 'teardown') {
        try { await page.getByRole('button', { name: 'Authorize removal in Cloudflare', exact: true }).click(); }
        catch { throw new LiveGatewayBrowserError('teardown_review_failed'); }
      }
      notify('Review and approve the test operation in Cloudflare. The runner will verify its recorded result.');
    },
    async continueBootstrap(value, provision) {
      const origin = validateLiveBootstrapOrigin(provision);
      if (!origins.includes(origin)) throw new LiveGatewayBrowserError('bootstrap_identity_invalid');
      await navigate(validateLiveHandoff(value, origin, '/__ankka/install'));
      return waitFor(() => request(origin, '/__ankka/install/setup'),
        (value) => Array.isArray(value.availableZones));
    },
    async login(origin) {
      if (!origins.includes(origin)) throw new LiveGatewayBrowserError('origin_invalid');
      await installAccess(context, origin);
      authenticated.set(origin, Date.now());
      await navigate(origin);
      return waitFor(() => request(origin, origin === installerOrigin ? '/api/session' : '/api/status'),
        (value) => value.schemaVersion === 1);
    },
    async consent(authorizationUrl, read, accepts, { holdOrigin, keepHold = false } = {}) {
      const url = new URL(authorizationUrl);
      if (url.origin !== 'https://dash.cloudflare.com' || url.pathname !== '/oauth2/auth') {
        throw new LiveGatewayBrowserError('authorization_url_invalid');
      }
      hold.origin = holdOrigin ?? null;
      try {
        await navigate(url.href);
        return await waitFor(read, accepts, { instruction: 'Review and approve the test operation in Cloudflare. The runner will continue after the callback.' });
      } finally {
        // A caller that keeps the hold (the hostname is not served yet) releases it itself.
        if (!keepHold) hold.origin = null;
      }
    },
    release() { hold.origin = null; },
    holdHandoff() { handoffHold.active = true; },
    releaseHandoff() { handoffHold.active = false; },
    async loseNextTeardownCallbackResponse() {
      if (interruptionArmed) throw new LiveGatewayBrowserError('interruption_already_armed');
      interruptionArmed = true;
      await page.route(isTeardownCallback, loseTeardownCallbackResponse);
    },
    interruptionObserved: () => interrupted,
    async close() {
      accessCancellation.abort();
      try {
        // A stop while a hosted callback is pending must not cut it: a borrowed tab is left to the operator, and an
        // owned browser waits for the callback to end, at most for the hosted attempt's own window.
        if (callbacks.inFlight() && borrowed) {
          notify('Test tab left open: a hosted callback is still in flight. Close it once the page has loaded.');
        } else {
          if (callbacks.inFlight()) {
            notify('A hosted callback is still in flight. The test browser closes once it has ended.');
            const deadline = Date.now() + CALLBACK_CLOSE_WAIT_MS;
            while (callbacks.inFlight() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          if (borrowed) await page.close(); else await context.close();
        }
      } finally { await browser?.close(); } // CDP close disconnects; it does not quit Chrome.
    },
  };
}
