import { chromium } from 'playwright-core';
import { createLiveGatewayAccess, LiveGatewayAccessError } from './live-gateway-access.mjs';
import { LiveGatewayBrowserError, validateLiveBootstrapOrigin, validateLiveBrowserOrigin } from './live-gateway-origin.mjs';

export { LiveGatewayBrowserError, validateLiveBootstrapOrigin, validateLiveBrowserOrigin } from './live-gateway-origin.mjs';

const API_PATH = /^\/api\/(?:session(?:\/new)?|selection|plan|cleanup|bootstrap(?:\/handoff)?|status|sources(?:\/discover)?|source-actions(?:\/action_[A-Za-z0-9_-]{32})?|team|team-actions(?:\/action_[A-Za-z0-9_-]{32})?|update|update-actions(?:\/action_[A-Za-z0-9_-]{32})?|teardown-actions(?:\/action_[A-Za-z0-9_-]{32})?|teardown(?:\/import|\/authorize)?)$/u;
const BOOTSTRAP_PATH = /^\/__ankka\/install\/(?:status|setup|configuration|oauth\/start)$/u;
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/**
 * A gateway action applies Portal and Access policy changes before it answers, and a Team write has taken more than
 * thirty seconds live. A write is never retried, so the runner waits for it as long as the API client does.
 */
export const BROWSER_REQUEST_TIMEOUT_MS = 120_000;

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

/** An explicitly authorized Chrome connection borrows its context and owns only
 * a new tab. Never close that context or export browser storage, traces or HAR. */
export async function openLiveGatewayBrowser({ installerOrigin, managementOrigin, basics, browserProfile, browserConnection, headless = false, notify }) {
  const origins = [installerOrigin, managementOrigin].map(validateLiveBrowserOrigin);
  const accessCancellation = new AbortController();
  const installAccess = createLiveGatewayAccess({ origins, email: basics.adminEmail, notify, signal: accessCancellation.signal });
  const authenticated = new Set();
  if (browserConnection !== undefined && (browserConnection !== 'chrome' || browserProfile)) {
    throw new LiveGatewayBrowserError('browser_connection_invalid');
  }
  const borrowed = browserConnection === 'chrome';
  const browser = borrowed ? await chromium.connectOverCDP('chrome', { noDefaults: true, timeout: 120_000 }) :
    browserProfile ? null : await chromium.launch({ channel: 'chrome', headless, chromiumSandbox: true });
  const context = borrowed ? browser.contexts()[0] : browserProfile
    ? await chromium.launchPersistentContext(browserProfile, {
      channel: 'chrome', headless, chromiumSandbox: true, acceptDownloads: false, serviceWorkers: 'block',
      // A manually authenticated Chrome profile uses the real OS keychain.
      // Mock/basic stores cannot decrypt that profile's existing login cookies.
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
    })
    : await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
  const page = borrowed ? await context.newPage() : context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(30_000);
  // A held origin is answered locally so the browser never resolves a hostname whose record may not exist yet. The
  // route stays installed for the page's life and consults the held origin per request: releasing the hold changes
  // the variable, not the routes, because an attached browser can refuse to remove a route without saying so.
  const hold = { origin: null };
  await page.route(heldOriginMatcher(hold), (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><title>Ankka lifecycle</title><p>Installation is finishing. The runner continues by API.</p>',
  }));
  let interrupted = false;
  let interruptionArmed = false;
  let interruptionError = null;
  let cancelled = false;

  async function navigate(url) {
    const target = new URL(url);
    const consent = target.origin === 'https://dash.cloudflare.com' && target.pathname === '/oauth2/auth';
    if ((!origins.includes(target.origin) && !consent) || target.username || target.password) {
      throw new LiveGatewayBrowserError('navigation_outside_lifecycle');
    }
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
    }
    catch { throw new LiveGatewayBrowserError('navigation_failed'); }
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
        authenticated.add(origin);
        await response.dispose(); response = null;
        return await request(origin, path, { method, body, csrfToken }, false);
      }
      if (authenticated.has(origin) && [302, 303, 401, 403].includes(status)) {
        throw new LiveGatewayAccessError('access_session_rejected');
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
      authenticated.add(origin);
      await navigate(origin);
      return waitFor(() => request(origin, origin === installerOrigin ? '/api/session' : '/api/status'),
        (value) => value.schemaVersion === 1);
    },
    async consent(authorizationUrl, read, accepts, { holdOrigin } = {}) {
      const url = new URL(authorizationUrl);
      if (url.origin !== 'https://dash.cloudflare.com' || url.pathname !== '/oauth2/auth') {
        throw new LiveGatewayBrowserError('authorization_url_invalid');
      }
      hold.origin = holdOrigin ?? null;
      try {
        await navigate(url.href);
        return await waitFor(read, accepts, { instruction: 'Review and approve the test operation in Cloudflare. The runner will continue after the callback.' });
      } finally {
        hold.origin = null;
      }
    },
    async loseNextTeardownCallbackResponse() {
      if (interruptionArmed) throw new LiveGatewayBrowserError('interruption_already_armed');
      interruptionArmed = true;
      await page.route((url) => url.origin === managementOrigin && url.pathname === '/__ankka/install/oauth/callback', async (route) => {
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
      });
    },
    interruptionObserved: () => interrupted,
    async close() {
      accessCancellation.abort();
      try { if (borrowed) await page.close(); else await context.close(); }
      finally { await browser?.close(); } // CDP close disconnects; it does not quit Chrome.
    },
  };
}
