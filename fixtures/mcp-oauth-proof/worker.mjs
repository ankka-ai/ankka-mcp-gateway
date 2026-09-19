// Disposable synthetic OAuth proof, never a production identity provider.
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

const FIXTURE = 'ankka-mcp-oauth-proof';
const TOOL = 'synthetic_status';
const OTHER_TOOL = 'synthetic_other_read';
const SCOPE = 'ankka:read';
const COOKIE = '__Host-ankka-proof';
const encoder = new TextEncoder();
const headers = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};
const opaque = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u));
const fail = () => { throw new Error('proof_request_rejected'); };
const json = (value, status = 200, extra = {}) => Response.json(value, { status, headers: { ...headers, ...extra } });
const redirect = (url, extra = {}) => new Response(null, { status: 303, headers: { ...headers, location: url, ...extra } });
const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
function base64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
const digest = async (value) => base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
async function equal(left, right) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

// Limit bytes, chunks and time even when Content-Length is absent or false.
async function boundedText(message, limit = 32_768) {
  if (!message.body) fail();
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '', size = 0, chunks = 0, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('proof_body_timeout')), 5_000); });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) return result + decoder.decode();
      size += value.byteLength;
      if (size > limit || ++chunks > 128) fail();
      result += decoder.decode(value, { stream: true });
    }
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
function fields(parameters, allowed) {
  const keys = [...parameters.keys()];
  if (keys.length !== new Set(keys).size || keys.some((key) => !allowed.includes(key))) fail();
  return Object.fromEntries(parameters);
}
async function body(request, schema) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail();
  return v.parse(schema, JSON.parse(await boundedText(request)));
}
function state(env) { return env.STATE.getByName('one-disposable-run'); }
function config(origin) {
  return { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`, resource: `${origin}/mcp`, scopes_supported: [SCOPE],
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] };
}
function cookie(request) {
  const entries = (request.headers.get('cookie') || '').split(';').map((part) => part.trim());
  const matches = entries.filter((entry) => entry.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) fail();
  return v.parse(opaque, matches[0].slice(COOKIE.length + 1));
}
async function controlled(request, env) {
  if (!await equal(request.headers.get('authorization') || '', `Bearer ${env.CONTROL_SECRET}`)) fail();
}

// One object per disposable deployment. Raw provider tokens are never stored;
// only their digests. PKCE and cookie binding live for one five-minute attempt.
export class OAuthProofState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  }
  put(key, value, expires) {
    this.ctx.storage.sql.exec('DELETE FROM entries WHERE expires <= ?', Date.now());
    if (this.ctx.storage.sql.exec('SELECT count(*) AS n FROM entries').one().n >= 64) fail();
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO entries VALUES (?, ?, ?)', key, JSON.stringify(value), expires);
  }
  get(key) {
    const row = this.ctx.storage.sql.exec('SELECT value FROM entries WHERE key = ? AND expires > ?', key, Date.now()).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  take(key) {
    return this.ctx.storage.transactionSync(() => {
      const value = this.get(key);
      this.ctx.storage.sql.exec('DELETE FROM entries WHERE key = ?', key);
      return value;
    });
  }
  bump(name) {
    if (!['startAccepted', 'sourceOwned', 'metadataDiscovered', 'registered', 'authorized', 'codeExchanges', 'refreshes', 'imports', 'readCalls', 'otherReadCalls', 'deniedCalls', 'mcpMissingBearer', 'mcpInvalidBearer', 'mcpRequests', 'mcpParsed', 'rejectedMcp', 'initialize', 'discover', 'listTools'].includes(name)) fail();
    this.ctx.storage.sql.exec('INSERT INTO counters VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value=value+1', name);
  }
  report() {
    return Object.fromEntries(this.ctx.storage.sql.exec('SELECT name, value FROM counters').toArray().map((row) => [row.name, row.value]));
  }
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || response.status >= 300) throw new Error('proof_upstream_rejected');
  return JSON.parse(await boundedText(response, 256 * 1024));
}
async function cloudflare(env, method, value) {
  if (!/^[a-f0-9]{32}$/u.test(env.ACCOUNT_ID) || !/^oauth-proof-[a-f0-9]{12}$/u.test(env.SERVER_ID)) fail();
  const init = { method, headers: { authorization: `Bearer ${env.ANKKA_MANAGEMENT_TOKEN}`, 'content-type': 'application/json' } };
  if (value !== undefined) init.body = JSON.stringify(value);
  const result = await fetchJson(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/access/ai-controls/mcp/servers/${env.SERVER_ID}`, init);
  if (result.success !== true) throw new Error('proof_cloudflare_rejected');
  return result.result;
}
async function ownedSource(env) {
  const source = await cloudflare(env, 'GET');
  if (source.id !== env.SERVER_ID || source.hostname !== `${env.PUBLIC_ORIGIN}/mcp`
    || source.description !== `${FIXTURE}:${env.SERVER_ID}` || source.auth_type !== 'oauth') {
    throw new Error('proof_source_ownership_rejected');
  }
}
const registrationSchema = v.strictObject({
  redirect_uris: v.tuple([v.string()]), token_endpoint_auth_method: v.literal('none'),
  grant_types: v.tuple([v.literal('authorization_code'), v.literal('refresh_token')]),
  response_types: v.tuple([v.literal('code')]), scope: v.literal(SCOPE),
});
async function register(request, env) {
  const metadata = await body(request, registrationSchema);
  if (metadata.redirect_uris[0] !== `${env.PUBLIC_ORIGIN}/client/callback`) fail();
  const clientId = random();
  await state(env).put(`client:${clientId}`, metadata, Number(env.EXPIRES_AT));
  await state(env).bump('registered');
  return json({ ...metadata, client_id: clientId }, 201);
}
async function start(request, env) {
  await controlled(request, env);
  await state(env).bump('startAccepted');
  await ownedSource(env);
  await state(env).bump('sourceOwned');
  const origin = env.PUBLIC_ORIGIN;
  const metadata = config(origin);
  const discovered = await fetchJson(`${origin}/.well-known/oauth-authorization-server`);
  for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (discovered[key] !== metadata[key]) fail();
  }
  await state(env).bump('metadataDiscovered');
  const registration = await fetchJson(metadata.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [`${origin}/client/callback`], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE }) });
  v.parse(opaque, registration.client_id);
  const csrf = random(), verifier = random(), browserBinding = random();
  await state(env).put(`session:${await digest(csrf)}`, { verifier, browserBinding: await digest(browserBinding), registration }, Date.now() + 300_000);
  const query = new URLSearchParams({ client_id: registration.client_id, redirect_uri: `${origin}/client/callback`,
    response_type: 'code', scope: SCOPE, resource: `${origin}/mcp`, state: csrf,
    code_challenge: await digest(verifier), code_challenge_method: 'S256' });
  return redirect(`${metadata.authorization_endpoint}?${query}`, { 'set-cookie': `${COOKIE}=${browserBinding}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300` });
}
async function authorize(request, env) {
  const q = fields(new URL(request.url).searchParams,
    ['client_id', 'redirect_uri', 'response_type', 'scope', 'resource', 'state', 'code_challenge', 'code_challenge_method']);
  for (const value of [q.client_id, q.state, q.code_challenge]) v.parse(opaque, value);
  const session = await state(env).get(`session:${await digest(q.state)}`);
  if (!session || session.registration.client_id !== q.client_id || !await equal(session.browserBinding, await digest(cookie(request)))) fail();
  const client = await state(env).get(`client:${q.client_id}`);
  if (!client || q.redirect_uri !== client.redirect_uris[0] || q.response_type !== 'code'
    || q.scope !== SCOPE || q.resource !== `${env.PUBLIC_ORIGIN}/mcp` || q.code_challenge_method !== 'S256') fail();
  const code = random();
  await state(env).put(`code:${await digest(code)}`, { clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge }, Date.now() + 60_000);
  await state(env).bump('authorized');
  // Synthetic-only auto-consent; grants access to constant fixture data.
  return redirect(`${q.redirect_uri}?${new URLSearchParams({ code, state: q.state })}`);
}
async function issueTokens(env, clientId) {
  const accessToken = random(), refreshToken = random();
  const ttl = Number(env.ACCESS_TTL_SECONDS);
  if (!Number.isInteger(ttl) || ttl < 2 || ttl > 300) fail();
  await state(env).put(`access:${await digest(accessToken)}`, { clientId }, Date.now() + ttl * 1000);
  await state(env).put(`refresh:${await digest(refreshToken)}`, { clientId }, Number(env.EXPIRES_AT));
  return json({ access_token: accessToken, refresh_token: refreshToken, expires_in: ttl, token_type: 'Bearer', scope: SCOPE });
}
async function token(request, env) {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) fail();
  const form = fields(new URLSearchParams(await boundedText(request)),
    ['grant_type', 'client_id', 'code', 'redirect_uri', 'code_verifier', 'refresh_token', 'resource', 'scope']);
  v.parse(opaque, form.client_id);
  if (form.resource !== undefined && form.resource !== `${env.PUBLIC_ORIGIN}/mcp`) fail();
  if (form.scope !== undefined && form.scope !== SCOPE) fail();
  if (form.grant_type === 'authorization_code') {
    v.parse(opaque, form.code); v.parse(opaque, form.code_verifier);
    const code = await state(env).take(`code:${await digest(form.code)}`);
    if (!code || code.clientId !== form.client_id || code.redirectUri !== form.redirect_uri
      || !await equal(code.challenge, await digest(form.code_verifier))) fail();
    await state(env).bump('codeExchanges');
  } else if (form.grant_type === 'refresh_token') {
    v.parse(opaque, form.refresh_token);
    const grant = await state(env).take(`refresh:${await digest(form.refresh_token)}`);
    if (!grant || grant.clientId !== form.client_id) fail();
    await state(env).bump('refreshes');
  } else fail();
  return issueTokens(env, form.client_id);
}
async function callback(request, env) {
  const q = fields(new URL(request.url).searchParams, ['code', 'state']);
  v.parse(opaque, q.code); v.parse(opaque, q.state);
  const key = `session:${await digest(q.state)}`;
  const pending = await state(env).get(key);
  if (!pending || !await equal(pending.browserBinding, await digest(cookie(request)))) fail();
  const session = await state(env).take(key);
  if (!session) fail();
  await ownedSource(env);
  const metadata = config(env.PUBLIC_ORIGIN);
  const tokens = v.parse(v.strictObject({ access_token: opaque, refresh_token: opaque,
    expires_in: v.number(), token_type: v.literal('Bearer'), scope: v.literal(SCOPE) }),
  await fetchJson(metadata.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, code_verifier: session.verifier,
      client_id: session.registration.client_id, redirect_uri: `${env.PUBLIC_ORIGIN}/client/callback`, resource: metadata.resource }).toString() }));
  // Observed dashboard import format, deliberately confined to this prototype.
  await cloudflare(env, 'PUT', { auth_credentials: JSON.stringify({ tokens, config: metadata, registration_info: session.registration }) });
  await state(env).bump('imports');
  return redirect(`${env.PUBLIC_ORIGIN}/client/complete`, { 'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
}
const rpcSchema = v.object({ jsonrpc: v.literal('2.0'), id: v.optional(v.union([v.string(), v.number()])),
  method: v.string(), params: v.optional(v.looseObject({})) });
async function mcp(request, env) {
  await state(env).bump('mcpRequests');
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(request.headers.get('authorization') || '');
  if (!bearer || !await state(env).get(`access:${await digest(bearer[1])}`)) {
    await state(env).bump(bearer ? 'mcpInvalidBearer' : 'mcpMissingBearer');
    return json({ error: 'invalid_token' }, 401, { 'www-authenticate': `Bearer resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"` });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const rpc = await body(request, rpcSchema);
  await state(env).bump('mcpParsed');
  if (rpc.method === 'initialize') await state(env).bump('initialize');
  if (rpc.method === 'server/discover') await state(env).bump('discover');
  if (rpc.method === 'tools/list') await state(env).bump('listTools');
  if (rpc.id === undefined) return new Response(null, { status: 202, headers });
  const modern = rpc.method === 'server/discover' || request.headers.get('mcp-protocol-version') === '2026-07-28'
    || rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28';
  const reply = (result) => json({ jsonrpc: '2.0', id: rpc.id, result: modern ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...result,
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: FIXTURE, version: '1.0.0' } } } : result });
  if (rpc.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'],
    capabilities: { tools: {}, prompts: {}, resources: {} }, ttlMs: 0, cacheScope: 'private',
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: FIXTURE, version: '1.0.0' } } });
  if (rpc.method === 'initialize') return reply({ protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25'].includes(rpc.params?.protocolVersion)
    ? rpc.params.protocolVersion : '2025-11-25', capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: FIXTURE, version: '1.0.0' } });
  if (rpc.method === 'ping') return reply({});
  if (rpc.method === 'tools/list') return reply({ tools: [TOOL, OTHER_TOOL].map((name) => ({ name, description: 'Read constant synthetic fixture data.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } })) });
  if (rpc.method === 'prompts/list') return reply({ prompts: [] });
  if (rpc.method === 'resources/list') return reply({ resources: [] });
  if (rpc.method === 'resources/templates/list') return reply({ resourceTemplates: [] });
  if (rpc.method === 'tools/call' && [TOOL, OTHER_TOOL].includes(rpc.params?.name)) {
    await state(env).bump(rpc.params.name === TOOL ? 'readCalls' : 'otherReadCalls');
    return reply({ content: [{ type: 'text', text: JSON.stringify({ fixture: FIXTURE, value: 'synthetic', sharedGrant: true }) }], isError: false });
  }
  await state(env).bump('deniedCalls');
  return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Synthetic operation unavailable' } });
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.origin !== env.PUBLIC_ORIGIN || url.protocol !== 'https:'
        || !Number.isSafeInteger(Number(env.EXPIRES_AT)) || Date.now() >= Number(env.EXPIRES_AT)) fail();
      if (request.headers.has('origin') && request.headers.get('origin') !== url.origin) fail();
      if (url.pathname !== '/authorize' && url.pathname !== '/client/callback' && url.search) fail();
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case 'GET /health': return json({ fixture: FIXTURE });
        case 'GET /.well-known/oauth-authorization-server': return json(config(url.origin));
        case 'GET /.well-known/oauth-protected-resource':
        case 'GET /.well-known/oauth-protected-resource/mcp':
          return json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'] });
        case 'POST /register': return await register(request, env);
        case 'POST /client/start': return await start(request, env);
        case 'GET /authorize': return await authorize(request, env);
        case 'POST /token': return await token(request, env);
        case 'GET /client/callback': return await callback(request, env);
        case 'GET /client/complete': return json({ fixture: FIXTURE, result: 'callback_completed' });
        case 'GET /control/report': await controlled(request, env); return json({ fixture: FIXTURE, counters: await state(env).report() });
        case 'POST /mcp':
        case 'GET /mcp': return await mcp(request, env);
        default: return json({ error: 'not_found' }, 404);
      }
    } catch {
      if (new URL(request.url).pathname === '/mcp') await state(env).bump('rejectedMcp');
      return json({ error: 'proof_request_rejected' }, 400);
    }
  },
};
