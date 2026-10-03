import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { cloudflareProvider, installReadyGateway } from '../../../test/payload-lifecycle.mjs';


const origin = 'https://manage.example.com';
const sourcesKey = 'ankka-mcp-gateway/management-sources/v1';
const editKey = 'ankka-mcp-gateway/source-label-edit/v1';


test('Company change resumes its SQLite journal after restart without repeating the accepted server write', async () => {
  let interrupt = true;
  const provider = cloudflareProvider({ onRequest({ record, state }) {
    if (interrupt && record.method === 'PUT' && record.pathname.includes('/mcp/servers/')) {
      Object.assign(state.servers.get(record.pathname.split('/').at(-1)), record.body);
      return new Response(null, { status: 503 });
    }
  } });
  const gateway = await installReadyGateway({ provider });
  gateway.env.ANKKA_MANAGEMENT_TOKEN = 'synthetic-context-token-never-store';
  const management = Object.fromEntries(await gateway.objects.get('v1:management').storage.list());
  const root = Object.fromEntries(await gateway.objects.get(`v1:${gateway.env.ANKKA_INSTALL_ID}`).storage.list());
  const { revision, sources: [source] } = management[sourcesKey];
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./installed-source-removal-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  const directory = await mkdtemp(join(tmpdir(), 'ankka-company-runtime-'));
  let runtime;
  const boot = () => new Miniflare({ host: '127.0.0.1', port: 0, cf: false,
    unsafeDevRegistryPath: join(directory, 'registry'), resourcePersistencePath: join(directory, 'storage'),
    workers: [{ config: { type: 'worker', name: 'installed-removal-runtime', compatibilityDate: '2026-08-14',
      manifest: { mainModule: 'fixture.mjs', modules: { 'fixture.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
      env: { ...Object.fromEntries(Object.entries(gateway.env).filter(([key]) => key !== 'ADMIN_STATE')
        .map(([key, value]) => [key, { type: 'text', value }])),
      ADMIN_STATE: { type: 'durable-object', workerName: 'installed-removal-runtime', exportName: 'RemovalState' } },
      exports: { RemovalState: { type: 'durable-object', storage: 'sqlite' } } },
    dev: { outboundService: { type: 'fetcher', handler: (request) => {
      assert.equal(new URL(request.url).origin, 'https://api.cloudflare.com');
      // The outbound service transport reconstructs Request.redirect. The
      // production fetch already selected manual redirects before this hop.
      return provider.fetch(new Request(request.url, { method: request.method, headers: request.headers,
        body: request.body, duplex: 'half', redirect: 'manual' }));
    } } } }] });
  const post = (path, body, isRoot = false) => runtime.dispatchFetch(`${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-root': String(isRoot) }, body: JSON.stringify(body),
  });
  const save = () => runtime.dispatchFetch(`${origin}/sources/${source.id}/label`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-ankka-actor-email': 'admin@example.com' },
    body: JSON.stringify({ schemaVersion: 1, revision, label: source.label, company: 'Company B' }),
  });
  try {
    runtime = boot(); await runtime.ready;
    assert.equal((await post('/fixture/seed', management)).status, 200);
    assert.equal((await post('/fixture/seed', root, true)).status, 200);
    const first = await save();
    assert.equal(first.status, 409, await first.clone().text());
    assert.equal((await first.json()).error, 'source_label_recovery_required');
    const pending = await (await runtime.dispatchFetch(`${origin}/fixture/state`)).json();
    assert.equal(pending[editKey].company, 'Company B');
    assert.equal(pending[sourcesKey].revision, revision);
    await runtime.dispose(); runtime = boot(); await runtime.ready;
    interrupt = false;
    const serverWrites = () => provider.requests.filter((request) => request.method === 'PUT' && request.pathname.includes('/mcp/servers/')).length;
    const before = serverWrites();
    const resumed = await save();
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const finished = await (await runtime.dispatchFetch(`${origin}/fixture/state`)).json();
    assert.equal(finished[sourcesKey].sources[0].company, 'Company B');
    assert.equal(finished[editKey], null);
    assert.equal(serverWrites(), before);
    assert.ok(provider.state.portal.servers[0].updated_tools.every((tool) => tool.description.startsWith('Company: "Company B".')));
    assert.ok(!JSON.stringify(finished).includes(gateway.env.ANKKA_MANAGEMENT_TOKEN));
    assert.deepEqual(await (await runtime.dispatchFetch(`${origin}/fixture/state`, { headers: { 'x-fixture-root': 'true' } })).json(), root);
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
