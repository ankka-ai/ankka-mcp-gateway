'use strict';

const ROUTES = new Set(['/', '/gateway', '/review', '/deploy', '/result']);
const STEP_ROUTES = Object.freeze(['/', '/review', '/deploy', '/result']);
const CUSTOMER_INSTALL_PATH = '/__ankka/install';
const HANDOFF_POLL_MS = 3000;
const HANDOFF_POLL_MAX_MS = 15000;
const BROWSER_READINESS_TIMEOUT_MS = 5000;
const BROWSER_READINESS_MAX_BYTES = 8192;

const state = {
  session: null,
  csrf: null,
  now: 0,
  clockOffset: 0,
  route: ROUTES.has(window.location.pathname) ? window.location.pathname : '/',
  busy: false,
  authorizationUrl: null,
  authorizationExpiresAt: null,
  authorizationKind: null,
  handoffUrl: null,
  handoffTimer: null,
  handoffController: null,
  handoffFailed: false,
  agentToolsRegistered: false,
  agentToolsController: null,
  agentToolsRegistration: null,
  agentPageActive: true,
};

const byId = (id) => document.getElementById(id);
const notice = byId('live-notice');
const OBJECT_TAG = Object.prototype.toString;
const FUNCTION_SOURCE = Function.prototype.toString;

function isText(value) {
  return Object(value) !== value && OBJECT_TAG.call(value) === '[object String]';
}

function isCallable(value) {
  try {
    FUNCTION_SOURCE.call(value);
    return true;
  } catch {
    return false;
  }
}

function text(value) {
  return isText(value) ? value : '';
}

const SELECTION_ERROR_MESSAGES = Object.freeze({
  active_zone_required: 'Your Cloudflare account needs an active domain before you can install a gateway.',
  zone_discovery_rejected: 'Cloudflare did not allow domain discovery. Check that you approved domain read access for the selected account.',
  zone_discovery_limit: 'This setup supports accounts with up to 100 active domains. Use the source deployment flow for larger accounts.',
  account_worker_subdomain_create_rejected: 'Cloudflare could not register your Workers subdomain. Try again, or register one in Workers & Pages.',
  selection_contract_invalid: 'The setup form is incomplete. Check every field.',
  gateway_name_invalid: 'Enter a gateway name between 2 and 80 letters, numbers, spaces, or hyphens.',
  admin_email_invalid: 'Enter a valid administrator email.',
  additional_admin_emails_invalid: 'Enter valid additional administrator emails.',
  zone_name_invalid: 'Enter the storefront domain you host on Cloudflare, such as example.com.',
  management_hostname_invalid: 'Enter a valid management hostname beneath your domain.',
  portal_hostname_invalid: 'Enter a valid portal hostname beneath your domain.',
  gateway_hostnames_invalid: 'Use two different hostnames beneath the storefront domain.',
});

const API_ERROR_MESSAGES = Object.freeze({
  rate_limited: 'This installer is receiving too many requests. Wait one minute, then retry.',
  abuse_controls_unavailable: 'The installer request protection is temporarily unavailable. Wait and retry; no Cloudflare change was attempted.',
  session_conflict: 'This step no longer matches the saved setup. Reload the page to continue from the current step.',
  session_expired: 'The setup session expired. Reload the page to start a fresh approval.',
  session_invalid: 'The setup session could not be validated. Reload the page before continuing.',
  csrf_invalid: 'The page is out of date. Reload it before continuing.',
  origin_invalid: 'The request did not come from this installer page. Reload it before continuing.',
  bad_request: 'The installer rejected the request. Check the form and try again.',
  release_unavailable: 'The signed gateway release is not available right now. Try again in a few minutes.',
  release_invalid: 'The signed gateway release could not be verified. Try again later.',
  callback_invalid: 'Cloudflare returned an incomplete approval. Start a fresh approval in this browser.',
  bootstrap_failed: 'Your Gateway did not answer with the expected identity, so the incomplete install must be removed before retrying.',
  internal_error: 'The installer encountered an internal error.',
});

const FAILURE_MESSAGES = Object.freeze({
  attempt_expired: 'The Cloudflare approval window closed before it was completed.',
  authorization_rejected: 'The Cloudflare approval was declined.',
  callback_invalid: 'Cloudflare returned an approval that did not match this browser session.',
  cleanup_failed: 'The removal of the incomplete install could not be completed.',
  grant_invalid: 'Cloudflare granted permissions different from those requested, or more than one account was selected.',
  provision_failed: 'The Gateway shell could not be installed with the temporary permission.',
  revocation_unconfirmed: 'The temporary permission could not be confirmed as revoked. Check Cloudflare Connected Applications before retrying.',
  session_expired: 'The setup session expired.',
});

const LOCAL_AGENT_ERRORS = Object.freeze({
  invalid_arguments: 'The tool arguments do not match its declared input schema.',
  action_unavailable: 'This action is not available in the current setup step.',
  page_inactive: 'This installer page is no longer active. Reopen it before continuing.',
  action_cancelled: 'The action was cancelled before it started.',
  installer_busy: 'Another installer action is still running.',
  plan_unavailable: 'Describe the gateway and create the review plan first.',
});

const AGENT_API_ERROR_CODES = new Set([
  ...Object.keys(API_ERROR_MESSAGES),
  'bootstrap_not_ready', 'install_mutations_disabled',
]);

class ApiError extends Error {
  constructor(status, payload) {
    super('request_failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = isText(payload?.code) ? payload.code : 'internal_error';
    this.reason = isText(payload?.reason) ? payload.reason : null;
    this.payload = payload;
  }
}

function showNotice(message, tone = 'neutral') {
  notice.textContent = message;
  notice.classList.toggle('notice-error', tone === 'error');
  notice.classList.toggle('notice-success', tone === 'success');
  notice.hidden = message.length === 0;
}

function setBusy(value) {
  state.busy = value;
  for (const button of document.querySelectorAll('button')) button.disabled = value;
}

async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') {
    if (!state.csrf) throw new ApiError(401, { code: 'session_invalid' });
    headers['x-csrf-token'] = state.csrf;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = { method, headers, credentials: 'same-origin', redirect: 'error' };
  if (body !== undefined) request.body = JSON.stringify(body);
  if (signal) request.signal = signal;
  const response = await fetch(path, request);
  let payload = null;
  try { payload = await response.json(); } catch { /* The fixed UI error is enough. */ }
  if (!response.ok) throw new ApiError(response.status, payload);
  if (!payload || payload.schemaVersion !== 1) throw new ApiError(502, null);
  if (isText(payload.csrfToken)) state.csrf = payload.csrfToken;
  if (Number.isSafeInteger(payload.now)) {
    state.now = payload.now;
    state.clockOffset = payload.now - Date.now();
  }
  if (payload.session && isText(payload.session.phase)) state.session = payload.session;
  return payload;
}

function apiErrorMessage(error, fallback) {
  if (!(error instanceof ApiError)) return fallback;
  if (error.reason && Object.hasOwn(SELECTION_ERROR_MESSAGES, error.reason)) {
    return SELECTION_ERROR_MESSAGES[error.reason];
  }
  return API_ERROR_MESSAGES[error.code] ?? `${fallback} Diagnostic: ${text(error.code) || 'internal_error'}.`;
}

function agentError(error) {
  if (error instanceof ApiError) {
    const code = AGENT_API_ERROR_CODES.has(error.code) ? error.code : 'internal_error';
    const reason = Object.hasOwn(SELECTION_ERROR_MESSAGES, error.reason ?? '') ? error.reason : null;
    return {
      code,
      reason,
      message: reason ? SELECTION_ERROR_MESSAGES[reason] : (API_ERROR_MESSAGES[code] ?? 'The installer request was rejected.'),
      retryable: error.code === 'rate_limited' || error.code === 'bootstrap_not_ready' || error.status >= 500,
    };
  }
  const code = error instanceof Error && Object.hasOwn(LOCAL_AGENT_ERRORS, error.message)
    ? error.message
    : 'internal_error';
  return {
    code,
    reason: null,
    message: LOCAL_AGENT_ERRORS[code] ?? 'The installer action could not complete.',
    retryable: code === 'installer_busy',
  };
}

function route(path, replace = false) {
  const target = ROUTES.has(path) ? path : '/';
  if (replace) window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  state.route = target;
  render();
  byId('main').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function clearChildren(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function summaryRows(container, rows) {
  clearChildren(container);
  for (const [label, value] of rows) {
    if (!value) continue;
    const row = document.createElement('div');
    row.className = 'summary-row';
    const key = document.createElement('span');
    key.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    row.append(key, strong);
    container.append(row);
  }
  container.hidden = container.childElementCount === 0;
}

function formatWhen(timestamp) {
  if (!Number.isSafeInteger(timestamp)) return '';
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function minutesLeft(timestamp) {
  if (!Number.isSafeInteger(timestamp)) return 0;
  return Math.max(0, Math.ceil((timestamp - (state.now || Date.now())) / 60000));
}

function validAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://dash.cloudflare.com' && !url.username && !url.password && !url.port &&
      url.pathname === '/oauth2/auth'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function validHandoffUrl(value, bootstrapOrigin) {
  try {
    const url = new URL(value);
    const expected = new URL(bootstrapOrigin);
    return url.protocol === 'https:' && url.origin === expected.origin &&
      !url.username && !url.password && !url.port &&
      url.pathname === CUSTOMER_INSTALL_PATH && url.search === '' &&
      /^#[A-Za-z0-9_-]{40,65536}$/u.test(url.hash)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function session() {
  return state.session;
}

function phase() {
  return session()?.phase ?? 'draft';
}

function selectionBasics() {
  return session()?.selection?.basics ?? null;
}

function planSummary() {
  return session()?.plan ?? null;
}

function provisionSummary() {
  return session()?.provision ?? null;
}

async function loadSession() {
  await api('/api/session');
  state.handoffFailed = false;
}

async function beginAuthorization(kind) {
  const path = kind === 'cleanup' ? '/api/cleanup' : '/api/bootstrap';
  const result = await api(path, { method: 'POST', body: {} });
  const url = validAuthorizationUrl(result.authorizationUrl);
  if (!url) throw new ApiError(502, { code: 'internal_error' });
  state.authorizationUrl = url;
  state.authorizationExpiresAt = Number.isSafeInteger(result.expiresAt) ? result.expiresAt : null;
  state.authorizationKind = kind;
  return { authorizationUrl: url, expiresAt: state.authorizationExpiresAt };
}

function stopHandoffPolling() {
  if (state.handoffTimer !== null) {
    window.clearTimeout(state.handoffTimer);
    state.handoffTimer = null;
  }
  state.handoffController?.abort();
  state.handoffController = null;
}

function checkHandoffExpiry(provision) {
  if (!Number.isSafeInteger(provision?.capabilityExpiresAt) ||
      Date.now() + state.clockOffset >= provision.capabilityExpiresAt) {
    throw new ApiError(410, { code: 'session_expired' });
  }
}

function browserReadinessUrl(provision) {
  try {
    const url = new URL(provision.bootstrapOrigin);
    const labels = url.hostname.split('.');
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash || labels.length !== 4 ||
        labels[0] !== provision.workerName || !/^[a-z0-9-]{1,63}$/u.test(labels[1]) ||
        labels.slice(2).join('.') !== 'workers.dev') return null;
    return new URL(CUSTOMER_INSTALL_PATH + '/status', url).href;
  } catch {
    return null;
  }
}

// A Cloudflare-to-Cloudflare read can succeed before this browser can establish
// TLS. Probe the exact public Worker first, while the one-time handoff is still
// safely retained by the installer. No cookie, grant, or fragment goes here.
async function checkBrowserReadiness(provision, releaseId, signal) {
  const url = browserReadinessUrl(provision);
  if (!url || !isText(releaseId)) throw new ApiError(502, { code: 'internal_error' });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = window.setTimeout(abort, BROWSER_READINESS_TIMEOUT_MS);
  let reader;
  try {
    const response = await fetch(url, {
      method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
      cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    if (response.status !== 200 || !response.body) throw new ApiError(503, { code: 'bootstrap_not_ready' });
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '', size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > BROWSER_READINESS_MAX_BYTES) throw new ApiError(502, { code: 'bootstrap_failed' });
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    let value;
    try { value = JSON.parse(body); } catch { throw new ApiError(503, { code: 'bootstrap_not_ready' }); }
    if (value?.schemaVersion !== 1 || value.role !== 'customer-gateway-bootstrap' ||
        value.status !== 'INCOMPLETE' || value.installId !== provision.installId ||
        value.release !== releaseId || !/^[A-Za-z0-9_-]{43}$/u.test(text(value.ownershipPublicKey)) ||
        (value.failure !== undefined && value.failure !== null)) {
      throw new ApiError(502, { code: 'bootstrap_failed' });
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, { code: 'bootstrap_not_ready' });
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
    await reader?.cancel().catch(() => { /* The response may already be closed. */ });
  }
}

async function pollHandoff(delayMs = 0) {
  if (state.handoffController !== null) return;
  stopHandoffPolling();
  if (phase() !== 'provisioned' || state.route !== '/result' || !state.agentPageActive) return;
  state.handoffTimer = window.setTimeout(async () => {
    state.handoffTimer = null;
    const controller = new AbortController();
    state.handoffController = controller;
    let retryAfter = null;
    try {
      const provision = provisionSummary();
      checkHandoffExpiry(provision);
      await checkBrowserReadiness(provision, planSummary()?.releaseId, controller.signal);
      if (controller.signal.aborted) return;
      checkHandoffExpiry(provision);
      const result = await api('/api/bootstrap/handoff', { signal: controller.signal });
      if (controller.signal.aborted) return;
      const handoff = validHandoffUrl(result.handoffUrl, provision.bootstrapOrigin);
      if (!handoff) throw new ApiError(502, { code: 'internal_error' });
      state.handoffUrl = handoff;
      await loadSession().catch(() => { /* The handoff itself succeeded. */ });
      if (controller.signal.aborted) return;
      render();
      window.location.assign(handoff);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === 'bootstrap_not_ready') {
        retryAfter = Number.isSafeInteger(error.payload?.retryAfterMs)
          ? Math.min(HANDOFF_POLL_MAX_MS, Math.max(HANDOFF_POLL_MS, error.payload.retryAfterMs))
          : HANDOFF_POLL_MS;
        renderResult();
      } else {
        await loadSession().catch(() => { /* The failure below is still shown. */ });
        if (controller.signal.aborted) return;
        state.handoffFailed = true;
        showNotice(apiErrorMessage(error, 'Finishing secure setup did not complete.'), 'error');
        render();
      }
    } finally {
      if (state.handoffController === controller) state.handoffController = null;
    }
    if (retryAfter !== null) await pollHandoff(retryAfter);
  }, delayMs);
}

function renderSteps() {
  const current = state.route === '/gateway' ? '/' : state.route;
  for (const link of document.querySelectorAll('.steps a[data-route-link]')) {
    const target = link.dataset.routeLink;
    const index = STEP_ROUTES.indexOf(target);
    const currentIndex = STEP_ROUTES.indexOf(current);
    link.classList.toggle('is-current', target === current);
    link.classList.toggle('is-complete', index !== -1 && index < currentIndex);
    if (target === current) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  }
}

function renderWelcome() {
  byId('save-gateway').textContent = 'Deploy to Cloudflare';
}

function renderReview() {
  const basics = selectionBasics();
  const plan = planSummary();
  summaryRows(byId('review-summary'), [
    ['Gateway name', basics?.gatewayName],
    ['Storefront domain', basics?.zoneName],
    ['Management page', basics?.managementHostname],
    ['MCP portal', basics?.portalHostname],
    ['Administrator', basics?.adminEmail],
    ['Signed release', plan?.releaseId],
  ]);
  const expiry = byId('plan-expiry');
  expiry.textContent = plan
    ? `Plan valid until ${formatWhen(plan.expiresAt)}. Refreshes automatically.`
    : 'Prepare your initial Gateway deployment to continue.';
  byId('connect-cloudflare').hidden = !plan;
  byId('review-missing').hidden = Boolean(plan);
}

function renderDeploy() {
  const link = byId('authorization-link');
  const handoff = byId('authorization-handoff');
  const url = state.authorizationUrl;
  if (url) {
    link.href = url;
    link.hidden = false;
    handoff.hidden = false;
  } else {
    link.removeAttribute('href');
    link.hidden = true;
    handoff.hidden = true;
  }
  const expiresAt = state.authorizationExpiresAt ?? session()?.attempt?.expiresAt ?? null;
  byId('approval-expiry').textContent = expiresAt
    ? `This approval link is valid for about ${minutesLeft(expiresAt)} minutes (until ${formatWhen(expiresAt)}). If it lapses, start a fresh approval; nothing is left behind.`
    : '';
  byId('deploy-title').textContent = state.authorizationKind === 'cleanup'
    ? 'Approve the removal in Cloudflare'
    : 'Continue in Cloudflare';
  byId('deploy-lede').textContent = state.authorizationKind === 'cleanup'
    ? 'Cloudflare will ask for one temporary permission to edit Workers. Ankka uses it once to remove exactly the incomplete Gateway shell it installed earlier, then revokes it.'
    : 'Approve Workers editing and domain reading for one account. Access is revoked after deployment.';
}

function renderResult() {
  const current = phase();
  const provision = provisionSummary();
  const basics = selectionBasics();
  const failure = session()?.failure ?? null;
  const cleanup = session()?.cleanup ?? null;
  const title = byId('result-title');
  const intro = byId('result-intro');
  const detail = byId('result-detail');
  const stage = byId('operation-stage');
  const finish = byId('finish-setup');
  const fresh = byId('fresh-approval');
  const beginCleanup = byId('begin-cleanup');
  const gatewayLink = byId('continue-gateway');
  const cleanupLink = byId('cleanup-link');
  const describe = byId('describe-again');
  for (const element of [finish, fresh, beginCleanup, gatewayLink, cleanupLink, describe, stage]) element.hidden = true;
  summaryRows(byId('result-summary'), [
    ['Gateway name', basics?.gatewayName],
    ['Installed in account', provision ? 'Your Cloudflare account' : ''],
    ['Gateway shell', provision?.workerName],
    ['Management page', basics?.managementHostname],
  ]);
  byId('result-eyebrow').textContent = 'Installation status';
  switch (current) {
    case 'provisioned': {
      title.textContent = 'Ankka Gateway installed';
      intro.textContent = 'The first temporary permission was revoked. Your Gateway is starting inside your Cloudflare account.';
      stage.hidden = false;
      byId('operation-title').textContent = state.handoffUrl ? 'Ready to finish secure setup' : 'Waiting for your secure Gateway address';
      byId('operation-detail').textContent = state.handoffUrl
        ? 'Continue to your Gateway. It will ask Cloudflare for the second temporary approval so it can finish its own setup.'
        : `Cloudflare is preparing your new address. This browser checks its secure connection every few seconds and continues automatically when it is ready. Your setup link stays valid until ${formatWhen(provision?.capabilityExpiresAt)}.`;
      detail.textContent = 'Keep this browser open. The handoff is released only to this browser, and only once.';
      if (state.handoffUrl) {
        finish.hidden = false;
      }
      break;
    }
    case 'handed_off': {
      title.textContent = 'Setup continues on your Gateway';
      intro.textContent = 'The one-time handoff was released to your Gateway in this browser. The second approval and the rest of the setup happen there, inside your Cloudflare account.';
      detail.textContent = 'If you closed that tab, open your Gateway to continue. This installer holds no Cloudflare permission and nothing else to hand over.';
      if (provision?.bootstrapOrigin) {
        gatewayLink.href = provision.bootstrapOrigin;
        gatewayLink.hidden = false;
      }
      describe.hidden = false;
      break;
    }
    case 'failed': {
      title.textContent = 'The approval did not complete';
      intro.textContent = FAILURE_MESSAGES[failure?.code] ?? 'The Cloudflare approval did not complete.';
      const reason = isText(failure?.reason) && /^[a-z][a-z0-9_]{0,159}$/u.test(failure.reason)
        ? ` Reference: ${failure.reason}.` : '';
      detail.textContent = (failure?.code === 'provision_failed'
        ? 'Setup stopped. Review the failure reference and any incomplete gateway in Cloudflare before starting a fresh approval.'
        : 'The same setup is kept. Start a fresh approval when you are ready.') + reason;
      fresh.hidden = !planSummary();
      describe.hidden = false;
      break;
    }
    case 'cleanup_required': {
      title.textContent = 'Remove the incomplete install first';
      intro.textContent = cleanup?.reason === 'handoff_rejected'
        ? 'Your Gateway shell did not answer with the identity Ankka recorded, so it must be removed before a new attempt.'
        : 'The one-time handoff to your Gateway was lost before setup finished, so the incomplete Gateway shell must be removed before a new attempt.';
      detail.textContent = 'Cloudflare will ask once more for the single temporary permission. Ankka removes exactly the shell it recorded, verifies it is gone, and revokes the permission. Nothing else in your account is touched.';
      if (state.authorizationUrl && state.authorizationKind === 'cleanup') {
        cleanupLink.href = state.authorizationUrl;
        cleanupLink.hidden = false;
      } else {
        beginCleanup.hidden = false;
      }
      if (failure?.code === 'cleanup_failed') {
        detail.textContent = `${FAILURE_MESSAGES.cleanup_failed} You can approve the removal again.`;
      }
      break;
    }
    case 'authorizing': {
      title.textContent = 'Approval still pending';
      intro.textContent = 'Cloudflare has not returned an approval for this browser yet.';
      detail.textContent = 'Finish the approval in the Cloudflare tab, or start a fresh approval here.';
      fresh.hidden = false;
      break;
    }
    default: {
      title.textContent = 'Nothing to finish yet';
      intro.textContent = 'Describe your gateway and connect Cloudflare to install it.';
      detail.textContent = '';
      describe.hidden = false;
    }
  }
  byId('result-actions').hidden = [finish, fresh, beginCleanup, gatewayLink, cleanupLink, describe].every((element) => element.hidden);
}

function render() {
  const current = state.route === '/gateway' ? '/' : state.route;
  for (const panel of document.querySelectorAll('[data-route]')) {
    panel.hidden = panel.dataset.route !== current;
  }
  renderSteps();
  if (current === '/') renderWelcome();
  if (current === '/review') renderReview();
  if (current === '/deploy') renderDeploy();
  if (current === '/result') renderResult();
  if (current === '/result' && phase() === 'provisioned' && state.handoffUrl === null && !state.handoffFailed) void pollHandoff();
  else if (current !== '/result') stopHandoffPolling();
}

function initialRoute() {
  const current = phase();
  if (current === 'provisioned' || current === 'handed_off' || current === 'failed' || current === 'cleanup_required') {
    return '/result';
  }
  if (current === 'authorizing') return state.route === '/result' ? '/result' : '/deploy';
  if (state.route === '/review' && !planSummary()) return '/';
  if (state.route === '/deploy' || state.route === '/result') return planSummary() ? '/review' : '/';
  return state.route;
}

async function runAction(pending, action, fallback) {
  if (state.busy) throw new Error('installer_busy');
  setBusy(true);
  showNotice(pending);
  try {
    const result = await action();
    showNotice('');
    return result;
  } catch (error) {
    showNotice(apiErrorMessage(error, fallback), 'error');
    throw error;
  } finally {
    setBusy(false);
  }
}

byId('gateway-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void startApproval('bootstrap');
});

async function startApproval(kind) {
  try {
    const prepared = await runAction('Creating your Cloudflare approval link…', () => beginAuthorization(kind),
      'The Cloudflare approval could not be started.');
    if (kind === 'cleanup') render();
    else route('/deploy');
    window.location.assign(prepared.authorizationUrl);
  } catch { /* The notice already explains the failure. */ }
}

byId('connect-cloudflare').addEventListener('click', () => { void startApproval('bootstrap'); });
byId('fresh-approval').addEventListener('click', () => { void startApproval('bootstrap'); });
byId('restart-approval').addEventListener('click', () => { void startApproval('bootstrap'); });
byId('begin-cleanup').addEventListener('click', () => { void startApproval('cleanup'); });
byId('describe-again').addEventListener('click', async () => {
  try {
    await runAction('Starting a new deployment…', () => api('/api/session/new', { method: 'POST', body: {} }),
      'A new deployment could not be started.');
    state.authorizationUrl = null;
    state.authorizationExpiresAt = null;
    state.authorizationKind = null;
    state.handoffUrl = null;
    state.handoffFailed = false;
    route('/');
  } catch { /* Keep the current session visible when restarting is rejected. */ }
});
byId('finish-setup').addEventListener('click', () => {
  if (state.handoffUrl) window.location.assign(state.handoffUrl);
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-route-link], [data-go]');
  if (!target || state.busy) return;
  const path = target.dataset.routeLink ?? target.dataset.go;
  if (!ROUTES.has(path)) return;
  event.preventDefault();
  route(path);
});

window.addEventListener('popstate', () => {
  state.route = ROUTES.has(window.location.pathname) ? window.location.pathname : '/';
  render();
});

function validAgentInput(schema, input) {
  if (input === undefined || input === null) return Object.keys(schema.properties).length === 0 || !(schema.required ?? []).length;
  if (Object(input) !== input || Array.isArray(input)) return false;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.properties, key)) return false;
    const rule = schema.properties[key];
    const value = input[key];
    if (rule.type === 'string') {
      if (!isText(value) || value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? Infinity)) return false;
    } else {
      return false;
    }
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(input, key)) return false;
  }
  return true;
}

function publicStatus() {
  const current = session();
  return {
    phase: phase(),
    gateway: selectionBasics() ? {
      gatewayName: selectionBasics().gatewayName,
      zoneName: selectionBasics().zoneName,
      managementHostname: selectionBasics().managementHostname,
      portalHostname: selectionBasics().portalHostname,
      adminEmail: selectionBasics().adminEmail,
    } : null,
    plan: planSummary() ? { planId: planSummary().planId, releaseId: planSummary().releaseId, expiresAt: planSummary().expiresAt } : null,
    installed: provisionSummary() ? {
      workerName: provisionSummary().workerName,
      gatewayOrigin: provisionSummary().bootstrapOrigin,
      handoffExpiresAt: provisionSummary().capabilityExpiresAt,
    } : null,
    failure: current?.failure?.code ?? null,
    cleanup: current?.cleanup ? { reason: current.cleanup.reason, completed: current.cleanup.completedAt !== null } : null,
    approvals: {
      first: 'Temporary Cloudflare permissions to edit Workers and read domains, used for the initial setup, then revoked.',
      second: 'Requested by your own Gateway to finish its setup; never held by Ankka.',
    },
  };
}

async function runAgentAction(pending, action) {
  if (!state.agentPageActive) throw new Error('page_inactive');
  const result = await runAction(pending, action, 'The installer action could not complete.');
  return JSON.stringify({ ok: true, ...result });
}

function unregisterAgentTools() {
  state.agentToolsController?.abort();
  state.agentToolsController = null;
  state.agentToolsRegistered = false;
}

async function registerAgentTools() {
  const modelContext = document.modelContext;
  if (!state.agentPageActive || state.agentToolsRegistered || !modelContext || !isCallable(modelContext.registerTool)) return;
  if (state.agentToolsRegistration) {
    await state.agentToolsRegistration;
    if (state.agentPageActive && !state.agentToolsRegistered) return registerAgentTools();
    return;
  }
  const controller = new AbortController();
  state.agentToolsController = controller;
  const tools = [
    {
      name: 'get_installer_status',
      description: 'Read the current Ankka MCP Gateway setup step: the initial deployment, its release plan, the installed Gateway shell, and any failure or pending removal. Performs no writes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, untrustedContentHint: false },
      execute: async () => {
        await loadSession();
        render();
        return JSON.stringify({ ok: true, status: publicStatus() });
      },
    },
    {
      name: 'prepare_deployment',
      description: 'Prepare a deployment of the initial Gateway Worker. Gateway name, domain selection, and administrators are configured later inside the Worker. Performs no Cloudflare writes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, untrustedContentHint: false },
      execute: async () => runAgentAction('Preparing your Gateway deployment…', async () => {
        await api('/api/plan', { method: 'POST', body: {} });
        route('/review', true);
        return { status: publicStatus() };
      }),
    },
    {
      name: 'begin_authorization',
      description: 'Create the first Cloudflare approval link: temporary permissions to edit Workers and read available domains, used for the initial deployment and then revoked. Return the link to the user; do not open or approve it for them.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, untrustedContentHint: false },
      execute: async () => runAgentAction('Creating your Cloudflare approval link…', async () => {
        const prepared = await beginAuthorization('bootstrap');
        route('/deploy', true);
        return {
          status: 'user_authorization_required',
          authorizationUrl: prepared.authorizationUrl,
          expiresAt: prepared.expiresAt,
          instruction: 'Send authorizationUrl to the user. After they approve in Cloudflare, poll get_installer_status until phase is provisioned, then call finish_secure_setup in this browser.',
        };
      }),
    },
    {
      name: 'finish_secure_setup',
      description: 'After the Gateway shell is installed, check whether it is ready and, if so, continue this browser to the Gateway for the second approval. The one-time handoff is never returned to the caller.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, untrustedContentHint: false },
      execute: async () => runAgentAction('Checking whether your Gateway is ready…', async () => {
        await loadSession();
        if (phase() !== 'provisioned') throw new Error('action_unavailable');
        route('/result', true);
        await pollHandoff();
        return { status: 'checking', instruction: 'The browser continues to the Gateway automatically once it answers.' };
      }),
    },
    {
      name: 'begin_cleanup',
      description: 'When an incomplete Gateway shell must be removed, create the Cloudflare approval link for the single temporary permission that removes exactly the recorded shell. Return the link to the user; do not open or approve it for them.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, untrustedContentHint: false },
      execute: async () => runAgentAction('Creating your Cloudflare removal link…', async () => {
        await loadSession();
        if (phase() !== 'cleanup_required') throw new Error('action_unavailable');
        const prepared = await beginAuthorization('cleanup');
        route('/result', true);
        return {
          status: 'user_authorization_required',
          authorizationUrl: prepared.authorizationUrl,
          expiresAt: prepared.expiresAt,
          instruction: 'Send authorizationUrl to the user. After they approve, poll get_installer_status until phase returns to draft.',
        };
      }),
    },
  ];
  const registration = (async () => {
    try {
      for (const tool of tools) {
        if (controller.signal.aborted) return;
        await modelContext.registerTool({
          ...tool,
          execute: async (input, options = {}) => {
            try {
              if (controller.signal.aborted) throw new Error('page_inactive');
              if (options.signal?.aborted) throw new Error('action_cancelled');
              if (!validAgentInput(tool.inputSchema, input)) throw new Error('invalid_arguments');
              return await tool.execute(input ?? {});
            } catch (error) {
              return JSON.stringify({ ok: false, error: agentError(error) });
            }
          },
        }, { signal: controller.signal });
      }
      if (!controller.signal.aborted) state.agentToolsRegistered = true;
    } catch {
      controller.abort();
      if (state.agentToolsController === controller) state.agentToolsController = null;
    }
  })();
  state.agentToolsRegistration = registration;
  try { await registration; } finally { state.agentToolsRegistration = null; }
}

window.addEventListener('pagehide', () => {
  state.agentPageActive = false;
  stopHandoffPolling();
  unregisterAgentTools();
});
for (const event of ['pageshow', 'focus']) {
  window.addEventListener(event, () => {
    if (event === 'pageshow') {
      state.agentPageActive = true;
      render();
    }
    if (state.session) void registerAgentTools().catch(() => { /* The existing UI remains available. */ });
  });
}

(async () => {
  showNotice('Loading installer…');
  try {
    await loadSession();
    showNotice('');
    route(initialRoute(), true);
    void registerAgentTools().catch(() => { /* The existing UI remains available. */ });
  } catch (error) {
    showNotice(apiErrorMessage(error, 'The installer could not start.'), 'error');
    render();
  }
})();

// A local, decorative field: no input tracking, network calls, or stored state.
(() => {
  const canvas = document.querySelector('.ambient-field');
  const context = canvas?.getContext('2d');
  if (!context) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0;
  let height = 0;
  let frame = 0;
  let lastTime = 0;
  let phase = 0;

  // These are original studies of processes, not reproductions of artworks.
  let study = document.documentElement.dataset.artwork ?? 'kuro-fault';

  function weave() {
    const step = width < 600 ? 13 : 17;
    for (let row = -1; row < height / step + 1; row += 1) {
      for (let column = -1; column < width / step + 1; column += 1) {
        // A twill weave: each weft passes over three warp threads, then under one.
        const over = ((column + row) % 4 + 4) % 4 !== 0;
        const tension = Math.sin(row * 0.08 + phase * 0.4) * Math.sin(column * 0.11) * 2;
        const x = column * step + tension;
        const y = row * step;
        context.strokeStyle = over ? 'rgba(205,205,205,0.12)' : 'rgba(205,205,205,0.055)';
        context.lineWidth = 1;
        for (let thread = -2; thread <= 2; thread += 1) {
          context.beginPath();
          if (over) {
            context.moveTo(x - step / 2 + 1, y + thread * 1.3);
            context.quadraticCurveTo(x, y + thread * 1.3 + tension * 0.3, x + step / 2 - 1, y + thread * 1.3);
          } else {
            context.moveTo(x + thread * 1.3, y - step / 2 + 1);
            context.lineTo(x + thread * 1.3, y + step / 2 - 1);
          }
          context.stroke();
        }
      }
    }
  }

  function brush() {
    // Each pass retains its own pressure and dry-brush gaps. Passes accumulate
    // slowly, as a plotting tool revisits a surface with imperfect registration.
    const span = 180;
    for (let band = -1; band < height / span + 1; band += 1) {
      for (let pass = 0; pass < 40; pass += 1) {
        const seed = Math.sin(pass * 127.1 + band * 311.7) * 43758.5453;
        const grain = seed - Math.floor(seed);
        const deposit = 0.35 + 0.65 * (0.5 + Math.sin(phase * 0.5 - pass * 0.045 + band) * 0.5);
        context.strokeStyle = `rgba(205,205,205,${(0.025 + grain * 0.065) * deposit})`;
        context.lineWidth = 0.7 + grain * 2;
        context.beginPath();
        const start = -width * 0.15 + grain * 28;
        const end = width * 1.15 - grain * 40;
        for (let point = 0; point <= 70; point += 1) {
          const x = start + (end - start) * point / 70;
          const u = x / width;
          const y = band * span + pass * 2.6 + Math.sin(u * 4.3 + band * 1.7) * 65
            + Math.sin(u * 13 + pass * 0.15) * grain * 5;
          if (point === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
    }
  }

  function layers() {
    // Three transparent drawings use the same geometry, with independent
    // registration. Their overlaps create forms absent from any single layer.
    const scale = Math.max(width, height) * 0.56;
    for (let layer = 0; layer < 3; layer += 1) {
      const shiftX = Math.sin(phase * 0.35 + layer * 2.1) * 15;
      const shiftY = Math.cos(phase * 0.3 + layer * 2.1) * 15;
      context.strokeStyle = 'rgba(205,205,205,0.075)';
      context.lineWidth = 0.65;
      for (let contour = 0; contour < 50; contour += 1) {
        const fraction = contour / 49;
        context.beginPath();
        for (let point = 0; point <= 120; point += 1) {
          const angle = point / 120 * Math.PI * 2;
          const radius = 0.23 + fraction * 0.68 + Math.cos(angle * 3 + fraction * 2) * 0.12;
          const x = width * 0.5 + Math.cos(angle) * radius * scale + shiftX;
          const y = height * 0.5 + Math.sin(angle) * radius * scale + shiftY;
          if (point === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
    }
  }

  function random(index) {
    const value = Math.sin(index * 127.1 + 43.7) * 43758.5453;
    return value - Math.floor(value);
  }

  function confluence() {
    // Independent fragments share an orientation only inside a moving field.
    const time = phase * 0.35;
    for (let i = 0; i < 260; i += 1) {
      const x = ((random(i) + time * (0.012 + random(i + 700) * 0.01)) % 1) * width;
      const y = random(i + 300) * height + Math.sin(time + i) * 8;
      const field = Math.exp(-Math.pow((x / width - 0.5 - Math.sin(time) * 0.17) / 0.24, 2));
      const angle = (random(i + 900) - 0.5) * Math.PI * (1 - field);
      context.save();
      context.translate(x, y);
      context.rotate(angle);
      context.fillStyle = `rgba(210,210,210,${0.045 + field * 0.11})`;
      context.fillRect(-4, -1, 5 + random(i + 1200) * 15, 1 + random(i + 1600) * 3);
      context.restore();
    }
  }

  function eclipse() {
    // Large offset apertures overlap: the negative spaces make the composition.
    for (let i = 0; i < 5; i += 1) {
      const size = Math.max(width, height) * (0.28 + i * 0.045);
      const x = width * (0.18 + i * 0.17) + Math.sin(phase * 0.25 + i) * 24;
      const y = height * (0.2 + (i % 3) * 0.32);
      context.save();
      context.translate(x, y);
      context.rotate(i * 0.7 + Math.sin(phase * 0.2) * 0.06);
      context.beginPath();
      context.ellipse(0, 0, size, size * 0.65, 0, 0, Math.PI * 2);
      context.ellipse(size * 0.13, 0, size * 0.88, size * 0.58, 0, 0, Math.PI * 2);
      context.fillStyle = 'rgba(200,200,200,0.065)';
      context.fill('evenodd');
      context.restore();
    }
  }

  function resonance() {
    // Two near-identical spatial frequencies produce a much larger beat pattern.
    const step = 9;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const a = Math.hypot(x - width * 0.25, y - height * 0.35);
        const b = Math.hypot(x - width * 0.72, y - height * 0.62);
        const beat = Math.sin(a * 0.038 + phase * 0.5) * Math.sin(b * 0.039 - phase * 0.4);
        const strength = Math.pow(Math.max(0, beat), 2);
        if (strength < 0.08) continue;
        context.fillStyle = `rgba(210,210,210,${strength * 0.18})`;
        context.beginPath();
        context.arc(x, y, 0.5 + strength * 1.4, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  function palimpsest() {
    // Incomplete, overlapping impressions never resolve into readable symbols.
    const cell = 110;
    for (let row = -1; row < height / cell; row += 1) {
      for (let column = -1; column < width / cell; column += 1) {
        const seed = (row + 30) * 97 + column;
        for (let layer = 0; layer < 3; layer += 1) {
          const x = column * cell + random(seed) * 25 + layer * 3;
          const y = row * cell + random(seed + 100) * 30;
          const alpha = 0.02 + (0.5 + Math.sin(phase * 0.35 + seed + layer) * 0.5) * 0.035;
          context.strokeStyle = `rgba(205,205,205,${alpha})`;
          context.lineWidth = 7 - layer * 2;
          context.beginPath();
          context.moveTo(x, y + 65);
          context.lineTo(x + 15, y);
          context.lineTo(x + 65, y + random(seed + 200) * 45);
          if (random(seed + 300) > 0.5) context.lineTo(x + 50, y + 70);
          context.stroke();
        }
      }
    }
  }

  function silt() {
    // A granular field records smooth pressure changes as density, not trajectories.
    for (let i = 0; i < 6500; i += 1) {
      const x = random(i) * width;
      const y = random(i + 9000) * height;
      const u = x / Math.max(width, 1);
      const v = y / Math.max(height, 1);
      const pressure = Math.sin(v * 15 + Math.sin(u * 6 + phase * 0.25) * 2.4);
      const density = Math.pow(0.5 + pressure * 0.5, 4);
      context.fillStyle = `rgba(215,215,215,${density * 0.19})`;
      context.fillRect(x, y, 0.7 + random(i + 18000) * 1.3, 0.8);
    }
  }

  function vellum() {
    // Broad translucent cut-paper shapes reveal a third shape at each overlap.
    for (let i = 0; i < 8; i += 1) {
      const y = (i - 1) * height / 5;
      const lift = Math.sin(phase * 0.23 + i * 1.1) * height * 0.025;
      context.beginPath();
      context.moveTo(-20, y);
      context.bezierCurveTo(width * 0.28, y - 100 + lift, width * 0.6, y + 180, width + 20, y + 35);
      context.lineTo(width + 20, y + 95);
      context.bezierCurveTo(width * 0.6, y + 255, width * 0.28, y - 45 + lift, -20, y + 145);
      context.closePath();
      context.fillStyle = 'rgba(205,205,205,0.038)';
      context.fill();
    }
  }

  function ikeda() {
    const step = 7;
    for (let y = 0; y < height; y += step) {
      const band = Math.floor(y / 90);
      for (let x = 0; x < width; x += step * 2) {
        const n = Math.floor(x / (step * 2)) + Math.floor(y / step) * 199;
        const pulse = 0.5 + 0.5 * Math.sin(phase * 2 - band * 0.8);
        if (random(n + band * 701) < 0.45) continue;
        context.fillStyle = `rgba(225,225,225,${0.025 + pulse * 0.09})`;
        context.fillRect(x, y, band % 3 === 0 ? 9 : 2, 2 + random(n + 3) * 3);
      }
    }
  }

  function nicolai() {
    for (let panel = 0; panel < 4; panel += 1) {
      context.save();
      context.beginPath(); context.rect(panel * width / 4, 0, width / 4, height); context.clip();
      for (let layer = 0; layer < 2; layer += 1) {
        context.save(); context.translate((panel + 0.5) * width / 4, height / 2);
        context.rotate((layer ? -1 : 1) * (0.025 + Math.sin(phase * 0.4 + panel) * 0.045));
        context.fillStyle = 'rgba(220,220,220,0.055)';
        for (let x = -width; x < width; x += 6 + panel) context.fillRect(x + layer * Math.sin(phase) * 5, -height, 1, height * 2);
        context.restore();
      }
      context.restore();
    }
  }

  function kurokawa() {
    for (let i = 0; i < 7000; i += 1) {
      const u = random(i * 3), v = random(i * 3 + 1);
      const fold = Math.sin(u * 17 + phase * 0.35) * Math.cos(v * 11 - phase * 0.2);
      const x = u * width + fold * 50;
      const y = v * height + Math.sin(u * 8 + v * 5) * 70;
      const density = Math.pow(Math.max(0, Math.cos(v * 14 + u * 9 + fold * 2)), 5);
      context.fillStyle = `rgba(225,225,225,${density * 0.28})`;
      context.fillRect(x, y, 0.8 + random(i + 100) * 2.2, i % 31 === 0 ? 15 : 1);
    }
  }

  function quayola() {
    const step = 95;
    const point = (x, y) => [x * step + Math.sin(y * 2.3 + x * 4.1 + phase * 0.2) * 30, y * step + Math.cos(x * 2 + y * 3.7) * 35];
    for (let y = -1; y < height / step + 1; y += 1) for (let x = -1; x < width / step + 1; x += 1) {
      const a = point(x, y), b = point(x + 1, y), c = point(x, y + 1), d = point(x + 1, y + 1);
      for (const triangle of [[a,b,c],[b,d,c]]) {
        context.beginPath(); triangle.forEach(([px,py], index) => index ? context.lineTo(px,py) : context.moveTo(px,py)); context.closePath();
        const value = 0.018 + 0.08 * (0.5 + 0.5 * Math.sin(x * 1.9 + y * 0.7 + phase * 0.25));
        context.fillStyle = `rgba(215,215,215,${value})`; context.fill();
        context.strokeStyle = 'rgba(210,210,210,0.05)'; context.lineWidth = 0.6; context.stroke();
      }
    }
  }

  function reas() {
    const elements = Array.from({length: 75}, (_, i) => {
      const angle = random(i + 81) * Math.PI * 2 + phase * 0.15;
      return {x: ((random(i * 3) * width + Math.cos(angle) * phase * 35) % width + width) % width, y: ((random(i * 3 + 1) * height + Math.sin(angle) * phase * 35) % height + height) % height, dx: Math.cos(angle) * 65, dy: Math.sin(angle) * 65};
    });
    for (let i = 0; i < elements.length; i += 1) for (let j = i + 1; j < elements.length; j += 1) {
      const a = elements[i], b = elements[j], distance = Math.hypot(a.x-b.x,a.y-b.y);
      if (distance > 150) continue;
      context.beginPath(); context.moveTo(a.x-a.dx,a.y-a.dy); context.lineTo(a.x+a.dx,a.y+a.dy); context.lineTo(b.x+b.dx,b.y+b.dy); context.lineTo(b.x-b.dx,b.y-b.dy); context.closePath();
      context.fillStyle = `rgba(210,210,210,${(1-distance/150)*0.09})`; context.fill();
    }
  }

  function lia() {
    for (let group = 0; group < 6; group += 1) {
      context.save(); context.translate(width * (group % 3 + 0.5) / 3, height * (Math.floor(group / 3) + 0.5) / 2);
      context.rotate(phase * 0.025 * (group % 2 ? 1 : -1));
      for (let ring = 0; ring < 48; ring += 1) {
        context.beginPath();
        for (let i = 0; i <= 160; i += 1) {
          const t = i / 160 * Math.PI * 2;
          const r = 12 + ring * 3.5 + Math.sin(t * 3 + ring * 0.09 + phase * 0.3) * ring * 1.1;
          const x = Math.cos(t) * r, y = Math.sin(t) * r;
          if (i) context.lineTo(x,y); else context.moveTo(x,y);
        }
        context.strokeStyle = 'rgba(215,215,215,0.095)'; context.lineWidth = 0.65; context.stroke();
      }
      context.restore();
    }
  }

  function akten() {
    for (let i = 0; i < 220; i += 1) {
      const x = i / 219 * width;
      const frequency = 1 + i * 0.004;
      const y = height / 2 + Math.sin(phase * frequency + i * 0.065) * height * 0.34;
      context.beginPath(); context.ellipse(x,y,2.5,10 + 10 * (0.5 + Math.cos(i * 0.08 + phase) * 0.5),0,0,Math.PI*2);
      context.fillStyle = 'rgba(225,225,225,0.18)'; context.fill();
      for(let echo=1;echo<5;echo+=1) {
        context.beginPath(); context.arc(x,y + Math.sin(i * 0.025 + phase) * echo * 22,1.2,0,Math.PI*2); context.fillStyle = `rgba(215,215,215,${0.065/echo})`;context.fill();
      }
    }
  }

  function lemercier() {
    for (let row = -10; row < height / 8 + 12; row += 1) {
      context.beginPath();
      for (let x = -10; x <= width + 10; x += 7) {
        const u = x / width;
        const ridge = Math.pow(Math.abs(Math.sin(u * 7 + row * 0.025)), 5) * 95;
        const y = row * 8 - ridge * Math.sin(row * 0.035 + phase * 0.13) + Math.sin(u * 23 + row * 0.1) * 9;
        if (x === -10) context.moveTo(x,y); else context.lineTo(x,y);
      }
      context.strokeStyle = 'rgba(210,210,210,0.095)'; context.lineWidth = 0.6; context.stroke();
    }
  }

  function giger() {
    for (let column = -1; column < width / 230 + 1; column += 1) {
      const spine = column * 230 + 115;
      for (let row = -2; row < height / 23 + 2; row += 1) {
        const y = row * 23 + Math.sin(phase * 0.22 + column) * 8;
        const spread = 80 + Math.sin(row * 0.12 + column) * 25;
        for (const side of [-1,1]) {
          context.beginPath(); context.moveTo(spine + side * 8,y);
          context.bezierCurveTo(spine + side * spread * 0.5,y - 38,spine + side * spread,y - 30,spine + side * (spread + 18),y + 34);
          context.strokeStyle = 'rgba(180,180,180,0.055)'; context.lineWidth=9;context.stroke();
          context.strokeStyle = 'rgba(225,225,225,0.10)';context.lineWidth=1;context.stroke();
        }
        context.fillStyle='rgba(210,210,210,0.10)';context.fillRect(spine-3,y-4,6,10);
      }
    }
  }

  function mead() {
    for (let band = -1; band < 7; band += 1) {
      const y = band * height / 5 + Math.sin(phase * 0.18) * 8;
      for (let cell = -1; cell < width / 190 + 1; cell += 1) {
        const x = cell * 190 + (band % 2) * 75;
        const length = 140 + random(cell + band * 30) * 65;
        context.beginPath();context.moveTo(x,y);context.lineTo(x+length,y);context.lineTo(x+length-48,y+60);context.lineTo(x-28,y+60);context.closePath();
        context.fillStyle='rgba(210,210,210,0.045)';context.fill();
        context.strokeStyle='rgba(215,215,215,0.10)';context.lineWidth=0.7;context.stroke();
        for(let detail=0;detail<7;detail+=1){context.fillStyle='rgba(225,225,225,0.07)';context.fillRect(x+12+detail*12,y+13,6,2);}
        context.fillStyle='rgba(225,225,225,0.085)';context.fillRect(x+10,y+44,length-70,1);
      }
    }
  }

  // Original 2D studies of material, fragmentation and temporal composition.
  // Geometry is sampled once: every grain belongs to a persistent fragment.
  const kuroCache = new Map();
  let kuroSamples = null;
  const ease = (value) => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  };
  function grainNoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const tx = ease(x - ix), ty = ease(y - iy);
    const a = random(ix * 127.1 + iy * 311.7);
    const b = random((ix + 1) * 127.1 + iy * 311.7);
    const c = random(ix * 127.1 + (iy + 1) * 311.7);
    const d = random((ix + 1) * 127.1 + (iy + 1) * 311.7);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
  function materialNoise(x, y) {
    return grainNoise(x, y) * 0.55 + grainNoise(x * 2.13, y * 2.13) * 0.28 + grainNoise(x * 5.17, y * 5.17) * 0.17;
  }
  function kuroGeometry(kind) {
    if (kuroCache.has(kind)) return kuroCache.get(kind);
    const groups = Array.from({ length: 40 }, () => Array.from({ length: 7 }, () => []));
    if (!kuroSamples) {
      const count = Math.min(76000, Math.round(width * height / 10));
      kuroSamples = new Float32Array(count * 4);
      for (let i = 0; i < count; i += 1) {
        const u = random(i * 3.13 + 27), v = random(i * 4.71 + 109);
        kuroSamples.set([u, v, materialNoise(u * 7, v * 8), materialNoise(u * 42, v * 37)], i * 4);
      }
    }
    for (let i = 0; i < kuroSamples.length / 4; i += 1) {
      const [u, v, coarse, fine] = kuroSamples.subarray(i * 4, i * 4 + 4);
      let density, group;
      if (kind === 'fault') {
        const ridge = v - (0.10 + u * 0.73 + Math.sin(u * 9) * 0.10);
        const ridge2 = v - (0.78 - u * 0.38);
        const body = Math.exp(-Math.pow(ridge / (0.10 + coarse * 0.13), 2));
        const counter = Math.exp(-Math.pow(ridge2 / 0.08, 2)) * 0.38;
        const veins = Math.pow(Math.abs(Math.sin(v * 110 + u * 24 + coarse * 12)), 7);
        density = Math.max(body, counter) * (0.12 + fine * 0.55 + veins * 0.52);
        group = Math.min(39, Math.floor(v * 20) * 2 + (u > 0.55 ? 1 : 0));
      } else if (kind === 'assemblage') {
        const xx = u * 5, yy = v * 4;
        const cell = Math.floor(xx) + Math.floor(yy) * 5;
        const fx = xx % 1, fy = yy % 1;
        const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
        const manmade = Math.exp(-edge * 30) * 0.7 + (Math.sin(fx * 68) > 0.85 ? 0.22 : 0.02);
        const organic = Math.pow(Math.max(0, 1 - Math.abs(coarse - 0.52) * 5), 4) * fine;
        const mix = random(cell + 49);
        density = (mix > 0.45 ? organic : manmade * (0.3 + fine)) * (0.35 + coarse);
        group = Math.min(39, Math.floor(v * 8) * 5 + Math.floor(u * 5));
      } else if (kind === 'fold') {
        const axis = 0.24 + u * 0.46;
        const d = v - axis;
        const membrane = Math.exp(-Math.pow(d / (0.23 + 0.07 * Math.sin(u * 11)), 2));
        const veins = Math.pow(Math.abs(Math.sin(d * 100 + coarse * 18)), 9);
        density = membrane * (veins * 0.72 + fine * 0.36) * (0.35 + coarse);
        group = Math.min(39, Math.floor(u * 10) * 4 + Math.floor(v * 4));
      } else {
        const column = Math.min(4, Math.floor(u * 5));
        const local = (u * 5) % 1;
        const edge = Math.pow(Math.sin(local * Math.PI), 0.6);
        const relief = Math.exp(-Math.pow((v - 0.5 - Math.sin(local * 6 + column) * 0.16) / 0.34, 2));
        density = edge * relief * (fine * 0.48 + Math.pow(Math.abs(Math.sin(v * 87 + coarse * 12)), 8) * 0.58);
        group = column * 8 + Math.min(7, Math.floor(v * 8));
      }
      if (density < 0.09 || random(i * 9.7 + 7) > density * 1.5) continue;
      const tone = Math.min(6, Math.floor(density * 8));
      const size = 0.55 + random(i + 811) * 0.95;
      const grainWidth = kind === 'assemblage' && tone > 2 ? 2 + fine * 5 : size;
      const grainHeight = kind === 'quintet' && i % 5 === 0 ? 2.5 : size;
      groups[group][tone].push(u * width, v * height, grainWidth, i % 97 === 0 ? 4 + fine * 9 : grainHeight);
    }
    const paths = kind === 'fold' ? null : groups.map(tones => tones.map(points => {
      const path = new Path2D();
      for (let p = 0; p < points.length; p += 4) path.rect(points[p], points[p + 1], points[p + 2], points[p + 3]);
      return path;
    }));
    const geometry = { groups, paths };
    kuroCache.set(kind, geometry);
    return geometry;
  }
  // A slow score: establish / displace / suspend / re-form. Staggered fragments
  // share the same event, so movement reads as one material changing state.
  function kuroEnvelope(time, delay = 0) {
    const t = ((time - delay) % 38 + 38) % 38;
    return ease((t - 9) / 5) * (1 - ease((t - 23) / 9));
  }
  function kuroStudy(kind) {
    const { groups, paths } = kuroGeometry(kind);
    const time = phase / 0.085;
    for (let g = 0; g < groups.length; g += 1) {
      const column = kind === 'quintet' ? Math.floor(g / 8) : g % 5;
      const delay = kind === 'quintet' ? [0, 2.2, 5.6, 3.8, 7.4][column] : random(g + 30) * 3;
      const event = kuroEnvelope(time + 8, delay);
      const breath = Math.sin(time * 0.11 + g * 0.18);
      let dx = 0, dy = 0, sx = 1, sy = 1;
      if (kind === 'fault') {
        dx = (random(g + 62) - 0.5) * width * 0.085 * event;
        dy = (random(g + 93) - 0.5) * 24 * event + breath * 1.5;
      } else if (kind === 'assemblage') {
        dx = (column - 2) * event * 11;
        dy = (random(g + 21) - 0.5) * event * 76;
        sx = 1 - event * 0.045;
      } else if (kind === 'fold') {
        sy = 1 - event * 0.70;
        dx = breath * 3;
        dy = (g % 4 - 1.5) * event * 12;
      } else {
        dy = event * Math.sin(column * 1.7 + 0.4) * height * 0.10;
        sy = 1 - event * 0.16;
      }
      context.save();
      context.translate(width / 2 + dx, height / 2 + dy);
      context.scale(sx, sy);
      context.translate(-width / 2, -height / 2);
      for (let tone = 0; tone < 7; tone += 1) {
        const alpha = (0.075 + tone * 0.054) * (1 - event * 0.12);
        context.fillStyle = `rgba(226,226,226,${alpha})`;
        if (paths) {
          context.fill(paths[g][tone]);
          continue;
        }
        const points = groups[g][tone];
        for (let p = 0; p < points.length; p += 4) {
          let y = points[p + 1];
          if (kind === 'fold') y += Math.sin(points[p] / width * 8 + time * 0.13) * event * 35;
          context.fillRect(points[p], y, points[p + 2], points[p + 3]);
        }
      }
      context.restore();
    }
  }

  const studies = { 'kuro-fault': () => kuroStudy('fault'), 'kuro-assemblage': () => kuroStudy('assemblage'), 'kuro-fold': () => kuroStudy('fold'), 'kuro-quintet': () => kuroStudy('quintet'), ikeda, nicolai, kurokawa, quayola, reas, lia, akten, lemercier, giger, mead, anna: weave, licia: brush, iskra: layers, confluence, eclipse, resonance, palimpsest, silt, vellum };

  function draw() {
    context.clearRect(0, 0, width, height);
    (studies[study] ?? confluence)();
  }

  window.addEventListener('ankka:artwork', () => {
    const selected = document.documentElement.dataset.artwork;
    if (!Object.hasOwn(studies, selected)) return;
    study = selected;
    phase = 0;
    sync();
  });

  function animate(time) {
    frame = 0;
    if (document.hidden || reducedMotion.matches) return;
    if (time - lastTime >= 1000 / 30) {
      phase += Math.min(time - lastTime, 50) * 0.000085;
      lastTime = time;
      draw();
    }
    frame = window.requestAnimationFrame(animate);
  }

  function sync() {
    window.cancelAnimationFrame(frame);
    frame = 0;
    lastTime = performance.now();
    draw();
    if (!document.hidden && !reducedMotion.matches) frame = window.requestAnimationFrame(animate);
  }

  function resize() {
    kuroCache.clear();
    kuroSamples = null;
    width = window.innerWidth;
    height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    sync();
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 120);
  });
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
  resize();
})();
