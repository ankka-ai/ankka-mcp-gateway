import assert from 'node:assert/strict';
import test from 'node:test';

import { deploymentCredentialFamilies, inventoryDeploymentCredential } from '../tools/lifecycle-credentials.mjs';

const TOKEN = 'synthetic-deployment-token-value-never-printed';
const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);

function envelope(result, status = 200) {
  return Response.json({ success: status === 200, errors: [], messages: [], result }, { status });
}

test('the inventory reports token identity and per-family verdicts without the token, identifiers or bodies', async () => {
  const seen = [];
  const inventory = await inventoryDeploymentCredential({ token: TOKEN, accountId, zoneId, transport: async (url, init) => {
    seen.push(url);
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, 'manual');
    if (url.endsWith('/user/tokens/verify')) return Response.json({ success: false, errors: [{ code: 1000 }] }, { status: 400 });
    if (url.endsWith(`/accounts/${accountId}/tokens/verify`)) return envelope({ id: 'token-id', status: 'active', expires_on: '2026-10-06T00:00:00Z' });
    if (url.endsWith('/dns_records?per_page=1')) return Response.json({ success: false, errors: [{ code: 9109 }] }, { status: 403 });
    if (url.endsWith('/access/service_tokens?per_page=1')) return new Response('not found', { status: 404 });
    if (url.endsWith('/graphql')) return Response.json({ data: null, errors: [{ message: 'private detail' }] });
    if (url.endsWith('/workers/subdomain')) throw new TypeError('network down');
    return envelope([]);
  } });
  assert.deepEqual(inventory.identity, { kind: 'account_owned', status: 'active', expiresOn: '2026-10-06T00:00:00Z' });
  const verdicts = Object.fromEntries(inventory.families.map((family) => [family.family, family.outcome]));
  assert.equal(verdicts['dns-records'], 'denied');
  assert.equal(verdicts['access-service-tokens'], 'not_found');
  assert.equal(verdicts['workers-analytics'], 'denied');
  assert.equal(verdicts['workers-subdomain'], 'unreachable');
  assert.equal(verdicts['mcp-portals'], 'readable');
  assert.equal(inventory.families.length, deploymentCredentialFamilies({ accountId, zoneId }).length);
  const printed = JSON.stringify(inventory);
  assert.doesNotMatch(printed, /synthetic-deployment|token-id|private detail/u);
  assert.doesNotMatch(printed, new RegExp(accountId, 'u'));
  assert.ok(seen.every((url) => url.startsWith('https://api.cloudflare.com/client/v4/')));
});

test('a rejected credential is reported as rejected on every family, never as absence', async () => {
  const inventory = await inventoryDeploymentCredential({ token: TOKEN, accountId, zoneId, transport: async () => new Response('{}', { status: 401 }) });
  assert.deepEqual(inventory.identity, { kind: 'unknown', status: null, expiresOn: null });
  assert.ok(inventory.families.every((family) => family.outcome === 'credential_rejected'));
  await assert.rejects(inventoryDeploymentCredential({ token: 'short', accountId, zoneId }), { code: 'credential_inventory_input_invalid' });
  await assert.rejects(inventoryDeploymentCredential({ token: TOKEN, accountId: 'x', zoneId }), { code: 'credential_inventory_input_invalid' });
});
