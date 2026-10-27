import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { AdminState } from '../payload/worker/index.js';
import { ACCOUNT_ID, ZONE_ID, canonicalJson, cloudflareProvider, installReadyGateway, withProviderFetch } from './payload-lifecycle.mjs';

// Sources reached with a Cloudflare Access service token. Every provider is
// synthetic. The customer's credential write is modelled directly on the fake
// Cloudflare state: the gateway itself must never send `auth_credentials`.
const ADMIN = 'admin@example.com';
const MEMBER = 'member@example.com';
const ORIGIN = 'https://manage.example.com';
const SOURCE_URL = 'https://warehouse.example.net/mcp';
const METADATA = 'https://warehouse.example.net/.well-known/oauth-protected-resource/mcp';
const SOURCES_KEY = 'ankka-mcp-gateway/management-sources/v1';
const CONTROL_KEY = 'ankka-mcp-gateway/management-control/v1';
const SWITCH_KEY = 'ankka-mcp-gateway/source-token-switch/v1';
const SERVERS = `/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/servers`;
const TOOLS = [{ name: 'warehouse_read' }, { name: 'warehouse_write' }];
const envelope = (result, status = 200) => Response.json({ success: status < 300, errors: [], messages: [], result }, { status });

/** The real Worker over the fake provider, extended with what Cloudflare does for these flows. */
async function fixture(run) {
  let hook;
  const provider = cloudflareProvider({ async onRequest(context) {
    const intercepted = await hook?.(context);
    if (intercepted instanceof Response) return intercepted;
    const { record, state } = context;
    if (record.pathname === `/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`) return envelope({ status: 'active' });
    // A bearer record without credentials cannot sync: Access refuses Cloudflare before the origin.
    if (record.method === 'POST' && record.pathname === SERVERS && record.body.auth_type === 'bearer') {
      const server = { ...record.body, status: 'error', error: 'synthetic-private-detail', error_details: { status_code: 401 }, tools: [] };
      state.servers.set(server.id, server);
      return envelope(server);
    }
    if (record.pathname.startsWith(`${SERVERS}/`) && record.pathname.endsWith('/sync') && record.method === 'POST') {
      const server = state.servers.get(decodeURIComponent(record.pathname.slice(SERVERS.length + 1, -'/sync'.length)));
      return server ? envelope(server) : envelope(null, 404);
    }
    // A Team policy edit and a Team application retarget, both on an existing target.
    for (const base of [`/client/v4/zones/${ZONE_ID}/access/apps`, `/client/v4/accounts/${ACCOUNT_ID}/access/apps`]) {
      if (record.method !== 'PUT' || !record.pathname.startsWith(`${base}/`)) continue;
      const [appId, segment, policyId] = record.pathname.slice(base.length + 1).split('/');
      if (!state.apps.has(appId)) return envelope(null, 404);
      if (segment === undefined) {
        // A full replacement: only the policies the request names stay attached.
        const { policies: linked = [], ...app } = record.body;
        assert.deepEqual(linked.map(({ id }) => id), state.policies.get(appId).map(({ id }) => id), 'a retarget names every policy again');
        state.policies.set(appId, state.policies.get(appId).filter(({ id }) => linked.some((entry) => entry.id === id)));
        state.apps.set(appId, { id: appId, ...structuredClone(app) });
        return envelope({ ...state.apps.get(appId), policies: structuredClone(state.policies.get(appId)) });
      }
      const policies = state.policies.get(appId);
      const index = policies.findIndex((policy) => policy.id === policyId);
      if (index < 0) return envelope(null, 404);
      policies[index] = { id: policyId, ...structuredClone(record.body) };
      return envelope(policies[index]);
    }
    return undefined;
  } });
  const gateway = await installReadyGateway({ provider });
  gateway.env.ANKKA_MANAGEMENT_TOKEN = 'synthetic-account-management-token-never-store';
  const namespace = gateway.env.ADMIN_STATE;
  const instances = new Map();
  gateway.env.ADMIN_STATE = { ...namespace, get(name) {
    if (!instances.has(name)) instances.set(name, new AdminState({ storage: gateway.objects.get(name).storage }, gateway.env));
    return { fetch: (request) => instances.get(name).fetch(request) };
  } };
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const kid = `synthetic-service-token-key-${crypto.randomUUID()}`;
  async function api(path, { method = 'GET', body, email = ADMIN } = {}) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode({
      iss: gateway.env.CF_ACCESS_ISSUER, aud: [gateway.env.CF_ACCESS_AUD], email, nbf: now - 1, exp: now + 300 })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned));
    const init = { method, headers: { 'cf-access-authenticated-user-email': email, 'content-type': 'application/json', origin: ORIGIN,
      'cf-access-jwt-assertion': `${unsigned}.${Buffer.from(signature).toString('base64url')}` } };
    if (body !== undefined) init.body = canonicalJson(body);
    return worker.fetch(new Request(`${ORIGIN}${path}`, init), gateway.env);
  }
  // The origin sits behind Access: without a token it answers like Managed OAuth does.
  const network = async (request) => {
    if (request.url === `${gateway.env.CF_ACCESS_ISSUER}/cdn-cgi/access/certs`) return Response.json({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
    if (request.url === SOURCE_URL) return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${METADATA}"` } });
    if (request.url.startsWith('https://warehouse.example.net/')) return new Response(null, { status: 404 });
    return provider.fetch(request);
  };
  const storage = gateway.objects.get('v1:management').storage;
  const coverOrigin = () => {
    provider.state.apps.set('f'.repeat(32), { id: 'f'.repeat(32), type: 'self_hosted', name: 'Warehouse MCP', domain: 'warehouse.example.net' });
    provider.state.policies.set('f'.repeat(32), []);
  };
  return withProviderFetch(network, () => run({ ...gateway, provider, api, storage, coverOrigin, hook(next) { hook = next; } }));
}

async function saveDraft(gateway, authMode, enabledTools = []) {
  const current = await (await gateway.api('/api/sources')).json();
  return gateway.api('/api/sources', { method: 'PUT', body: { schemaVersion: 1, revision: current.revision,
    source: { label: 'Warehouse', url: SOURCE_URL, authMode, enabledTools } } });
}

async function install(gateway, sourceId, actionId = null) {
  const { revision } = await (await gateway.api('/api/sources')).json();
  return gateway.api(actionId ? `/api/source-actions/${actionId}/renew` : '/api/source-actions',
    { method: 'POST', body: { schemaVersion: 1, revision, sourceId } });
}

function customerWritesToken(gateway, serverId, tools = TOOLS) {
  Object.assign(gateway.provider.state.servers.get(serverId), { status: 'ready', authentication_status: 'not_required', tools,
    error: undefined, error_details: undefined });
}

async function installedOauthSource(gateway) {
  const saved = await saveDraft(gateway, 'oauth', ['warehouse_read']);
  assert.equal(saved.status, 200, await saved.clone().text());
  const source = (await saved.json()).sources.find((entry) => entry.url === SOURCE_URL);
  assert.equal(source.onBehalfOfUser, false);
  const applied = await install(gateway, source.id);
  assert.equal(applied.status, 200, await applied.clone().text());
  return source;
}

const switchTo = (gateway, sourceId, operation) => gateway.api('/api/sources').then((response) => response.json())
  .then(({ revision }) => gateway.api(`/api/sources/${sourceId}/service-token`, { method: 'POST', body: { schemaVersion: 1, revision, operation } }));

test('a service-token source needs a self-hosted Access application in this account covering it', async () => fixture(async (gateway) => {
  const refused = await saveDraft(gateway, 'access_service_token');
  assert.equal(refused.status, 409, await refused.clone().text());
  assert.equal((await refused.json()).error, 'source_access_application_required');
  const discovered = await gateway.api('/api/sources/discover', { method: 'POST', body: { url: SOURCE_URL } });
  assert.equal((await discovered.json()).serviceTokenAvailable, undefined);
  gateway.coverOrigin();
  const offered = await (await gateway.api('/api/sources/discover', { method: 'POST', body: { url: SOURCE_URL } })).json();
  assert.equal(offered.authentication, 'oauth');
  assert.equal(offered.serviceTokenAvailable, true);
  const saved = await saveDraft(gateway, 'access_service_token');
  assert.equal(saved.status, 200, await saved.clone().text());
  const source = (await saved.json()).sources.find((entry) => entry.url === SOURCE_URL);
  assert.equal(source.authMode, 'access_service_token');
  assert.equal(source.onBehalfOfUser, false);
  assert.deepEqual(source.enabledTools, []);
  // The gateway's own hostname never qualifies, whatever Access covers.
  const current = await (await gateway.api('/api/sources')).json();
  const own = await gateway.api('/api/sources', { method: 'PUT', body: { schemaVersion: 1, revision: current.revision,
    source: { label: 'Own', url: `${ORIGIN}/api/other`, authMode: 'access_service_token', enabledTools: [] } } });
  assert.equal(own.status, 400);
}));

test('a service-token source installs a bearer record without credentials and waits for the customer token', async () => fixture(async (gateway) => {
  gateway.coverOrigin();
  const saved = await saveDraft(gateway, 'access_service_token');
  const source = (await saved.json()).sources.find((entry) => entry.url === SOURCE_URL);
  const portalBefore = structuredClone(gateway.provider.state.portal);
  const paused = await install(gateway, source.id);
  assert.equal(paused.status, 409);
  assert.equal((await paused.json()).error, 'source_credential_required');
  const created = gateway.provider.requests.find((entry) => entry.method === 'POST' && entry.pathname === SERVERS && entry.body.hostname === SOURCE_URL);
  assert.equal(created.body.auth_type, 'bearer');
  assert.equal(Object.hasOwn(created.body, 'auth_credentials'), false);
  assert.equal(Object.hasOwn(created.body, 'is_shared_oauth_callback_enabled'), false);
  assert.match(created.body.id, /^mcp-source-[a-f0-9]{12}-[a-f0-9]{8}$/u);
  assert.equal(gateway.provider.requests.some((entry) => entry.method === 'PUT' && entry.pathname.startsWith(`${SERVERS}/`)), false);
  assert.deepEqual(gateway.provider.state.portal, portalBefore, 'nothing is mapped before the token works');
  const snapshot = (await (await gateway.api('/api/source-actions')).json()).actions.at(-1);
  assert.deepEqual(snapshot.credentialTarget, { accountId: ACCOUNT_ID, serverId: created.body.id });
  assert.equal(snapshot.canRenew, true);
  // A wrong token: Cloudflare reports an error, never an empty list that looks connected.
  Object.assign(gateway.provider.state.servers.get(created.body.id), { status: 'error', tools: [], error: 'synthetic-private-detail',
    error_details: { status_code: 403 } });
  const rejected = await install(gateway, source.id, snapshot.actionId);
  assert.equal((await rejected.json()).error, 'source_credential_required');
  assert.ok(gateway.provider.requests.some((entry) => entry.method === 'POST' && entry.pathname === `${SERVERS}/${created.body.id}/sync`));
  customerWritesToken(gateway, created.body.id);
  const tools = await install(gateway, source.id, snapshot.actionId);
  assert.equal((await tools.json()).error, 'source_tools_required');
  const { revision } = await (await gateway.api('/api/sources')).json();
  const chosen = await gateway.api(`/api/source-actions/${snapshot.actionId}/tools`, { method: 'POST',
    body: { schemaVersion: 1, revision, sourceId: source.id, enabledTools: ['warehouse_read'] } });
  assert.equal(chosen.status, 200, await chosen.clone().text());
  const done = await install(gateway, source.id, snapshot.actionId);
  assert.equal(done.status, 200, await done.clone().text());
  const mapping = gateway.provider.state.portal.servers.find((entry) => entry.server_id === created.body.id);
  assert.equal(mapping.on_behalf, false);
  assert.equal(mapping.default_disabled, true);
  assert.deepEqual(mapping.updated_tools.map((tool) => tool.name), ['warehouse_read']);
  const installed = gateway.storage.snapshot(SOURCES_KEY).sources.find((entry) => entry.id === source.id);
  assert.equal(installed.status, 'installed');
  assert.equal(JSON.stringify(gateway.storage.writes ?? []).includes('auth_credentials'), false);
  // Health: a working token is connected; a refused one is a credential problem, not a sign-in.
  const connected = await (await gateway.api(`/api/sources/${source.id}/connection`, { method: 'POST' })).json();
  assert.equal(connected.state, 'connected');
  assert.deepEqual(connected.credentialTarget, { accountId: ACCOUNT_ID, serverId: created.body.id });
  assert.equal(connected.reconnectUrl, undefined);
  gateway.hook(({ record }) => record.pathname.endsWith('/sync') ? envelope({ ...gateway.provider.state.servers.get(created.body.id),
    status: 'error', error: 'synthetic-private-detail', error_details: { status_code: 302 } }) : undefined);
  const refused = await (await gateway.api(`/api/sources/${source.id}/connection`, { method: 'POST' })).json();
  assert.equal(refused.state, 'service_auth_required');
  assert.equal(refused.reconnectUrl, undefined);
  assert.equal(JSON.stringify(refused).includes('synthetic-private'), false);
  // A service-token source has no sign-in to renew.
  const reconnect = await gateway.api(`/api/sources/${source.id}/authorize`, { method: 'POST', body: { schemaVersion: 1, revision } });
  assert.notEqual(reconnect.status, 200);
}));

test('drift: a bearer record is accepted only for the service-token mode', async () => fixture(async (gateway) => {
  const source = await installedOauthSource(gateway);
  const serverId = gateway.storage.snapshot(CONTROL_KEY).sourceOwnership.find((entry) => entry.sourceId === source.id).resources[0].provider.id;
  gateway.provider.state.servers.get(serverId).auth_type = 'bearer';
  const checked = await (await gateway.api(`/api/sources/${source.id}/connection`, { method: 'POST' })).json();
  assert.equal(checked.state, 'unknown');
  assert.equal(checked.reason, 'configuration_changed');
}));

test('switching a shared sign-in source to its token keeps tools and Team assignments and deletes the old record', async () => fixture(async (gateway) => {
  const source = await installedOauthSource(gateway);
  const team = await (await gateway.api('/api/team')).json();
  const assigned = await gateway.api('/api/team-actions', { method: 'POST', body: { schemaVersion: 1, expectedRevision: team.revision,
    members: team.members.map((member) => member.email === MEMBER ? { ...member, sourceIds: [...member.sourceIds, source.id].sort() } : member) } });
  assert.equal(assigned.status, 200, await assigned.clone().text());
  const before = gateway.storage.snapshot(CONTROL_KEY).sourceOwnership.find((entry) => entry.sourceId === source.id).resources;
  const oauthId = before[0].provider.id, appId = before[1].provider.id;
  // A policy the gateway did not create, on the same application, survives the retarget too.
  gateway.provider.state.policies.get(appId).push({ id: 'synthetic-manual-policy', name: 'Manual', decision: 'non_identity',
    include: [{ service_token: { token_id: 'synthetic-benchmark-token' } }], exclude: [], require: [] });
  const policyBefore = structuredClone(gateway.provider.state.policies.get(appId));
  const refused = await switchTo(gateway, source.id, 'start');
  assert.equal((await refused.json()).error, 'source_access_application_required');
  gateway.coverOrigin();
  const started = await switchTo(gateway, source.id, 'start');
  assert.equal(started.status, 200, await started.clone().text());
  const pending = (await started.json()).tokenSwitch;
  assert.equal(pending.phase, 'credential');
  assert.equal(pending.reason, 'source_credential_required');
  const tokenId = pending.credentialTarget.serverId;
  assert.notEqual(tokenId, oauthId);
  assert.equal(tokenId.slice(0, 23), oauthId.slice(0, 23), 'the tool-name prefix keeps the source identity');
  const created = gateway.provider.state.servers.get(tokenId);
  assert.equal(created.auth_type, 'bearer');
  assert.equal(Object.hasOwn(created, 'auth_credentials'), false);
  assert.deepEqual(created.updated_tools, [{ name: 'warehouse_read', enabled: true }]);
  assert.ok(gateway.provider.state.portal.servers.some((entry) => entry.server_id === oauthId), 'the source keeps working meanwhile');
  // Anything else waits while the switch is open.
  const { revision } = await (await gateway.api('/api/sources')).json();
  const edit = await gateway.api(`/api/sources/${source.id}/tools`, { method: 'PUT', body: { schemaVersion: 1, revision, enabledTools: ['warehouse_read', 'warehouse_write'] } });
  assert.equal(edit.status, 409);
  // Until the token works, continuing only waits.
  const waiting = await switchTo(gateway, source.id, 'continue');
  assert.equal((await waiting.json()).tokenSwitch.reason, 'source_credential_required');
  // A credential write that changed the tool overrides is drift, not a token.
  customerWritesToken(gateway, tokenId);
  gateway.provider.state.servers.get(tokenId).updated_tools = [];
  const drift = await switchTo(gateway, source.id, 'continue');
  assert.equal((await drift.json()).error, 'source_switch_drift');
  gateway.provider.state.servers.get(tokenId).updated_tools = [{ name: 'warehouse_read', enabled: true }];
  const finished = await switchTo(gateway, source.id, 'continue');
  assert.equal(finished.status, 200, await finished.clone().text());
  const result = await finished.json();
  assert.equal(result.tokenSwitch, null);
  assert.equal(result.sources.find((entry) => entry.id === source.id).authMode, 'access_service_token');
  assert.deepEqual(result.sources.find((entry) => entry.id === source.id).enabledTools, ['warehouse_read']);
  assert.equal(gateway.provider.state.servers.has(oauthId), false, 'the sign-in record is deleted');
  const mappings = gateway.provider.state.portal.servers;
  assert.equal(mappings.some((entry) => entry.server_id === oauthId), false);
  const mapping = mappings.find((entry) => entry.server_id === tokenId);
  assert.deepEqual({ on_behalf: mapping.on_behalf, default_disabled: mapping.default_disabled, tools: mapping.updated_tools.map((tool) => tool.name) },
    { on_behalf: false, default_disabled: true, tools: ['warehouse_read'] });
  assert.deepEqual(gateway.provider.state.apps.get(appId).destinations, [{ type: 'via_mcp_server_portal', mcp_server_id: tokenId }]);
  assert.deepEqual(gateway.provider.state.policies.get(appId), policyBefore, 'the Team policy is untouched');
  const ownership = gateway.storage.snapshot(CONTROL_KEY).sourceOwnership.find((entry) => entry.sourceId === source.id).resources;
  assert.equal(ownership[0].provider.id, tokenId);
  assert.deepEqual(ownership[2], before[2]);
  const view = await (await gateway.api('/api/team')).json();
  assert.ok(view.members.find((member) => member.email === MEMBER).sourceIds.includes(source.id));
  assert.equal(view.members.find((member) => member.email === ADMIN).sourceIds.includes(source.id), false);
  assert.equal((await (await gateway.api(`/api/sources/${source.id}/connection`, { method: 'POST' })).json()).state, 'connected');
  assert.equal(gateway.storage.snapshot(SWITCH_KEY), undefined);
  // Removal still recognises every resource it owns. It refuses an application carrying a policy it did not create.
  gateway.provider.state.policies.set(appId, gateway.provider.state.policies.get(appId).filter(({ id }) => id !== 'synthetic-manual-policy'));
  const removal = await gateway.api(`/api/sources/${source.id}`, { method: 'DELETE', body: { schemaVersion: 1, revision: result.revision } });
  assert.equal(removal.status, 200, await removal.clone().text());
  assert.equal(gateway.provider.state.servers.has(tokenId), false);
}));

test('a failed move rolls back to the sign-in record while it exists', async () => fixture(async (gateway) => {
  const source = await installedOauthSource(gateway);
  gateway.coverOrigin();
  const controlBefore = gateway.storage.snapshot(CONTROL_KEY);
  const portalBefore = structuredClone(gateway.provider.state.portal);
  const before = controlBefore.sourceOwnership.find((entry) => entry.sourceId === source.id).resources;
  const started = await (await switchTo(gateway, source.id, 'start')).json();
  const tokenId = started.tokenSwitch.credentialTarget.serverId;
  customerWritesToken(gateway, tokenId);
  // The Portal refuses the mapping onto the new record after the source was unmapped and the application moved.
  gateway.hook(({ record }) => record.method === 'PUT' && record.pathname.includes('/mcp/portals/') &&
    record.body.servers.some((entry) => entry.server_id === tokenId) ? envelope(null, 500) : undefined);
  const stopped = await switchTo(gateway, source.id, 'continue');
  assert.equal((await stopped.json()).error, 'source_switch_recovery_required');
  assert.equal(gateway.provider.state.portal.servers.some((entry) => entry.server_id === before[0].provider.id), false);
  assert.equal(gateway.provider.state.apps.get(before[1].provider.id).destinations[0].mcp_server_id, tokenId);
  gateway.hook(undefined);
  const returned = await switchTo(gateway, source.id, 'rollback');
  assert.equal(returned.status, 200, await returned.clone().text());
  assert.equal((await returned.json()).tokenSwitch, null);
  assert.equal(gateway.provider.state.servers.has(tokenId), false);
  assert.equal(gateway.provider.state.servers.has(before[0].provider.id), true);
  const byServer = (servers) => [...servers].sort((left, right) => left.server_id.localeCompare(right.server_id));
  assert.deepEqual(byServer(gateway.provider.state.portal.servers), byServer(portalBefore.servers));
  assert.equal(gateway.provider.state.apps.get(before[1].provider.id).destinations[0].mcp_server_id, before[0].provider.id);
  assert.deepEqual(gateway.storage.snapshot(CONTROL_KEY).sourceOwnership, controlBefore.sourceOwnership);
  assert.equal(gateway.storage.snapshot(SOURCES_KEY).sources.find((entry) => entry.id === source.id).authMode, 'oauth');
}));

test('cancelling while the credential is pending deletes only the new record', async () => fixture(async (gateway) => {
  const source = await installedOauthSource(gateway);
  gateway.coverOrigin();
  const controlBefore = gateway.storage.snapshot(CONTROL_KEY);
  const portalBefore = structuredClone(gateway.provider.state.portal);
  const tokenId = (await (await switchTo(gateway, source.id, 'start')).json()).tokenSwitch.credentialTarget.serverId;
  const cancelled = await switchTo(gateway, source.id, 'rollback');
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  assert.equal(gateway.provider.state.servers.has(tokenId), false);
  assert.deepEqual(gateway.provider.state.portal, portalBefore);
  assert.deepEqual(gateway.storage.snapshot(CONTROL_KEY), controlBefore);
  assert.equal(gateway.storage.snapshot(SWITCH_KEY), undefined);
}));
