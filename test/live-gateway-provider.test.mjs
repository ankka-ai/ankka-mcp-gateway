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
