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
/** Routes a rejection probe may address: the ones the gateway must refuse to a service identity, plus its allowed reads. */
const probePaths = {
  GET: /^\/api\/(?:status|team|update-actions\/action_[A-Za-z0-9_-]{32})$/u,
  POST: /^\/api\/(?:update-actions|teardown-actions)$/u,
  DELETE: /^\/api\/source-actions\/action_[A-Za-z0-9_-]{32}$/u,
};

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
function createRequest({ origin, transport, signal, credentials, allow = paths, rejected = () => false }) {
  return async function request(path, { method = 'GET', body } = {}) {
    if (!allow[method]?.test(path) || method === 'GET' && body !== undefined) {
      throw new LiveGatewayApiError('api_request_outside_qualification');
    }
    const identity = await credentials();
    try {
      const options = {
        method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { origin, accept: 'application/json', ...identity },
      };
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const response = await transport(origin + path, options);
      if (response.status !== 200) {
        const outcome = rejected(response.status);
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
 * login. `probe` returns the HTTP status of a request the gateway is expected
 * to refuse, so rejection is evidence rather than an error.
 */
export function createLiveGatewayServiceApi({ origin, clientId, secret, transport = fetch, signal }) {
  requireOrigin(origin);
  if (!/^[a-f0-9]{32}\.access$/u.test(clientId) || !v.is(v.pipe(v.string(), v.minLength(32), v.maxLength(256)), secret)) {
    throw new LiveGatewayApiError('service_credential_invalid');
  }
  const credentials = async () => ({ 'cf-access-client-id': clientId, 'cf-access-client-secret': secret });
  const request = createRequest({ origin, transport, signal, credentials });
  const probe = createRequest({ origin, transport, signal, credentials, allow: probePaths, rejected: (status) => ({ refused: status }) });
  return { request, async probe(path, options) {
    const outcome = await probe(path, options);
    return v.is(v.strictObject({ refused: v.number() }), outcome) ? outcome.refused : 200;
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
