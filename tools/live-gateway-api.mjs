import * as v from 'valibot';
import { createLiveGatewayAccess, LiveGatewayAccessError } from './live-gateway-access.mjs';

export class LiveGatewayApiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const paths = {
  GET: /^\/(?:cdn-cgi\/access\/get-identity|api\/(?:status|sources|team|source-actions\/action_[A-Za-z0-9_-]{32}))$/u,
  POST: /^\/api\/(?:sources\/discover|source-actions|team-actions)$/u,
  PUT: /^\/api\/sources$/u,
};

/** Fixed-origin HTTP checks with cached operator Access identity. No browser,
 * infrastructure token, redirects, login prompts, cookie export, or write retry.
 */
export function createLiveGatewayApi({ origin, email, transport = fetch, run, signal }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
    throw new LiveGatewayApiError('api_origin_invalid');
  }
  let cookie;
  const install = createLiveGatewayAccess({ origins: [origin], email, run, signal });
  const context = { addCookies: async ([value]) => { cookie = value; } };
  async function request(path, { method = 'GET', body } = {}) {
    if (!paths[method]?.test(path) || method === 'GET' && body !== undefined) {
      throw new LiveGatewayApiError('api_request_outside_qualification');
    }
    await install(context, origin);
    try {
      const options = {
        method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { origin, accept: 'application/json',
          cookie: `${cookie.name}=${cookie.value}` },
      };
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const response = await transport(origin + path, options);
      if (response.status !== 200) {
        await response.body?.cancel();
        if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) throw new LiveGatewayAccessError('access_session_rejected');
        throw new LiveGatewayApiError('api_http_rejected');
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
  }
  return { request, async checkAccess() {
    const identity = await request('/cdn-cgi/access/get-identity');
    if (!v.is(v.string(), identity?.email) || identity.email.toLowerCase() !== email.toLowerCase()) {
      throw new LiveGatewayAccessError('access_identity_mismatch');
    }
  } };

}
