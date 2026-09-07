import * as v from 'valibot';
import { createLiveGatewayAccess, LiveGatewayAccessError } from './live-gateway-access.mjs';

export class LiveGatewayApiError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}

const paths = {
  GET: /^\/(?:cdn-cgi\/access\/get-identity|api\/(?:status|update|sources|team|source-actions|source-actions\/action_[A-Za-z0-9_-]{32}|team-actions\/action_[A-Za-z0-9_-]{32}))$/u,
  POST: /^\/api\/(?:sources\/discover|source-actions|source-actions\/action_[A-Za-z0-9_-]{32}\/renew|team-actions)$/u,
  PUT: /^\/api\/sources$/u,
};
export const REQUEST_TIMEOUT_MS = 120_000;

/** Routes a rejection probe may address: the ones the gateway must refuse to a service identity, plus its allowed reads. */
const probePaths = {
  GET: /^\/api\/(?:status|team|update-actions\/action_[A-Za-z0-9_-]{32})$/u,
  POST: /^\/api\/(?:update-actions|teardown-actions)$/u,
  DELETE: /^\/api\/source-actions\/action_[A-Za-z0-9_-]{32}$/u,
};

/** The gateway's own fixed refusal body; a refusal without it came from the Access edge. */
const gatewayRefusal = v.looseObject({ schemaVersion: v.literal(1), error: v.pipe(v.string(), v.regex(/^[a-z_]{1,64}$/u)) });
const refusal = v.strictObject({ refused: v.number(), layer: v.picklist(['access_edge', 'gateway', 'unknown']), code: v.nullable(v.string()) });

/** The gateway's fixed refusal code in a response, or null when the body is not the gateway's JSON. Reads at most 16 KiB; the lock is released so the caller can still cancel. */
async function gatewayRefusalOf(response) {
  if (!response.headers.get('content-type')?.includes('application/json') || !response.body) return null;
  const reader = response.body.getReader();
  const chunks = []; let size = 0; let text = null;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > 16 * 1024) { await reader.cancel(); break; }
      chunks.push(item.value);
    }
    if (size <= 16 * 1024) text = Buffer.concat(chunks).toString('utf8');
  } catch { text = null; } finally { reader.releaseLock(); }
  if (text === null) return null;
  try {
    const parsed = v.safeParse(gatewayRefusal, JSON.parse(text));
    return parsed.success ? parsed.output.error : null;
  } catch { return null; }
}

/** Fixed-origin HTTP checks with cached operator Access identity. No browser,
 * infrastructure token, redirects, login prompts, cookie export, or write retry.
 */
function requireOrigin(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
    throw new LiveGatewayApiError('api_origin_invalid');
  }
}

/** One fixed-origin request path; `credentials` supplies the headers that carry the caller's identity. */
function createRequest({ origin, transport, signal, credentials, allow = paths, rejected = () => false, redirect = 'error' }) {
  return async function request(path, { method = 'GET', body } = {}) {
    if (!allow[method]?.test(path) || method === 'GET' && body !== undefined) {
      throw new LiveGatewayApiError('api_request_outside_qualification');
    }
    const identity = await credentials();
    try {
      const options = {
        // A gateway action applies Portal and Access policy changes before it answers; a slow write is awaited, not abandoned.
        method, redirect, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { origin, accept: 'application/json', ...identity },
      };
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const response = await transport(origin + path, options);
      if (response.status !== 200) {
        const outcome = await rejected(response.status, response);
        await response.body?.cancel();
        if (outcome !== false) return outcome;
        if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) throw new LiveGatewayAccessError('access_session_rejected');
        throw new LiveGatewayApiError('api_http_rejected', response.status);
      }
      if (!response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel(); throw new LiveGatewayApiError('api_response_invalid');
      }
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.length;
        if (size > 512 * 1024) { await reader.cancel(); throw new LiveGatewayApiError('api_response_too_large'); }
        chunks.push(item.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof LiveGatewayApiError || error instanceof LiveGatewayAccessError) throw error;
      throw new LiveGatewayApiError('api_request_failed');
    }
  };
}

/**
 * Fixed-origin checks as the Access service identity: the client id and secret
 * ride in the service-token headers, no cookie, no cached human session, no
 * login. `probe` returns the outcome of a request the gateway or the Access edge
 * is expected to refuse, so rejection is evidence rather than an error: the HTTP
 * status, the layer that answered (`access_edge` for a redirect to the Access
 * login page or an edge 401/403, `gateway` for the gateway's own fixed JSON
 * refusal, `admitted` for 200) and, from the gateway, its refusal code.
 */
export function createLiveGatewayServiceApi({ origin, clientId, secret, transport = fetch, signal }) {
  requireOrigin(origin);
  if (!/^[a-f0-9]{32}\.access$/u.test(clientId) || !v.is(v.pipe(v.string(), v.minLength(32), v.maxLength(256)), secret)) {
    throw new LiveGatewayApiError('service_credential_invalid');
  }
  const credentials = async () => ({ 'cf-access-client-id': clientId, 'cf-access-client-secret': secret });
  // Redirects are observed, never followed: the Access edge answers an identity it does not admit with a
  // redirect to its login page, and that redirect is the refusal a probe records.
  const request = createRequest({ origin, transport, signal, credentials, redirect: 'manual' });
  const probe = createRequest({ origin, transport, signal, credentials, allow: probePaths, redirect: 'manual', rejected: async (status, response) => {
    if (status >= 300 && status < 400) {
      let host = null;
      try { host = new URL(response.headers.get('location') ?? '', origin).hostname; } catch { host = null; }
      return host !== null && host.endsWith('.cloudflareaccess.com') ? { refused: status, layer: 'access_edge', code: null } : false;
    }
    // The gateway refuses with its fixed JSON body; the edge's own 401 and 403 pages carry no such body.
    const code = await gatewayRefusalOf(response);
    return { refused: status, layer: code !== null ? 'gateway' : status === 401 || status === 403 ? 'access_edge' : 'unknown', code };
  } });
  return { request, async probe(path, options) {
    const outcome = await probe(path, options);
    return v.is(refusal, outcome) ? { status: outcome.refused, layer: outcome.layer, code: outcome.code } : { status: 200, layer: 'admitted', code: null };
  } };
}

export function createLiveGatewayApi({ origin, email, transport = fetch, run, signal }) {
  requireOrigin(origin);
  let cookie;
  const install = createLiveGatewayAccess({ origins: [origin], email, run, signal });
  const context = { addCookies: async ([value]) => { cookie = value; } };
  const request = createRequest({ origin, transport, signal, credentials: async () => {
    await install(context, origin);
    return { cookie: `${cookie.name}=${cookie.value}` };
  } });
  return { request, async checkAccess() {
    const identity = await request('/cdn-cgi/access/get-identity');
    if (!v.is(v.string(), identity?.email) || identity.email.toLowerCase() !== email.toLowerCase()) {
      throw new LiveGatewayAccessError('access_identity_mismatch');
    }
  } };

}
