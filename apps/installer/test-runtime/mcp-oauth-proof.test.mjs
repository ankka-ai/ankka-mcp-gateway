import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const origin = 'https://oauth-proof.example.com';
const sourceId = 'oauth-proof-0123456789ab';
const marker = `ankka-mcp-oauth-proof:${sourceId}`;
const account = '1'.repeat(32);
const providerPath = `/client/v4/accounts/${account}/access/ai-controls/mcp/servers/${sourceId}`;
const moduleCode = await build({ entryPoints: [fileURLToPath(new URL('../../../fixtures/mcp-oauth-proof/worker.mjs', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ankka-oauth-proof-test-'));
  const control = randomBytes(32).toString('base64url');
  const management = randomBytes(32).toString('base64url');
  const vars = { PUBLIC_ORIGIN: origin, ACCOUNT_ID: account, SERVER_ID: sourceId, CONTROL_SECRET: control,
    ANKKA_MANAGEMENT_TOKEN: management, EXPIRES_AT: String(Date.now() + 300_000), ACCESS_TTL_SECONDS: '2' };
  let imported, drift = false, providerRedirect = false, writes = 0, unexpected = 0, runtime;
  async function outbound(request) {
    const url = new URL(request.url);
    if (url.origin === origin) return runtime.dispatchFetch(request.url, request);
    if (url.origin !== 'https://api.cloudflare.com' || url.pathname !== providerPath) {
      unexpected++; return Response.json({ error: 'network_refused' }, { status: 502 });
    }
    assert.ok(request.headers.get('authorization') === `Bearer ${management}`);
    if (providerRedirect) return new Response(null, { status: 302, headers: { location: 'https://untrusted.example.net/' } });
    if (request.method === 'PUT') {
      imported = JSON.parse((await request.json()).auth_credentials); writes++;
    }
    return Response.json({ success: true, result: { id: sourceId, hostname: `${origin}/mcp`,
      description: drift ? 'another-owner' : marker, auth_type: 'oauth' } });
  }
  runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, unsafeDevRegistryPath: directory,
    workers: [{ config: { type: 'worker', name: 'oauth-proof-test', compatibilityDate: '2026-09-02',
      compatibilityFlags: ['global_fetch_strictly_public'],
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: moduleCode.outputFiles[0].text } } },
      env: { ...Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, { type: 'text', value }])),
        STATE: { type: 'durable-object', workerName: 'oauth-proof-test', exportName: 'OAuthProofState' } },
      exports: { OAuthProofState: { type: 'durable-object', storage: 'sqlite' } } },
    dev: { outboundService: { type: 'fetcher', handler: outbound } } }] });
  try { await runtime.ready; }
  catch (error) { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); throw error; }
  const request = (path, init = {}) => runtime.dispatchFetch(new URL(path, origin).href, { ...init, redirect: 'manual' });
  async function begin() {
    const started = await request('/client/start', { method: 'POST', headers: { authorization: `Bearer ${control}` } });
    assert.equal(started.status, 303);
    const cookie = started.headers.get('set-cookie').split(';')[0];
    const authorizeUrl = started.headers.get('location');
    const authorized = await request(authorizeUrl, { headers: { cookie } });
    assert.equal(authorized.status, 303);
    return { cookie, authorizeUrl, callbackUrl: authorized.headers.get('location') };
  }
  return { request, begin, imported: () => imported, writes: () => writes,
    drift: () => { drift = true; }, redirect: () => { providerRedirect = true; },
    async report() { return (await request('/control/report', { headers: { authorization: `Bearer ${control}` } })).json(); },
    async dispose() { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); assert.equal(unexpected, 0); } };
}

test('self-hosted callback imports a synthetic grant once and never returns it to the browser', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/client/start', { method: 'POST' })).status, 400);
    const flow = await f.begin();
    const callback = await f.request(flow.callbackUrl, { headers: { cookie: flow.cookie } });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), `${origin}/client/complete`);
    assert.equal(callback.headers.get('cache-control'), 'no-store');
    assert.equal(await callback.text(), '');
    assert.equal(f.writes(), 1);
    assert.equal(f.imported().registration_info.redirect_uris[0], `${origin}/client/callback`);
    assert.equal(f.imported().tokens.scope, 'ankka:read');
    assert.equal((await f.request(flow.callbackUrl, { headers: { cookie: flow.cookie } })).status, 400);
    const reply = await f.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${f.imported().tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'synthetic_status' } }) });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).result.isError, false);
    assert.deepEqual(await f.report(), { fixture: 'ankka-mcp-oauth-proof', counters: { startAccepted: 1, sourceOwned: 1, metadataDiscovered: 1, registered: 1, authorized: 1, codeExchanges: 1, imports: 1, mcpRequests: 1, mcpParsed: 1, readCalls: 1 } });
  } finally { await f.dispose(); }
});

test('callback binds state to the initiating browser and rejects duplicate query parameters', async () => {
  const f = await fixture();
  try {
    const flow = await f.begin();
    assert.equal((await f.request(flow.callbackUrl)).status, 400);
    assert.equal((await f.request(flow.callbackUrl, { headers: { cookie: `__Host-ankka-proof=${randomBytes(32).toString('base64url')}` } })).status, 400);
    const duplicate = `${flow.callbackUrl}&state=duplicate`;
    assert.equal((await f.request(duplicate, { headers: { cookie: flow.cookie } })).status, 400);
    assert.equal(f.writes(), 0);
    assert.equal((await f.request(flow.callbackUrl, { headers: { cookie: flow.cookie } })).status, 303);
  } finally { await f.dispose(); }
});

test('competing callbacks consume the grant once and the fixture supports modern discovery', async () => {
  const f = await fixture();
  try {
    const flow = await f.begin();
    const callbacks = await Promise.all([1, 2].map(() => f.request(flow.callbackUrl, { headers: { cookie: flow.cookie } })));
    assert.deepEqual(callbacks.map((response) => response.status).sort(), [303, 400]);
    assert.equal(f.writes(), 1);
    for (const method of ['server/discover', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']) {
      const response = await f.request('/mcp', { method: 'POST', headers: {
        authorization: `Bearer ${f.imported().tokens.access_token}`, 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
      const { result } = await response.json();
      assert.equal(result.resultType, 'complete');
      assert.equal(result.ttlMs, 0);
      assert.equal(result.cacheScope, 'private');
      if (method === 'server/discover') assert.deepEqual(result.supportedVersions, ['2026-07-28']);
    }
  } finally { await f.dispose(); }
});

test('authorization codes enforce PKCE and cannot be exchanged after a failed verifier', async () => {
  const f = await fixture();
  try {
    const flow = await f.begin();
    const query = new URL(flow.callbackUrl).searchParams;
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: query.get('code'),
      client_id: new URL(flow.authorizeUrl).searchParams.get('client_id'), redirect_uri: `${origin}/client/callback`, code_verifier: randomBytes(32).toString('base64url') });
    assert.equal((await f.request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() })).status, 400);
    assert.equal((await f.request(flow.callbackUrl, { headers: { cookie: flow.cookie } })).status, 400);
    assert.equal(f.writes(), 0);
  } finally { await f.dispose(); }
});

test('ownership drift and provider redirects fail before any credential write', async () => {
  for (const scenario of ['drift', 'redirect']) {
    const f = await fixture();
    try {
      const flow = await f.begin(); f[scenario]();
      const response = await f.request(flow.callbackUrl, { headers: { cookie: flow.cookie } });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'proof_request_rejected' });
      assert.equal(f.writes(), 0);
      assert.equal((await f.report()).counters.codeExchanges, undefined);
    } finally { await f.dispose(); }
  }
});

test('synthetic access expires; refresh rotates the token and rejects replay and write tools', async () => {
  const f = await fixture();
  try {
    const flow = await f.begin();
    assert.equal((await f.request(flow.callbackUrl, { headers: { cookie: flow.cookie } })).status, 303);
    const imported = f.imported();
    await setTimeout(2_100);
    assert.equal((await f.request('/mcp', { headers: { authorization: `Bearer ${imported.tokens.access_token}` } })).status, 401);
    const init = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: imported.registration_info.client_id, refresh_token: imported.tokens.refresh_token,
    }).toString() };
    const refreshed = await f.request('/token', init);
    assert.equal(refreshed.status, 200);
    const tokens = await refreshed.json();
    assert.ok(tokens.refresh_token !== imported.tokens.refresh_token);
    assert.equal((await f.request('/token', init)).status, 400);
    const denied = await f.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'synthetic_write' } }) });
    assert.equal((await denied.json()).error.code, -32601);
    assert.equal((await f.report()).counters.refreshes, 1);
  } finally { await f.dispose(); }
});
