import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import worker, { managedSourceHash } from '../../../payload/worker/index.js';
import { ACCOUNT_ID, canonicalJson, cloudflareProvider, installReadyGateway, portalOnlyClaim, prefixedSha256, withProviderFetch } from '../../../test/payload-lifecycle.mjs';

const sourceUrl = 'https://source.example.net/mcp';
const origin = 'https://manage.example.com';
const oauthKey = 'ankka-mcp-gateway/source-oauth/v1';
const sourcesKey = 'ankka-mcp-gateway/management-sources/v1';
const actionsKey = 'ankka-mcp-gateway/source-actions/v1';
const moduleCode = await build({ entryPoints: [fileURLToPath(new URL('./source-oauth-worker.mjs', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });

// Produce the seed through the actual installer, draft save, prepare and apply.
// No hand-authored receipts or hashes can make the runtime test accept a state
// that production would not create.
async function pausedGateway() {
  const provider = cloudflareProvider({ onRequest({ record, state }) {
    if (record.method === 'POST' && record.pathname.endsWith('/mcp/servers')) {
      const server = { ...record.body, authentication_status: 'required', status: 'waiting', tools: [] };
      state.servers.set(server.id, server);
      return Response.json({ success: true, result: server });
    }
  } });
  const gateway = await installReadyGateway({ provider, claimInput: await portalOnlyClaim() });
  gateway.env.ANKKA_MANAGEMENT_TOKEN = randomBytes(32).toString('base64url');
  const stub = gateway.env.ADMIN_STATE.get('v1:management');
  const storage = gateway.objects.get('v1:management').storage;
  const post = (path, body, put = false) => stub.fetch(new Request(`https://admin-state.invalid${path}`, {
    method: put ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: canonicalJson(body),
  }));
  const saved = await post('/sources', { schemaVersion: 1, revision: storage.snapshot(sourcesKey).revision,
    source: { label: 'Synthetic sign-in', url: sourceUrl, authMode: 'oauth', enabledTools: [] } }, true);
  assert.equal(saved.status, 200, await saved.clone().text());
  const sources = await saved.json(), source = sources.sources.at(-1);
  const actionKey = randomBytes(32).toString('base64url'), issuedAt = Date.now();
  const actionId = `action_${randomBytes(24).toString('base64url')}`;
  const prepared = await post('/source-actions', { schemaVersion: 1, actionId, sourceId: source.id, sourceRevision: sources.revision,
    actorEmail: 'admin@example.com', issuedAt, expiresAt: issuedAt + 600_000,
    actionKeyHash: await prefixedSha256(actionKey), sourceHash: await managedSourceHash(source) });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const body = canonicalJson({ schemaVersion: 1, actionId, actionKey, actorEmail: 'admin@example.com', accountId: ACCOUNT_ID,
    issuedAt, expiresAt: issuedAt + 600_000, cloudflareAccessToken: gateway.env.ANKKA_MANAGEMENT_TOKEN });
  const signature = createHmac('sha256', Buffer.from(actionKey, 'base64url')).update(body).digest('hex');
  const applied = await withProviderFetch((request) => request.url === sourceUrl
    ? Promise.resolve(new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://source.example.net/.well-known/oauth-protected-resource/mcp"' } }))
    : provider.fetch(request), () => worker.fetch(new Request('https://ankka-gateway-test.tenant.workers.dev/__ankka/source-action', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ankka-source-action-signature': `sha256=${signature}` }, body,
  }), gateway.env));
  assert.equal((await applied.json()).error, 'source_connection_required');
  return { ...gateway, storage, source, action: storage.snapshot(actionsKey).actions.at(-1), revision: sources.revision };
}

test('production source OAuth consumes its SQLite attempt once across concurrent callbacks and a workerd restart', async () => {
  const gateway = await pausedGateway();
  const directory = await mkdtemp(join(tmpdir(), 'ankka-source-oauth-runtime-'));
  let runtime, exchanges = 0, imports = 0;
  const trace = [];
  const accessToken = randomBytes(32).toString('base64url'), refreshToken = randomBytes(32).toString('base64url');
  const config = { issuer: 'https://identity.example.net', authorization_endpoint: 'https://identity.example.net/authorize',
    token_endpoint: 'https://identity.example.net/token', registration_endpoint: 'https://identity.example.net/register',
    code_challenge_methods_supported: ['S256'] };
  async function outbound(request) {
    const url = new URL(request.url);
    trace.push({ method: request.method, url: url.href });
    if (url.href === sourceUrl) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
    if (url.href === 'https://source.example.net/.well-known/oauth-protected-resource/mcp') return Response.json({ resource: sourceUrl, authorization_servers: [config.issuer] });
    if (url.href === `${config.issuer}/.well-known/oauth-authorization-server`) return Response.json(config);
    if (url.href === config.registration_endpoint) return Response.json({ ...await request.json(), client_id: 'synthetic-public-client' });
    if (url.href === config.token_endpoint) { exchanges++; return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 60 }); }
    if (url.origin === 'https://api.cloudflare.com') {
      if (request.method === 'PUT') {
        const imported = JSON.parse((await request.json()).auth_credentials);
        assert.equal(imported.tokens.access_token, accessToken);
        imports++;
        return Response.json({ success: true, result: {} });
      }
      if (url.pathname.endsWith('/sync')) return Response.json({ success: true, result: {} });
      assert.equal(url.pathname, `/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/servers/${gateway.action.resources[0].provider.id}`);
      return Response.json({ success: true, result: gateway.provider.state.servers.get(gateway.action.resources[0].provider.id) });
    }
    assert.fail('Unexpected outbound destination');
  }
  const textBindings = Object.entries(gateway.env).filter(([key]) => key !== 'ADMIN_STATE');
  function boot() {
    return new Miniflare({ host: '127.0.0.1', port: 0, cf: false, unsafeDevRegistryPath: join(directory, 'registry'), resourcePersistencePath: join(directory, 'storage'),
      workers: [{ config: { type: 'worker', name: 'source-oauth-runtime', compatibilityDate: '2026-08-08',
        manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: moduleCode.outputFiles[0].text } } },
        env: { ...Object.fromEntries(textBindings.map(([key, value]) => [key, { type: 'text', value }])),
          ADMIN_STATE: { type: 'durable-object', workerName: 'source-oauth-runtime', exportName: 'SourceOauthState' } },
        exports: { SourceOauthState: { type: 'durable-object', storage: 'sqlite' } } },
      dev: { outboundService: { type: 'fetcher', handler: outbound } } }] });
  }
  const post = (path, body) => runtime.dispatchFetch(`${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    runtime = boot(); await runtime.ready;
    await post('/fixture/seed', Object.fromEntries(await gateway.storage.list()));
    const started = await post('/source-oauth/start', { schemaVersion: 1, actionId: gateway.action.actionId,
      sourceId: gateway.source.id, revision: gateway.revision, actorEmail: 'admin@example.com' });
    assert.equal(started.status, 200, JSON.stringify({ response: await started.clone().json(), trace }));
    const authorization = new URL((await started.json()).authorizationUrl);
    const browser = started.headers.get('set-cookie').split(';')[0].split('=')[1];
    await runtime.dispose(); runtime = boot(); await runtime.ready;
    const input = { actorEmail: 'admin@example.com', state: authorization.searchParams.get('state'), browser,
      code: 'synthetic-code', denied: false, issuer: null };
    const callbacks = await Promise.all([post('/source-oauth/callback', input), post('/source-oauth/callback', input)]);
    assert.deepEqual(callbacks.map((response) => response.status).sort(), [200, 409]);
    assert.equal(exchanges, 1); assert.equal(imports, 1);
    const retained = await (await runtime.dispatchFetch(`${origin}/fixture/state`)).json();
    assert.equal(retained[oauthKey], undefined);
    assert.ok(!JSON.stringify(retained).includes(accessToken)); assert.ok(!JSON.stringify(retained).includes(refreshToken));
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
