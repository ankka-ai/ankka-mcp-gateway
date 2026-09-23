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
const teamKey = 'ankka-mcp-gateway/team-access/v1';

test('Dashboard grant resumes from SQLite after a lost policy write and revocation survives restart', async () => {
  let writes = 0;
  const provider = cloudflareProvider({ onRequest: ({ record, state }) => {
    const envelope = (result) => Response.json({ success: true, errors: [], result });
    if (record.pathname.endsWith('/tokens/verify')) return envelope({ status: 'active' });
    if (record.method !== 'PUT' || !record.pathname.includes('/policies/')) return;
    const parts = record.pathname.split('/');
    const policy = { id: parts.at(-1), ...record.body };
    assert.ok(state.policies.get(parts.at(-3)).some(({ id }) => id === policy.id));
    state.policies.set(parts.at(-3), [policy]);
    // The provider committed the dashboard write, but its response was lost.
    if (++writes === 1) return new Response(null, { status: 503 });
    return envelope(policy);
  } });
  const gateway = await installReadyGateway({ provider });
  const target = {
    applicationId: 'synthetic-dashboard-app', policyId: 'synthetic-dashboard-policy',
    applicationName: 'Synthetic dashboard', policyName: 'Synthetic administrators',
    hostname: 'manage.example.com', aud: gateway.env.CF_ACCESS_AUD, allowedIdps: ['synthetic-idp'],
  };
  gateway.env.FIXTURE_DASHBOARD_TARGET = JSON.stringify(target);
  provider.state.apps.set(target.applicationId, { id: target.applicationId, type: 'self_hosted',
    domain: target.hostname, name: target.applicationName, aud: target.aud, allowed_idps: target.allowedIdps });
  provider.state.policies.set(target.applicationId, [{ id: target.policyId, name: target.policyName,
    decision: 'allow', precedence: 1, include: ['admin@example.com', 'owner@example.com'].map(email => ({ email: { email } })),
    exclude: [], require: [] }]);
  gateway.env.ANKKA_MANAGEMENT_TOKEN = 'synthetic-team-token-never-store';
  const management = Object.fromEntries(await gateway.objects.get('v1:management').storage.list());
  const root = Object.fromEntries(await gateway.objects.get(`v1:${gateway.env.ANKKA_INSTALL_ID}`).storage.list());
  // Reuse the minimal two-object fixture; requests still execute production
  // AdminState code and the journal lives in actual SQLite storage.
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./installed-source-removal-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  const directory = await mkdtemp(join(tmpdir(), 'ankka-dashboard-runtime-'));
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
      members: before.members.map(member => member.email === 'member@example.com' ? { ...member, dashboardAccess: true } : member) };
    const apply = () => {
      const issuedAt = Date.now();
      return post('/team-actions', { request: input, actorEmail: 'admin@example.com',
        actionId: `action_${'A'.repeat(32)}`, actionKeyHash: `sha256:${'b'.repeat(64)}`, issuedAt, expiresAt: issuedAt + 600_000 });
    };
    const interrupted = await apply();
    assert.equal(interrupted.status, 409, await interrupted.clone().text());
    const pending = await (await runtime.dispatchFetch(`${origin}/fixture/state`)).json();
    assert.deepEqual(pending[teamKey].pendingAction.journal.map(({ phase }) => phase), ['send_armed']);
    assert.equal((await post('/dashboard-access', { email: 'member@example.com' })).status, 403);
    await runtime.dispose(); runtime = boot(); await runtime.ready;
    const resumed = await apply();
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.equal(writes, 1, 'the committed dashboard policy is not written again');
    assert.equal((await post('/dashboard-access', { email: 'member@example.com' })).status, 204);
    const finished = await (await runtime.dispatchFetch(`${origin}/fixture/state`)).json();
    assert.equal(finished[teamKey].pendingAction.status, 'succeeded');
    assert.equal(finished[teamKey].members.find(({ email }) => email === 'member@example.com').dashboardAccess, true);
    input.expectedRevision = finished[teamKey].revision;
    input.members = input.members.map(member => member.email === 'member@example.com' ? { ...member, dashboardAccess: false } : member);
    assert.equal((await apply()).status, 200);
    await runtime.dispose(); runtime = boot(); await runtime.ready;
    assert.equal((await post('/dashboard-access', { email: 'member@example.com' })).status, 403);
    assert.equal((await post('/dashboard-access', { email: 'admin@example.com' })).status, 204);
    assert.ok(!JSON.stringify(finished).includes(gateway.env.ANKKA_MANAGEMENT_TOKEN));
    assert.deepEqual(await (await runtime.dispatchFetch(`${origin}/fixture/state`, { headers: { 'x-fixture-root': 'true' } })).json(), root);
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
