import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveGatewayProvider } from '../tools/live-gateway-provider.mjs';

const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32);
const config = { accountId, zoneId, basics: { zoneName: 'example.com', managementHostname: 'manage.example.com', portalHostname: 'portal.example.com' } };
function response(result, result_info) {
  const body = { success: true, errors: null, messages: null, result };
  if (result_info) body.result_info = result_info;
  return Response.json(body);
}

test('fresh-target preflight reads later pages even with nullable errors and no total_pages', async () => {
  const calls = [];
  const transport = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.cloudflare.com');
    assert.equal(options.headers.authorization, 'Bearer synthetic-test-token');
    assert.equal(options.redirect, 'error');
    const path = new URL(url).pathname;
    calls.push(url);
    if (path === `/client/v4/zones/${zoneId}`) return response({ name: 'example.com', account: { id: accountId } });
    if (path.endsWith('/mcp/portals')) {
      const page = Number(new URL(url).searchParams.get('page'));
      return response(page === 1 ? Array.from({ length: 100 }, () => ({ hostname: 'foreign.example.com' })) : [{ hostname: config.basics.portalHostname }],
        { page, per_page: 100, total_count: 101 });
    }
    return response([]);
  };
  await assert.rejects(createLiveGatewayProvider({ config, token: 'synthetic-test-token', transport }).assertFresh(), { code: 'fresh_gateway_hostnames_required' });
  assert.ok(calls.some((url) => url.includes('page=2')));
});

test('provider read failures never include the credential or provider body', async () => {
  const provider = createLiveGatewayProvider({ config, token: 'synthetic-test-token', transport: async () =>
    new Response('synthetic-sensitive-provider-body', { status: 403 }) });
  await assert.rejects(provider.assertFresh(), (error) => error.code === 'provider_read_rejected' &&
    !String(error).includes('synthetic'));
});

test('recovery inventory cannot change the configured provider account or normalize into another route', async () => {
  let requests = 0;
  const provider = createLiveGatewayProvider({ config, token: 'synthetic-test-token', transport: async () => { requests += 1; return response([]); } });
  const installId = `acg-${'1'.repeat(24)}`;
  const provision = { installId, workerName: `ankka-gateway-${installId}`, bootstrapOrigin: `https://ankka-gateway-${installId}.synthetic.workers.dev` };
  for (const path of [`/accounts/${'c'.repeat(32)}/workers/scripts/foreign`, `/accounts/${accountId}/../foreign`, `/accounts/${accountId}/%2e%2e/foreign`]) {
    await assert.rejects(provider.assertAllAbsent({ schemaVersion: 1, accountId, zoneId, provision, resources: [{ path, dependency: false }] }), { code: 'provider_path_invalid' });
  }
  assert.equal(requests, 0);
});

test('failure metrics are bounded to the configured account and exact recorded Worker', async () => {
  const installId = `acg-${'1'.repeat(24)}`;
  const provision = { installId, workerName: `ankka-gateway-${installId}`, bootstrapOrigin: `https://ankka-gateway-${installId}.synthetic.workers.dev` };
  const rows = [{ sum: { requests: 3, errors: 1 }, quantiles: { cpuTimeP99: 4 } }];
  const provider = createLiveGatewayProvider({ config, token: 'synthetic-test-token', transport: async (url, options) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.variables.accountTag, accountId);
    assert.equal(body.variables.scriptName, provision.workerName);
    assert.equal(Date.parse(body.variables.to) - Date.parse(body.variables.from), 30 * 60_000);
    return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } });
  } });
  assert.deepEqual(await provider.metrics(provision), rows);
  const denied = createLiveGatewayProvider({ config, token: 'synthetic-test-token', transport: async () => new Response('private', { status: 403 }) });
  assert.equal(await denied.metrics(provision), null);
});

test('the inventory expects the management application\'s Service Auth policy exactly when a service identity is configured', async () => {
  const installId = `acg-${'c'.repeat(24)}`;
  const workerName = `ankka-gateway-${installId}`;
  const provision = { installId, workerName, bootstrapOrigin: `https://${workerName}.tenant.workers.dev/` };
  const tokenId = '11111111-2222-3333-4444-555555555555';
  const serviceConfig = { ...config, source: { url: 'https://source.example.net/mcp' }, serviceAccess: { tokenId } };
  const admin = { id: 'policy-admin', decision: 'allow', include: [{ email: { email: 'owner@example.com' } }] };
  const service = (id) => ({ id: 'policy-service', decision: 'non_identity', include: [{ service_token: { token_id: id } }] });
  function transport({ managementPolicies, portalPolicies = [admin] }) {
    return async (url) => {
      const path = new URL(url).pathname.replace('/client/v4', '');
      if (path === `/accounts/${accountId}/access/ai-controls/mcp/portals`) return response([{ id: 'portal1', hostname: 'portal.example.com', description: `acg:v1:${installId}:portal` }]);
      if (path === `/accounts/${accountId}/access/ai-controls/mcp/portals/portal1`) return response({ servers: [{ server_id: 'srv1' }] });
      if (path === `/accounts/${accountId}/access/ai-controls/mcp/servers`) return response([{ id: 'srv1', hostname: 'https://source.example.net/mcp' }]);
      if (path === `/accounts/${accountId}/access/apps`) return response([
        { id: 'app-portal', domain: 'portal.example.com' }, { id: 'app-manage', domain: 'manage.example.com' }, { id: 'app-source', destinations: [{ mcp_server_id: 'srv1' }] },
      ]);
      if (path === `/accounts/${accountId}/access/apps/app-manage/policies`) return response(managementPolicies);
      if (path === `/accounts/${accountId}/access/apps/app-portal/policies`) return response(portalPolicies);
      if (path === `/accounts/${accountId}/access/apps/app-source/policies`) return response([admin]);
      if (path === `/zones/${zoneId}/dns_records`) return response([{ id: 'dns1', comment: `acg:v1:${installId}:portal` }]);
      if (path === `/accounts/${accountId}/workers/domains`) return response([{ id: 'dom1', hostname: 'manage.example.com', service: workerName }]);
      if (path === `/accounts/${accountId}/workers/durable_objects/namespaces`) return response([{ id: 'ns1', script: workerName }]);
      throw new Error(`unexpected ${path}`);
    };
  }
  const provider = (cfg, fixture) => createLiveGatewayProvider({ config: cfg, token: 'synthetic-test-token', transport: transport(fixture) });
  const inventory = await provider(serviceConfig, { managementPolicies: [admin, service(tokenId)] }).capture(provision);
  const managementPolicies = inventory.resources.filter((item) => item.path.startsWith(`/accounts/${accountId}/access/apps/app-manage/policies/`));
  assert.deepEqual(managementPolicies.map((item) => item.dependency), [false, false]);
  // Without the opt-in a second policy is foreign; with it, the service policy must admit exactly the configured token and sit on the management application only.
  await assert.rejects(provider({ ...serviceConfig, serviceAccess: undefined }, { managementPolicies: [admin, service(tokenId)] }).capture(provision), { code: 'policy_inventory_incomplete' });
  await assert.rejects(provider(serviceConfig, { managementPolicies: [admin] }).capture(provision), { code: 'policy_inventory_incomplete' });
  await assert.rejects(provider(serviceConfig, { managementPolicies: [admin, service('99999999-2222-3333-4444-555555555555')] }).capture(provision), { code: 'policy_inventory_incomplete' });
  await assert.rejects(provider(serviceConfig, { managementPolicies: [admin, service(tokenId)], portalPolicies: [admin, service(tokenId)] }).capture(provision), { code: 'policy_inventory_incomplete' });
});

test('the management domain is ready only when it is a custom domain of the installation\'s Worker', async () => {
  const installId = `acg-${'e'.repeat(24)}`;
  const provision = { installId, workerName: `ankka-gateway-${installId}`, bootstrapOrigin: `https://ankka-gateway-${installId}.tenant.workers.dev/` };
  const provider = (domains) => createLiveGatewayProvider({ config, token: 'synthetic-test-token', transport: async (url) => {
    assert.ok(new URL(url).pathname.endsWith('/workers/domains'));
    return response(domains);
  } });
  assert.equal(await provider([]).managementDomainReady(provision), false);
  assert.equal(await provider([{ hostname: 'manage.example.com', service: 'ankka-gateway-other' }]).managementDomainReady(provision), false);
  assert.equal(await provider([{ hostname: 'manage.example.com', service: provision.workerName }]).managementDomainReady(provision), true);
});
