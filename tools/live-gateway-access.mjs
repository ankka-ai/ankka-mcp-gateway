import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as v from 'valibot';

const execute = promisify(execFile);

export class LiveGatewayAccessError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Decode only to reject a wrong identity or stale cache. Cloudflare verifies
 * the signature, audience and policy when it receives the host-only cookie. */
export function accessCookie(token, origin, email, now = Date.now()) {
  if (!v.is(v.string(), token) || token.length > 32_768 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
    throw new LiveGatewayAccessError('access_cache_invalid');
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw new LiveGatewayAccessError('access_cache_invalid'); }
  if (!v.is(v.strictObject({ email: v.string(), exp: v.number() }), { email: claims?.email, exp: claims?.exp })) {
    throw new LiveGatewayAccessError('access_cache_invalid');
  }
  if (claims.email.toLowerCase() !== email.toLowerCase()) throw new LiveGatewayAccessError('access_identity_mismatch');
  if (!Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now + 60_000) {
    throw new LiveGatewayAccessError('access_login_required');
  }
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new LiveGatewayAccessError('access_origin_invalid');
  return { name: 'CF_Authorization', value: token, domain: url.hostname, path: '/',
    secure: true, httpOnly: true, sameSite: 'Lax', expires: claims.exp };
}

/** Read an existing user session, never an infrastructure API token. Login is
 * opt-in, quiet, and uses cloudflared's normal-browser flow. No shell, raw child
 * process error, or token-bearing command argument crosses this boundary. */
export function createLiveGatewayAccess({ origins, email, run = execute, notify = () => {}, signal }) {
  const allowed = new Set(origins);
  const installed = new Map();
  const environment = () => Object.fromEntries(['HOME', 'PATH', 'USER', 'TMPDIR'].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  async function cached(origin) {
    let stdout;
    try {
      ({ stdout } = await run('cloudflared', ['access', 'token', '--app', origin], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 65_536, env: environment(), signal,
      }));
    } catch { throw new LiveGatewayAccessError('access_login_required'); }
    return accessCookie(stdout.trim(), origin, email);
  }
  return async function install(context, origin, { allowLogin = false } = {}) {
    if (signal?.aborted) throw new LiveGatewayAccessError('access_login_cancelled');
    if (!allowed.has(origin)) throw new LiveGatewayAccessError('access_origin_invalid');
    if ((installed.get(origin) ?? 0) > Date.now() + 60_000) return;
    let cookie;
    try {
      cookie = await cached(origin);
    } catch (error) {
      if (signal?.aborted) throw new LiveGatewayAccessError('access_login_cancelled');
      if (!allowLogin || error.code !== 'access_login_required') throw error;
      notify('Complete the Access login opened by cloudflared in your normal browser.');
      try {
        await run('cloudflared', ['access', 'login', '--quiet', '--app', origin], {
          encoding: 'utf8', timeout: 600_000, maxBuffer: 65_536, env: environment(), signal,
        });
      } catch { throw new LiveGatewayAccessError(signal?.aborted ? 'access_login_cancelled' : 'access_login_required'); }
      cookie = await cached(origin);
    }
    try { await context.addCookies([cookie]); }
    catch { throw new LiveGatewayAccessError('access_cookie_install_failed'); }
    installed.set(origin, cookie.expires * 1000);
  };
}
