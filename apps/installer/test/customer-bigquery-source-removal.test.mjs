import { AdminState } from '../../../payload/worker/index.js';
import { installReadyGateway, ACCOUNT_ID, ZONE_ID, INSTALLATION_ID } from '../../../test/payload-lifecycle.mjs';
import { createBigQuerySetup } from '../src/customer-bigquery-setup';
import { createBigQueryTeardown } from '../src/customer-bigquery-teardown';
import { base64UrlDecode } from '../src/crypto';
import { fixture as bridgeFixture, grant, JOURNAL } from './bigquery-teardown-fixture.mjs';

const SOURCES = 'ankka-mcp-gateway/management-sources/v1';
const ACTIONS = 'ankka-mcp-gateway/source-actions/v1';
const context = { accountId: ACCOUNT_ID, zoneId: ZONE_ID, installationId: INSTALLATION_ID,
  zoneName: 'example.com', accessIssuer: 'https://example.cloudflareaccess.com' };
async function fixture(options = {}) {
  const { env, objects } = await installReadyGateway();
  const storage = objects.get('v1:management').storage;
  const bridge = await bridgeFixture({ ...options, fixtureContext: context, journalStorage: storage, scoped: true });
  bridge.provider.servers = [];
  await storage.put(bridge.key, bridge.record);
  const current = await storage.get(SOURCES);
  const source = { ...bridge.snapshot.sources.sources[0], status: 'draft' };
  await storage.put(SOURCES, { ...current, revision: current.revision + 1,
    sources: [...current.sources, source].sort((a,b)=>a.id.localeCompare(b.id)) });
  const now = Date.now();
  const action = { ...bridge.snapshot.actions[0], schemaVersion: 1, sourceRevision: current.revision + 1,
    initialPolicyVersion: 2, issuedAt: now - 700_000, expiresAt: now - 100_000,
    status: 'recovery_required', actionKeyHash: `sha256:${'0'.repeat(64)}`,
    resources: [], pending: null, portalUpdate: null, failureCode: 'source_discovery_failed' };
  await storage.put(ACTIONS, { schemaVersion: 1, revision: 1, actions: [action] });
  const managed = createBigQueryTeardown(context, { storage, fetch: bridge.fetch });
  const runtime = new AdminState({ storage }, env, managed);
  const counts = [];
  const setup = createBigQuerySetup({ ...context, managementOrigin: 'https://manage.example.com', workerName: 'ankka-gateway',
    workersSubdomain: 'example', controlPlaneOrigin: 'https://deploy.ankka.ai',
    releaseIdentity: { schemaVersion: 1, channel: 'canary', controlPlaneOrigin: 'https://deploy.ankka.ai',
      release: 'gateway-v1.0.0', keyId: 'test-key', publicKey: 'p'.repeat(43), artifactSha256: 'a'.repeat(64) },
  }, { storage, fetch: bridge.fetch, runtime: (request) => runtime.fetch(request),
    removalRuntime: async (request) => {
      const before = bridge.requests.length;
      try { return await runtime.fetch(request); } finally { counts.push(bridge.requests.length - before); }
    } });
  const prepare = async (actor = 'admin@example.com', revision) => setup.prepareRemoval(new Request('https://manage.example.com/api/bigquery/remove', {
    method: 'POST', body: JSON.stringify({ schemaVersion: 1, sourceId: source.id,
      revision: revision ?? (await storage.get(SOURCES)).revision }),
  }), actor);
  const authorize = async () => {
    const response = await prepare();
    expect(response.status).toBe(200);
    const result = await response.json();
    const claim = JSON.parse(new TextDecoder().decode(base64UrlDecode(new URL(result.handoffUrl).hash.slice(1))));
    expect(claim.actionType).toBe('bigquery_remove');
    return { actionId: claim.actionId, actionKey: claim.actionKey, actorEmail: claim.actorEmail,
      accessToken: grant.accessToken, actionExpiresAt: claim.expiresAt };
  };
  return { bridge, storage, runtime, setup, source, action, counts, prepare, authorize };
}

describe('removing a BigQuery bridge after source discovery fails', () => {
  it('removes only the selected bridge in bounded passes and clears its draft atomically', async () => {
    const test = await fixture();
    test.bridge.provider.cataloguePages = 10;
    const before = (await test.storage.get(SOURCES)).sources.filter(s=>s.id!==test.source.id);
    const input = await test.authorize();
    expect(test.bridge.requests).toEqual([]);
    expect((await test.setup.remove(input)).status).toBe(200);
    expect(test.bridge.deletions).toEqual(['domain','settings','app']);
    expect(Math.max(...test.counts)).toBeLessThanOrEqual(26);
    expect(test.counts.length).toBeLessThanOrEqual(8);
    expect((await test.storage.get(SOURCES)).sources).toEqual(before);
    expect((await test.storage.get(ACTIONS)).actions).toEqual([]);
    expect(await test.storage.get(test.bridge.key)).toBeUndefined();
    expect(await test.storage.get(`${JOURNAL}/${test.source.id}`)).toBeUndefined();
    expect(JSON.stringify(test.storage.writes)).not.toContain(input.actionKey);
    expect(JSON.stringify(test.storage.writes)).not.toContain(input.accessToken);
    expect((await test.setup.remove(input)).status).toBe(409);
  });
  it.each([true,false])('recovers a lost DELETE response (applied=%s) with fresh consent', async (applied) => {
    const test = await fixture({ lostDelete: 1, applied });
    const first = await test.authorize();
    expect((await test.setup.remove(first)).status).toBe(409);
    expect(await test.storage.get(test.bridge.key)).toBeDefined();
    expect((await test.storage.get(ACTIONS)).actions[0]).toMatchObject({ status: 'recovery_required', failureCode: 'source_removal_required' });
    const second = await test.authorize();
    expect(second.actionKey).not.toBe(first.actionKey);
    expect((await test.setup.remove(first)).status).toBe(409);
    expect((await test.setup.remove(second)).status).toBe(200);
    expect(test.bridge.deletions).toEqual(['domain','settings','app']);
  });
  it('rejects another administrator, stale revisions and unattested creates before mutation', async () => {
    const test = await fixture();
    expect((await test.prepare('other@example.com')).status).toBe(409);
    expect((await test.prepare('admin@example.com', 1)).status).toBe(409);
    await test.storage.put(test.bridge.key, { ...test.bridge.record, pending: 'worker' });
    expect((await test.prepare()).status).toBe(409);
    expect(test.bridge.requests).toEqual([]);
  });
  it('keeps foreign references and replacement Workers untouched', async () => {
    const test = await fixture();
    test.bridge.provider.servers = [{ id: 'foreign-source', hostname: test.source.url }];
    expect((await test.setup.remove(await test.authorize())).status).toBe(409);
    expect(test.bridge.deletions).toEqual([]);
    test.bridge.provider.servers = [];
    test.bridge.provider.deployments.deployments[0].versions[0].version_id = 'replacement';
    expect((await test.setup.remove(await test.authorize())).status).toBe(409);
    expect(test.bridge.deletions).toEqual([]);
  });
  it('removes an unrelated failed draft without breaking the recovering source revision', async () => {
    const test = await fixture();
    const current = await test.storage.get(SOURCES);
    const other = { ...test.source, id: 'source-1111111111111111', label: 'Unused', url: 'https://unused.example.com/mcp' };
    await test.storage.put(SOURCES, { ...current, sources: [...current.sources, other].sort((a,b)=>a.id.localeCompare(b.id)) });
    const response = await test.runtime.fetch(new Request('https://admin-state.invalid/sources', { method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-ankka-actor-email': 'admin@example.com' },
      body: JSON.stringify({ schemaVersion: 1, revision: current.revision, sourceId: other.id }) }));
    expect(response.status).toBe(200);
    const remaining = await test.storage.get(ACTIONS);
    expect(remaining.actions[0]).toEqual({ ...test.action, sourceRevision: current.revision + 1 });
    expect(await test.storage.get(test.bridge.key)).toEqual(test.bridge.record);
    expect(test.bridge.requests).toEqual([]);
    expect((await test.setup.remove(await test.authorize())).status).toBe(200);
  });
});
