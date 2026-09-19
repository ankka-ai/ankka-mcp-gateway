import { chromium } from 'playwright-core';
import * as v from 'valibot';
import { createLiveGatewayAccess, LiveGatewayAccessError } from './live-gateway-access.mjs';
import { LiveGatewayBrowserError, managementStepWord, validateLiveBootstrapOrigin, validateLiveBrowserOrigin } from './live-gateway-origin.mjs';

export { LiveGatewayBrowserError, NAVIGATION_FAILURES, validateLiveBootstrapOrigin, validateLiveBrowserOrigin } from './live-gateway-origin.mjs';

const API_PATH = /^\/api\/(?:session(?:\/new)?|selection|plan|cleanup|bootstrap(?:\/handoff)?|status|sources(?:\/discover)?|source-actions(?:\/action_[A-Za-z0-9_-]{32})?|team|team-actions(?:\/action_[A-Za-z0-9_-]{32})?|update|update-actions(?:\/action_[A-Za-z0-9_-]{32})?|teardown-actions(?:\/action_[A-Za-z0-9_-]{32})?|teardown(?:\/import|\/authorize)?)$/u;
const BOOTSTRAP_PATH = /^\/__ankka\/install\/(?:status|setup|configuration|oauth\/start)$/u;
/** The gateway removal page's own progress route, for the one attempt that page follows: a read, and the only
 * lifecycle path that carries a query. */
const REMOVAL_PROGRESS_PATH = /^\/__ankka\/operation\/teardown\/progress\?attempt=attempt_[A-Za-z0-9_-]{24}$/u;
const REMOVAL_ATTEMPT = /^attempt_[A-Za-z0-9_-]{24}$/u;
/** The management step of the customer's own setup page, the one lifecycle request that can carry the operator's
 * management token: a POST, and only to a shell on workers.dev, which is the customer's own Worker. Never to the
 * installer, which is hosted, and never to the installed gateway's management origin. */
const MANAGEMENT_STEP_PATH = '/__ankka/install/management-token';
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/** The shell's one word about the management step, from its answer to the step or from its public install status;
 * null for anything outside the fixed vocabulary, and for the final runtime's status, which carries no word. */
export function managementStepWordOf(answer) {
  return managementStepWord(answer?.managementCredential);
}

/**
 * Whether Playwright's debug output is switched on in this environment. `DEBUG` enables its `pw:` loggers, and
 * `pw:channel` prints every message the client sends to its driver, an API request's body included; `PWDEBUG` opens
 * its inspector over each call. Either would show the request that carries the management token, so the token is
 * never sent under them. Judged broadly on purpose: any non-empty `DEBUG`, and any `PWDEBUG` Playwright does not
 * read as off.
 */
export function browserDebugOutputEnabled(env = process.env) {
  const set = (value) => v.is(v.pipe(v.string(), v.minLength(1)), value);
  return set(env.DEBUG) || (set(env.PWDEBUG) && !['0', 'false'].includes(env.PWDEBUG));
}

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
/** How long the load that opens the installer's own connection ahead of a removal round may take; a round's consent
 * window is ten minutes, and a load that fails is tolerated. */
export const INSTALLER_CONNECTION_TIMEOUT_MS = 30_000;
/** The fixed reasons the runner replaces its test tab on purpose, as the journal records them: the interception has
 * spent itself on the lost callback, so what follows runs in a tab that never carried it. */
export const TAB_REPLACEMENT_REASONS = Object.freeze(['interruption_spent']);

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

/** A customer shell's origin by its form: the installer and the management hostname live in the operator's zone. */
function onWorkersDev(origin) {
  try { return new URL(origin).hostname.endsWith('.workers.dev'); } catch { return false; }
}

export function validateLiveBrowserRequest(origins, origin, path, method) {
  const lifecyclePath = API_PATH.test(path) || BOOTSTRAP_PATH.test(path) || (method === 'GET' && REMOVAL_PROGRESS_PATH.test(path)) ||
    (method === 'POST' && path === MANAGEMENT_STEP_PATH && onWorkersDev(origin));
  if (!origins.includes(origin) || !lifecyclePath || !METHODS.has(method)) {
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

const HOP_LABEL = /^[a-z0-9_-]{1,24}$/u;

/** What answered the browser's navigation to the installer's receipt page, in fixed fields only: the HTTP status, the
 * `server` label and Cloudflare's mitigation label when present. Tells an edge refusal from the application's. */
export function receiptHopOf(status, headers) {
  const word = (value) => v.is(v.string(), value) && HOP_LABEL.test(value.toLowerCase()) ? value.toLowerCase() : null;
  return { status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, server: word(headers?.server), mitigated: word(headers?.['cf-mitigated']) };
}

/** Whether an answer is the Access edge's redirect to its login: the request never reached the application. */
export function refusedAtAccessEdge(status, location, origin) {
  if (![302, 303].includes(status) || !v.is(v.string(), location)) return false;
  try { return new URL(location, origin).hostname.endsWith('.cloudflareaccess.com'); } catch { return false; }
}

const LANDING_WORD = /^[a-z_]{1,32}$/u;
const HOSTED_CALLBACK_PATH = /^\/(?:oauth\/callback|__ankka\/install\/oauth\/callback)$/u;

/** A hosted OAuth callback on one of the lifecycle's origins: it exchanges the consent and answers at once with the
 * page that follows the operation, which runs behind that page in the owning Durable Object. */
export function isHostedCallback(value, origins) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return origins.includes(url.origin) && HOSTED_CALLBACK_PATH.test(url.pathname);
}

/** Knows while a hosted callback's response is pending in the tab: a tab closed then can still cut the exchange before
 * the object holds the grant. Requests are tracked by identity; their URLs are never kept. */
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
 * page the `result` and `reason` words in its address (`removed` once its removal settled and it hops to the receipt
 * page, `recovery_required` with the reason word otherwise). Never the fragment, which carries handoffs, never the
 * attempt the page follows, and never a query value outside that vocabulary. */
export function landingOf(value, { installerOrigin, managementOrigin }) {
  let url;
  try { url = new URL(value); } catch { return { site: 'other', page: 'other', result: null, reason: null }; }
  // Chrome commits its own error page for a navigation it could not render, an empty error response among them; a
  // journal then shows an error page rather than an unknown site.
  if (url.protocol === 'chrome-error:') return { site: 'other', page: 'error', result: null, reason: null };
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

/** The attempt the gateway's removal page follows, from that page's own address; null for every other address. The
 * runner keeps it in memory for the one progress read that may need it: it is never journaled, printed or handed to
 * the lifecycle. */
export function removalAttemptOf(value, managementOrigin) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== managementOrigin || url.pathname !== '/__ankka/operation/teardown') return null;
  const attempt = url.searchParams.get('attempt');
  return attempt !== null && REMOVAL_ATTEMPT.test(attempt) ? attempt : null;
}

/** The signed receipt a settled attempt's progress hands to the removal page, decoded as the installer's receipt page
 * decodes it from the hop's fragment; null unless the attempt ended in `removed` with a link to exactly that page.
 * Only the receipt leaves: never the link, and never the attempt the progress names. */
export function recordedReceiptOf(progress, installerOrigin) {
  if (progress?.status !== 'settled' || progress.result !== 'removed') return null;
  try {
    const link = new URL(validateLiveHandoff(progress.handoffUrl, installerOrigin, '/teardown'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(link.hash.slice(1), 'base64url'));
  } catch { return null; }
}

/** An explicitly authorized Chrome connection borrows its context and owns only
 * a new tab. Never close that context or export browser storage, traces or HAR. The port starts no Playwright
 * tracing, HAR or video recording and takes no screenshot: the management step's request relies on that. */
export async function openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserProfile, browserConnection, headless = false, notify, checkpoint = async () => {}, browserType = chromium, accessFactory = createLiveGatewayAccess, env = process.env }) {
  const origins = [installerOrigin, managementOrigin].map(validateLiveBrowserOrigin);
  // The shells this run adopted, and the shell's last word about the management step: from its answer to the step,
  // then from its public install status as the customer's own progress page polls it while the install runs. The
  // runner adds no poll of its own, so it never keeps the shell's object awake where a customer's browser would not.
  const shells = new Set();
  let shellWord = null;
  async function noteManagementStep(response) {
    // A poll the page's next navigation cut short says nothing, and the final runtime's status carries no word.
    try { shellWord = managementStepWordOf(await response.json()) ?? shellWord; } catch { /* nothing read */ }
  }
  const accessCancellation = new AbortController();
  const installAccess = accessFactory({ origins, email: basics.adminEmail, notify, signal: accessCancellation.signal });
  // Origins whose Access session the runner installed, with the time of that install.
  const authenticated = new Map();
  if (browserConnection !== undefined && (browserConnection !== 'chrome' || browserProfile)) {
    throw new LiveGatewayBrowserError('browser_connection_invalid');
  }
  const borrowed = browserConnection === 'chrome';
  let browser = null;
  if (borrowed) {
    // Chrome refuses the attach with its remote debugging switched off, or when nobody allows the connection within
    // the wait. The stop names the fixed code and the operator's remedy; the error's text is never kept.
    try { browser = await browserType.connectOverCDP('chrome', { noDefaults: true, timeout: 120_000 }); }
    catch { throw new LiveGatewayBrowserError('browser_attach_failed'); }
  } else if (!browserProfile) browser = await browserType.launch({ channel: 'chrome', headless, chromiumSandbox: true });
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
  let lastReceiptHop = null;
  // What answered the last load of the installer ahead of a removal round, in the receipt hop's fixed fields.
  let lastInstallerLoad = null;
  // The attempt the gateway's removal page follows in the current round, from that page's own address. In memory only.
  let removalAttempt = null;
  let cancelled = false;
  // Once the gateway has removed the dependencies behind its removal page, that page hops to the installer's receipt
  // page with the signed receipt in its fragment. While armed, the hop is dropped at the browser, once: the receipt
  // stays with the gateway's recorded outcome, the installer never imports it, and only a fresh consent recovers it.
  // Never save the request, its address or the fragment.
  const isReceiptHop = (url) => url.origin === installerOrigin && url.pathname === '/teardown';
  async function loseTeardownReceiptHop(route) {
    if (interrupted || route.request().resourceType() !== 'document') { await route.continue(); return; }
    interrupted = true;
    await route.abort('failed');
  }

  /**
   * Everything the runner attaches to a tab, in one place so a replacement tab cannot drift from the first: the
   * default timeout, the callback tracker's listeners, the held-origin and handoff-hold routes, and the receipt-hop
   * interception while it is armed and not yet spent. Routes are matched in reverse registration order.
   */
  async function attach(tab) {
    tab.setDefaultTimeout(30_000);
    tab.on('request', (request) => callbacks.started(request));
    tab.on('requestfinished', (request) => callbacks.ended(request));
    tab.on('requestfailed', (request) => callbacks.ended(request));
    tab.on('response', (response) => {
      let url;
      try { url = new URL(response.url()); } catch { return; }
      if (shells.has(url.origin) && url.pathname === '/__ankka/install/status') { void noteManagementStep(response); return; }
      if (response.request().resourceType() !== 'document') return;
      if (url.origin === installerOrigin && url.pathname === '/teardown') lastReceiptHop = receiptHopOf(response.status(), response.headers());
      if (url.origin === installerOrigin && url.pathname === '/') lastInstallerLoad = receiptHopOf(response.status(), response.headers());
      // The consent lands on the gateway's removal page, whose address names the attempt it follows. Only the attempt
      // is kept, in memory: the address itself is never saved.
      removalAttempt = removalAttemptOf(url.href, managementOrigin) ?? removalAttempt;
    });
    await tab.route(heldOriginMatcher(hold), answerHeldOrigin);
    await tab.route(isHandoffPoll, answerHandoffPoll);
    if (interruptionArmed && !interrupted) await tab.route(isReceiptHop, loseTeardownReceiptHop);
  }
  let page = borrowed ? await context.newPage() : context.pages()[0] ?? await context.newPage();
  await attach(page);

  /**
   * A new tab in the same context takes the current one's place, with everything the runner attaches per tab (the
   * interception route only while it is still armed and not spent); the previous one is closed where the browser
   * still lets the runner, only ever the runner's own tab, and a discarded tab's placeholder stays with the operator.
   * What the previous tab still had in flight is forgotten: it can neither end nor be waited for.
   */
  async function replace() {
    const previous = page;
    let replacement;
    try {
      replacement = await context.newPage();
      await attach(replacement);
    } catch (error) { throw new LiveGatewayBrowserError('navigation_failed', null, navigationFailureOf(error)); }
    page = replacement;
    callbacks.reset();
    await previous.close().catch(() => {});
  }

  /**
   * A tab the browser discarded after minutes in the background (Chrome's Memory Saver) or whose renderer crashed
   * reads as a closed page. A replacement takes its place, recorded in the journal with the failure that caused it.
   */
  async function reopen(failure) {
    await replace();
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
      // Only a rejected read can bootstrap Access for a newly installed gateway, and a token is never forwarded across
      // a redirect. The Access edge's redirect to its login means the application never saw the request, so the same
      // request is sent once more after the session cookie is put back from the cached token: a browser can lose that
      // cookie while the token is still valid, for a read and a write alike.
      const location = response.headers().location;
      const known = authenticated.has(origin);
      if (authenticate && refusedAtAccessEdge(status, location, origin) && (known || (method === 'GET' && origin === managementOrigin))) {
        await installAccess(context, origin, { allowLogin: !known, force: known });
        if (known) notify(`Access session put back for the ${origin === installerOrigin ? 'isolated installer' : 'test gateway'}.`);
        else authenticated.set(origin, Date.now());
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
    /** The answer to the current removal round's navigation to the installer's receipt page, in fixed fields; null
     * before any. */
    receiptHop: () => lastReceiptHop,
    /**
     * Opens a connection of the installer's own ahead of a removal round, by loading the installer in the test tab.
     * In the isolated fixture the gateway's hostname and the installer's are in the same zone under one certificate,
     * so a browser that holds a live connection to the gateway reuses it for its request to the installer, and the
     * edge refuses a request whose TLS name differs from its Host with an empty 403 that never reaches the installer.
     * A browser that already holds a connection of the installer's own uses that one. This load can itself be reused
     * onto the gateway's connection and refused, so it never stops the run: the journal records whether the page
     * loaded and what answered, and a refused receipt hop is then recovered by API. The origin's root, never the
     * receipt page: a load of that page would spend an armed interception.
     */
    async openInstallerConnection() {
      lastInstallerLoad = null;
      let loaded = true;
      try { await page.goto(`${installerOrigin}/`, { waitUntil: 'commit', timeout: INSTALLER_CONNECTION_TIMEOUT_MS }); }
      catch { loaded = false; }
      const answer = lastInstallerLoad;
      // A refusal that carries a body commits like a page; only the answer's status tells it from a load.
      if ((answer?.status ?? 0) >= 400) loaded = false;
      await checkpoint({ stage: 'browser', status: 'installer_connection', loaded, answer });
      notify(loaded ? 'Active test tab: isolated installer, loaded ahead of the removal round.'
        : 'The isolated installer did not load ahead of the removal round. The run continues.');
    },
    /**
     * The signed receipt the gateway recorded for the attempt its removal page followed in this round, read from that
     * page's own progress route without the browser hop; null when the tab showed no attempt or the attempt did not
     * end in `removed`. The attempt stays in this module: it rides in this one request and nowhere else.
     */
    async recordedReceipt() {
      if (removalAttempt === null) return null;
      return recordedReceiptOf(await request(managementOrigin, `/__ankka/operation/teardown/progress?attempt=${removalAttempt}`), installerOrigin);
    },
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
      shells.add(origin);
      return origin;
    },
    /**
     * Answers the management step of the customer's own setup page as that page does: one same-origin POST to the
     * shell this run adopted, carrying the token ("Use this token") or, without a value, the choice to go on without
     * one ("Continue without a token"). The value rides in that request's body and nowhere else. It is never typed
     * into a page, so no DOM, screenshot or browser network log holds it; this port records no trace, HAR or video;
     * a refusal leaves as a fixed code with at most the HTTP status, never a body or the browser's error text; and
     * with Playwright's debug output switched on the token is not sent at all. The request is sent once: a shell's
     * origin never takes the Access retry, and an answer that never arrives stops the run like any other lost
     * write. Only the shell's fixed word leaves. Like the page, the port trims the value and sends no empty one; the
     * shell alone judges its form.
     */
    async answerManagementStep(provision, value = null) {
      const origin = validateLiveBootstrapOrigin(provision);
      if (!shells.has(origin)) throw new LiveGatewayBrowserError('bootstrap_identity_invalid');
      if (value !== null && browserDebugOutputEnabled(env)) throw new LiveGatewayBrowserError('browser_debug_output_enabled');
      if (value !== null && !v.is(v.pipe(v.string(), v.trim(), v.minLength(1)), value)) throw new LiveGatewayBrowserError('management_token_unavailable');
      const answer = await request(origin, MANAGEMENT_STEP_PATH, { method: 'POST', body: value === null ? { skip: true } : { managementToken: value.trim() } });
      const word = managementStepWordOf(answer);
      shellWord = word ?? shellWord;
      return word;
    },
    /** The shell's last word about the management step (`dropped` once it no longer holds a pasted value); null
     * before any. */
    managementStepWord: () => shellWord,
    async continueHandoff(value, kind) {
      const path = kind === 'teardown' ? '/__ankka/operation/teardown' : '/__ankka/operation';
      // A removal round's evidence is its own: the hop's answer and the attempt of an earlier round never count for it.
      if (kind === 'teardown') { lastReceiptHop = null; removalAttempt = null; }
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
    async loseNextTeardownReceiptHop() {
      if (interruptionArmed) throw new LiveGatewayBrowserError('interruption_already_armed');
      interruptionArmed = true;
      await page.route(isReceiptHop, loseTeardownReceiptHop);
    },
    interruptionObserved: () => interrupted,
    /**
     * Replaces the test tab on purpose, for one of the fixed reasons, and journals it: the rounds after the
     * interruption run in a tab that never carried the route, as they would in a fresh process. The replacement is
     * harmless, and it is not what the empty 403 on the receipt hop in recovery rounds needed: that refusal was first
     * attributed to the tab that had carried the interception, but its cause is the connection reuse described at
     * `openInstallerConnection`, which a fresh process escaped only because it had just loaded the installer and
     * still held a connection of the installer's own.
     */
    async replaceTab(reason) {
      if (!TAB_REPLACEMENT_REASONS.includes(reason)) throw new LiveGatewayBrowserError('tab_replacement_reason_invalid');
      await replace();
      await checkpoint({ stage: 'browser', status: 'tab_replaced', reason });
      notify('Test tab replaced: the run continues in a new tab. Leave the runner\'s tabs alone.');
    },
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
