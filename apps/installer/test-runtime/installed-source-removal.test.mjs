import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { cloudflareProvider, installReadyGateway } from '../../../test/payload-lifecycle.mjs';

import { pausedGateway } from './paused-source-fixture.mjs';

const origin = 'https://manage.example.com';
const sourcesKey = 'ankka-mcp-gateway/management-sources/v1';
const removalKey = 'ankka-mcp-gateway/source-removal/v1';
const teamKey = 'ankka-mcp-gateway/team-access/v1';

for (const state of ['installed', 'connection-paused']) test(`${state} source removal resumes its SQLite journal after restart and preserves the root receipt`, async () => {
  let interrupt = true;
  const onRequest = ({ record, state }) => {
    if (interrupt && record.method === 'DELETE' && record.pathname.includes('/mcp/servers/')) {
      state.servers.delete(record.pathname.split('/').at(-1));
      return new Response(null, { status: 503 });
    }
  };
  const gateway = state === 'connection-paused' ? await pausedGateway({ onRequest })
    : await installReadyGateway({ provider: cloudflareProvider({ onRequest }) });
  const provider = gateway.provider;
  gateway.env.ANKKA_MANAGEMENT_TOKEN = 'synthetic-removal-token-never-store';
  const management = Object.fromEntries(await gateway.objects.get('v1:management').storage.list());
  const root = Object.fromEntries(await gateway.objects.get(`v1:${gateway.env.ANKKA_INSTALL_ID}`).storage.list());
  const { revision, sources: [source] } = management[sourcesKey];
  assert.equal(source.status, state === 'connection-paused' ? 'draft' : 'installed');
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./installed-source-removal-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  const directory = await mkdtemp(join(tmpdir(), 'ankka-removal-runtime-'));
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
  const remove = () => post('/source-removal', { schemaVersion: 1, revision, sourceId: source.id, actorEmail: 'admin@example.com' });
  try {
    runtime = boot(); await runtime.ready;
    assert.equal((await post('/fixture/seed', management)).status, 200);
    assert.equal((await post('/fixture/seed', root, true)).status, 200);
    const proof = await post('/teardown-root', { schemaVersion: 1, installationId: gateway.env.ANKKA_INSTALL_ID }, true);
    assert.equal(proof.status, 200, await proof.clone().text());
    const first = await remove();
    assert.equal(first.status, 409, await first.clone().text());
    assert.equal((await first.json()).error, 'source_removal_recovery_required');
    const pending = await (await runtime.dispatchFetch(`${origin}/fixture/state`)).json();
    assert.equal(pending[removalKey].step, 1);
    assert.equal(pending[removalKey].pending, true);
    assert.equal(pending[sourcesKey].sources.length, 1);
    await runtime.dispose(); runtime = boot(); await runtime.ready;
    interrupt = false;
    const writesBefore = provider.requests.filter((request) => request.method === 'DELETE' && request.pathname.includes('/mcp/servers/')).length;
    const resumed = await remove();
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const finished = await (await runtime.dispatchFetch(`${origin}/fixture/state`)).json();
    assert.deepEqual(finished[sourcesKey].sources, []);
    assert.equal(finished[removalKey], null);
    if (state === 'connection-paused') assert.deepEqual(finished['ankka-mcp-gateway/source-actions/v1'].actions, []);
    assert.equal(finished[teamKey].members.every((member) => member.sourceIds.length === 0), true);
    assert.ok(!JSON.stringify(finished).includes(gateway.env.ANKKA_MANAGEMENT_TOKEN));
    assert.deepEqual(await (await runtime.dispatchFetch(`${origin}/fixture/state`, { headers: { 'x-fixture-root': 'true' } })).json(), root);
    assert.equal(provider.requests.filter((request) => request.method === 'DELETE' && request.pathname.includes('/mcp/servers/')).length, writesBefore);
    assert.deepEqual(provider.state.portal.servers ?? [], []);
    assert.equal(provider.state.servers.size, 0);
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
