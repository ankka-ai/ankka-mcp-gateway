import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { cloudflareProvider, installReadyGateway } from '../../../test/payload-lifecycle.mjs';
import { addHistoricalInstalledSource } from '../../../test/historical-source-fixture.mjs';

const origin = 'https://manage.example.com';
const teamKey = 'ankka-mcp-gateway/team-access/v1';

test('Team resumes seven-source access from SQLite after restart without replaying committed writes', async () => {
  let writes = 0;
  const provider = cloudflareProvider({ onRequest: ({ record, state }) => {
    const envelope = (result) => Response.json({ success: true, errors: [], result });
    if (record.pathname.endsWith('/tokens/verify')) return envelope({ status: 'active' });
    if (record.method !== 'PUT' || !record.pathname.includes('/policies/')) return;
    const parts = record.pathname.split('/');
    const policy = { id: parts.at(-1), ...record.body };
    assert.ok(state.policies.get(parts.at(-3)).some(({ id }) => id === policy.id));
    state.policies.set(parts.at(-3), [policy]);
    // The provider committed the third write, but its response was lost.
    if (++writes === 3) return new Response(null, { status: 503 });
    return envelope(policy);
  } });
  const gateway = await installReadyGateway({ provider });
  for (let index = 1; index < 7; index += 1) {
    await addHistoricalInstalledSource(gateway, { label: `Source ${index}`, url: `https://source-${index}.example.net/mcp` });
  }
  gateway.env.ANKKA_MANAGEMENT_TOKEN = 'synthetic-team-token-never-store';
  const management = Object.fromEntries(await gateway.objects.get('v1:management').storage.list());
  const root = Object.fromEntries(await gateway.objects.get(`v1:${gateway.env.ANKKA_INSTALL_ID}`).storage.list());
  // Reuse the minimal two-object fixture; requests still execute production
  // AdminState code and the journal lives in actual SQLite storage.
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./installed-source-removal-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  const directory = await mkdtemp(join(tmpdir(), 'ankka-team-runtime-'));
  let runtime;
  const boot = () => new Miniflare({ host: '127.0.0.1', port: 0, cf: false,
    unsafeDevRegistryPath: join(directory, 'registry'), resourcePersistencePath: join(directory, 'storage'),
    workers: [{ config: { type: 'worker', name: 'team-runtime', compatibilityDate: '2026-08-14',
      manifest: { mainModule: 'fixture.mjs', modules: { 'fixture.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
      env: { ...Object.fromEntries(Object.entries(gateway.env).filter(([key]) => key !== 'ADMIN_STATE')
        .map(([key, value]) => [key, { type: 'text', value }])),
      ADMIN_STATE: { type: 'durable-object', workerName: 'team-runtime', exportName: 'RemovalState' } },
      exports: { RemovalState: { type: 'durable-object', storage: 'sqlite' } } },
    dev: { outboundService: { type: 'fetcher', handler: (request) => {
      assert.equal(new URL(request.url).origin, 'https://api.cloudflare.com');
      return provider.fetch(new Request(request.url, { method: request.method, headers: request.headers,
        body: request.body, duplex: 'half', redirect: 'manual' }));
    } } } }] });
  const post = (path, body, isRoot = false) => runtime.dispatchFetch(`${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-root': String(isRoot) }, body: JSON.stringify(body),
  });
  try {
    runtime = boot(); await runtime.ready;
    assert.equal((await post('/fixture/seed', management)).status, 200);
    assert.equal((await post('/fixture/seed', root, true)).status, 200);
    const response = await runtime.dispatchFetch(`${origin}/team`);
    assert.equal(response.status, 200, await response.clone().text());
    const before = await response.json();
    const input = { schemaVersion: 1, expectedRevision: before.revision,
      members: [...before.members, { email: 'new-person@example.com', sourceIds: before.sources.map(({ id }) => id) }] };
    const apply = () => {
      const issuedAt = Date.now();
      return post('/team-actions', { request: input, actorEmail: 'admin@example.com',
        actionId: `action_${'A'.repeat(32)}`, actionKeyHash: `sha256:${'b'.repeat(64)}`, issuedAt, expiresAt: issuedAt + 600_000 });
    };
    const interrupted = await apply();
    assert.equal(interrupted.status, 409, await interrupted.clone().text());
    const pending = await (await runtime.dispatchFetch(`${origin}/fixture/state`)).json();
    assert.deepEqual(pending[teamKey].pendingAction.journal.map(({ phase }) => phase), ['verified', 'verified', 'send_armed']);
    const committedIds = pending[teamKey].pendingAction.journal.map(({ policyId }) => policyId);
    await runtime.dispose(); runtime = boot(); await runtime.ready;
    const baseline = provider.requests.length;
    const resumed = await apply();
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.equal(writes, 8, 'the three previously committed policies are never replayed');
    for (const policyId of committedIds) {
      const applicationId = [...provider.state.policies].find(([, policies]) => policies.some(({ id }) => id === policyId))[0];
      const reads = provider.requests.slice(baseline).filter(({ pathname }) => pathname.endsWith(`/apps/${applicationId}/policies`));
      assert.equal(reads.length, 2, 'completed targets need only the initial and final graph checks');
    }
    const finished = await (await runtime.dispatchFetch(`${origin}/fixture/state`)).json();
    assert.equal(finished[teamKey].pendingAction.status, 'succeeded');
    assert.equal(finished[teamKey].members.find(({ email }) => email === 'new-person@example.com').sourceIds.length, 7);
    assert.ok(!JSON.stringify(finished).includes(gateway.env.ANKKA_MANAGEMENT_TOKEN));
    assert.deepEqual(await (await runtime.dispatchFetch(`${origin}/fixture/state`, { headers: { 'x-fixture-root': 'true' } })).json(), root);
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
