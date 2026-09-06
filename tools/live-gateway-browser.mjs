import { chromium } from 'playwright-core';

const API_PATH = /^\/api\/(?:session(?:\/new)?|selection|plan|cleanup|bootstrap(?:\/handoff)?|status|sources(?:\/discover)?|source-actions(?:\/action_[A-Za-z0-9_-]{32})?|team|team-actions(?:\/action_[A-Za-z0-9_-]{32})?|update|update-actions(?:\/action_[A-Za-z0-9_-]{32})?|teardown-actions(?:\/action_[A-Za-z0-9_-]{32})?|teardown(?:\/import|\/authorize)?)$/u;
const BOOTSTRAP_PATH = /^\/__ankka\/install\/(?:status|setup|configuration|oauth\/start)$/u;
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

export class LiveGatewayBrowserError extends Error {
  constructor(code, status = null) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function validateLiveBrowserOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new LiveGatewayBrowserError('origin_invalid'); }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new LiveGatewayBrowserError('origin_invalid');
  }
  return url.origin;
}

export function validateLiveBrowserRequest(origins, origin, path, method) {
  if (!origins.includes(origin) || !(API_PATH.test(path) || BOOTSTRAP_PATH.test(path)) || !METHODS.has(method)) {
    throw new LiveGatewayBrowserError('request_outside_lifecycle');
  }
}

export function validateLiveBootstrapOrigin(provision) {
  if (!/^acg-[a-f0-9]{24}$/u.test(provision?.installId) ||
      provision.workerName !== `ankka-gateway-${provision.installId}`) {
    throw new LiveGatewayBrowserError('bootstrap_identity_invalid');
  }
  const origin = validateLiveBrowserOrigin(provision.bootstrapOrigin);
  const labels = new URL(origin).hostname.split('.');
  if (labels.length !== 4 || labels[0] !== provision.workerName ||
      !/^[a-z0-9-]{1,63}$/u.test(labels[1]) || labels.slice(2).join('.') !== 'workers.dev') {
    throw new LiveGatewayBrowserError('bootstrap_identity_invalid');
  }
  return origin;
}

export function validateLiveHandoff(value, origin, path) {
  let url;
  try { url = new URL(value); } catch { throw new LiveGatewayBrowserError('handoff_invalid'); }
  if (url.origin !== origin || url.pathname !== path || url.search || url.username || url.password ||
      !/^#[A-Za-z0-9_-]{40,65536}$/u.test(url.hash)) throw new LiveGatewayBrowserError('handoff_invalid');
  return url.href;
}

/** Own ephemeral browser. No CDP attachment, cookies exported, traces or HAR files. */
export async function openLiveGatewayBrowser({ installerOrigin, managementOrigin, browserProfile, notify }) {
  const origins = [installerOrigin, managementOrigin].map(validateLiveBrowserOrigin);
  const browser = browserProfile ? null : await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true });
  const context = browserProfile
    ? await chromium.launchPersistentContext(browserProfile, {
      channel: 'chrome', headless: false, chromiumSandbox: true, acceptDownloads: false, serviceWorkers: 'block',
      // A manually authenticated Chrome profile uses the real OS keychain.
      // Mock/basic stores cannot decrypt that profile's existing login cookies.
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
    })
    : await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(30_000);
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
      await page.goto(target.href, { waitUntil: 'domcontentloaded' });
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

  async function request(origin, path, { method = 'GET', body, csrfToken } = {}) {
    validateLiveBrowserRequest(origins, origin, path, method);
    let response;
    try {
      const options = {
        method, maxRedirects: 0, timeout: 30_000,
        headers: { origin, accept: 'application/json' },
      };
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json';
        options.data = JSON.stringify(body);
      }
      if (csrfToken !== undefined) options.headers['x-csrf-token'] = csrfToken;
      response = await context.request.fetch(origin + path, options);
      const status = response.status();
      if (status !== 200) throw new LiveGatewayBrowserError('gateway_http_rejected', status);
      const bytes = await response.body();
      if (bytes.length > 512 * 1024) throw new LiveGatewayBrowserError('gateway_response_too_large');
      if (!response.headers()['content-type']?.includes('application/json')) {
        throw new LiveGatewayBrowserError('gateway_response_invalid');
      }
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error instanceof LiveGatewayBrowserError) throw error;
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
    cancel() { cancelled = true; },
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
      await navigate(origin);
      return waitFor(() => request(origin, origin === installerOrigin ? '/api/session' : '/api/status'),
        (value) => value.schemaVersion === 1, { instruction: 'Complete login in the test browser if prompted.' });
    },
    async consent(authorizationUrl, read, accepts) {
      const url = new URL(authorizationUrl);
      if (url.origin !== 'https://dash.cloudflare.com' || url.pathname !== '/oauth2/auth') {
        throw new LiveGatewayBrowserError('authorization_url_invalid');
      }
      await navigate(url.href);
      return waitFor(read, accepts, { instruction: 'Review and approve the test operation in Cloudflare. The runner will continue after the callback.' });
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
    async close() { await context.close(); await browser?.close(); },
  };
}
