import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import * as v from 'valibot';

import { APPROVED_CLOUDFLARE_CONTRACT } from '../apps/installer/scripts/sign-gateway-release.mjs';
import { HttpGatewayAdminApi } from '../apps/admin/src/api.ts';
import worker, { AdminState, planTeamAccessChange, prepareCurrentGatewayTeardown, verifyAccess } from '../payload/worker/index.js';
import { addHistoricalInstalledSource } from './historical-source-fixture.mjs';
import {
  ACCOUNT_ID,
  BOOTSTRAP_NONCE,
  ZONE_ID,
  canonicalJson,
  cloudflareProvider,
  installReadyGateway,
  portalOnlyClaim,
  prefixedSha256,
  withProviderFetch,
} from './payload-lifecycle.mjs';

// Exercise the real Worker against synthetic Cloudflare resource state.
// Current account-token management and retained source actions share the
// receipt ownership, recovery and lifecycle invariants.
const ADMIN = 'admin@example.com';
const OWNER = 'owner@example.com';
const MEMBER = 'member@example.com';
const NEW_PERSON = 'new-person@example.com';
const TEAM_KEY = 'ankka-mcp-gateway/team-access/v1';
const UPDATES_KEY = 'ankka-mcp-gateway/runtime-updates/v1';
const TEARDOWNS_KEY = 'ankka-mcp-gateway/teardown-actions/v1';
const SOURCES_KEY = 'ankka-mcp-gateway/management-sources/v1';
const SOURCE_ACTIONS_KEY = 'ankka-mcp-gateway/source-actions/v1';
const MANAGEMENT_ORIGIN = 'https://manage.example.com';
const SYNTHETIC_GRANT = 'synthetic-legacy-installer-grant-never-store';
const API_APPS = `/client/v4/zones/${ZONE_ID}/access/apps`;
const NEW_SOURCE_URL = 'https://catalog.example.net/mcp';
const SERVICE_CLIENT = `${'c'.repeat(32)}.access`;
const OTHER_CLIENT = `${'d'.repeat(32)}.access`;

function envelope(result, status = 200) {
  return Response.json({ success: status >= 200 && status < 300, errors: [], messages: [], result }, { status });
}

// Extend the existing explicit resource fake locally: permission updates change
// only an existing policy below its existing application, never create a target.
function teamProvider() {
  let hook;
  const provider = cloudflareProvider({
    async onRequest(context) {
      const intercepted = await hook?.(context);
      if (intercepted instanceof Response) return intercepted;
      const { record, state } = context;
      if (record.pathname === `/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`) return envelope({ status: 'active' });
      if (record.method === 'POST' && record.pathname.endsWith('/access/apps')) {
        const destinations = record.body.destinations ?? [];
        const pathDomain = [record.body.domain, ...destinations.filter((entry) => entry.type === 'public').map((entry) => entry.uri)]
          .some((domain) => domain?.includes('/'));
        if ((record.body.type === 'mcp' && pathDomain) ||
            (record.body.type === 'self_hosted' && destinations.some((entry) => entry.type === 'via_mcp_server_portal'))) {
          return Response.json({ success: false, errors: [{ code: 12130, message: 'Invalid application destinations' }] }, { status: 400 });
        }
      }
      const appPath = record.pathname.startsWith(`${API_APPS}/`) ? API_APPS : `/client/v4/accounts/${ACCOUNT_ID}/access/apps`;
      if (record.method !== 'PUT' || !record.pathname.startsWith(`${appPath}/`)) return undefined;
      const [appId, segment, policyId, extra] = record.pathname.slice(appPath.length + 1).split('/');
      assert.equal(segment, 'policies');
      assert.equal(extra, undefined);
      const policies = state.policies.get(appId);
      const index = policies?.findIndex((policy) => policy.id === policyId) ?? -1;
      if (index < 0) return envelope(null, 404);
      policies[index] = { id: policyId, ...structuredClone(record.body) };
      return envelope(policies[index]);
    },
  });
  return {
    ...provider,
    hook(next) { hook = next; },
    puts() { return provider.requests.filter(({ method }) => method === 'PUT'); },
  };
}

async function fixture(run, claimInput) {
  const provider = teamProvider();
  const options = { provider };
  if (claimInput) options.claimInput = claimInput;
  const gateway = await installReadyGateway(options);
  gateway.env.ANKKA_MANAGEMENT_TOKEN = 'synthetic-account-management-token-never-store';
  // Real Durable Object instances retain their operation queue. The shared
  // sequential lifecycle fixture recreates instances; retain them here so
  // concurrent API regressions exercise the actual runtime serialization.
  const namespace = gateway.env.ADMIN_STATE;
  const instances = new Map();
  gateway.env.ADMIN_STATE = {
    ...namespace,
    get(name) {
      if (!instances.has(name)) {
        const entry = gateway.objects.get(name);
        assert.ok(entry);
        instances.set(name, new AdminState({ storage: entry.storage }, gateway.env));
      }
      return { fetch: (request) => instances.get(name).fetch(request) };
    },
  };
  const keys = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const kid = `synthetic-team-regression-key-${crypto.randomUUID()}`;
  async function headers(email = ADMIN, audience = gateway.env.CF_ACCESS_AUD) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode({
      iss: gateway.env.CF_ACCESS_ISSUER, aud: [audience],
      email, nbf: now - 1, exp: now + 300,
    })}`;
    const signed = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned));
    return {
      'cf-access-authenticated-user-email': email,
      'cf-access-jwt-assertion': `${unsigned}.${Buffer.from(signed).toString('base64url')}`,
      'content-type': 'application/json', origin: MANAGEMENT_ORIGIN,
    };
  }
  /** A service-token assertion: no email claim, no identity header, the exact client identity in `common_name`. */
  async function serviceHeaders({ clientId = SERVICE_CLIENT, aud = gateway.env.CF_ACCESS_AUD, email, identityHeader } = {}) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: gateway.env.CF_ACCESS_ISSUER, aud: [aud], type: 'app', common_name: clientId, sub: '', nbf: now - 1, exp: now + 300 };
    if (email !== undefined) claims.email = email;
    const unsigned = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode(claims)}`;
    const signed = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned));
    const result = { 'cf-access-jwt-assertion': `${unsigned}.${Buffer.from(signed).toString('base64url')}`, 'content-type': 'application/json', origin: MANAGEMENT_ORIGIN };
    if (identityHeader !== undefined) result['cf-access-authenticated-user-email'] = identityHeader;
    return result;
  }
  async function serviceApi(path, { method = 'GET', body, token = {} } = {}) {
    const init = { method, headers: await serviceHeaders(token) };
    if (body !== undefined) init.body = canonicalJson(body);
    return worker.fetch(new Request(`${MANAGEMENT_ORIGIN}${path}`, init), gateway.env);
  }
  async function api(path, { method = 'GET', body, email = ADMIN, extraHeaders = {}, currentTeardown = false } = {}) {
    const init = {
      method, headers: { ...await headers(email), ...extraHeaders },
    };
    if (body !== undefined) init.body = canonicalJson(body);
    const request = new Request(`${MANAGEMENT_ORIGIN}${path}`, init);
    return currentTeardown ? prepareCurrentGatewayTeardown(request, gateway.env) : worker.fetch(request, gateway.env);
  }
  async function view() {
    const response = await api('/api/team');
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  // A draft exists only in the browser until one authenticated Save request.
  async function draft(input) { return { input }; }
  async function apply(prepared, overrides = {}, action = 'access') {
    if (prepared.input) return api('/api/team-actions', { method: 'POST', body: prepared.input });
    const { claim } = prepared;
    const input = {
      schemaVersion: 1, actionId: claim.actionId,
      actionKey: claim.actionKey, actorEmail: claim.actorEmail, accountId: claim.accountId,
      issuedAt: Date.now(), expiresAt: claim.expiresAt,
      cloudflareAccessToken: SYNTHETIC_GRANT,
    };
    if (action !== null) input.action = action;
    Object.assign(input, overrides);
    const body = canonicalJson(input);
    const signature = `sha256=${createHmac('sha256', Buffer.from(claim.actionKey, 'base64url')).update(body).digest('hex')}`;
    return worker.fetch(new Request('https://ankka-gateway-test.tenant.workers.dev/__ankka/source-action', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ankka-source-action-signature': signature }, body,
    }), gateway.env);
  }
  async function teardown() {
    const response = await api('/api/teardown-actions', { method: 'POST', body: { schemaVersion: 1 } });
    assert.equal(response.status, 200, await response.clone().text());
    const prepared = await response.json();
    const claim = JSON.parse(Buffer.from(new URL(prepared.handoffUrl).hash.slice(1), 'base64url').toString('utf8'));
    return async (command, requestId) => {
      const input = {
        schemaVersion: 1, command, actionId: claim.actionId, actionKey: claim.actionKey,
        actorEmail: claim.actorEmail, accountId: claim.accountId, installationId: claim.installationId,
        issuedAt: Date.now(), expiresAt: claim.expiresAt,
      };
      if (requestId !== undefined) {
        input.requestId = requestId;
        input.cloudflareAccessToken = SYNTHETIC_GRANT;
      }
      const body = canonicalJson(input);
      const signature = `sha256=${createHmac('sha256', Buffer.from(claim.actionKey, 'base64url')).update(body).digest('hex')}`;
      return worker.fetch(new Request('https://ankka-gateway-test.tenant.workers.dev/__ankka/teardown-action', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-ankka-teardown-action-signature': signature }, body,
      }), gateway.env);
    };
  }
  async function currentTeardown(seed = 4) {
    const actionKey = Buffer.alloc(32, seed).toString('base64url');
    const issuedAt = Date.now();
    const input = {
      schemaVersion: 1, actionId: `action_${String.fromCharCode(65 + seed).repeat(32)}`,
      actionKeyHash: await prefixedSha256(actionKey), actorEmail: ADMIN,
      installationId: gateway.readyReceipt.installationId,
      issuedAt, expiresAt: issuedAt + 600_000,
    };
    const stub = gateway.env.ADMIN_STATE.get(gateway.env.ADMIN_STATE.idFromName('v1:management'));
    const prepared = await stub.fetch(new Request('https://admin-state.invalid/teardown-actions/prepare-current', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: canonicalJson(input),
    }));
    return {
      prepared,
      async send(command, requestId = 'F'.repeat(22), legacy = false) {
        const claim = {
          schemaVersion: 1, command, actionId: input.actionId, actionKey,
          actorEmail: ADMIN, accountId: ACCOUNT_ID, installationId: input.installationId,
          issuedAt: Date.now(), expiresAt: input.expiresAt,
        };
        if (command === 'apply') Object.assign(claim, { requestId, cloudflareAccessToken: SYNTHETIC_GRANT });
        const body = canonicalJson(claim);
        const signature = `sha256=${createHmac('sha256', Buffer.from(actionKey, 'base64url')).update(body).digest('hex')}`;
        return stub.fetch(new Request(`https://admin-state.invalid/teardown-actions/${command}${legacy ? '' : '-current'}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-ankka-teardown-action-signature': signature }, body,
        }));
      },
    };
  }
  const managementStorage = gateway.objects.get('v1:management').storage;
  let sourceRequestHook;
  const network = async (request) => {
    if (request.url === `${gateway.env.CF_ACCESS_ISSUER}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
    }
    if (request.url === NEW_SOURCE_URL) {
      await sourceRequestHook?.(request);
      const message = await request.json();
      if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'Synthetic source', version: '1' },
      } });
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [{
        name: 'company_lookup', description: 'Read synthetic reference records.', inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      }] } });
    }
    return provider.fetch(request);
  };
  return withProviderFetch(network, () => run({ ...gateway, api, serviceApi, view, draft, apply, teardown, currentTeardown,
    headers, managementStorage,
    onSourceRequest(hook) { sourceRequestHook = hook; },
    reloadManagement() { instances.delete('v1:management'); },
  }));
}

function changedRequest(view) {
  return {
    schemaVersion: 1, expectedRevision: view.revision,
    members: [
      { email: ADMIN, sourceIds: [] },
      { email: OWNER, sourceIds: [] },
      { email: NEW_PERSON, sourceIds: [view.sources[0].id] },
    ],
  };
}

function app(gateway, type = 'mcp') {
  const result = [...gateway.provider.state.apps.values()].find((value) => value.type === type);
  assert.ok(result);
  return result;
}

function policy(gateway, type = 'mcp') {
  return gateway.provider.state.policies.get(app(gateway, type).id)[0];
}

function assertNoMutation(provider, baseline) {
  assert.deepEqual(provider.requests.slice(baseline).filter(({ method }) => method !== 'GET'), []);
}

async function prepareNewSource(gateway) {
  const current = await (await gateway.api('/api/sources')).json();
  const savedResponse = await gateway.api('/api/sources', { method: 'PUT', body: {
    schemaVersion: 1, revision: current.revision,
    source: { label: 'Additional source', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: ['company_lookup'] },
  } });
  assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
  const sources = await savedResponse.json();
  assert.equal(sources.installationEnabled, true);
  const source = sources.sources.find((candidate) => candidate.url === NEW_SOURCE_URL);
  return { source, sources, ...await authorizeNewSource(gateway, source.id, sources.revision) };
}

// Build a retained pre-upgrade action to keep exercising the existing relay,
// journal, cancellation and lifecycle recovery paths independently of new setup.
async function authorizeNewSource(gateway, sourceId, revision, renewActionId = null) {
  const source = gateway.managementStorage.snapshot(SOURCES_KEY).sources.find((item) => item.id === sourceId);
  const claim = { actionId: renewActionId ?? `action_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')}`,
    actionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), actorEmail: ADMIN, accountId: ACCOUNT_ID, expiresAt: Date.now() + 600_000 };
  const response = await gateway.env.ADMIN_STATE.get('v1:management').fetch(new Request(`https://admin-state.invalid/source-actions${renewActionId ? `/${renewActionId}/renew` : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: canonicalJson({ schemaVersion: 1,
      actionId: claim.actionId, sourceId, sourceRevision: revision, actorEmail: ADMIN,
      issuedAt: claim.expiresAt - 600_000, expiresAt: claim.expiresAt,
      actionKeyHash: await prefixedSha256(claim.actionKey), sourceHash: await prefixedSha256({
        id: source.id, label: source.label, url: source.url, authMode: source.authMode,
        onBehalfOfUser: source.onBehalfOfUser, enabledTools: source.enabledTools,
      }),
    }),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  return { claim };
}

// A previously issued, unexpired source-installation handoff can survive a
// runtime upgrade. Model that historical journal directly without enabling a
// current preparation route or altering any original resource/receipt authority.
async function historicalPreparedSource(gateway, status = 'authorization_required') {
  const current = gateway.managementStorage.snapshot(SOURCES_KEY);
  const source = { id: 'source-4444444444444444', label: 'Additional source', url: NEW_SOURCE_URL,
    authMode: 'none', onBehalfOfUser: false, enabledTools: ['company_lookup'], status: 'draft' };
  const sources = { ...current, revision: current.revision + 1, sources: [...current.sources, source] };
  const claim = { actionId: `action_${'L'.repeat(32)}`, actionKey: BOOTSTRAP_NONCE,
    actorEmail: ADMIN, accountId: ACCOUNT_ID, expiresAt: Date.now() + 600_000 };
  const action = { schemaVersion: 1, actionId: claim.actionId, sourceId: source.id,
    sourceRevision: sources.revision, actorEmail: ADMIN, issuedAt: Date.now(), expiresAt: claim.expiresAt,
    actionKeyHash: await prefixedSha256(claim.actionKey), sourceHash: await prefixedSha256({
      id: source.id, label: source.label, url: source.url, authMode: source.authMode,
      onBehalfOfUser: source.onBehalfOfUser, enabledTools: source.enabledTools,
    }), status: 'authorization_required', resources: [], pending: status === 'recovery_required'
      ? { kind: 'mcp_server', phase: 'send_armed', provider: null } : null,
    portalUpdate: null, failureCode: status === 'recovery_required' ? 'source_action_recovery_required' : null };
  await gateway.managementStorage.put(SOURCES_KEY, sources);
  if (status !== null) {
    await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, { schemaVersion: 1, revision: 2, actions: [action] });
  }
  return { source, sources, claim, action };
}

// Reconstruct a v16 retained proposal with its original exact planner hash.
// This models stored migration state, not an available preparation endpoint.
async function historicalPreparedTeam(gateway, input) {
  const view = await gateway.view();
  const sources = gateway.managementStorage.snapshot(SOURCES_KEY);
  const control = gateway.managementStorage.snapshot('ankka-mcp-gateway/management-control/v1');
  const target = (applicationId, policyId) => ({ applicationId, policyId,
    policyName: gateway.provider.state.policies.get(applicationId).find(({ id }) => id === policyId).name });
  const portal = policy(gateway, 'mcp_portal');
  const plan = planTeamAccessChange(input, {
    revision: view.revision, adminEmails: view.adminEmails, currentMembers: view.members,
    sources: view.sources.map(({ status, ...source }) => ({ ...source, installed: status === 'installed' })),
    portalTarget: target(app(gateway, 'mcp_portal').id, portal.id),
    sourceTargets: control.sourceOwnership.map(({ sourceId, resources }) => ({ sourceId,
      ...target(resources[2].provider.parentId, resources[2].provider.id) })),
  });
  const claim = { actionId: `action_${'K'.repeat(32)}`, actionKey: BOOTSTRAP_NONCE,
    actorEmail: ADMIN, accountId: ACCOUNT_ID, expiresAt: Date.now() + 600_000 };
  const action = { schemaVersion: 1, actionId: claim.actionId, actorEmail: ADMIN,
    issuedAt: Date.now(), expiresAt: claim.expiresAt, actionKeyHash: await prefixedSha256(claim.actionKey),
    status: 'authorization_required', failureCode: null,
    request: { ...input, members: plan.nextState.members }, sourceRevision: sources.revision,
    planHash: await prefixedSha256({ plan, sourceRevision: sources.revision }), journal: [] };
  await gateway.managementStorage.put(TEAM_KEY, { ...gateway.managementStorage.snapshot(TEAM_KEY), pendingAction: action });
  return { claim, authorization: { actionId: action.actionId } };
}

async function runtimeAction(gateway, { operation = 'rollback', release = 'gateway-v0.0.9' } = {}) {
  const to = { release, artifactSha256: `sha256:${'8'.repeat(64)}`, versionId: '00000000-0000-4000-8000-000000000008' };
  await gateway.managementStorage.put(UPDATES_KEY, {
    schemaVersion: 1, revision: 1, actions: [],
    current: { release: gateway.env.ANKKA_GATEWAY_RELEASE,
      artifactSha256: gateway.env.ANKKA_GATEWAY_RELEASE_SHA256,
      versionId: '00000000-0000-4000-8000-000000000009' },
    previous: to,
  });
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 600_000;
  const actionId = `action_${'R'.repeat(32)}`;
  const stub = gateway.env.ADMIN_STATE.get('v1:management');
  const prepare = () => stub.fetch(new Request('https://admin-state.invalid/runtime-updates', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: canonicalJson({ actionId, actionKeyHash, actorEmail: ADMIN, issuedAt, expiresAt, operation, to }),
  }));
  const actionKeyHash = await prefixedSha256(BOOTSTRAP_NONCE);
  const begin = () => {
    const body = canonicalJson({ schemaVersion: 1, command: 'begin', actionId, actionKey: BOOTSTRAP_NONCE,
      issuedAt: Date.now(), expiresAt, operation });
    const signature = `sha256=${createHmac('sha256', Buffer.from(BOOTSTRAP_NONCE, 'base64url')).update(body).digest('hex')}`;
    return stub.fetch(new Request('https://admin-state.invalid/runtime-updates/control', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ankka-runtime-action-signature': signature }, body,
    }));
  };
  return { prepare, begin };
}

test('Team API requires matching administrator identity, same origin, exact schema and current revision', async () => fixture(async (gateway) => {
  const { api, env, provider } = gateway;
  const initial = await gateway.view();
  const input = changedRequest(initial);
  const baseline = provider.requests.length;
  const anonymous = await worker.fetch(new Request(`${MANAGEMENT_ORIGIN}/api/team-actions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: MANAGEMENT_ORIGIN }, body: canonicalJson(input),
  }), env);
  assert.equal(anonymous.status, 401);
  assert.equal((await api('/api/team-actions', { method: 'POST', body: input, email: MEMBER })).status, 401);
  assert.equal((await api('/api/team-actions', {
    method: 'POST', body: input, extraHeaders: { 'cf-access-authenticated-user-email': OWNER },
  })).status, 401);
  assert.equal((await api('/api/team-actions', {
    method: 'POST', body: input, extraHeaders: { origin: 'https://foreign.example.com' },
  })).status, 403);
  for (const malformed of [
    { ...input, expectedRevision: initial.revision + 1 },
    { ...input, members: input.members.filter(({ email }) => email !== OWNER) },
    { ...input, members: [...input.members, { email: ' ADMIN@EXAMPLE.COM ', sourceIds: [] }] },
    { ...input, members: [{ email: ADMIN, sourceIds: ['uninstalled-source'] }, { email: OWNER, sourceIds: [] }] },
    { ...input, members: input.members.map((member) => ({ ...member, role: 'admin' })) },
    { ...input, cloudflareAccessToken: SYNTHETIC_GRANT },
  ]) {
    const response = await api('/api/team-actions', { method: 'POST', body: malformed });
    assert.ok([400, 409].includes(response.status), await response.clone().text());
    assert.doesNotMatch(await response.text(), /new-person@example\.com|synthetic-team-action-grant/u);
  }
  delete env.ANKKA_MANAGEMENT_TOKEN;
  const valid = await api('/api/team-actions', { method: 'POST', body: input });
  assert.equal(valid.status, 409);
  assert.deepEqual(await valid.json(), { schemaVersion: 1, error: 'team_action_conflict' });
  assertNoMutation(provider, baseline);
}));

test('missing management credential leaves Team read-only without provider writes', async () => fixture(async (gateway) => {
  delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
  const view = await gateway.view();
  const before = canonicalJson(gateway.managementStorage.snapshot(TEAM_KEY));
  assert.equal(view.editingEnabled, false);
  assert.equal(view.editingDisabledReason, 'management_credential_missing');
  assert.equal(view.managementCredentialConfigured, false);
  assert.equal(Object.hasOwn(gateway.env, 'ANKKA_TEAM_MANAGEMENT_TOKEN'), false);
  const baseline = gateway.provider.requests.length;
  const response = await gateway.api('/api/team-actions', {
    method: 'POST',
    body: changedRequest(view),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { schemaVersion: 1, error: 'team_action_conflict' });
  assertNoMutation(gateway.provider, baseline);
  assert.equal(canonicalJson(gateway.managementStorage.snapshot(TEAM_KEY)), before);
}));

test('all legacy Team relays are retired, including valid and altered signed grants', async () => fixture(async (gateway) => {
  const prepared = await historicalPreparedTeam(gateway, changedRequest(await gateway.view()));
  const baseline = gateway.provider.requests.length;
  for (const override of [
    {}, { accountId: '9'.repeat(32) }, { actorEmail: MEMBER }, { actionKey: 'A'.repeat(43) },
    { action: 'install' }, { members: [{ email: NEW_PERSON, sourceIds: [] }] },
  ]) {
    const response = await gateway.apply(prepared, override);
    assert.ok(response.status >= 400, await response.clone().text());
  }
  assertNoMutation(gateway.provider, baseline);
}));

test('pristine legacy teardown keeps its existing exact receipt-backed path', async () => fixture(async (gateway) => {
  const send = await gateway.teardown();
  const proof = await send('prove');
  assert.equal(proof.status, 200, await proof.clone().text());
  const authority = await proof.json();
  assert.equal(canonicalJson(authority.authority.root.receipt), canonicalJson(gateway.readyReceipt));
  const removed = await send('apply', 'T'.repeat(22));
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal(gateway.provider.liveResourceCount(), 0);
}));

test('historical day-two ownership cannot alias another source application or policy parent during teardown', async () => fixture(async (gateway) => {
  await addHistoricalInstalledSource(gateway);
  await addHistoricalInstalledSource(gateway, { label: 'Other historical source', url: 'https://other.example.net/mcp' });
  const key = 'ankka-mcp-gateway/management-control/v1';
  const originalReceipt = canonicalJson(gateway.storage.snapshot());
  const control = gateway.managementStorage.snapshot(key);
  const [first, second] = control.sourceOwnership.slice(-2);
  second.resources[1].provider.id = first.resources[1].provider.id;
  second.resources[2].provider.parentId = first.resources[1].provider.id;
  await gateway.managementStorage.put(key, control);
  const baseline = gateway.provider.requests.length;
  const response = await gateway.api('/api/teardown-actions', { method: 'POST', body: { schemaVersion: 1 } });
  assert.equal(response.status, 409);
  assertNoMutation(gateway.provider, baseline);
  assert.equal(gateway.provider.deletes().length, 0);
  assert.equal(canonicalJson(gateway.storage.snapshot()), originalReceipt);
}));

test('historical day-two policy drift blocks every teardown deletion in the primary runtime', async () => fixture(async (gateway) => {
  const added = await addHistoricalInstalledSource(gateway);
  const send = await gateway.teardown();
  added.policy.include = [{ email: { email: 'unowned@example.com' } }];
  const proof = await send('prove');
  assert.equal(proof.status, 200, await proof.clone().text());
  const baseline = gateway.provider.requests.length;
  const result = await send('apply', 'Q'.repeat(22));
  assert.equal(result.status, 409);
  assertNoMutation(gateway.provider, baseline);
  assert.equal(gateway.provider.deletes().length, 0);
  assert.equal(gateway.provider.liveResourceCount(), 10);
}));

for (const drift of ['root Portal application alias', 'desired hash mismatch']) {
  test(`historical day-two ${drift} invalidates previously prepared primary teardown authority`, async () => fixture(async (gateway) => {
    const added = await addHistoricalInstalledSource(gateway);
    const send = await gateway.teardown();
    const valid = await send('prove');
    assert.equal(valid.status, 200, await valid.clone().text());
    const key = 'ankka-mcp-gateway/management-control/v1';
    const control = gateway.managementStorage.snapshot(key);
    const owned = control.sourceOwnership.find(({ sourceId }) => sourceId === added.source.id);
    if (drift === 'root Portal application alias') {
      const portalApplicationId = app(gateway, 'mcp_portal').id;
      owned.resources[1].provider.id = portalApplicationId;
      owned.resources[2].provider.parentId = portalApplicationId;
    } else {
      owned.resources[0].desiredHash = `sha256:${'0'.repeat(64)}`;
    }
    await gateway.managementStorage.put(key, control);
    const baseline = gateway.provider.requests.length;
    const proof = await send('prove');
    assert.equal(proof.status, 409);
    const result = await send('apply', 'Q'.repeat(22));
    assert.equal(result.status, 409);
    assertNoMutation(gateway.provider, baseline);
    assert.equal(gateway.provider.deletes().length, 0);
    assert.equal(gateway.provider.liveResourceCount(), 10);
  }));
}

test('pristine historical two-source additions retain exact primary-runtime teardown order without native Team state', async () => fixture(async (gateway) => {
  const first = await addHistoricalInstalledSource(gateway);
  const second = await addHistoricalInstalledSource(gateway, {
    label: 'Historical shared OAuth source', url: 'https://other.example.net/mcp', authMode: 'oauth',
  });
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY), undefined);
  assert.equal(gateway.provider.liveResourceCount(), 13);
  const send = await gateway.teardown();
  const proof = await send('prove');
  assert.equal(proof.status, 200, await proof.clone().text());
  const response = await send('apply', 'Q'.repeat(22));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).removedResourceCount, 13);
  assert.equal(gateway.provider.liveResourceCount(), 0);
  const expectedExtraIds = [first, second].sort((left, right) => right.source.id.localeCompare(left.source.id))
    .flatMap(({ resources }) => [...resources].reverse().map(({ provider }) => provider.id));
  assert.deepEqual(gateway.provider.deletes().slice(0, 6).map(({ pathname }) => pathname.split('/').at(-1)), expectedExtraIds);
}));

// New source provisioning has a distinct empty initial audience. It must not
// inherit the original receipt audience or change existing saved assignments.
for (const initialState of ['before first Team view', 'after Team view']) {
  test(`new source starts denied ${initialState} without changing existing grants or receipts`, async () => fixture(async (gateway) => {
    assert.equal(gateway.managementStorage.snapshot(TEAM_KEY), undefined);
    if (initialState !== 'before first Team view') await gateway.view();
    const publicSources = await (await gateway.api('/api/sources')).json();
    assert.equal(publicSources.installationEnabled, true);
    assert.equal(Object.hasOwn(gateway.managementStorage.snapshot(SOURCES_KEY), 'installationEnabled'), false);
    const originalPolicies = new Map([...gateway.provider.state.policies].map(([id, policies]) => [id, canonicalJson(policies)]));
    const originalMappings = structuredClone(gateway.provider.state.portal.servers);
    const originalReceipt = canonicalJson(gateway.storage.snapshot());
    const originalTeam = gateway.managementStorage.snapshot(TEAM_KEY);
    const baseline = gateway.provider.requests.length;
    const prepared = await prepareNewSource(gateway);
    assertNoMutation(gateway.provider, baseline);
    assert.deepEqual(gateway.managementStorage.snapshot(TEAM_KEY), originalTeam, 'draft and review do not arm a floor');
    const applied = await gateway.apply(prepared, {}, null);
    assert.equal(applied.status, 200, await applied.clone().text());
    const team = await gateway.view();
    assert.equal(team.sources.find((source) => source.id === prepared.source.id).status, 'installed');
    assert.equal(team.members.some((member) => member.sourceIds.includes(prepared.source.id)), false);
    if (originalTeam) {
      assert.deepEqual(team.members, originalTeam.members);
      assert.equal(team.revision, originalTeam.revision);
    }
    const ownership = gateway.managementStorage.snapshot('ankka-mcp-gateway/management-control/v1')
      .sourceOwnership.find((entry) => entry.sourceId === prepared.source.id);
    const newPolicy = gateway.provider.state.policies.get(ownership.resources[1].provider.id);
    assert.equal(newPolicy.length, 1);
    assert.deepEqual(newPolicy[0].include, [{ everyone: {} }]);
    assert.equal(newPolicy[0].decision, 'deny');
    assert.equal(ownership.resources[2].identityHash, await prefixedSha256({ emails: [] }));
    const retainedTeam = gateway.managementStorage.snapshot(TEAM_KEY);
    assert.equal(retainedTeam.teardownDisabled, true);
    assert.equal(retainedTeam.minimumRuntimeRelease, gateway.env.ANKKA_GATEWAY_RELEASE);
    for (const [id, policies] of originalPolicies) assert.equal(canonicalJson(gateway.provider.state.policies.get(id)), policies);
    assert.deepEqual(gateway.provider.state.portal.servers.filter((mapping) => mapping.server_id !== ownership.resources[0].provider.id), originalMappings);
    assert.equal(canonicalJson(gateway.storage.snapshot()), originalReceipt);
    assert.equal(gateway.provider.liveResourceCount(), 10);
    const next = { schemaVersion: 1, expectedRevision: team.revision,
      members: team.members.map((member) => member.email === ADMIN
        ? { ...member, sourceIds: [...member.sourceIds, prepared.source.id] } : member) };
    delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
    const denied = await gateway.api('/api/team-actions', { method: 'POST', body: next });
    assert.equal(denied.status, 409);
    assert.deepEqual(await denied.json(), { schemaVersion: 1, error: 'team_action_conflict' });
    assert.deepEqual(gateway.provider.state.policies.get(ownership.resources[1].provider.id)[0].include,
      [{ everyone: {} }]);
  }));
}

for (const status of ['authorization_required', 'recovery_required']) {
  test(`a legacy ${status} source handoff cannot resume an old Allow policy`, async () => fixture(async (gateway) => {
    const originalReceipt = canonicalJson(gateway.storage.snapshot());
    const prepared = await historicalPreparedSource(gateway, status);
    const originalPolicies = canonicalJson([...gateway.provider.state.policies]);
    const originalMappings = canonicalJson(gateway.provider.state.portal.servers);
    const baseline = gateway.provider.requests.length;
    const storageWrites = gateway.managementStorage.writes.length;
    const originalActions = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
    const originalSources = gateway.managementStorage.snapshot(SOURCES_KEY);
    const renewal = await gateway.api('/api/source-actions', { method: 'POST', body: {
      schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id,
    } });
    assert.equal(renewal.status, 409);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await gateway.apply(prepared, {}, null);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'source_action_legacy_policy');
    }
    const wrongKey = await gateway.apply({ ...prepared, claim: { ...prepared.claim, actionKey: 'Z'.repeat(43) } }, {}, null);
    assert.equal(wrongKey.status, 400);
    assert.deepEqual(gateway.provider.requests.slice(baseline).map(({ pathname }) => pathname), [`/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`]);
    assert.equal(gateway.managementStorage.writes.length, storageWrites);
    assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), originalActions);
    assert.deepEqual(gateway.managementStorage.snapshot(SOURCES_KEY), originalSources);
    assert.equal(canonicalJson([...gateway.provider.state.policies]), originalPolicies);
    assert.equal(canonicalJson(gateway.provider.state.portal.servers), originalMappings);
    assert.equal(canonicalJson(gateway.storage.snapshot()), originalReceipt);
    assert.equal(Object.hasOwn(gateway.env, 'ANKKA_TEAM_MANAGEMENT_TOKEN'), false);
  }));
}

test('source installation preserves administrator and same-origin authorization', async () => fixture(async (gateway) => {
  const baseline = gateway.provider.requests.length;
  const sources = await (await gateway.api('/api/sources')).json();
  for (const path of ['/api/sources', '/api/source-actions']) {
    const method = path === '/api/sources' ? 'PUT' : 'POST';
    const body = { schemaVersion: 1, revision: sources.revision };
    const anonymous = await worker.fetch(new Request(`${MANAGEMENT_ORIGIN}${path}`, {
      method, headers: { 'content-type': 'application/json', origin: MANAGEMENT_ORIGIN }, body: canonicalJson(body),
    }), gateway.env);
    assert.equal(anonymous.status, 401);
    assert.equal((await gateway.api(path, { method, body, email: MEMBER })).status, 401);
    assert.equal((await gateway.api(path, { method, body, extraHeaders: { origin: 'https://other.example.com' } })).status, 403);
  }
  assert.equal(gateway.provider.requests.length, baseline);
}));

test('slow consent is discoverable after reload and repeated Apply points to the same source action', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  const retained = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
  const baseline = gateway.provider.requests.length;
  let sourceRequests = 0;
  gateway.onSourceRequest(() => { sourceRequests += 1; });
  const pointer = { kind: 'source', actionId: prepared.claim.actionId, sourceId: prepared.source.id };
  for (let tab = 0; tab < 2; tab += 1) {
    gateway.reloadManagement();
    const response = await gateway.api('/api/source-actions');
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.deepEqual(snapshot.blockingAction, pointer);
    assert.equal(snapshot.actions.length, 1);
    const action = snapshot.actions[0];
    assert.equal(action.state, 'authorization_required');
    assert.equal(action.canCancel, true);
    assert.equal(action.issuedAt, new Date(retained.actions[0].issuedAt).toISOString());
    assert.equal(action.expiresAt, new Date(prepared.claim.expiresAt).toISOString());
    assert.doesNotMatch(canonicalJson(snapshot), /actionKey|actorEmail|accountId|provider|resources|sourceHash|cloudflareAccessToken|handoffUrl|catalog\.example/iu);
    const duplicate = await gateway.api('/api/source-actions', { method: 'POST', body: {
      schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id,
    } });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { schemaVersion: 1, error: 'source_action_conflict',
      reason: 'source_pending', action: pointer });
  }
  assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), retained);
  assert.equal(sourceRequests, 0, 'duplicate preparation stops before remote discovery');
  assertNoMutation(gateway.provider, baseline);
  const otherAdmin = await (await gateway.api('/api/source-actions', { email: OWNER })).json();
  assert.equal(otherAdmin.actions[0].canCancel, false);
  assert.equal((await gateway.api(`/api/source-actions/${prepared.claim.actionId}`, { method: 'DELETE', email: OWNER })).status, 409);
  assert.equal((await gateway.api('/api/source-actions', { email: MEMBER })).status, 401);
  assert.equal((await worker.fetch(new Request(`${MANAGEMENT_ORIGIN}/api/source-actions`), gateway.env)).status, 401);
  assert.equal((await gateway.api('/api/source-actions', {
    extraHeaders: { 'cf-access-authenticated-user-email': OWNER },
  })).status, 401);
  assert.equal((await gateway.api(`/api/source-actions/${prepared.claim.actionId}`, {
    method: 'DELETE', extraHeaders: { origin: 'https://other.example.com' },
  })).status, 403);
  assert.equal((await gateway.api(`/api/source-actions/${prepared.claim.actionId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await gateway.apply(prepared, {}, null)).status, 400, 'cancellation wins before execution claims');
  assertNoMutation(gateway.provider, baseline);
}));

test('an expired proven-unstarted source action requires owner cancellation before a fresh authorization', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  const saved = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
  const now = Date.now();
  await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, { ...saved,
    actions: saved.actions.map((action) => ({ ...action, issuedAt: now - 700_000, expiresAt: now - 100_000 })) });
  const snapshot = await (await gateway.api('/api/source-actions')).json();
  assert.equal(snapshot.actions[0].state, 'authorization_expired');
  assert.equal(snapshot.actions[0].canCancel, true);
  assert.equal(snapshot.blockingAction.actionId, prepared.claim.actionId);
  const repeat = await gateway.api('/api/source-actions', { method: 'POST', body: {
    schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id,
  } });
  assert.equal(repeat.status, 409);
  assert.equal((await repeat.json()).reason, 'source_pending');
  const cancelled = await gateway.api(`/api/source-actions/${prepared.claim.actionId}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'failed');
  assert.equal((await (await gateway.api('/api/source-actions')).json()).blockingAction, null);
  const next = await authorizeNewSource(gateway, prepared.source.id, prepared.sources.revision);
  assert.notEqual(next.claim.actionId, prepared.claim.actionId);
  const baseline = gateway.provider.requests.length;
  assert.equal((await gateway.apply(prepared, {}, null)).status, 400, 'old callback cannot execute after cancellation');
  assertNoMutation(gateway.provider, baseline);
}));

test('expired armed, partial, failed-with-evidence and unknown execution states remain protected', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  assert.equal((await gateway.apply(prepared, {}, null)).status, 200);
  const saved = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
  const complete = saved.actions[0];
  const now = Date.now();
  const expired = { ...complete, issuedAt: now - 700_000, expiresAt: now - 100_000,
    resources: [], pending: null, portalUpdate: null };
  const cases = [
    { ...expired, status: 'authorization_required', pending: { kind: 'mcp_server', phase: 'send_armed', provider: null } },
    { ...expired, status: 'failed', pending: { kind: 'mcp_server', phase: 'submitted', provider: complete.resources[0].provider } },
    { ...expired, status: 'recovery_required', resources: complete.resources.slice(0, 1) },
    { ...expired, status: 'applying' },
    { ...expired, status: 'applying', resources: complete.resources,
      portalUpdate: { phase: 'submitted', desiredHash: `sha256:${'8'.repeat(64)}` } },
  ];
  for (const action of cases) {
    const retained = { ...saved, actions: [action] };
    await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, retained);
    const before = gateway.managementStorage.writes.length;
    const baseline = gateway.provider.requests.length;
    const snapshot = await (await gateway.api('/api/source-actions')).json();
    assert.equal(snapshot.actions[0].state, 'recovery_required');
    assert.equal(snapshot.actions[0].canCancel, false);
    assert.equal(snapshot.blockingAction.actionId, action.actionId);
    for (const [path, options] of [
      [`/api/source-actions/${action.actionId}`, { method: 'DELETE' }],
      ['/api/source-actions', { method: 'POST', body: {
        schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id,
      } }],
    ]) {
      const response = await gateway.api(path, options);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).reason, 'recovery_required');
    }
    assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), retained);
    assert.equal(gateway.managementStorage.writes.length, before);
    assertNoMutation(gateway.provider, baseline);
  }
}));

test('source execution claims before remote discovery, stays observable and wins a cancellation race safely', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  gateway.onSourceRequest(async () => { entered(); await held; });
  const execution = gateway.apply(prepared, {}, null);
  await started;
  try {
    const snapshot = await (await gateway.api('/api/source-actions')).json();
    assert.equal(snapshot.actions[0].state, 'applying');
    assert.equal(snapshot.actions[0].canCancel, false);
    assert.equal((await gateway.api('/api/status')).status, 200);
    const during = await (await gateway.api('/api/sources')).json();
    assert.equal(during.sources.find((source) => source.id === prepared.source.id).status, 'draft');
    assert.equal((await (await gateway.api(`/api/source-actions/${prepared.claim.actionId}`)).json()).status, 'applying');
    const duplicate = await gateway.api('/api/source-actions', { method: 'POST', body: {
      schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id,
    } });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).reason, 'source_pending');
    const cancellation = gateway.api(`/api/source-actions/${prepared.claim.actionId}`, { method: 'DELETE' });
    release();
    assert.equal((await execution).status, 200);
    assert.equal((await cancellation).status, 409);
    const completed = await (await gateway.api('/api/source-actions')).json();
    assert.equal(completed.actions[0].state, 'succeeded');
    assert.equal(completed.actions[0].canCancel, false);
    assert.equal(completed.blockingAction, null);
    const sources = await (await gateway.api('/api/sources')).json();
    assert.equal(sources.sources.find((source) => source.id === prepared.source.id).status, 'installed');
    assert.doesNotMatch(canonicalJson(gateway.managementStorage.writes), /synthetic-legacy-installer-grant-never-store|cloudflareAccessToken/iu);
  } finally { release(); }
}));

test('a stale source draft revision has its own conflict and creates no authorization', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  assert.equal((await gateway.api(`/api/source-actions/${prepared.claim.actionId}`, { method: 'DELETE' })).status, 200);
  const saved = await gateway.api('/api/sources', { method: 'PUT', body: {
    schemaVersion: 1, revision: prepared.sources.revision,
    source: { label: 'Updated source label', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: ['company_lookup'] },
  } });
  assert.equal(saved.status, 200);
  const retained = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
  const stale = await gateway.api('/api/source-actions', { method: 'POST', body: {
    schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id,
  } });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { schemaVersion: 1, error: 'source_action_conflict', reason: 'draft_changed' });
  assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), retained);
}));

test('invalid source journal state cannot be presented as idle or replaced', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  const saved = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
  const invalid = { ...saved, actions: [{ ...saved.actions[0], pending: { phase: 'unknown' } }] };
  await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, invalid);
  const baseline = gateway.provider.requests.length;
  for (const options of [{}, { method: 'POST', body: {
    schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id,
  } }]) {
    const response = await gateway.api('/api/source-actions', options);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { schemaVersion: 1, error: 'source_actions_unavailable' });
  }
  assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), invalid);
  assertNoMutation(gateway.provider, baseline);
}));

for (const kind of ['source', 'runtime', 'teardown', 'team']) {
  test(`source preparation identifies an unrelated ${kind} action`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    if (kind !== 'source') {
      assert.equal((await gateway.api(`/api/source-actions/${prepared.claim.actionId}`, { method: 'DELETE' })).status, 200);
      if (kind === 'runtime') assert.equal((await (await runtimeAction(gateway)).prepare()).status, 200);
      if (kind === 'teardown') await gateway.teardown();
      if (kind === 'team') await historicalPreparedTeam(gateway, changedRequest(await gateway.view()));
    }
    const response = await gateway.api('/api/source-actions', { method: 'POST', body: {
      schemaVersion: 1, revision: prepared.sources.revision, sourceId: 'source-5555555555555555',
    } });
    assert.equal(response.status, 409);
    const conflict = await response.json();
    assert.equal(conflict.reason, kind === 'source' ? 'source_pending' : 'lifecycle_pending');
    assert.equal(conflict.action.kind, kind);
    const snapshot = await (await gateway.api('/api/source-actions')).json();
    assert.deepEqual(snapshot.blockingAction, conflict.action);
  }));
}

test('a fresh empty Portal can install its first source without implicitly granting it to anyone', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY), undefined);
  const response = await gateway.apply(prepared, {}, null);
  assert.equal(response.status, 200, await response.clone().text());
  const team = await gateway.view();
  assert.equal(team.sources.length, 1);
  assert.equal(team.members.every((member) => member.sourceIds.length === 0), true);
  assert.equal(gateway.provider.state.portal.servers[0].on_behalf, false);
  assert.equal(gateway.provider.state.portal.servers[0].default_disabled, true);
}, await portalOnlyClaim()));

async function expireSourceAction(gateway, actionId) {
  const state = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
  const now = Date.now();
  await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, { ...state,
    actions: state.actions.map((action) => {
      if (action.actionId !== actionId) return action;
      const expired = { ...action, issuedAt: now - 700_000, expiresAt: now - 100_000 };
      if (action.renewedAt !== undefined) expired.renewedAt = expired.issuedAt;
      return expired;
    }),
  });
}

for (const [message, label] of [
  ['servers[0].server_id is required: synthetic-private-value', 'field_server_id'],
  ['Not valid ID format: synthetic-private-value', 'id_format'],
  ['synthetic-private-value', null],
]) {
  test(`portal rejection exposes only a fixed validation label (${label ?? 'none'})`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    const beforePortal = structuredClone(gateway.provider.state.portal);
    gateway.provider.hook(({ record }) => {
      if (record.method !== 'PUT' || !record.pathname.includes('/mcp/portals/')) return undefined;
      return Response.json({ success: false, errors: [{ code: 7001, message }] }, { status: 400 });
    });
    const response = await gateway.apply(prepared, {}, null);
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.detail, `portal_update_blocked_http_400_code_7001${label ? `_${label}` : ''}`);
    assert.equal(JSON.stringify(result).includes('synthetic-private-value'), false);
    const retained = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
    assert.equal(JSON.stringify(retained).includes('synthetic-private-value'), false);
    assert.equal(retained.actions.at(-1).resources.length, 3);
    assert.deepEqual(gateway.provider.state.portal, beforePortal);
  }));
}

async function renewPreparedSource(gateway, prepared) {
  const { claim } = await authorizeNewSource(gateway, prepared.source.id, prepared.sources.revision, prepared.claim.actionId);
  assert.equal(claim.actionId, prepared.claim.actionId);
  assert.notEqual(claim.actionKey, prepared.claim.actionKey);
  return { ...prepared, claim };
}

for (const [authentication, status, tools, failureCode] of [
  ['required', 'waiting', [], 'source_connection_required'],
  ['stale', 'stale', [], 'source_connection_required'],
  ['connected', 'waiting', [], 'source_sync_required'],
  ['connected', 'error', [], 'source_sync_required'],
  ['connected', 'ready', [{ name: 'other_tool' }], 'source_tools_mismatch'],
]) {
  test(`source waits for ${authentication}/${status} before attaching exact tools`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    const beforePortal = structuredClone(gateway.provider.state.portal);
    gateway.provider.hook(({ record, state }) => {
      if (record.method !== 'POST' || !record.pathname.endsWith('/mcp/servers')) return undefined;
      const server = { ...record.body, authentication_status: authentication, status, tools,
        error: 'synthetic-private-provider-detail',
      };
      state.servers.set(server.id, server);
      return envelope(server);
    });
    const response = await gateway.apply(prepared, {}, null);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, failureCode);
    const retained = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.at(-1);
    assert.equal(retained.resources.length, 3);
    assert.equal(retained.pending, null);
    assert.equal(retained.portalUpdate, null);
    assert.equal(JSON.stringify(retained).includes('synthetic-private'), false);
    assert.deepEqual(gateway.provider.state.portal, beforePortal);
    const policyResource = retained.resources[2];
    const policies = gateway.provider.state.policies.get(policyResource.provider.parentId);
    assert.equal(policies.length, 1);
    assert.equal(policies[0].decision, 'deny');
    assert.deepEqual(policies[0].include, [{ everyone: {} }]);
    const snapshot = (await (await gateway.api('/api/source-actions')).json()).actions.at(-1);
    assert.equal(snapshot.canRenew, true, 'a completed connection pause can renew before expiry');
    assert.equal(snapshot.canCancel, false);
    assert.equal(snapshot.connectionUrl,
      `https://dash.cloudflare.com/${ACCOUNT_ID}/one/access-controls/ai-controls/mcp-server/edit/${retained.resources[0].provider.id}`);
    const otherAdmin = (await (await gateway.api('/api/source-actions', { email: OWNER })).json()).actions.at(-1);
    assert.equal(otherAdmin.canRenew, false);
    const renewed = await renewPreparedSource(gateway, prepared);
    assert.equal((await gateway.apply(prepared, { expiresAt: renewed.claim.expiresAt }, null)).status, 400);
    const server = gateway.provider.state.servers.get(retained.resources[0].provider.id);
    Object.assign(server, { authentication_status: 'connected', status: 'ready',
      tools: prepared.source.enabledTools.map((name) => ({ name })),
    });
    gateway.provider.hook(undefined);
    const baseline = gateway.provider.requests.length;
    const result = await gateway.apply(renewed, {}, null);
    assert.equal(result.status, 200, await result.clone().text());
    const mutations = gateway.provider.requests.slice(baseline).filter(({ method }) => method !== 'GET');
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].method, 'PUT');
    assert.equal(mutations[0].body.servers.at(-1).default_disabled, true);
    assert.deepEqual(gateway.provider.state.policies.get(policyResource.provider.parentId), policies);
    assert.equal((await gateway.view()).members.some((member) => member.sourceIds.includes(prepared.source.id)), false);
  }));
}

for (const portalCommitted of [false, true]) {
  test(`renewed source consent reconciles retained portal work without recreating resources (committed: ${portalCommitted})`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    gateway.provider.hook(({ record, state }) => {
      if (record.method !== 'PUT' || !record.pathname.includes('/mcp/portals/')) return undefined;
      if (portalCommitted) state.portal = { id: state.portal.id, ...record.body };
      return envelope(null, 503);
    });
    assert.equal((await gateway.apply(prepared, {}, null)).status, 409);
    const path = `/api/source-actions/${prepared.claim.actionId}/renew`;
    const options = { method: 'POST', body: { schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id } };
    assert.equal((await gateway.api(path, options)).status, 409, 'unexpired work cannot renew');
    await expireSourceAction(gateway, prepared.claim.actionId);
    const before = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.at(-1);
    assert.equal(before.resources.length, 3);
    assert.equal((await (await gateway.api('/api/source-actions')).json()).actions.at(-1).canRenew, true);
    assert.equal((await gateway.api(path, { ...options, email: OWNER })).status, 409);
    assert.equal((await gateway.api(path, { ...options, email: MEMBER })).status, 401);
    assert.equal((await gateway.api(path, { ...options, extraHeaders: { origin: 'https://other.example.com' } })).status, 403);
    assert.equal((await gateway.api(path, { ...options, body: { ...options.body, revision: 999 } })).status, 409);
    gateway.provider.hook(undefined);
    const baseline = gateway.provider.requests.length;
    const renewed = await renewPreparedSource(gateway, prepared);
    const retained = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.at(-1);
    for (const field of ['resources', 'pending', 'portalUpdate', 'sourceHash', 'sourceRevision', 'failureCode']) {
      assert.deepEqual(retained[field], before[field], field);
    }
    assertNoMutation(gateway.provider, baseline);
    const pending = (await (await gateway.api('/api/source-actions')).json()).actions.at(-1);
    assert.equal(pending.state, 'authorization_required');
    assert.equal(pending.canCancel, false);
    assert.equal(pending.canRenew, false);
    assert.equal((await gateway.api(path, options)).status, 409, 'one renewal per consent window');
    assert.equal((await gateway.api(`/api/source-actions/${retained.actionId}`, { method: 'DELETE' })).status, 409);
    assert.equal((await gateway.apply(prepared, { expiresAt: renewed.claim.expiresAt }, null)).status, 400, 'old key is revoked');
    const result = await gateway.apply(renewed, {}, null);
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).status, 'succeeded');
    const mutations = gateway.provider.requests.slice(baseline).filter((request) => request.method !== 'GET');
    assert.equal(mutations.length, portalCommitted ? 0 : 1);
    if (!portalCommitted) {
      assert.equal(mutations[0].method, 'PUT');
      assert.equal(mutations[0].body.servers.some((mapping) => mapping.id === retained.resources[0].provider.id), true);
      assert.equal(mutations[0].body.servers.every((mapping) => mapping.server_id === mapping.id), true);
    }
    assert.equal((await gateway.view()).members.some((member) => member.sourceIds.includes(prepared.source.id)), false);
    assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).teardownDisabled, true);
  }));
}

test('renewal refuses unknown Access application creation and leaves its evidence untouched', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  gateway.provider.hook(({ record }) => record.method === 'POST' && record.pathname === API_APPS
    ? envelope(null, 503) : undefined);
  assert.equal((await gateway.apply(prepared, {}, null)).status, 409);
  await expireSourceAction(gateway, prepared.claim.actionId);
  const retained = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
  assert.deepEqual(retained.actions.at(-1).pending, { kind: 'source_access_application', phase: 'send_armed', provider: null });
  const snapshot = await (await gateway.api('/api/source-actions')).json();
  assert.equal(snapshot.actions.at(-1).canRenew, false);
  const baseline = gateway.provider.requests.length;
  const response = await gateway.api(`/api/source-actions/${prepared.claim.actionId}/renew`, {
    method: 'POST', body: { schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), retained);
  assertNoMutation(gateway.provider, baseline);
}));

test('concurrent token renewals complete one action without exposing a handoff', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  gateway.provider.hook(({ record }) => record.method === 'PUT' && record.pathname.includes('/mcp/portals/')
    ? envelope(null, 503) : undefined);
  assert.equal((await gateway.apply(prepared, {}, null)).status, 409);
  await expireSourceAction(gateway, prepared.claim.actionId);
  gateway.provider.hook(undefined);
  const responses = await Promise.all([0, 1].map(() => gateway.api(`/api/source-actions/${prepared.claim.actionId}/renew`, {
    method: 'POST', body: { schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id },
  })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const renewed = await responses.find((response) => response.status === 200).json();
  assert.equal(renewed.status, 'succeeded');
  assert.equal(renewed.actionId, prepared.claim.actionId);
  assert.equal(Object.hasOwn(renewed, 'handoffUrl'), false);
}));

for (const createdBeforeFailure of [false, true]) {
  test(`source create uncertainty preserves its journal and floor (provider committed: ${createdBeforeFailure})`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    const originalReceipt = canonicalJson(gateway.storage.snapshot());
    const originalMappings = structuredClone(gateway.provider.state.portal.servers);
    gateway.provider.hook(({ record, state }) => {
      if (record.method !== 'POST' || !record.pathname.endsWith('/mcp/servers')) return undefined;
      const team = gateway.managementStorage.snapshot(TEAM_KEY);
      assert.equal(team.teardownDisabled, true, 'floor must be durable before potential creation');
      assert.equal(team.minimumRuntimeRelease, gateway.env.ANKKA_GATEWAY_RELEASE);
      if (createdBeforeFailure) state.servers.set(record.body.id, { ...record.body, status: 'ready',
        tools: record.body.updated_tools.map(({ name }) => ({ name })),
      });
      return envelope(null, 503);
    });
    const response = await gateway.apply(prepared, {}, null);
    assert.equal(response.status, 409);
    const retained = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.at(-1);
    assert.equal(retained.status, 'recovery_required');
    assert.equal(retained.initialPolicyVersion, 2);
    assert.deepEqual(retained.pending, { kind: 'mcp_server', phase: 'send_armed', provider: null });
    const cancelled = await gateway.api(`/api/source-actions/${retained.actionId}`, { method: 'DELETE' });
    assert.equal(cancelled.status, 409);
    assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.at(-1), retained);
    assert.deepEqual(gateway.provider.state.portal.servers, originalMappings);
    assert.equal(canonicalJson(gateway.storage.snapshot()), originalReceipt);
    gateway.provider.hook(undefined);
    const baseline = gateway.provider.requests.length;
    const renewal = await gateway.api('/api/source-actions', { method: 'POST', body: {
      schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id,
    } });
    assert.equal(renewal.status, 409);
    assert.equal((await renewal.json()).reason, 'recovery_required');
    assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.at(-1), retained);
    assertNoMutation(gateway.provider, baseline);
    assert.equal((await gateway.view()).members.some((member) => member.sourceIds.includes(prepared.source.id)), false);
    await expireSourceAction(gateway, prepared.claim.actionId);
    const renewed = await renewPreparedSource(gateway, prepared);
    const resumed = await gateway.apply(renewed, {}, null);
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const serverCreates = gateway.provider.requests.slice(baseline).filter((request) =>
      request.method === 'POST' && request.pathname.endsWith('/mcp/servers'));
    assert.equal(serverCreates.length, createdBeforeFailure ? 0 : 1);
  }));
}

for (const committedBeforeInterruption of [false, true]) {
  test(`source finalization is all-or-nothing across ownership, installed status and journal (committed: ${committedBeforeInterruption})`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    const controlKey = 'ankka-mcp-gateway/management-control/v1';
    const originalControl = gateway.managementStorage.snapshot(controlKey);
    const originalSources = gateway.managementStorage.snapshot(SOURCES_KEY);
    const originalPut = gateway.managementStorage.put;
    let interrupted = false;
    gateway.managementStorage.put = async (key, value) => {
      if (Object.hasOwn(key, SOURCES_KEY)) {
        assert.deepEqual(Object.keys(key).sort(), [controlKey, SOURCES_KEY, SOURCE_ACTIONS_KEY].sort());
        const completed = key[SOURCE_ACTIONS_KEY].actions.find((action) => action.actionId === prepared.claim.actionId);
        assert.equal(completed.status, 'succeeded');
        assert.equal(key[SOURCES_KEY].sources.find((source) => source.id === prepared.source.id).status, 'installed');
        assert.deepEqual(key[controlKey].sourceOwnership.find((entry) => entry.sourceId === prepared.source.id).resources,
          completed.resources);
        interrupted = true;
        if (committedBeforeInterruption) await originalPut(key);
        throw new Error('synthetic local commit interruption');
      }
      return originalPut(key, value);
    };
    const response = await gateway.apply(prepared, {}, null);
    assert.equal(response.status, 503);
    assert.equal(interrupted, true);
    gateway.managementStorage.put = originalPut;
    const state = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
    const action = state.actions.find((entry) => entry.actionId === prepared.claim.actionId);
    const baseline = gateway.provider.requests.length;
    if (committedBeforeInterruption) {
      assert.equal(action.status, 'succeeded');
      const refreshed = await gateway.api(`/api/source-actions/${action.actionId}`);
      assert.equal((await refreshed.json()).status, 'succeeded');
    } else {
      assert.deepEqual(gateway.managementStorage.snapshot(controlKey), originalControl);
      assert.deepEqual(gateway.managementStorage.snapshot(SOURCES_KEY), originalSources);
      assert.equal(action.status, 'applying');
      assert.equal(action.resources.length, 3);
      assert.equal(action.portalUpdate.phase, 'submitted');
      // Expiry does not establish whether the provider or final local commit
      // completed. Preserve the journal without minting a replacement action.
      const now = Date.now();
      await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, { ...state,
        actions: state.actions.map((entry) => entry.actionId === action.actionId
          ? { ...entry, issuedAt: now - 700_000, expiresAt: now - 100_000 } : entry) });
      const retained = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
      const renewal = await gateway.api('/api/source-actions', { method: 'POST', body: {
        schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id,
      } });
      assert.equal(renewal.status, 409);
      assert.equal((await renewal.json()).reason, 'recovery_required');
      assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), retained);
    }
    assertNoMutation(gateway.provider, baseline);
    if (!committedBeforeInterruption) {
      assert.equal((await gateway.api('/api/team')).status, 503, 'uncertain portal ownership cannot be presented as a verified live view');
      delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
    }
    const team = await gateway.view();
    assert.equal(team.sources.find((source) => source.id === prepared.source.id).status,
      committedBeforeInterruption ? 'installed' : 'draft');
    assert.equal(team.members.some((member) => member.sourceIds.includes(prepared.source.id)), false);
    assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).teardownDisabled, true);
  }));
}

for (const decision of ['allow', 'bypass']) {
  test(`new source cannot be mapped when its native application has a competing ${decision} policy`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    const originalMappings = structuredClone(gateway.provider.state.portal.servers);
    gateway.provider.hook(({ record, state }) => {
      if (record.method !== 'GET' || !record.pathname.endsWith('/policies')) return undefined;
      const id = record.pathname.split('/').at(-2);
      const policies = state.policies.get(id);
      if (policies?.length === 1 && policies[0].decision === 'deny') {
        policies.push({ id: 'foreign-policy', name: 'Unrelated policy', decision, include: [{ everyone: {} }], exclude: [], require: [] });
      }
      return undefined;
    });
    const response = await gateway.apply(prepared, {}, null);
    assert.equal(response.status, 409);
    assert.deepEqual(gateway.provider.state.portal.servers, originalMappings);
    assert.equal(gateway.provider.puts().length, 0);
  }));
}

test('new source checks the exact Portal baseline before its first mapping PUT', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  gateway.provider.state.portal.servers.push({ server_id: 'foreign-server', default_disabled: true,
    on_behalf: false, updated_tools: [{ name: 'foreign_read', enabled: true }] });
  const mappings = structuredClone(gateway.provider.state.portal.servers);
  const response = await gateway.apply(prepared, {}, null);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'portal_drift');
  assert.equal(gateway.provider.puts().length, 0);
  assert.deepEqual(gateway.provider.state.portal.servers, mappings);
}));

test('stale source revisions stop provisioning before any mutation', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  const saved = gateway.managementStorage.snapshot(SOURCES_KEY);
  await gateway.managementStorage.put(SOURCES_KEY, { ...saved, revision: saved.revision + 1 });
  const baseline = gateway.provider.requests.length;
  const response = await gateway.apply(prepared, {}, null);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'source_action_conflict');
  assertNoMutation(gateway.provider, baseline);
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY), undefined);
}));

test('another prepared lifecycle action stops source provisioning before its first mutation', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  await gateway.teardown();
  const baseline = gateway.provider.requests.length;
  const response = await gateway.apply(prepared, {}, null);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'source_action_conflict');
  assertNoMutation(gateway.provider, baseline);
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY), undefined);
}));

for (const status of ['authorization_required', 'failed', 'recovery_required']) {
  test(`an expired other ${status} source journal is retained and blocks new preparation`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    const saved = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
    const now = Date.now();
    const uncertain = { ...saved.actions[0], actionId: `action_${'X'.repeat(32)}`,
      sourceId: 'source-5555555555555555', issuedAt: now - 700_000, expiresAt: now - 100_000,
      status, pending: { kind: 'mcp_server', phase: 'send_armed', provider: null } };
    const retained = { ...saved, actions: [...saved.actions, uncertain] };
    await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, retained);
    const baseline = gateway.provider.requests.length;
    const writes = gateway.managementStorage.writes.length;
    const response = await gateway.api('/api/source-actions', { method: 'POST', body: {
      schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id,
    } });
    assert.equal(response.status, 409);
    assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), retained);
    assert.equal(gateway.managementStorage.writes.length, writes);
    assertNoMutation(gateway.provider, baseline);
    assert.equal(gateway.managementStorage.snapshot(TEAM_KEY), undefined);
  }));
}

for (const [field, value] of [
  ['id', 'foreign-portal'], ['name', 'Unrelated Portal'], ['hostname', 'other.example.com'],
  ['description', 'foreign-marker'], ['code_mode', 'default_off'], ['secure_web_gateway', true],
  ['servers', null],
]) {
  test(`an empty Portal with malformed ${field} cannot be overwritten during first-source installation`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    gateway.provider.hook(({ record, state }) => record.method === 'GET' &&
      record.pathname.endsWith(`/mcp/portals/${state.portal.id}`)
      ? envelope({ ...state.portal, [field]: value }) : undefined);
    const response = await gateway.apply(prepared, {}, null);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'portal_drift');
    assert.equal(gateway.provider.puts().length, 0);
    assert.equal(gateway.provider.state.portal.servers, undefined);
  }, await portalOnlyClaim()));
}

test('new receipt hashes cannot be relabeled as legacy authority to grant access', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  const installed = await gateway.apply(prepared, {}, null);
  assert.equal(installed.status, 200);
  const team = await gateway.view();
  const controlKey = 'ankka-mcp-gateway/management-control/v1';
  const control = gateway.managementStorage.snapshot(controlKey);
  const ownership = control.sourceOwnership.find((entry) => entry.sourceId === prepared.source.id);
  ownership.resources[2].identityHash = await prefixedSha256({ emails: control.audienceEmails });
  await gateway.managementStorage.put(controlKey, control);
  const baseline = gateway.provider.requests.length;
  const response = await gateway.apply(await gateway.draft({ schemaVersion: 1, expectedRevision: team.revision,
    members: team.members.map((member) => member.email === ADMIN
      ? { ...member, sourceIds: [...member.sourceIds, prepared.source.id] } : member),
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(gateway.provider.requests.slice(baseline).map(({ pathname }) => pathname), [`/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`]);
}));

test('restoring Team from legacy and native source receipts never grants a new source or loses its compatibility floor', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  const response = await gateway.apply(prepared, {}, null);
  assert.equal(response.status, 200);
  // Model a restored source/ownership snapshot with no saved Team record.
  await gateway.managementStorage.put(TEAM_KEY, undefined);
  const baseline = gateway.provider.requests.length;
  const team = await gateway.view();
  assert.equal(team.members.some((member) => member.sourceIds.includes(prepared.source.id)), false);
  const legacySource = team.sources.find((source) => source.id !== prepared.source.id);
  assert.ok(team.members.some((member) => member.sourceIds.includes(legacySource.id)));
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).minimumRuntimeRelease, gateway.env.ANKKA_GATEWAY_RELEASE);
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).teardownDisabled, true);
  assertNoMutation(gateway.provider, baseline);
}));

test('an unstarted old source handoff can be cancelled but an old armed journal remains untouched', async () => {
  for (const phase of ['authorization_required', 'recovery_required']) await fixture(async (gateway) => {
    const prepared = await historicalPreparedSource(gateway, phase);
    const before = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
    const cancelled = await gateway.api(`/api/source-actions/${prepared.claim.actionId}`, { method: 'DELETE' });
    assert.equal(cancelled.status, phase === 'authorization_required' ? 200 : 409);
    if (phase === 'recovery_required') assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), before);
    else {
      const next = await authorizeNewSource(gateway, prepared.source.id, prepared.sources.revision);
      assert.notEqual(next.claim.actionId, prepared.claim.actionId);
      assert.equal(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.at(-1).initialPolicyVersion, 2);
    }
  });
});

test('a previously authorized teardown cannot prove or execute after native permission exclusion is recorded', async () => fixture(async (gateway) => {
  const send = await gateway.teardown();
  await gateway.view();
  const originalReceipt = canonicalJson(gateway.readyReceipt);
  // Model a retained authorization presented after a separately durable native
  // mutation boundary. The exclusion must be enforced at execution, not just
  // by hiding or disabling the fresh handoff UI.
  await gateway.managementStorage.put(TEAM_KEY, {
    ...gateway.managementStorage.snapshot(TEAM_KEY),
    minimumRuntimeRelease: gateway.env.ANKKA_GATEWAY_RELEASE, teardownDisabled: true,
  });
  const baseline = gateway.provider.requests.length;
  for (const [command, requestId] of [['prove', undefined], ['apply', 'U'.repeat(22)]]) {
    const response = await send(command, requestId);
    assert.equal(response.status, 409, await response.clone().text());
  }
  assertNoMutation(gateway.provider, baseline);
  assert.equal(gateway.provider.deletes().length, 0);
  assert.equal(canonicalJson(gateway.storage.snapshot()), originalReceipt);
}));

test('an unstarted legacy Team proposal can be cancelled while an armed journal remains protected', async () => fixture(async (gateway) => {
  const input = changedRequest(await gateway.view());
  const first = await historicalPreparedTeam(gateway, input);
  const firstPath = `/api/team-actions/${first.authorization.actionId}`;
  const status = await gateway.api(firstPath);
  assert.equal((await status.json()).canCancel, true);
  const foreignActor = await gateway.api(firstPath, { method: 'DELETE', body: {}, email: OWNER });
  assert.equal(foreignActor.status, 409);
  const cancelled = await gateway.api(firstPath, { method: 'DELETE', body: {} });
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  assert.equal((await cancelled.json()).status, 'failed');
  const stale = await gateway.apply(first);
  assert.equal(stale.status, 410);
  assert.equal(gateway.provider.puts().length, 0);

  const second = await historicalPreparedTeam(gateway, input);
  const retained = gateway.managementStorage.snapshot(TEAM_KEY);
  retained.pendingAction.status = 'recovery_required';
  retained.pendingAction.failureCode = 'team_action_recovery_required';
  retained.pendingAction.journal = [{ policyId: 'm'.repeat(32), phase: 'send_armed' }];
  await gateway.managementStorage.put(TEAM_KEY, retained);
  const secondPath = `/api/team-actions/${second.authorization.actionId}`;
  const pending = await gateway.api(secondPath);
  assert.equal((await pending.json()).canCancel, false);
  const before = canonicalJson(gateway.managementStorage.snapshot(TEAM_KEY));
  const rejected = await gateway.api(secondPath, { method: 'DELETE', body: {} });
  assert.equal(rejected.status, 409);
  assert.equal(canonicalJson(gateway.managementStorage.snapshot(TEAM_KEY)), before);
}));

test('rollback authorized before a native mutation cannot begin below the subsequently recorded floor', async () => fixture(async (gateway) => {
  await gateway.view();
  const rollback = await runtimeAction(gateway);
  const prepared = await rollback.prepare();
  assert.equal(prepared.status, 200, await prepared.clone().text());
  await gateway.managementStorage.put(TEAM_KEY, {
    ...gateway.managementStorage.snapshot(TEAM_KEY),
    minimumRuntimeRelease: gateway.env.ANKKA_GATEWAY_RELEASE, teardownDisabled: true,
  });
  const before = canonicalJson(gateway.managementStorage.snapshot(UPDATES_KEY));
  const begun = await rollback.begin();
  assert.equal(begun.status, 409, await begun.clone().text());
  assert.equal(canonicalJson(gateway.managementStorage.snapshot(UPDATES_KEY)), before);
}));

test('a retained proposal resumes locally but its old OAuth relay stays retired', async () => fixture(async (gateway) => {
  const input = changedRequest(await gateway.view());
  const legacy = await historicalPreparedTeam(gateway, input);
  const before = canonicalJson(gateway.managementStorage.snapshot(TEAM_KEY));
  const baseline = gateway.provider.requests.length;
  const stale = await gateway.apply(legacy);
  assert.equal(stale.status, 410);
  assertNoMutation(gateway.provider, baseline);
  assert.equal(canonicalJson(gateway.managementStorage.snapshot(TEAM_KEY)), before);
  const applied = await gateway.api('/api/team-actions', { method: 'POST', body: input });
  assert.equal(applied.status, 200, await applied.clone().text());
  assert.equal((await applied.json()).action.status, 'succeeded');
  assert.ok(gateway.provider.puts().length > 0);
}));

for (const assignment of ['deny', 'members']) {
  test(`current teardown removes a native source with ${assignment} while retaining its immutable ownership receipt`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    assert.equal((await gateway.apply(prepared, {}, null)).status, 200);
    const original = structuredClone(gateway.readyReceipt);
    const ownership = gateway.managementStorage.snapshot('ankka-mcp-gateway/management-control/v1').sourceOwnership
      .find((entry) => entry.sourceId === prepared.source.id);
    const policy = gateway.provider.state.policies.get(ownership.resources[1].provider.id)[0];
    if (assignment === 'members') Object.assign(policy, {
      decision: 'allow', include: [{ email: { email: MEMBER } }],
    });
    const teardown = await gateway.currentTeardown();
    assert.equal(teardown.prepared.status, 200, await teardown.prepared.clone().text());
    assert.equal((await teardown.send('prove', undefined, true)).status, 409, 'old routes cannot widen their matcher');
    const proof = await teardown.send('prove');
    assert.equal(proof.status, 200, await proof.clone().text());
    const result = await teardown.send('apply');
    assert.equal(result.status, 200, await result.clone().text());
    const completion = await result.json();
    assert.equal(completion.removedResourceCount, 7);
    assert.equal(completion.readyReceiptChecksum, original.checksum);
    assert.equal(completion.dependencyResourcesHash, gateway.storage.snapshot().teardown.resourcesHash);
    assert.deepEqual((await proof.json()).receiptResourceKinds, ['access_application', 'access_policy', 'dns_record', 'mcp_portal', 'mcp_server']);
    assert.equal(gateway.provider.liveResourceCount(), 0);
    assert.deepEqual(gateway.storage.snapshot().receipt, original);
    const order = gateway.provider.deletes().map(({ pathname }) => pathname);
    assert.ok(order.findIndex((path) => path.includes('/mcp/portals/')) < order.findIndex((path) => path.includes('/mcp/servers/')));
    const deletes = order.length;
    assert.equal((await teardown.send('apply', 'G'.repeat(22))).status, 200);
    assert.equal(gateway.provider.deletes().length, deletes);
    assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).minimumRuntimeRelease, gateway.env.ANKKA_GATEWAY_RELEASE);
    assert.doesNotMatch(JSON.stringify(gateway.managementStorage.writes), /synthetic-legacy-installer-grant-never-store/);
  }, await portalOnlyClaim()));
}

test('current teardown retains a completed BigQuery bridge until its resources have a compatible removal path', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  assert.equal((await gateway.apply(prepared, {}, null)).status, 200);
  const saved = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
  const action = saved.actions.find((entry) => entry.actionId === prepared.claim.actionId);
  assert.equal(action.status, 'succeeded');
  action.bigquerySetupStarted = true;
  await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, saved);
  const teardown = await gateway.currentTeardown();
  assert.equal(teardown.prepared.status, 409);
  assert.equal(gateway.provider.deletes().length, 0);
}, await portalOnlyClaim()));

for (const change of ['foreign policy', 'renamed policy', 'different destination', 'different receipt hash', 'shared server']) {
  test(`current teardown rejects ${change} before deleting any resource`, async () => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    assert.equal((await gateway.apply(prepared, {}, null)).status, 200);
    const key = 'ankka-mcp-gateway/management-control/v1';
    const control = gateway.managementStorage.snapshot(key);
    const ownership = control.sourceOwnership.find((entry) => entry.sourceId === prepared.source.id);
    const application = gateway.provider.state.apps.get(ownership.resources[1].provider.id);
    const policies = gateway.provider.state.policies.get(application.id);
    const teardown = await gateway.currentTeardown();
    assert.equal(teardown.prepared.status, 200);
    assert.equal((await teardown.send('prove')).status, 200);
    if (change === 'foreign policy') policies.push({ ...policies[0], id: 'foreign-policy', name: 'Unrelated policy' });
    if (change === 'renamed policy') policies[0].name = 'Unrelated policy';
    if (change === 'different destination') application.destinations[0].mcp_server_id = 'foreign-server';
    if (change === 'shared server') {
      gateway.provider.hook(({ record, state }) => {
        if (record.method !== 'GET') return undefined;
        if (record.pathname.endsWith('/mcp/portals')) return envelope([state.portal, { id: 'foreign-portal' }]);
        if (record.pathname.endsWith('/mcp/portals/foreign-portal')) return envelope({
          id: 'foreign-portal', servers: [{ id: ownership.resources[0].provider.id }],
        });
        return undefined;
      });
    }
    if (change === 'different receipt hash') {
      ownership.resources[0].desiredHash = `sha256:${'0'.repeat(64)}`;
      await gateway.managementStorage.put(key, control);
    }
    assert.equal((await teardown.send('apply')).status, 409);
    assert.equal(gateway.provider.deletes().length, 0);
  }, await portalOnlyClaim()));
}


for (let lostDelete = 0; lostDelete < 7; lostDelete += 1) {
  test(`current teardown renews consent and resumes after losing deletion ${lostDelete + 1}'s response`, async (context) => fixture(async (gateway) => {
    const prepared = await prepareNewSource(gateway);
    assert.equal((await gateway.apply(prepared, {}, null)).status, 200);
    const first = await gateway.currentTeardown();
    assert.equal(first.prepared.status, 200);
    assert.equal((await first.send('prove')).status, 200);
    let deletes = 0;
    gateway.provider.hook(({ record, state }) => {
      if (record.method !== 'DELETE' || deletes++ !== lostDelete) return undefined;
      const path = record.pathname;
      const id = path.split('/').at(-1);
      if (path.includes('/dns_records/')) state.dns = null;
      else if (path.includes('/mcp/portals/')) state.portal = null;
      else if (path.includes('/mcp/servers/')) { state.servers.delete(id); state.server = null; }
      else if (path.includes('/policies/')) {
        const applicationId = path.split('/').at(-3);
        state.policies.set(applicationId, state.policies.get(applicationId).filter((policy) => policy.id !== id));
      } else { state.apps.delete(id); state.policies.delete(id); }
      return envelope(null, 503);
    });
    assert.equal((await first.send('apply')).status, 409);
    assert.equal(gateway.storage.snapshot().teardown.pending.phase, 'send_armed');
    const later = Date.now() + 600_001;
    context.mock.method(Date, 'now', () => later);
    gateway.provider.hook(undefined);
    const second = await gateway.currentTeardown(6);
    assert.equal(second.prepared.status, 200, await second.prepared.clone().text());
    assert.equal((await first.send('apply')).status, 409, 'the old action key cannot resume a renewed action');
    assert.equal((await second.send('prove')).status, 200);
    const result = await second.send('apply', 'H'.repeat(22));
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal(gateway.provider.liveResourceCount(), 0);
    const deletedPaths = gateway.provider.deletes().map(({ pathname }) => pathname);
    assert.equal(deletedPaths.length, 7);
    assert.equal(new Set(deletedPaths).size, 7, 'verified absence must not resend the lost delete');
  }, await portalOnlyClaim()));
}


test('current teardown routes have no public HTTP entry point', async () => fixture(async (gateway) => {
  const baseline = gateway.provider.requests.length;
  for (const path of ['/teardown-actions/prepare-current', '/teardown-actions/prove-current',
    '/teardown-actions/apply-current', '/teardown-actions/settle-current', '/teardown-root/apply-current', '/teardown-root/status-current']) {
    const response = await worker.fetch(new Request(`${MANAGEMENT_ORIGIN}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }), gateway.env);
    assert.equal(response.status, 404);
  }
  assert.equal(gateway.provider.requests.length, baseline);
}));


test('the final gateway prepare export verifies Access and hands off to its own removal review', async () => fixture(async (gateway) => {
  const baseline = gateway.provider.deletes().length;
  const denied = await gateway.api('/api/teardown-actions', { method: 'POST', body: { schemaVersion: 1 }, email: NEW_PERSON, currentTeardown: true });
  assert.equal(denied.status, 401);
  const foreign = await gateway.api('/api/teardown-actions', { method: 'POST', body: { schemaVersion: 1 }, extraHeaders: { origin: 'https://foreign.example' }, currentTeardown: true });
  assert.equal(foreign.status, 403);
  const prepared = await gateway.api('/api/teardown-actions', { method: 'POST', body: { schemaVersion: 1 }, currentTeardown: true });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const target = new URL((await prepared.json()).handoffUrl);
  assert.equal(target.origin, MANAGEMENT_ORIGIN);
  assert.equal(target.pathname, '/__ankka/operation/teardown');
  assert.equal(target.search, '');
  assert.equal(gateway.provider.deletes().length, baseline);
}));

test('settling an interrupted current teardown permits immediate fresh consent without erasing progress', async () => fixture(async (gateway) => {
  const first = await gateway.currentTeardown();
  assert.equal((await first.send('prove')).status, 200);
  gateway.provider.hook(({ record }) => record.method === 'DELETE' ? envelope(null, 503) : undefined);
  assert.equal((await first.send('apply')).status, 409);
  const pending = structuredClone(gateway.storage.snapshot().teardown);
  assert.equal((await first.send('settle')).status, 200);
  assert.equal((await first.send('apply')).status, 409);
  const second = await gateway.currentTeardown(6);
  assert.equal(second.prepared.status, 200, await second.prepared.clone().text());
  assert.deepEqual(gateway.storage.snapshot().teardown, pending);
  gateway.provider.hook(undefined);
  assert.equal((await second.send('prove')).status, 200);
  assert.equal((await second.send('apply', 'H'.repeat(22))).status, 200);
  assert.equal(gateway.provider.liveResourceCount(), 0);
}));


test('declining current teardown before deletion releases lifecycle locks without changing resources', async () => fixture(async (gateway) => {
  const first = await gateway.currentTeardown();
  assert.equal((await first.send('prove')).status, 200);
  assert.notEqual((await (await gateway.api('/api/source-actions')).json()).blockingAction, null);
  const before = structuredClone(gateway.storage.snapshot());
  const settled = await first.send('settle');
  assert.equal(settled.status, 200);
  assert.equal((await settled.json()).status, 'failed');
  assert.equal((await (await gateway.api('/api/source-actions')).json()).blockingAction, null);
  assert.deepEqual(gateway.storage.snapshot(), before);
  assert.equal(gateway.provider.deletes().length, 0);
  assert.equal((await first.send('apply')).status, 409);
}));


test('abandoning current consent expires its unstarted lifecycle lock without changing the root', async (context) => fixture(async (gateway) => {
  const first = await gateway.currentTeardown();
  const before = structuredClone(gateway.storage.snapshot());
  assert.equal((await first.send('prove')).status, 200);
  const later = Date.now() + 600_001;
  context.mock.method(Date, 'now', () => later);
  assert.equal((await (await gateway.api('/api/source-actions')).json()).blockingAction, null);
  assert.deepEqual(gateway.storage.snapshot(), before);
  assert.equal((await first.send('apply')).status, 409);
  assert.equal(gateway.provider.deletes().length, 0);
}));

const MANAGEMENT_TOKEN = 'synthetic-account-management-token-never-store';

for (const sourceCount of [0, 1, 5]) {
  test(`Team overlaps independent reads with bounded concurrency (${sourceCount} sources)`, async () => fixture(async (gateway) => {
    for (let index = 1; index < sourceCount; index += 1) {
      await addHistoricalInstalledSource(gateway, { label: `Extra source ${index}`, url: `https://source-${index}.example.net/mcp` });
    }
    const network = globalThis.fetch;
    let certReads = 0;
    globalThis.fetch = async (request) => {
      if (request.url.endsWith('/cdn-cgi/access/certs')) certReads += 1;
      return network(request);
    };
    let active = 0;
    let peak = 0;
    gateway.provider.hook(async ({ record }) => {
      assert.equal(record.method, 'GET');
      active += 1;
      peak = Math.max(peak, active);
      await nextTurn();
      active -= 1;
    });
    const baseline = gateway.provider.requests.length;
    try {
      const before = await gateway.view();
      const after = await gateway.view();
      assert.equal(before.sources.length, sourceCount);
      assert.deepEqual(after.members, before.members);
      assert.ok(before.observedAt && after.observedAt);
      assert.equal(active, 0, 'all reads settle before responding');
      assert.equal(peak, sourceCount === 0 ? 3 : 4);
      assert.equal(certReads, 1, 'repeat requests reuse the public signing keys');
      const calls = gateway.provider.requests.slice(baseline);
      assert.equal(calls.length, 2 * (5 + 2 * sourceCount), 'every load still reads the complete live policy graph');
      assert.equal(calls.filter(({ pathname }) => pathname.endsWith('/tokens/verify')).length, 2, 'management credentials are never cached');
    } finally { globalThis.fetch = network; }
  }, sourceCount === 0 ? await portalOnlyClaim() : undefined));
}

test('Team checks its token alongside the application list and Portal read', async () => fixture(async (gateway) => {
  let otherInitialReads = 0;
  gateway.provider.hook(async ({ record }) => {
    if (record.pathname.endsWith('/tokens/verify')) {
      await nextTurn();
      assert.equal(otherInitialReads, 2, 'the initial reads do not wait for token verification');
    } else if (record.pathname.endsWith('/access/apps') || record.pathname.includes('/mcp/portals/')) {
      otherInitialReads += 1;
    }
  });
  assert.ok((await gateway.view()).observedAt);
}));

test('an invalid token drains initial reads without reconciling external membership', async () => fixture(async (gateway) => {
  await gateway.view();
  const before = gateway.managementStorage.snapshot(TEAM_KEY);
  policy(gateway, 'mcp_portal').include.push({ email: { email: NEW_PERSON } });
  let active = 0;
  const paths = [];
  gateway.provider.hook(async ({ record }) => {
    paths.push(record.pathname);
    active += 1;
    await nextTurn();
    active -= 1;
    if (record.pathname.endsWith('/tokens/verify')) return envelope({ status: 'disabled' });
  });
  const response = await gateway.api('/api/team');
  assert.equal(response.status, 503);
  assert.equal(active, 0);
  assert.equal(paths.length, 3);
  assert.deepEqual(gateway.managementStorage.snapshot(TEAM_KEY), before);
  assert.equal(gateway.provider.puts().length, 0);
}));

test('a free Team read slot starts another source while an earlier source is still pending', async () => fixture(async (gateway) => {
  await addHistoricalInstalledSource(gateway);
  const slowId = app(gateway, 'mcp_portal').id;
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  let slowFinished = false;
  let advancedWhilePending = false;
  const applications = new Set();
  // A broken fixed-batch implementation must eventually unblock and fail the
  // assertion, rather than leave the test's simulated provider request hanging.
  const deadline = setTimeout(() => releaseSlow(), 1000);
  gateway.provider.hook(async ({ record }) => {
    if (record.pathname.endsWith(`/access/apps/${slowId}/policies`)) {
      await slow;
      slowFinished = true;
    } else if (/\/access\/apps\/[^/]+$/u.test(record.pathname)) {
      applications.add(record.pathname);
      if (applications.size === 3) {
        advancedWhilePending = !slowFinished;
        releaseSlow();
      }
    }
  });
  try {
    assert.ok((await gateway.view()).observedAt);
    assert.equal(advancedWhilePending, true);
  } finally { clearTimeout(deadline); releaseSlow(); }
}));

test('a failed parallel Team read drains outstanding reads and never returns a partial roster', async () => fixture(async (gateway) => {
  let active = 0;
  gateway.provider.hook(async ({ record }) => {
    if (!record.pathname.endsWith('/policies')) return;
    active += 1;
    await nextTurn();
    active -= 1;
    return envelope(null, 403);
  });
  const response = await gateway.api('/api/team');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { schemaVersion: 1, error: 'team_unavailable' });
  assert.equal(active, 0);
  assert.equal(gateway.provider.puts().length, 0);
}));

test('account token reads live Team policies and applies a change without OAuth', async () => fixture(async (gateway) => {
  gateway.env.ANKKA_MANAGEMENT_TOKEN = MANAGEMENT_TOKEN;
  const before = await gateway.view();
  assert.equal(before.editingEnabled, true);
  assert.ok(before.observedAt);
  const response = await gateway.api('/api/team-actions', { method: 'POST', body: changedRequest(before) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).action.status, 'succeeded');
  const after = await gateway.view();
  assert.ok(after.members.some(({ email }) => email === NEW_PERSON));
  assert.doesNotMatch(JSON.stringify([...await gateway.managementStorage.list()]), /synthetic-account-management-token/);
  assert.doesNotMatch(canonicalJson(after), /synthetic-account-management-token|handoffUrl/);
}));

test('live Team reads reconcile external membership and invalidate stale revisions', async () => fixture(async (gateway) => {
  gateway.env.ANKKA_MANAGEMENT_TOKEN = MANAGEMENT_TOKEN;
  const before = await gateway.view();
  policy(gateway, 'mcp_portal').include.push({ email: { email: NEW_PERSON } });
  const after = await gateway.view();
  assert.ok(after.revision > before.revision);
  assert.ok(after.members.some(({ email }) => email === NEW_PERSON));
  const baseline = gateway.provider.requests.length;
  const response = await gateway.api('/api/team-actions', { method: 'POST', body: changedRequest(before) });
  assert.equal(response.status, 409);
  assertNoMutation(gateway.provider, baseline);
}));

test('rejected management credential performs no writes and replacement restores reads', async () => fixture(async (gateway) => {
  gateway.env.ANKKA_MANAGEMENT_TOKEN = MANAGEMENT_TOKEN;
  gateway.provider.hook(({ record }) => record.pathname.endsWith('/tokens/verify') ? envelope(null, 403) : undefined);
  const baseline = gateway.provider.requests.length;
  assert.equal((await gateway.api('/api/team')).status, 503);
  assert.equal((await gateway.api('/api/source-actions', { method: 'POST', body: {} })).status, 409);
  assertNoMutation(gateway.provider, baseline);
  gateway.env.ANKKA_MANAGEMENT_TOKEN = 'synthetic-replacement-account-token';
  gateway.provider.hook(undefined);
  assert.ok((await gateway.view()).observedAt);
}));

for (const committed of [false, true]) {
  test(`Team resumes a lost policy-write response without losing its journal (committed: ${committed})`, async () => fixture(async (gateway) => {
    const before = await gateway.view();
    const input = changedRequest(before);
    gateway.provider.hook(({ record, state }) => {
      if (record.method !== 'PUT' || !record.pathname.includes('/policies/')) return undefined;
      if (committed) {
        const parts = record.pathname.split('/');
        state.policies.set(parts.at(-3), [{ id: parts.at(-1), ...record.body }]);
      }
      return envelope(null, 503);
    });
    assert.equal((await gateway.api('/api/team-actions', { method: 'POST', body: input })).status, 409);
    const retained = gateway.managementStorage.snapshot(TEAM_KEY);
    assert.equal(retained.pendingAction.status, 'recovery_required');
    assert.equal(retained.pendingAction.journal[0].phase, 'send_armed');
    gateway.provider.hook(undefined);
    const live = await gateway.view();
    if (!committed) assert.ok(live.observedAt);
    else assert.equal(live.observedAt, null, 'partial policy graph is not presented as a complete live membership snapshot');
    const response = await gateway.api('/api/team-actions', { method: 'POST', body: input });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).action.status, 'succeeded');
  }));
}

test('new source applies with the account token, stays default-deny and exposes no consent URL', async () => fixture(async (gateway) => {
  const current = await (await gateway.api('/api/sources')).json();
  const saved = await gateway.api('/api/sources', { method: 'PUT', body: { schemaVersion: 1, revision: current.revision,
    source: { label: 'Additional source', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: ['company_lookup'] },
  } });
  assert.equal(saved.status, 200);
  const sources = await saved.json();
  const source = sources.sources.find((item) => item.url === NEW_SOURCE_URL);
  const response = await gateway.api('/api/source-actions', { method: 'POST', body: { schemaVersion: 1, revision: sources.revision, sourceId: source.id } });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.status, 'succeeded');
  assert.equal(Object.hasOwn(result, 'handoffUrl'), false);
  const team = await gateway.view();
  assert.equal(team.members.some((member) => member.sourceIds.includes(source.id)), false);
  for (const object of gateway.objects.values()) {
    assert.doesNotMatch(JSON.stringify([...await object.storage.list()]), /synthetic-account-management-token/);
  }
}));

test('the configured service identity performs the management exercise over the protected routes and is denied everywhere else', async () => {
  await fixture(async (gateway) => {
    gateway.env.ANKKA_SERVICE_CLIENT_ID = SERVICE_CLIENT;
    const status = await gateway.serviceApi('/api/status');
    assert.equal(status.status, 200, await status.clone().text());
    assert.deepEqual((await status.json()).serviceIdentity, { clientId: SERVICE_CLIENT });
    assert.equal((await (await gateway.api('/api/status')).json()).serviceIdentity.clientId, SERVICE_CLIENT);
    assert.equal((await gateway.serviceApi('/api/update')).status, 200);
    const discovered = await gateway.serviceApi('/api/sources/discover', { method: 'POST', body: { url: NEW_SOURCE_URL } });
    assert.equal(discovered.status, 200, await discovered.clone().text());
    const current = await (await gateway.serviceApi('/api/sources')).json();
    const saved = await gateway.serviceApi('/api/sources', { method: 'PUT', body: {
      schemaVersion: 1, revision: current.revision,
      source: { label: 'Automation source', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: ['company_lookup'] },
    } });
    assert.equal(saved.status, 200, await saved.clone().text());
    const drafted = (await saved.json());
    const draft = drafted.sources.find((source) => source.url === NEW_SOURCE_URL);
    const applied = await gateway.serviceApi('/api/source-actions', { method: 'POST', body: { schemaVersion: 1, revision: drafted.revision, sourceId: draft.id } });
    assert.equal(applied.status, 200, await applied.clone().text());
    const action = await applied.json();
    assert.equal(action.status, 'succeeded');
    const readBack = await (await gateway.serviceApi(`/api/source-actions/${action.actionId}`)).json();
    assert.equal(readBack.actorKind, 'service');
    assert.equal(readBack.status, 'succeeded');
    const listed = await (await gateway.serviceApi('/api/source-actions')).json();
    assert.equal(listed.actions.find((entry) => entry.actionId === action.actionId).actorKind, 'service');
    const team = await (await gateway.serviceApi('/api/team')).json();
    assert.equal(team.schemaVersion, 1);
    const granted = await gateway.serviceApi('/api/team-actions', { method: 'POST', body: {
      schemaVersion: 1, expectedRevision: team.revision,
      members: [...team.members, { email: NEW_PERSON, sourceIds: [draft.id] }],
    } });
    assert.equal(granted.status, 200, await granted.clone().text());
    const grant = await granted.json();
    assert.equal(grant.action.status, 'succeeded');
    assert.equal(grant.action.actorKind, 'service');
    const after = await (await gateway.serviceApi('/api/team')).json();
    assert.ok(after.members.some((member) => member.email === NEW_PERSON && member.sourceIds.includes(draft.id)));
    // Default deny: update and teardown action creation and source action cancellation stay human.
    for (const [path, method, body] of [
      ['/api/update-actions', 'POST', { schemaVersion: 1 }], ['/api/teardown-actions', 'POST', { schemaVersion: 1 }],
      [`/api/source-actions/${action.actionId}`, 'DELETE', undefined], ['/api/update-actions/action_' + 'A'.repeat(32), 'GET', undefined],
    ]) {
      const denied = await gateway.serviceApi(path, { method, body });
      assert.equal(denied.status, 403, `${method} ${path}`);
      assert.equal((await denied.json()).error, 'service_operation_denied');
    }
    // A human administrator still acts on those routes.
    assert.notEqual((await gateway.api('/api/update-actions/action_' + 'A'.repeat(32))).status, 403);
  });
});

test('service tokens are refused for an unapproved identity, a wrong audience, a mixed identity, and when no identity is configured', async () => {
  await fixture(async (gateway) => {
    gateway.env.ANKKA_SERVICE_CLIENT_ID = SERVICE_CLIENT;
    const refused = async (token, label) => {
      const response = await gateway.serviceApi('/api/status', { token });
      assert.equal(response.status, 401, label);
      assert.equal((await response.json()).error, 'access_required', label);
    };
    await refused({ clientId: OTHER_CLIENT }, 'unapproved identity');
    await refused({ aud: 'another-application-audience' }, 'wrong audience');
    await refused({ identityHeader: ADMIN }, 'identity header on a service token');
    await refused({ email: ADMIN }, 'email claim without identity header');
    await refused({ email: NEW_PERSON, identityHeader: NEW_PERSON }, 'email claim for a non-administrator');
    delete gateway.env.ANKKA_SERVICE_CLIENT_ID;
    await refused({}, 'service access not configured');
    const unconfigured = await gateway.api('/api/status');
    assert.equal(unconfigured.status, 200, 'administrators unaffected');
    assert.equal((await unconfigured.json()).serviceIdentity, null);
    // A malformed opt-in fails closed for everyone rather than widening access.
    gateway.env.ANKKA_SERVICE_CLIENT_ID = 'not-a-client-id';
    assert.equal((await gateway.serviceApi('/api/status')).status, 401);
    assert.equal((await gateway.api('/api/status')).status, 401);
  });
});

// The dashboard ships in the same release as this Worker and checks every answer against strict schemas of its own.
// Its real client runs here against the real Worker, so a field added on one side only fails in this suite and not in
// a customer's browser: gateway-v0.1.64 shipped a dashboard that refused `/api/status` for its new `serviceIdentity`.
async function dashboardClient(gateway, run) {
  const network = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if (!v.is(v.string(), input) || !input.startsWith('/')) return network(input, init);
    // The compiled gateway answers this one route with the current-policy preparation.
    const options = { method: init.method ?? 'GET', currentTeardown: init.method === 'POST' && input === '/api/teardown-actions' };
    if (init.body !== undefined) options.body = JSON.parse(init.body);
    return gateway.api(input, options);
  };
  try { return await run(new HttpGatewayAdminApi()); } finally { globalThis.fetch = network; }
}

test('the dashboard can save and reload a Gateway Management draft through its strict API client', async () => fixture(async (gateway) => {
  await dashboardClient(gateway, async (dashboard) => {
    const current = await dashboard.getSources();
    const discovery = await dashboard.discoverSource(`${MANAGEMENT_ORIGIN}/api/mcp`);
    const saved = await dashboard.saveSourceDraft(current.revision, {
      label: 'Gateway Management', url: discovery.endpoint, authMode: 'oauth',
      enabledTools: discovery.tools.map((tool) => tool.name),
    });
    assert.equal(saved.sources.find((source) => source.id === MANAGEMENT_ID).onBehalfOfUser, true);
    assert.deepEqual(await dashboard.getSources(), saved);
    assert.equal((await dashboard.getStatus()).status, 'ready');
    assert.equal(gateway.managementStorage.snapshot(SOURCES_KEY).sources.find((source) => source.id === MANAGEMENT_ID).initialManager, ADMIN);
  });
}));

test('the dashboard client accepts every answer the gateway gives an administrator', async () => fixture(async (gateway) => {
  await dashboardClient(gateway, async (dashboard) => {
    assert.equal((await dashboard.getStatus()).serviceIdentity, null);
    assert.equal((await dashboard.getUpdate()).schemaVersion, 1);
    assert.deepEqual((await dashboard.getSourceActions()).actions, []);

    const discovered = await dashboard.discoverSource(NEW_SOURCE_URL);
    assert.ok(discovered.tools.some((tool) => tool.name === 'company_lookup'));
    const current = await dashboard.getSources();
    const drafted = await dashboard.saveSourceDraft(current.revision, {
      label: 'Dashboard source', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: ['company_lookup'],
    });
    const draft = drafted.sources.find((source) => source.url === NEW_SOURCE_URL);
    const applied = await dashboard.prepareSourceAction(drafted.revision, draft.id);
    assert.equal(applied.status, 'succeeded');
    assert.equal((await dashboard.getSourceAction(applied.actionId)).actorKind, 'human');
    assert.equal((await dashboard.getSourceActions()).actions.find((entry) => entry.actionId === applied.actionId).actorKind, 'human');

    const team = await dashboard.getTeam();
    const granted = await dashboard.prepareTeamAction(team.revision, [...team.members, { email: NEW_PERSON, sourceIds: [draft.id] }]);
    assert.equal(granted.action.status, 'succeeded');
    assert.equal(granted.action.actorKind, 'human');
    assert.equal((await dashboard.getTeamAction(granted.action.actionId)).actorKind, 'human');
    assert.equal((await dashboard.getTeam()).pendingAction.actorKind, 'human'); // the team view carries the last action too

    const teardown = await dashboard.prepareTeardownAction();
    assert.equal((await dashboard.getTeardownAction(teardown.actionId)).status, 'authorization_required');
  });
}));

test('the dashboard client accepts a gateway that admits a service identity and the actions that identity prepared', async () => fixture(async (gateway) => {
  gateway.env.ANKKA_SERVICE_CLIENT_ID = SERVICE_CLIENT;
  const team = await (await gateway.serviceApi('/api/team')).json();
  const granted = await gateway.serviceApi('/api/team-actions', { method: 'POST', body: changedRequest(team) });
  assert.equal(granted.status, 200, await granted.clone().text());
  const { action } = await granted.json();
  assert.equal(action.actorKind, 'service');
  await dashboardClient(gateway, async (dashboard) => {
    assert.deepEqual((await dashboard.getStatus()).serviceIdentity, { clientId: SERVICE_CLIENT });
    assert.equal((await dashboard.getTeamAction(action.actionId)).actorKind, 'service');
  });
}));

// The way back into an interrupted removal rests on these answers: everything the dashboard loads at startup still
// answers once the connected resources are gone, the pointer names the recorded removal, and its status says where it
// stands. Only Team, which reads the deleted policies, answers 503.
test('the dashboard client follows a removal through every status the gateway records and can prepare the next authorization', async () => fixture(async (gateway) => {
  await dashboardClient(gateway, async (dashboard) => {
    assert.equal((await dashboard.getSourceActions()).blockingAction, null);
    const removal = await gateway.currentTeardown();
    assert.equal(removal.prepared.status, 200, await removal.prepared.clone().text());
    const { actionId } = await removal.prepared.json();
    const recorded = async () => {
      assert.deepEqual((await dashboard.getSourceActions()).blockingAction, { kind: 'teardown', actionId });
      return dashboard.getTeardownAction(actionId);
    };
    assert.equal((await recorded()).status, 'authorization_required');
    assert.equal((await dashboard.getTeam()).schemaVersion, 1);

    assert.equal((await removal.send('prove')).status, 200);
    const applied = await removal.send('apply');
    assert.equal(applied.status, 200, await applied.clone().text());
    assert.equal(gateway.provider.liveResourceCount(), 0);
    assert.equal((await recorded()).status, 'gateway_removed');
    assert.equal((await dashboard.getStatus()).status, 'ready');
    assert.equal((await dashboard.getSources()).schemaVersion, 1);
    assert.equal((await dashboard.getUpdate()).schemaVersion, 1);
    await assert.rejects(dashboard.getTeam(), { status: 503 });

    assert.equal((await removal.send('settle')).status, 200);
    assert.deepEqual([(await recorded()).status, (await recorded()).failureCode], ['recovery_required', 'fresh_authorization_required']);
    const next = await dashboard.prepareTeardownAction();
    assert.equal(new URL(next.handoffUrl).pathname, '/__ankka/operation/teardown');
    assert.equal((await dashboard.getTeardownAction(next.actionId)).status, 'authorization_required');
  });
}, await portalOnlyClaim()));

test('the installation record, not the removal journal, tells the dashboard that a removal has begun', async () => fixture(async (gateway) => {
  await dashboardClient(gateway, async (dashboard) => {
    // Before anything is deleted the answer says so, also while a reviewed plan waits for its authorization.
    assert.equal((await dashboard.getSourceActions()).removalStarted, false);
    const removal = await gateway.currentTeardown();
    assert.equal(removal.prepared.status, 200, await removal.prepared.clone().text());
    assert.equal((await dashboard.getSourceActions()).removalStarted, false);
    assert.equal((await removal.send('prove')).status, 200);
    assert.equal((await removal.send('apply')).status, 200);
    assert.equal((await removal.send('settle')).status, 200);
    assert.equal((await dashboard.getSourceActions()).removalStarted, true);

    // The interrupted attempt leaves the journal: a later authorization replaces it, is never used, and expires.
    // The journal then names no removal at all, and the installation's own record still does.
    const next = await dashboard.prepareTeardownAction();
    const journal = gateway.managementStorage.snapshot(TEARDOWNS_KEY);
    await gateway.managementStorage.put(TEARDOWNS_KEY, { ...journal,
      actions: journal.actions.filter((action) => action.actionId === next.actionId)
        .map((action) => ({ ...action, issuedAt: action.issuedAt - 3_600_000, expiresAt: action.expiresAt - 3_600_000 })) });
    gateway.reloadManagement();
    const forgotten = await dashboard.getSourceActions();
    assert.equal(forgotten.blockingAction, null);
    assert.equal(forgotten.removalStarted, true);
    // The way back still works from there.
    const again = await dashboard.prepareTeardownAction();
    assert.equal(new URL(again.handoffUrl).pathname, '/__ankka/operation/teardown');
  });
}, await portalOnlyClaim()));

// A source installation records the running release as the minimum compatible runtime. That is a decision only while
// an older recorded release can still be restored. `/api/sources` names that release in `installEndsRollbackTo` for
// exactly that case, and `/api/update` stops offering a rollback the unchanged rule would refuse.
const EARLIER = Object.freeze({ release: 'gateway-v0.0.9', artifactSha256: `sha256:${'8'.repeat(64)}`,
  versionId: '00000000-0000-4000-8000-000000000008' });
const OFFERED = Object.freeze({ available: true, release: EARLIER.release, artifactSha256: EARLIER.artifactSha256, dataRollback: false });
const EXCLUDED = Object.freeze({ available: false, reason: 'minimum_runtime_release', release: EARLIER.release });

/** The journal of a gateway that was updated to the running release from `previous`. */
async function recordUpdateFrom(gateway, previous = EARLIER) {
  await gateway.view(); // the first Team read creates the Team record, without a minimum
  await gateway.managementStorage.put(UPDATES_KEY, { schemaVersion: 1, revision: 1, actions: [], previous,
    current: { release: gateway.env.ANKKA_GATEWAY_RELEASE, artifactSha256: gateway.env.ANKKA_GATEWAY_RELEASE_SHA256,
      versionId: '00000000-0000-4000-8000-000000000009' } });
}

async function recordMinimumRuntime(gateway, release) {
  await gateway.managementStorage.put(TEAM_KEY, { ...gateway.managementStorage.snapshot(TEAM_KEY),
    minimumRuntimeRelease: release, teardownDisabled: true });
}

async function rollbackAnswers(gateway) {
  const [update, sources] = [await gateway.api('/api/update'), await gateway.api('/api/sources')];
  assert.equal(update.status, 200, await update.clone().text());
  assert.equal(sources.status, 200, await sources.clone().text());
  return { rollback: (await update.json()).rollback, installEndsRollbackTo: (await sources.json()).installEndsRollbackTo };
}

async function prepareRollback(gateway) {
  return gateway.api('/api/update-actions', { method: 'POST', body: { schemaVersion: 1, operation: 'rollback' } });
}

test('a fresh install has no rollback to offer and nothing to decide before its first source', async () => fixture(async (gateway) => {
  assert.deepEqual(await rollbackAnswers(gateway), { rollback: { available: false }, installEndsRollbackTo: null });
  await gateway.view();
  assert.deepEqual(await rollbackAnswers(gateway), { rollback: { available: false }, installEndsRollbackTo: null });
}));

test('an updated gateway without sources offers its rollback and names it as what a source installation ends', async () => fixture(async (gateway) => {
  await recordUpdateFrom(gateway);
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).minimumRuntimeRelease, null);
  assert.deepEqual(await rollbackAnswers(gateway), { rollback: OFFERED, installEndsRollbackTo: EARLIER.release });
  // Reading the answers decides nothing: the minimum stays unset and the offered rollback can be prepared.
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).minimumRuntimeRelease, null);
  const prepared = await prepareRollback(gateway);
  assert.equal(prepared.status, 200, await prepared.clone().text());
}));

test('a minimum already at the running release excludes the recorded rollback with a fixed reason and leaves nothing to decide', async () => fixture(async (gateway) => {
  await recordUpdateFrom(gateway);
  await recordMinimumRuntime(gateway, gateway.env.ANKKA_GATEWAY_RELEASE);
  assert.deepEqual(await rollbackAnswers(gateway), { rollback: EXCLUDED, installEndsRollbackTo: null });
  // The unchanged rule refuses exactly what is no longer offered.
  const refused = await prepareRollback(gateway);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, 'runtime_action_conflict');
}));

test('a minimum below the running release keeps the rollback, and the next source installation is the decision', async () => {
  // Recorded at the earlier release itself, and below it: both still allow the rollback that an installation here ends.
  for (const minimum of [EARLIER.release, 'gateway-v0.0.8']) await fixture(async (gateway) => {
    await recordUpdateFrom(gateway);
    await recordMinimumRuntime(gateway, minimum);
    assert.deepEqual(await rollbackAnswers(gateway), { rollback: OFFERED, installEndsRollbackTo: EARLIER.release }, minimum);
  });
  // A minimum between the two releases has already excluded the target: nothing is left to decide.
  await fixture(async (gateway) => {
    await recordUpdateFrom(gateway, { ...EARLIER, release: 'gateway-v0.0.8' });
    await recordMinimumRuntime(gateway, 'gateway-v0.0.9');
    assert.deepEqual(await rollbackAnswers(gateway), {
      rollback: { ...EXCLUDED, release: 'gateway-v0.0.8' }, installEndsRollbackTo: null,
    });
  });
});

test('a recorded release newer than the running one stays restorable after a source installation, so nothing is named', async () => fixture(async (gateway) => {
  await recordUpdateFrom(gateway, { ...EARLIER, release: 'gateway-v0.2.0' });
  assert.deepEqual(await rollbackAnswers(gateway), {
    rollback: { ...OFFERED, release: 'gateway-v0.2.0' }, installEndsRollbackTo: null,
  });
}));

test('a gateway that cannot install sources names no rollback decision', async () => fixture(async (gateway) => {
  await recordUpdateFrom(gateway);
  delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
  const sources = await (await gateway.api('/api/sources')).json();
  assert.equal(sources.installationEnabled, false);
  assert.equal(sources.installEndsRollbackTo, null);
}));

test('a release received outside an action is named before the journal follows it', async () => fixture(async (gateway) => {
  await gateway.view();
  assert.deepEqual((await (await gateway.api('/api/update')).json()).rollback, { available: false });
  const installed = gateway.env.ANKKA_GATEWAY_RELEASE;
  gateway.env.ANKKA_GATEWAY_RELEASE = 'gateway-v0.1.1';
  gateway.env.ANKKA_GATEWAY_RELEASE_SHA256 = `sha256:${'7'.repeat(64)}`;
  gateway.reloadManagement();
  const journal = canonicalJson(gateway.managementStorage.snapshot(UPDATES_KEY));
  assert.equal((await (await gateway.api('/api/sources')).json()).installEndsRollbackTo, installed);
  assert.equal(canonicalJson(gateway.managementStorage.snapshot(UPDATES_KEY)), journal, 'the sources read writes nothing');
  const followed = await rollbackAnswers(gateway);
  assert.equal(followed.rollback.available, true);
  assert.equal(followed.rollback.release, installed);
  assert.equal(followed.installEndsRollbackTo, installed);
}));

test('the first source installation on an updated gateway turns the named decision into the recorded answer', async () => fixture(async (gateway) => {
  await recordUpdateFrom(gateway);
  const current = await (await gateway.api('/api/sources')).json();
  assert.equal(current.installEndsRollbackTo, EARLIER.release);
  const saved = await gateway.api('/api/sources', { method: 'PUT', body: { schemaVersion: 1, revision: current.revision,
    source: { label: 'Additional source', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: ['company_lookup'] },
  } });
  assert.equal(saved.status, 200, await saved.clone().text());
  const drafted = await saved.json();
  // Saving a draft decides nothing, and the save answers like the read, so the sentence stays beside the control.
  assert.equal(drafted.installEndsRollbackTo, EARLIER.release);
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).minimumRuntimeRelease, null);
  const source = drafted.sources.find((item) => item.url === NEW_SOURCE_URL);
  const applied = await gateway.api('/api/source-actions', { method: 'POST', body: { schemaVersion: 1, revision: drafted.revision, sourceId: source.id } });
  assert.equal(applied.status, 200, await applied.clone().text());
  assert.equal((await applied.json()).status, 'succeeded');
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).minimumRuntimeRelease, gateway.env.ANKKA_GATEWAY_RELEASE);
  assert.deepEqual(await rollbackAnswers(gateway), { rollback: EXCLUDED, installEndsRollbackTo: null });
  assert.equal((await prepareRollback(gateway)).status, 409);
}));

test('the dashboard client accepts what the gateway says about rollback in every state, around a source installation', async () => fixture(async (gateway) => {
  await dashboardClient(gateway, async (dashboard) => {
    assert.deepEqual((await dashboard.getUpdate()).rollback, { available: false });
    assert.equal((await dashboard.getSources()).installEndsRollbackTo, null);

    await recordUpdateFrom(gateway);
    assert.deepEqual((await dashboard.getUpdate()).rollback, OFFERED);
    const current = await dashboard.getSources();
    assert.equal(current.installEndsRollbackTo, EARLIER.release);
    const drafted = await dashboard.saveSourceDraft(current.revision, {
      label: 'Dashboard source', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: ['company_lookup'],
    });
    assert.equal(drafted.installEndsRollbackTo, EARLIER.release);
    const draft = drafted.sources.find((source) => source.url === NEW_SOURCE_URL);
    assert.equal((await dashboard.prepareSourceAction(drafted.revision, draft.id)).status, 'succeeded');

    assert.equal((await dashboard.getSources()).installEndsRollbackTo, null);
    assert.deepEqual((await dashboard.getUpdate()).rollback, EXCLUDED);
    await assert.rejects(dashboard.prepareRuntimeAction('rollback'), { code: 'runtime_action_conflict' });
  });
}));

test('the dashboard client prepares the rollback the gateway offers', async () => fixture(async (gateway) => {
  await recordUpdateFrom(gateway);
  await dashboardClient(gateway, async (dashboard) => {
    const offered = (await dashboard.getUpdate()).rollback;
    assert.deepEqual(offered, OFFERED);
    const prepared = await dashboard.prepareRuntimeAction('rollback', { release: offered.release, artifactSha256: offered.artifactSha256 });
    assert.equal(prepared.operation, 'rollback');
    assert.equal((await dashboard.getRuntimeAction(prepared.actionId)).to.release, EARLIER.release);
  });
}));

test('removal refused for an unfinished source installation says so through the dashboard client', async () => fixture(async (gateway) => {
  await prepareNewSource(gateway);
  await dashboardClient(gateway, async (dashboard) => {
    await assert.rejects(dashboard.prepareTeardownAction(), (error) => {
      assert.equal(error.code, 'teardown_action_conflict');
      assert.match(error.message, /^Finish or cancel any unfinished connector installation, update or Team change, or wait for an open removal authorization to expire/u);
      return true;
    });
  });
}));

// A sign-in source is saved and installed with nothing enabled. Its tools are chosen from the list Cloudflare synced
// after the operator connected it, as a revision-bound step of its own, and the recorded installation then attaches
// exactly that allowlist. The cases below hold every state, refusal and boundary of that design.
const SIGN_IN_URL = 'https://signin.example.net/mcp';
const CONTROL_KEY = 'ankka-mcp-gateway/management-control/v1';
const SERVERS_PATH = `/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/servers`;
const REAL_TOOLS = Object.freeze([
  { name: 'records_search', title: 'Search records', description: 'Search synthetic records.', inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'records_delete', description: 'Delete one synthetic record.', annotations: { destructiveHint: true } },
  { name: 'records_export' },
]);
const NO_HINTS = { title: null, description: null, readOnlyHint: null, destructiveHint: null, openWorldHint: null };

/** The shared fixture with one more endpoint on its network: a source that answers discovery with the standard sign-in challenge. */
function signInFixture(run, claimInput) {
  return fixture(async (gateway) => {
    const network = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (input instanceof Request && input.url === SIGN_IN_URL) {
        return new Response(null, { status: 401, headers: {
          'www-authenticate': 'Bearer resource_metadata="https://signin.example.net/.well-known/oauth-protected-resource"',
        } });
      }
      return network(input, init);
    };
    try { return await run(gateway); } finally { globalThis.fetch = network; }
  }, claimInput);
}

async function saveSignInDraft(gateway, enabledTools = []) {
  const current = await (await gateway.api('/api/sources')).json();
  const response = await gateway.api('/api/sources', { method: 'PUT', body: { schemaVersion: 1, revision: current.revision,
    source: { label: 'Sign-in source', url: SIGN_IN_URL, authMode: 'oauth', enabledTools } } });
  assert.equal(response.status, 200, await response.clone().text());
  const sources = await response.json();
  return { sources, source: sources.sources.find((candidate) => candidate.url === SIGN_IN_URL) };
}

function pausedAction(gateway) {
  return gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.at(-1);
}

/** Cloudflare creates the server of a sign-in source unconnected: the installation pauses before the Portal. */
function createServersUnconnected(gateway) {
  gateway.provider.hook(({ record, state }) => {
    if (record.method !== 'POST' || record.pathname !== SERVERS_PATH) return undefined;
    const server = { ...record.body, authentication_status: 'required', status: 'waiting', tools: [],
      error: 'synthetic-private-provider-detail' };
    state.servers.set(server.id, server);
    return envelope(server);
  });
}

async function installSignInSource(gateway, { enabledTools = [], draft } = {}) {
  const saved = draft ?? await saveSignInDraft(gateway, enabledTools);
  createServersUnconnected(gateway);
  const response = await gateway.api('/api/source-actions', { method: 'POST',
    body: { schemaVersion: 1, revision: saved.sources.revision, sourceId: saved.source.id } });
  gateway.provider.hook(undefined);
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error, 'source_connection_required');
  const action = pausedAction(gateway);
  return { ...saved, action, serverId: action.resources[0].provider.id,
    toolsPath: `/api/source-actions/${action.actionId}/tools` };
}

/** The operator has connected the source in Cloudflare and Cloudflare has synced its catalogue. */
function connectSignInSource(gateway, serverId, tools = REAL_TOOLS, overrides = {}) {
  Object.assign(gateway.provider.state.servers.get(serverId),
    { authentication_status: 'connected', status: 'ready', tools: structuredClone(tools), ...overrides });
}

function chooseTools(gateway, installed, enabledTools, { revision, sourceId, ...request } = {}) {
  return gateway.api(installed.toolsPath, { method: 'POST', ...request, body: { schemaVersion: 1,
    revision: revision ?? gateway.managementStorage.snapshot(SOURCES_KEY).revision,
    sourceId: sourceId ?? installed.source.id, enabledTools } });
}

function resumeInstallation(gateway, installed) {
  return gateway.api(`/api/source-actions/${installed.action.actionId}/renew`, { method: 'POST', body: {
    schemaVersion: 1, revision: gateway.managementStorage.snapshot(SOURCES_KEY).revision, sourceId: installed.source.id } });
}

function portalMapping(gateway, serverId) {
  return gateway.provider.state.portal.servers?.find((mapping) => mapping.server_id === serverId);
}

function manyTools(count, prefix = 'tool_') {
  return Array.from({ length: count }, (_, index) => ({ name: `${prefix}${String(index).padStart(3, '0')}` }));
}

async function refused(response, status, error, reason) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error, error);
  assert.equal(body.reason, reason);
  assert.doesNotMatch(JSON.stringify(body), /synthetic-private/u);
}

test('a sign-in source is saved and installed with no tools: nothing is enabled, nothing is attached, everyone is denied', async () => signInFixture(async (gateway) => {
  const current = await (await gateway.api('/api/sources')).json();
  const save = (source) => gateway.api('/api/sources', { method: 'PUT', body: { schemaVersion: 1, revision: current.revision, source } });
  await refused(await save({ label: 'Public source', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: [] }), 400, 'source_invalid');
  await refused(await save({ label: 'Public source', url: NEW_SOURCE_URL, authMode: 'oauth', enabledTools: [] }), 409, 'source_authentication_changed');
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY), undefined, 'a refused save arms nothing');
  assert.equal(gateway.managementStorage.snapshot(SOURCES_KEY).sources.some((source) => source.url === NEW_SOURCE_URL), false);

  const beforePortal = structuredClone(gateway.provider.state.portal);
  const baseline = gateway.provider.requests.length;
  const originalPut = gateway.managementStorage.put;
  gateway.managementStorage.put = async (key, value) => {
    if (key === SOURCES_KEY) {
      // Older runtimes cannot read a source without tools: the floor is durable before that record exists.
      const floor = gateway.managementStorage.snapshot(TEAM_KEY);
      assert.equal(floor?.teardownDisabled, true);
      assert.equal(floor.minimumRuntimeRelease, gateway.env.ANKKA_GATEWAY_RELEASE);
    }
    return originalPut(key, value);
  };
  const draft = await saveSignInDraft(gateway);
  gateway.managementStorage.put = originalPut;
  assert.deepEqual([draft.source.enabledTools, draft.source.status, draft.source.authMode, draft.source.onBehalfOfUser], [[], 'draft', 'oauth', false]);
  assertNoMutation(gateway.provider, baseline);

  const installed = await installSignInSource(gateway, { draft });
  const creation = gateway.provider.requests.find((request) => request.method === 'POST' &&
    request.pathname === SERVERS_PATH && request.body.hostname === SIGN_IN_URL);
  assert.deepEqual(Object.keys(creation.body).sort(), ['auth_type', 'description', 'hostname', 'id',
    'is_shared_oauth_callback_enabled', 'name', 'secure_web_gateway'], 'no tool override is sent for a source without tools');
  assert.equal(Object.hasOwn(gateway.provider.state.servers.get(installed.serverId), 'updated_tools'), false);
  assert.deepEqual(gateway.provider.state.portal, beforePortal, 'the source is attached to nothing');
  assert.equal(portalMapping(gateway, installed.serverId), undefined);
  const policies = gateway.provider.state.policies.get(installed.action.resources[2].provider.parentId);
  assert.equal(policies.length, 1);
  assert.deepEqual([policies[0].decision, policies[0].include], ['deny', [{ everyone: {} }]]);
  assert.deepEqual([installed.action.status, installed.action.failureCode, installed.action.resources.length,
    installed.action.pending, installed.action.portalUpdate], ['recovery_required', 'source_connection_required', 3, null, null]);
  assert.equal(JSON.stringify(installed.action).includes('synthetic-private'), false);
  const stored = gateway.managementStorage.snapshot(SOURCES_KEY).sources.find((source) => source.id === draft.source.id);
  assert.deepEqual([stored.status, stored.enabledTools], ['draft', []]);
  const summary = (await (await gateway.api('/api/source-actions')).json()).actions.at(-1);
  assert.deepEqual([summary.state, summary.canRenew, summary.canCancel], ['recovery_required', true, false]);
  assert.equal(summary.connectionUrl,
    `https://dash.cloudflare.com/${ACCOUNT_ID}/one/access-controls/ai-controls/mcp-server/edit/${installed.serverId}`);
  const team = await gateway.api('/api/team');
  assert.equal(team.status, 200, await team.clone().text());
  const view = await team.json();
  assert.deepEqual(view.sources.find((source) => source.id === draft.source.id).enabledTools, []);
  assert.equal(view.members.some((member) => member.sourceIds.includes(draft.source.id)), false);
}));

// Older releases cannot read a source without tools, so for that one draft the save, not the installation, is what
// ends a rollback. The gateway names the release beforehand and reports nothing left to decide in the save's own answer.
test('saving a sign-in source without tools is the rollback decision; a draft an older release can read decides nothing', async () => signInFixture(async (gateway) => {
  await recordUpdateFrom(gateway);
  assert.deepEqual(await rollbackAnswers(gateway), { rollback: OFFERED, installEndsRollbackTo: EARLIER.release });
  const typed = await saveSignInDraft(gateway, ['records_search']);
  assert.equal(typed.sources.installEndsRollbackTo, EARLIER.release);
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).minimumRuntimeRelease, null);
  assert.deepEqual(await rollbackAnswers(gateway), { rollback: OFFERED, installEndsRollbackTo: EARLIER.release });

  const bare = await saveSignInDraft(gateway);
  assert.deepEqual(bare.source.enabledTools, []);
  assert.equal(bare.sources.installEndsRollbackTo, null);
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY).minimumRuntimeRelease, gateway.env.ANKKA_GATEWAY_RELEASE);
  assert.deepEqual(await rollbackAnswers(gateway), { rollback: EXCLUDED, installEndsRollbackTo: null });
  await refused(await prepareRollback(gateway), 409, 'runtime_action_conflict');
}));

test('the real tool list is offered in fixed states, with one provider read and only what the record carries', async () => signInFixture(async (gateway) => {
  const installed = await installSignInSource(gateway);
  const server = gateway.provider.state.servers.get(installed.serverId);
  const offered = async (state) => {
    const baseline = gateway.provider.requests.length;
    const writes = gateway.managementStorage.writes.length;
    const response = await gateway.api(installed.toolsPath);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(gateway.provider.requests.slice(baseline).map(({ method, pathname }) => `${method} ${pathname}`),
      [`GET ${SERVERS_PATH}/${installed.serverId}`], 'one provider read per request');
    assert.equal(gateway.managementStorage.writes.length, writes, 'a read writes nothing');
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['actionId', 'schemaVersion', 'sourceId', 'state', 'tools']);
    assert.deepEqual([body.schemaVersion, body.actionId, body.sourceId, body.state],
      [1, installed.action.actionId, installed.source.id, state]);
    if (state !== 'ready') assert.deepEqual(body.tools, []);
    assert.doesNotMatch(JSON.stringify(body), /synthetic-private/u);
    return body.tools;
  };
  await offered('connection_required');
  server.authentication_status = 'stale';
  await offered('connection_required');
  Object.assign(server, { authentication_status: 'connected', status: 'waiting' });
  await offered('sync_required');
  server.status = 'error';
  await offered('sync_required');
  Object.assign(server, { status: 'ready', tools: 'not-a-list' });
  await offered('sync_required');

  connectSignInSource(gateway, installed.serverId, [
    ...REAL_TOOLS,
    { name: 'long_text', title: 't'.repeat(161), description: 'd'.repeat(2_001) },
    { name: 'control_text', description: 'line one\nline two', annotations: { readOnlyHint: 'yes', destructiveHint: 1 } },
    { name: 'provider_fields', enabled: true, alias: 'synthetic-private-alias',
      inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'synthetic-private-schema' } } } },
  ]);
  const tools = await offered('ready');
  assert.deepEqual(tools, [
    { name: 'control_text', ...NO_HINTS },
    { name: 'long_text', ...NO_HINTS },
    { name: 'provider_fields', ...NO_HINTS },
    { name: 'records_delete', ...NO_HINTS, description: 'Delete one synthetic record.', destructiveHint: true },
    { name: 'records_export', ...NO_HINTS },
    { name: 'records_search', title: 'Search records', description: 'Search synthetic records.',
      readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  ], 'sorted by name; an absent or oversized text and an absent hint are null, nothing is derived');
  assert.equal(tools.some((tool) => Object.hasOwn(tool, 'defaultSelected')), false);

  connectSignInSource(gateway, installed.serverId, manyTools(500));
  assert.equal((await offered('ready')).length, 500);
  for (const unsupported of [manyTools(501), [...REAL_TOOLS, { name: 'records_export' }], [{ name: 'has space' }],
    [{ name: 'n'.repeat(129) }], ['records_search'], [{ title: 'No name' }], [null]]) {
    connectSignInSource(gateway, installed.serverId, unsupported);
    await offered('unsupported');
  }

  connectSignInSource(gateway, installed.serverId);
  const failing = async (answer, status, error, reads = 1) => {
    gateway.provider.hook(({ record }) => record.method === 'GET' && record.pathname === `${SERVERS_PATH}/${installed.serverId}`
      ? answer() : undefined);
    const baseline = gateway.provider.requests.length;
    await refused(await gateway.api(installed.toolsPath), status, error);
    assert.equal(gateway.provider.requests.length - baseline, reads);
    gateway.provider.hook(undefined);
  };
  const providerError = (status) => () => Response.json({ success: false, result: null,
    errors: [{ code: 10000, message: 'synthetic-private-provider-detail' }] }, { status });
  await failing(providerError(503), 502, 'source_catalogue_unavailable');
  await failing(providerError(404), 502, 'source_catalogue_unavailable');
  await failing(() => envelope({ ...server, id: 'another-server' }), 502, 'source_catalogue_unavailable');
  await failing(() => { throw new Error('synthetic-private-network-detail'); }, 502, 'source_catalogue_unavailable');
  await failing(providerError(403), 409, 'management_credential_required');
  delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
  await failing(() => envelope(server), 409, 'management_credential_required', 0);
}));

test('only the initiating administrator of an exactly paused sign-in installation may read or choose its tools', async () => signInFixture(async (gateway) => {
  const installed = await installSignInSource(gateway);
  connectSignInSource(gateway, installed.serverId);
  const choice = { method: 'POST', body: { schemaVersion: 1, revision: installed.sources.revision,
    sourceId: installed.source.id, enabledTools: ['records_search'] } };
  const stored = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
  const storedSources = gateway.managementStorage.snapshot(SOURCES_KEY);
  // Neither route spends a provider read or a write on a caller or an installation it refuses.
  const untouched = async (run) => {
    const baseline = gateway.provider.requests.length;
    const writes = gateway.managementStorage.writes.length;
    await run();
    assert.equal(gateway.provider.requests.length, baseline);
    assert.equal(gateway.managementStorage.writes.length, writes);
  };
  await untouched(async () => {
    const unknown = `/api/source-actions/action_${'U'.repeat(32)}/tools`;
    await refused(await gateway.api(unknown), 404, 'source_action_not_found');
    await refused(await gateway.api(unknown, choice), 404, 'source_action_not_found');
    await refused(await gateway.api(`${installed.toolsPath}/more`), 404, 'source_action_not_found');
    await refused(await gateway.api(installed.toolsPath, { email: OWNER }), 409, 'source_tools_unavailable');
    await refused(await gateway.api(installed.toolsPath, { ...choice, email: OWNER }), 409, 'source_tools_unavailable');
    await refused(await gateway.api(installed.toolsPath, { email: MEMBER }), 401, 'access_required');
    await refused(await gateway.api(installed.toolsPath, { ...choice, email: MEMBER }), 401, 'access_required');
    await refused(await gateway.api(installed.toolsPath, { ...choice, extraHeaders: { origin: 'https://other.example.com' } }), 403, 'origin_required');
    gateway.env.ANKKA_SERVICE_CLIENT_ID = SERVICE_CLIENT;
    await refused(await gateway.serviceApi(installed.toolsPath), 403, 'service_operation_denied');
    await refused(await gateway.serviceApi(installed.toolsPath, choice), 403, 'service_operation_denied');
    delete gateway.env.ANKKA_SERVICE_CLIENT_ID;
  });

  const { initialPolicyVersion, ...legacyProfile } = installed.action;
  assert.equal(initialPolicyVersion, 2);
  for (const [label, action] of [
    ['waiting for authorization', { ...installed.action, status: 'authorization_required', failureCode: null }],
    ['applying', { ...installed.action, status: 'applying', failureCode: null }],
    ['completed', { ...installed.action, status: 'succeeded', failureCode: null }],
    ['closed', { ...installed.action, status: 'failed' }],
    ['another recovery reason', { ...installed.action, failureCode: 'source_action_recovery_required' }],
    ['a receipt missing behind a pending write', { ...installed.action, resources: installed.action.resources.slice(0, 2),
      pending: { kind: 'source_access_policy', phase: 'send_armed', provider: null } }],
    ['a recorded Portal write', { ...installed.action, portalUpdate: { phase: 'send_armed', desiredHash: installed.action.sourceHash } }],
    ['the legacy policy profile', legacyProfile],
    ['a BigQuery setup', { ...installed.action, bigquerySetupStarted: true }],
  ]) {
    await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, { ...stored, actions: [action] });
    await untouched(async () => {
      await refused(await gateway.api(installed.toolsPath), 409, 'source_tools_unavailable');
      const response = await gateway.api(installed.toolsPath, choice);
      assert.equal(response.status, 409, label);
      assert.equal((await response.json()).error, 'source_tools_unavailable', label);
    });
  }
  await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, stored);

  // The draft the action was approved for is the only one a choice may re-bind.
  await gateway.managementStorage.put(SOURCES_KEY, { ...storedSources, sources: storedSources.sources.map((source) =>
    source.id === installed.source.id ? { ...source, label: 'Relabelled source' } : source) });
  await untouched(async () => {
    await refused(await gateway.api(installed.toolsPath), 409, 'source_action_conflict', 'draft_changed');
    await refused(await gateway.api(installed.toolsPath, choice), 409, 'source_action_conflict', 'draft_changed');
  });
  await gateway.managementStorage.put(SOURCES_KEY, { ...storedSources, sources: storedSources.sources.map((source) =>
    source.id === installed.source.id ? { ...source, status: 'installed', enabledTools: ['records_search'] } : source) });
  await untouched(async () => refused(await gateway.api(installed.toolsPath, choice), 409, 'source_tools_unavailable'));
  await gateway.managementStorage.put(SOURCES_KEY, storedSources);
  await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, { schemaVersion: 1, revision: 'corrupt', actions: [] });
  await untouched(async () => refused(await gateway.api(installed.toolsPath), 409, 'source_action_state_unavailable'));
}));

test('a tool choice re-binds the paused installation in one write, and the resume attaches exactly those tools', async () => signInFixture(async (gateway) => {
  const installed = await installSignInSource(gateway);
  connectSignInSource(gateway, installed.serverId);
  const before = pausedAction(gateway);
  const beforeSources = gateway.managementStorage.snapshot(SOURCES_KEY);
  const beforePortal = structuredClone(gateway.provider.state.portal);
  const puts = [];
  const originalPut = gateway.managementStorage.put;
  gateway.managementStorage.put = async (key, value) => {
    puts.push(v.is(v.string(), key) ? [key] : Object.keys(key).sort());
    return originalPut(key, value);
  };
  let baseline = gateway.provider.requests.length;
  const response = await chooseTools(gateway, installed, ['records_export', 'records_search']);
  gateway.managementStorage.put = originalPut;
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { schemaVersion: 1, actionId: before.actionId, sourceId: installed.source.id,
    revision: beforeSources.revision + 1, enabledTools: ['records_export', 'records_search'] });
  assert.deepEqual(gateway.provider.requests.slice(baseline).map(({ method, pathname }) => `${method} ${pathname}`),
    [`GET ${SERVERS_PATH}/${installed.serverId}`], 'one provider read, no provider write');
  assert.deepEqual(puts, [[SOURCE_ACTIONS_KEY, SOURCES_KEY].sort()], 'the draft and its action change in one atomic write');

  const sources = gateway.managementStorage.snapshot(SOURCES_KEY);
  const source = sources.sources.find((candidate) => candidate.id === installed.source.id);
  const after = pausedAction(gateway);
  assert.deepEqual([sources.revision, source.status, source.enabledTools],
    [beforeSources.revision + 1, 'draft', ['records_export', 'records_search']]);
  assert.equal(after.sourceRevision, sources.revision);
  assert.equal(after.sourceHash, await prefixedSha256({ id: source.id, label: source.label, url: source.url,
    authMode: source.authMode, onBehalfOfUser: source.onBehalfOfUser, enabledTools: source.enabledTools }));
  assert.notEqual(after.sourceHash, before.sourceHash);
  assert.notEqual(after.resources[0].desiredHash, before.resources[0].desiredHash, 'the server receipt covers the tool policy');
  assert.deepEqual({ ...after.resources[0], desiredHash: null }, { ...before.resources[0], desiredHash: null });
  assert.deepEqual(after.resources.slice(1), before.resources.slice(1), 'the application and policy receipts cover no tool');
  for (const field of ['actionId', 'actionKeyHash', 'actorEmail', 'issuedAt', 'expiresAt', 'status', 'pending',
    'portalUpdate', 'initialPolicyVersion', 'sourceId']) assert.deepEqual(after[field], before[field], field);
  assert.equal(after.failureCode, 'source_tools_chosen');
  assert.deepEqual(gateway.provider.state.portal, beforePortal, 'a choice attaches nothing');
  const summary = (await (await gateway.api('/api/source-actions')).json()).actions.at(-1);
  assert.deepEqual([summary.state, summary.failureCode, summary.canRenew, summary.canCancel],
    ['recovery_required', 'source_tools_chosen', true, false]);
  assert.ok(summary.connectionUrl);

  gateway.reloadManagement(); // an object restart between the choice and the resume loses nothing
  baseline = gateway.provider.requests.length;
  const resumed = await resumeInstallation(gateway, installed);
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.equal((await resumed.json()).status, 'succeeded');
  const mutations = gateway.provider.requests.slice(baseline).filter(({ method }) => method !== 'GET');
  assert.deepEqual(mutations.map(({ method, pathname }) => `${method} ${pathname.includes('/mcp/portals/')}`), ['PUT true']);
  const mapping = portalMapping(gateway, installed.serverId);
  assert.deepEqual([mapping.default_disabled, mapping.on_behalf, mapping.updated_tools], [true, false,
    [{ name: 'records_export', enabled: true }, { name: 'records_search', enabled: true }]], 'exactly the chosen tools, nothing else');
  assert.equal(Object.hasOwn(gateway.provider.state.servers.get(installed.serverId), 'updated_tools'), false,
    'the server record is never updated: the Portal mapping is where the allowlist is enforced');
  const installedSource = gateway.managementStorage.snapshot(SOURCES_KEY).sources.find((candidate) => candidate.id === source.id);
  assert.deepEqual([installedSource.status, installedSource.enabledTools], ['installed', source.enabledTools]);
  const policies = gateway.provider.state.policies.get(after.resources[2].provider.parentId);
  assert.deepEqual([policies.length, policies[0].decision, policies[0].include], [1, 'deny', [{ everyone: {} }]]);
  assert.equal((await gateway.view()).members.some((member) => member.sourceIds.includes(source.id)), false);
  assert.deepEqual(gateway.managementStorage.snapshot(CONTROL_KEY).sourceOwnership
    .find((entry) => entry.sourceId === source.id).resources, after.resources);
  await refused(await gateway.api(installed.toolsPath), 409, 'source_tools_unavailable');

  // Removal re-derives every receipt hash from the installed source: it accepts the re-bound server receipt.
  const teardown = await gateway.currentTeardown();
  assert.equal(teardown.prepared.status, 200, await teardown.prepared.clone().text());
  assert.equal((await teardown.send('prove')).status, 200);
  const removed = await teardown.send('apply');
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal(gateway.provider.liveResourceCount(), 0);
}, await portalOnlyClaim()));

test('a tool choice is refused for any body, revision, list or lifecycle state the design does not allow', async () => signInFixture(async (gateway) => {
  const installed = await installSignInSource(gateway);
  connectSignInSource(gateway, installed.serverId);
  const storedActions = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
  const storedSources = gateway.managementStorage.snapshot(SOURCES_KEY);
  const beforePortal = structuredClone(gateway.provider.state.portal);
  const unchanged = async (run, reads) => {
    const baseline = gateway.provider.requests.length;
    await run();
    const requests = gateway.provider.requests.slice(baseline);
    assert.equal(requests.length, reads);
    assert.equal(requests.every(({ method }) => method === 'GET'), true);
    assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), storedActions);
    assert.deepEqual(gateway.managementStorage.snapshot(SOURCES_KEY), storedSources);
    assert.deepEqual(gateway.provider.state.portal, beforePortal);
  };
  const body = { schemaVersion: 1, revision: storedSources.revision, sourceId: installed.source.id, enabledTools: ['records_search'] };
  for (const invalid of [
    { ...body, enabledTools: [] }, { ...body, enabledTools: ['records_search', 'records_export'] },
    { ...body, enabledTools: ['records_search', 'records_search'] }, { ...body, enabledTools: ['has space'] },
    { ...body, enabledTools: ['*'] }, { ...body, enabledTools: manyTools(501).map(({ name }) => name) },
    { ...body, enabledTools: 'records_search' }, { ...body, schemaVersion: 2 }, { ...body, revision: 0 },
    { ...body, revision: '1' }, { ...body, sourceId: 'source-1' }, { ...body, actionId: installed.action.actionId },
    { schemaVersion: 1, revision: body.revision, sourceId: body.sourceId },
    { ...body, enabledTools: manyTools(500, 'n'.repeat(250)).map(({ name }) => name) },
  ]) await unchanged(async () => refused(await gateway.api(installed.toolsPath, { method: 'POST', body: invalid }), 400, 'source_tools_invalid'), 0);

  await unchanged(async () => refused(await chooseTools(gateway, installed, body.enabledTools, { revision: body.revision + 1 }),
    409, 'source_action_conflict', 'draft_changed'), 0);
  await unchanged(async () => refused(await chooseTools(gateway, installed, body.enabledTools, { sourceId: 'source-0000000000000000' }),
    409, 'source_action_conflict', 'draft_changed'), 0);
  await unchanged(async () => refused(await chooseTools(gateway, installed, ['records_purge', 'records_search']),
    409, 'source_tools_mismatch'), 1);

  const server = gateway.provider.state.servers.get(installed.serverId);
  for (const [change, error] of [
    [{ authentication_status: 'required' }, 'source_connection_required'],
    [{ authentication_status: 'connected', status: 'waiting' }, 'source_sync_required'],
    [{ status: 'ready', tools: manyTools(501) }, 'source_tools_unsupported'],
  ]) {
    Object.assign(server, change);
    await unchanged(async () => refused(await chooseTools(gateway, installed, ['tool_000']), 409, error), 1);
  }
  connectSignInSource(gateway, installed.serverId);
  gateway.provider.hook(({ record }) => record.method === 'GET' && record.pathname === `${SERVERS_PATH}/${installed.serverId}`
    ? Response.json({ success: false, errors: [{ code: 10000, message: 'synthetic-private-provider-detail' }] }, { status: 403 }) : undefined);
  await unchanged(async () => refused(await chooseTools(gateway, installed, body.enabledTools), 409, 'management_credential_required'), 1);
  gateway.provider.hook(({ record }) => record.method === 'GET' && record.pathname === `${SERVERS_PATH}/${installed.serverId}`
    ? envelope(null, 503) : undefined);
  await unchanged(async () => refused(await chooseTools(gateway, installed, body.enabledTools), 502, 'source_catalogue_unavailable'), 1);
  gateway.provider.hook(undefined);

  // Another lifecycle action blocks the choice as it blocks a renewal; no provider read is spent.
  const update = await runtimeAction(gateway, { operation: 'update', release: 'gateway-v9.9.9' });
  assert.equal((await update.prepare()).status, 200);
  await unchanged(async () => refused(await chooseTools(gateway, installed, body.enabledTools),
    409, 'source_action_conflict', 'lifecycle_pending'), 0);
}));

for (const committed of [false, true]) {
  test(`an interrupted tool choice is all-or-nothing, and its lost response is safe to repeat (committed: ${committed})`, async () => signInFixture(async (gateway) => {
    const installed = await installSignInSource(gateway);
    connectSignInSource(gateway, installed.serverId);
    const before = { actions: gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), sources: gateway.managementStorage.snapshot(SOURCES_KEY) };
    const originalPut = gateway.managementStorage.put;
    gateway.managementStorage.put = async (key, value) => {
      if (!Object.hasOwn(key, SOURCES_KEY)) return originalPut(key, value);
      assert.deepEqual(Object.keys(key).sort(), [SOURCE_ACTIONS_KEY, SOURCES_KEY].sort());
      const action = key[SOURCE_ACTIONS_KEY].actions.at(-1);
      assert.equal(action.sourceRevision, key[SOURCES_KEY].revision, 'the action and the draft it is bound to travel together');
      if (committed) await originalPut(key);
      throw new Error('synthetic local commit interruption');
    };
    const interrupted = await chooseTools(gateway, installed, ['records_search'], { revision: before.sources.revision });
    gateway.managementStorage.put = originalPut;
    assert.equal(interrupted.status, 503);
    gateway.reloadManagement();
    if (!committed) {
      assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), before.actions);
      assert.deepEqual(gateway.managementStorage.snapshot(SOURCES_KEY), before.sources);
      const repeated = await chooseTools(gateway, installed, ['records_search'], { revision: before.sources.revision });
      assert.equal(repeated.status, 200, await repeated.clone().text());
    } else {
      // The repeat carries the revision the client last saw: refused, and nothing is applied twice.
      const writes = gateway.managementStorage.writes.length;
      await refused(await chooseTools(gateway, installed, ['records_search'], { revision: before.sources.revision }),
        409, 'source_action_conflict', 'draft_changed');
      assert.equal(gateway.managementStorage.writes.length, writes);
    }
    const bound = pausedAction(gateway);
    const sources = gateway.managementStorage.snapshot(SOURCES_KEY);
    assert.deepEqual([sources.revision, bound.sourceRevision, bound.failureCode],
      [before.sources.revision + 1, before.sources.revision + 1, 'source_tools_chosen']);

    // The same choice on the bound revision writes nothing; a different one re-binds again while still paused.
    const writes = gateway.managementStorage.writes.length;
    const same = await chooseTools(gateway, installed, ['records_search']);
    assert.equal(same.status, 200);
    assert.equal((await same.json()).revision, sources.revision);
    assert.equal(gateway.managementStorage.writes.length, writes);
    const changed = await chooseTools(gateway, installed, ['records_export']);
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).revision, sources.revision + 1);
    assert.equal(pausedAction(gateway).sourceRevision, sources.revision + 1);

    // Once a resume has recorded a Portal write, the installation is no longer exactly paused.
    gateway.provider.hook(({ record }) => record.method === 'PUT' && record.pathname.includes('/mcp/portals/')
      ? envelope(null, 503) : undefined);
    assert.equal((await resumeInstallation(gateway, installed)).status, 409);
    gateway.provider.hook(undefined);
    assert.equal(pausedAction(gateway).portalUpdate.phase, 'send_armed');
    await refused(await chooseTools(gateway, installed, ['records_search']), 409, 'source_tools_unavailable');
    await refused(await gateway.api(installed.toolsPath), 409, 'source_tools_unavailable');
  }));
}

test('with nothing chosen the installation stays paused with a fixed reason and the Portal is never written', async () => signInFixture(async (gateway) => {
  const installed = await installSignInSource(gateway);
  const beforePortal = structuredClone(gateway.provider.state.portal);
  connectSignInSource(gateway, installed.serverId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const baseline = gateway.provider.requests.length;
    await refused(await resumeInstallation(gateway, installed), 409, 'source_tools_required');
    assertNoMutation(gateway.provider, baseline);
    const action = pausedAction(gateway);
    assert.deepEqual([action.status, action.failureCode, action.pending, action.portalUpdate, action.resources.length],
      ['recovery_required', 'source_tools_required', null, null, 3]);
    assert.deepEqual(gateway.provider.state.portal, beforePortal);
    const summary = (await (await gateway.api('/api/source-actions')).json()).actions.at(-1);
    assert.deepEqual([summary.canRenew, summary.failureCode], [true, 'source_tools_required']);
  }
  const source = gateway.managementStorage.snapshot(SOURCES_KEY).sources.find((candidate) => candidate.id === installed.source.id);
  assert.deepEqual([source.status, source.enabledTools], ['draft', []]);

  // A Portal that already maps this server with nothing enabled was changed elsewhere: drift, never completion.
  gateway.provider.state.portal.servers = [...(gateway.provider.state.portal.servers ?? []),
    { id: installed.serverId, server_id: installed.serverId, default_disabled: true, on_behalf: false, updated_tools: [] }];
  const baseline = gateway.provider.requests.length;
  await refused(await resumeInstallation(gateway, installed), 409, 'portal_drift');
  assertNoMutation(gateway.provider, baseline);
  const drifted = gateway.managementStorage.snapshot(SOURCES_KEY).sources.find((candidate) => candidate.id === installed.source.id);
  assert.equal(drifted.status, 'draft', 'a source without tools is never recorded as installed');
  assert.equal(gateway.managementStorage.snapshot(CONTROL_KEY).sourceOwnership.some((entry) => entry.sourceId === installed.source.id), false);
}));

for (const typo of [false, true]) {
  test(`an installation paused with typed names keeps working${typo ? ', and a typed name can be corrected from the real list' : ''}`, async () => signInFixture(async (gateway) => {
    const typed = typo ? ['records_serch'] : ['records_export', 'records_search'];
    const draft = await saveSignInDraft(gateway, typed);
    assert.equal(gateway.managementStorage.snapshot(TEAM_KEY), undefined, 'a draft that names tools arms nothing, as before');
    const installed = await installSignInSource(gateway, { draft });
    const creation = gateway.provider.requests.find((request) => request.method === 'POST' &&
      request.pathname === SERVERS_PATH && request.body.hostname === SIGN_IN_URL);
    assert.deepEqual(creation.body.updated_tools, typed.map((name) => ({ name, enabled: true })), 'the creation body is the one it always was');
    connectSignInSource(gateway, installed.serverId);
    if (typo) {
      await refused(await resumeInstallation(gateway, installed), 409, 'source_tools_mismatch');
      assert.equal(portalMapping(gateway, installed.serverId), undefined);
      const corrected = await chooseTools(gateway, installed, ['records_search']);
      assert.equal(corrected.status, 200, await corrected.clone().text());
    }
    const resumed = await resumeInstallation(gateway, installed);
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.deepEqual(portalMapping(gateway, installed.serverId).updated_tools,
      (typo ? ['records_search'] : typed).map((name) => ({ name, enabled: true })));
  }));
}

test('a public source keeps its flow byte for byte and is refused by the tool choice routes', async () => signInFixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  assert.equal(gateway.managementStorage.snapshot(TEAM_KEY), undefined, 'saving and preparing a public draft arms nothing');
  createServersUnconnected(gateway);
  assert.equal((await gateway.apply(prepared, {}, null)).status, 409);
  gateway.provider.hook(undefined);
  const action = pausedAction(gateway);
  assert.equal(action.failureCode, 'source_connection_required');
  const creation = gateway.provider.requests.find((request) => request.method === 'POST' && request.pathname === SERVERS_PATH &&
    request.body.hostname === NEW_SOURCE_URL);
  assert.deepEqual(creation.body, { id: action.resources[0].key, name: 'Additional source', hostname: NEW_SOURCE_URL,
    auth_type: 'unauthenticated', secure_web_gateway: false, description: action.resources[0].marker,
    updated_tools: [{ name: 'company_lookup', enabled: true }] });
  assert.equal(action.sourceHash, await prefixedSha256({ id: prepared.source.id, label: 'Additional source', url: NEW_SOURCE_URL,
    authMode: 'none', onBehalfOfUser: false, enabledTools: ['company_lookup'] }));
  const summary = (await (await gateway.api('/api/source-actions')).json()).actions.at(-1);
  assert.deepEqual(Object.keys(summary).sort(), ['actionId', 'actorKind', 'canCancel', 'canRenew', 'connectionUrl', 'expiresAt',
    'failureCode', 'issuedAt', 'schemaVersion', 'sourceId', 'state', 'status'], 'no answer gained a field');
  const baseline = gateway.provider.requests.length;
  const path = `/api/source-actions/${action.actionId}/tools`;
  await refused(await gateway.api(path), 409, 'source_tools_unavailable');
  await refused(await gateway.api(path, { method: 'POST', body: { schemaVersion: 1, revision: prepared.sources.revision,
    sourceId: prepared.source.id, enabledTools: ['company_lookup'] } }), 409, 'source_tools_unavailable');
  assert.equal(gateway.provider.requests.length, baseline);
  // Connected and synced, it resumes exactly as it always did.
  connectSignInSource(gateway, action.resources[0].provider.id, [{ name: 'company_lookup' }], { authentication_status: 'not_required' });
  const resumed = await gateway.api(`/api/source-actions/${action.actionId}/renew`, { method: 'POST',
    body: { schemaVersion: 1, revision: prepared.sources.revision, sourceId: prepared.source.id } });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.deepEqual(portalMapping(gateway, action.resources[0].provider.id).updated_tools, [{ name: 'company_lookup', enabled: true }]);
}));

test('a choice holds the 500-tool bound and the bound of the source record', async () => signInFixture(async (gateway) => {
  // Fill the record with drafts until only a small choice still fits under its 1 MiB bound.
  const filler = (index) => ({ id: `source-${String(index).padStart(16, '0')}`, label: `Filler source ${index}`,
    url: `https://filler-${index}.example.net/mcp`, authMode: 'none', onBehalfOfUser: false,
    enabledTools: manyTools(500, `${'f'.repeat(120)}_`).map(({ name }) => name), status: 'draft' });
  const record = gateway.managementStorage.snapshot(SOURCES_KEY);
  const size = (value) => Buffer.byteLength(canonicalJson(value));
  const room = 1024 * 1024 - 20_000; // what stays free: enough for 499 short names, not for 500 long ones
  let index = 1;
  for (; size(record) + size(filler(index)) < room; index += 1) record.sources.push(filler(index));
  const partial = filler(index);
  while (size(record) + size(partial) >= room) partial.enabledTools.pop();
  record.sources.push(partial);
  assert.ok(record.sources.length <= 32 && partial.enabledTools.length > 0);
  await gateway.managementStorage.put(SOURCES_KEY, { ...record, revision: record.revision + 1 });

  const installed = await installSignInSource(gateway);
  const long = manyTools(500, `${'t'.repeat(124)}_`);
  assert.equal(long[0].name.length, 128);
  connectSignInSource(gateway, installed.serverId, long);
  const stored = { actions: gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), sources: gateway.managementStorage.snapshot(SOURCES_KEY) };
  await refused(await chooseTools(gateway, installed, long.map(({ name }) => name)), 413, 'source_capacity_exceeded');
  assert.deepEqual(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY), stored.actions);
  assert.deepEqual(gateway.managementStorage.snapshot(SOURCES_KEY), stored.sources);

  // A list of five hundred tools is offered whole; what is chosen from it is attached, and only that.
  const names = manyTools(500).map(({ name }) => name);
  connectSignInSource(gateway, installed.serverId, manyTools(500));
  const chosen = await chooseTools(gateway, installed, names.slice(0, 499));
  assert.equal(chosen.status, 200, await chosen.clone().text());
  const resumed = await resumeInstallation(gateway, installed);
  assert.equal(resumed.status, 200, await resumed.clone().text());
  const mapping = portalMapping(gateway, installed.serverId);
  assert.deepEqual(mapping.updated_tools.map(({ name }) => name).sort(), names.slice(0, 499));
  assert.equal(mapping.updated_tools.some(({ name }) => name === names[499]), false, 'a tool that was not chosen is not enabled');
}));

test('the dashboard client accepts every answer of the sign-in source flow', async () => signInFixture(async (gateway) => {
  await dashboardClient(gateway, async (dashboard) => {
    const discovered = await dashboard.discoverSource(SIGN_IN_URL);
    assert.deepEqual([discovered.status, discovered.authentication, discovered.tools], ['authorization_required', 'oauth', []]);
    const current = await dashboard.getSources();
    const drafted = await dashboard.saveSourceDraft(current.revision, { label: 'Sign-in source', url: SIGN_IN_URL, authMode: 'oauth', enabledTools: [] });
    const draft = drafted.sources.find((source) => source.url === SIGN_IN_URL);
    assert.deepEqual(draft.enabledTools, []);
    await assert.rejects(dashboard.saveSourceDraft(drafted.revision, { label: 'Public source', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: [] }),
      { status: 400, code: 'source_invalid' });

    createServersUnconnected(gateway);
    await assert.rejects(dashboard.prepareSourceAction(drafted.revision, draft.id), { status: 409, code: 'source_connection_required' });
    gateway.provider.hook(undefined);
    const paused = (await dashboard.getSourceActions()).actions.at(-1);
    assert.deepEqual([paused.state, paused.failureCode, paused.canRenew], ['recovery_required', 'source_connection_required', true]);
    assert.ok(paused.connectionUrl);
    assert.deepEqual((await dashboard.getSources()).sources.find((source) => source.id === draft.id).enabledTools, []);
    assert.deepEqual((await dashboard.getTeam()).sources.find((source) => source.id === draft.id).enabledTools, []);

    const serverId = pausedAction(gateway).resources[0].provider.id;
    const server = gateway.provider.state.servers.get(serverId);
    assert.deepEqual(await dashboard.getSourceActionTools(paused.actionId),
      { schemaVersion: 1, actionId: paused.actionId, sourceId: draft.id, state: 'connection_required', tools: [] });
    Object.assign(server, { authentication_status: 'connected', status: 'waiting' });
    assert.equal((await dashboard.getSourceActionTools(paused.actionId)).state, 'sync_required');
    connectSignInSource(gateway, serverId, manyTools(501));
    assert.equal((await dashboard.getSourceActionTools(paused.actionId)).state, 'unsupported');
    connectSignInSource(gateway, serverId);
    const offered = await dashboard.getSourceActionTools(paused.actionId);
    assert.equal(offered.state, 'ready');
    assert.deepEqual(offered.tools.map((tool) => [tool.name, tool.description, tool.readOnlyHint]), [
      ['records_delete', 'Delete one synthetic record.', null], ['records_export', null, null],
      ['records_search', 'Search synthetic records.', true]]);

    // Connected, synced and nothing chosen: the recorded installation waits with its own fixed reason.
    await assert.rejects(dashboard.prepareSourceAction(drafted.revision, draft.id, paused.actionId), { status: 409, code: 'source_tools_required' });
    assert.equal((await dashboard.getSourceActions()).actions.at(-1).failureCode, 'source_tools_required');

    await assert.rejects(dashboard.chooseSourceActionTools(paused.actionId, drafted.revision, draft.id, []), { status: 400, code: 'source_tools_invalid' });
    await assert.rejects(dashboard.chooseSourceActionTools(paused.actionId, drafted.revision, draft.id, ['records_purge']), { status: 409, code: 'source_tools_mismatch' });
    await assert.rejects(dashboard.chooseSourceActionTools(paused.actionId, drafted.revision + 5, draft.id, ['records_search']),
      { status: 409, code: 'source_action_conflict', reason: 'draft_changed' });
    await assert.rejects(dashboard.getSourceActionTools(`action_${'U'.repeat(32)}`), { status: 404, code: 'source_action_not_found' });
    const chosen = await dashboard.chooseSourceActionTools(paused.actionId, drafted.revision, draft.id, ['records_search', 'records_export', 'records_search']);
    assert.deepEqual(chosen, { schemaVersion: 1, actionId: paused.actionId, sourceId: draft.id, revision: drafted.revision + 1,
      enabledTools: ['records_export', 'records_search'] });
    assert.equal((await dashboard.getSourceActions()).actions.at(-1).failureCode, 'source_tools_chosen');

    const applied = await dashboard.prepareSourceAction(chosen.revision, draft.id, paused.actionId);
    assert.equal(applied.status, 'succeeded');
    const installed = (await dashboard.getSources()).sources.find((source) => source.id === draft.id);
    assert.deepEqual([installed.status, installed.enabledTools], ['installed', ['records_export', 'records_search']]);
    await assert.rejects(dashboard.getSourceActionTools(paused.actionId), { status: 409, code: 'source_tools_unavailable' });
  });
}));

// Settings: the gateway's own management token. A change is prepared here, approved in Cloudflare, and finished on a
// page of the gateway that takes the pasted token once; this Worker records who prepared it and how it ended, never
// the token. Verification proves both permissions by writing the gateway's own Portal and policy back unchanged.
const CREDENTIAL_ACTION_KEY = 'ankka-mcp-gateway/management-credential-action/v1';
const MANAGEMENT_CHOICE_KEY = 'ankka-mcp-gateway/management-credential-choice/v1';
const TOKEN_ACTIONS = '/api/management-credential/actions';
const TOKEN_VERIFY = '/api/management-credential/verify';
const TOKEN_CONFLICT = { schemaVersion: 1, error: 'management_credential_action_conflict' };
const PORTAL_PATH = `/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/portals/`;

async function prepareTokenChange(gateway, options = {}) {
  return gateway.api(TOKEN_ACTIONS, { method: 'POST', body: { schemaVersion: 1 }, ...options });
}

async function preparedTokenChange(gateway, options) {
  const response = await prepareTokenChange(gateway, options);
  assert.equal(response.status, 200, await response.clone().text());
  const prepared = await response.json();
  return { prepared, claim: JSON.parse(Buffer.from(new URL(prepared.handoffUrl).hash.slice(1), 'base64url').toString('utf8')) };
}

function tokenControl(gateway, claim, command, { signature: forged, ...fields } = {}) {
  const body = canonicalJson({ schemaVersion: 1, actionId: claim.actionId, actionKey: claim.actionKey, command,
    issuedAt: Date.now(), expiresAt: claim.expiresAt, ...fields });
  const signature = forged ?? `sha256=${createHmac('sha256', Buffer.from(claim.actionKey, 'base64url')).update(body).digest('hex')}`;
  return gateway.env.ADMIN_STATE.get('v1:management').fetch(new Request('https://admin-state.invalid/management-credential-actions/control', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ankka-management-credential-signature': signature }, body,
  }));
}

async function verifyToken(gateway, options = {}) {
  const response = await gateway.api(TOKEN_VERIFY, { method: 'POST', body: { schemaVersion: 1 }, ...options });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('a management token change is prepared only by an administrator, same-origin, and its record never holds a token', async () => fixture(async (gateway) => {
  gateway.env.ANKKA_SERVICE_CLIENT_ID = SERVICE_CLIENT;
  const baseline = gateway.provider.requests.length;
  for (const [options, status, error] of [
    [{ email: MEMBER }, 401, 'access_required'],
    [{ extraHeaders: { origin: 'https://foreign.example.com' } }, 403, 'origin_required'],
    [{ body: {} }, 400, 'request_invalid'],
    [{ body: { schemaVersion: 1, managementToken: 'never-accepted-here' } }, 400, 'request_invalid'],
    [{ method: 'GET', body: undefined }, 405, 'method_not_allowed'],
  ]) {
    const response = await prepareTokenChange(gateway, options);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, error);
  }
  for (const path of [TOKEN_ACTIONS, TOKEN_VERIFY]) {
    const denied = await gateway.serviceApi(path, { method: 'POST', body: { schemaVersion: 1 } });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { schemaVersion: 1, error: 'service_operation_denied' });
  }
  assert.equal((await gateway.api('/api/management-credential/other', { method: 'POST', body: { schemaVersion: 1 } })).status, 404);
  assert.equal(gateway.managementStorage.snapshot(CREDENTIAL_ACTION_KEY), undefined);

  // The same route adds a token to a gateway that has none and replaces one that is installed.
  for (const installed of [false, true]) {
    if (!installed) delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
    else gateway.env.ANKKA_MANAGEMENT_TOKEN = MANAGEMENT_TOKEN;
    const { prepared, claim } = await preparedTokenChange(gateway);
    assert.deepEqual(Object.keys(prepared).sort(), ['actionId', 'expiresAt', 'handoffUrl', 'schemaVersion', 'status']);
    assert.equal(prepared.status, 'authorization_required');
    assert.equal(new URL(prepared.handoffUrl).origin + new URL(prepared.handoffUrl).pathname, `${MANAGEMENT_ORIGIN}/__ankka/operation`);
    assert.deepEqual(claim, {
      schemaVersion: 1, actionType: 'management_credential', actionId: prepared.actionId, actionKey: claim.actionKey,
      actorEmail: ADMIN, accountId: ACCOUNT_ID, controlPlaneOrigin: 'https://deploy.ankka.ai',
      workerName: gateway.env.ANKKA_WORKER_NAME, workersSubdomain: gateway.env.ANKKA_WORKERS_SUBDOMAIN,
      managementOrigin: MANAGEMENT_ORIGIN, release: gateway.env.ANKKA_GATEWAY_RELEASE,
      artifactSha256: gateway.env.ANKKA_GATEWAY_RELEASE_SHA256, expiresAt: Date.parse(prepared.expiresAt),
    });
    const recorded = gateway.managementStorage.snapshot(CREDENTIAL_ACTION_KEY);
    assert.deepEqual(recorded, {
      schemaVersion: 1, actionId: prepared.actionId, actionKeyHash: await prefixedSha256(claim.actionKey), actorEmail: ADMIN,
      issuedAt: recorded.issuedAt, expiresAt: claim.expiresAt, status: 'authorization_required', beganAt: null, failureCode: null,
    });
    assert.equal(recorded.expiresAt - recorded.issuedAt, 600_000);
    assert.equal(canonicalJson(recorded).includes(claim.actionKey), false);
    assert.equal((await tokenControl(gateway, claim, 'fail', { failureCode: 'cancelled' })).status, 200);
  }
  // Preparing talks to nobody: no Cloudflare call, with or without an installed token.
  assert.equal(gateway.provider.requests.length, baseline);
}));

test('the recorded token change moves only by commands signed with its key, and no command can carry a token', async () => fixture(async (gateway) => {
  const { claim } = await preparedTokenChange(gateway);
  const recorded = () => gateway.managementStorage.snapshot(CREDENTIAL_ACTION_KEY);
  for (const [command, overrides] of [
    ['begin', { actionKey: BOOTSTRAP_NONCE }],
    ['begin', { signature: `sha256=${'0'.repeat(64)}` }],
    ['begin', { expiresAt: claim.expiresAt + 1 }],
    ['begin', { actionId: `action_${'Z'.repeat(32)}` }],
    ['begin', { managementToken: 'never-accepted-here' }],
    ['begin', { failureCode: 'cancelled' }],
    ['fail', {}],
    ['fail', { failureCode: 'Not A Fixed Word' }],
    ['publish', {}],
  ]) {
    const response = await tokenControl(gateway, claim, command, overrides);
    assert.equal(response.status, 400, `${command} ${canonicalJson(overrides)}`);
    assert.deepEqual(await response.json(), { schemaVersion: 1, error: 'management_credential_action_rejected' });
  }
  // The end cannot come before the write was begun.
  assert.equal((await tokenControl(gateway, claim, 'complete')).status, 409);
  assert.equal(recorded().status, 'authorization_required');

  const began = await tokenControl(gateway, claim, 'begin');
  assert.equal(began.status, 200);
  assert.deepEqual(Object.keys(await began.json()).sort(), ['actionId', 'expiresAt', 'failureCode', 'schemaVersion', 'status']);
  assert.equal(recorded().status, 'applying');
  assert.ok(Number.isSafeInteger(recorded().beganAt));
  assert.equal((await tokenControl(gateway, claim, 'begin')).status, 409);
  assert.equal((await tokenControl(gateway, claim, 'complete')).status, 200);
  assert.deepEqual([recorded().status, recorded().failureCode], ['succeeded', null]);
  assert.equal((await tokenControl(gateway, claim, 'fail', { failureCode: 'cancelled' })).status, 409);

  // An approval that ran out can no longer begin its write, but it can still be ended.
  const late = await preparedTokenChange(gateway);
  const stored = recorded();
  await gateway.managementStorage.put(CREDENTIAL_ACTION_KEY, { ...stored, issuedAt: stored.issuedAt - 601_000, expiresAt: stored.expiresAt - 601_000 });
  const lateClaim = { ...late.claim, expiresAt: late.claim.expiresAt - 601_000 };
  assert.equal((await tokenControl(gateway, lateClaim, 'begin')).status, 409);
  assert.equal((await tokenControl(gateway, lateClaim, 'fail', { failureCode: 'approval_expired' })).status, 200);
  assert.deepEqual([recorded().status, recorded().failureCode], ['failed', 'approval_expired']);

  // The internal routes have no public entry point.
  for (const path of ['/management-credential-actions', '/management-credential-actions/control', '/management-credential/verify']) {
    assert.equal((await gateway.api(path, { method: 'POST', body: { schemaVersion: 1 } })).status, 404);
  }
}));

test('an administrator may start their own unfinished approval again; nobody else may, and nothing replaces a write in flight', async () => fixture(async (gateway) => {
  const first = await preparedTokenChange(gateway);
  assert.deepEqual(await (await prepareTokenChange(gateway, { email: OWNER })).json(), TOKEN_CONFLICT);
  const second = await preparedTokenChange(gateway);
  assert.notEqual(second.claim.actionId, first.claim.actionId);
  // The earlier handoff names an action the gateway no longer holds.
  assert.equal((await tokenControl(gateway, first.claim, 'begin')).status, 400);
  assert.equal((await tokenControl(gateway, second.claim, 'begin')).status, 200);
  assert.deepEqual(await (await prepareTokenChange(gateway)).json(), TOKEN_CONFLICT);
  assert.equal(gateway.managementStorage.snapshot(CREDENTIAL_ACTION_KEY).actionId, second.claim.actionId);
}));

for (const kind of ['source', 'runtime', 'teardown', 'team']) {
  test(`a token change is refused while a ${kind} action is unfinished`, async () => fixture(async (gateway) => {
    if (kind === 'source') await prepareNewSource(gateway);
    if (kind === 'runtime') assert.equal((await (await runtimeAction(gateway)).prepare()).status, 200);
    if (kind === 'teardown') assert.equal((await gateway.currentTeardown()).prepared.status, 200);
    if (kind === 'team') await historicalPreparedTeam(gateway, changedRequest(await gateway.view()));
    const response = await prepareTokenChange(gateway);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), TOKEN_CONFLICT);
    assert.equal(gateway.managementStorage.snapshot(CREDENTIAL_ACTION_KEY), undefined);
  }));
}

test('while a token change is open, sources, updates, removals and Team changes are refused, and they return when it ends', async () => fixture(async (gateway) => {
  const draft = await gateway.draft(changedRequest(await gateway.view()));
  const { claim } = await preparedTokenChange(gateway);
  const pointer = { kind: 'management_credential', actionId: claim.actionId };
  const refusedEverywhere = async () => {
    assert.deepEqual((await (await gateway.api('/api/source-actions')).json()).blockingAction, pointer);
    const team = await gateway.view();
    assert.deepEqual([team.editingEnabled, team.editingDisabledReason], [false, 'lifecycle_action_pending']);
    const baseline = gateway.provider.requests.length;
    assert.equal((await gateway.apply(draft)).status, 409);
    assert.equal((await (await runtimeAction(gateway)).prepare()).status, 409);
    assert.equal((await gateway.currentTeardown()).prepared.status, 409);
    assert.equal((await gateway.api('/api/teardown-actions', { method: 'POST', body: { schemaVersion: 1 } })).status, 409);
    assert.equal((await verifyToken(gateway)).status, 'busy');
    assertNoMutation(gateway.provider, baseline);
  };
  await refusedEverywhere();
  // A source installation names the token change as what it waits for.
  const sources = gateway.managementStorage.snapshot(SOURCES_KEY);
  const installing = await gateway.api('/api/source-actions', { method: 'POST', body: {
    schemaVersion: 1, revision: sources.revision, sourceId: 'source-5555555555555555',
  } });
  assert.equal(installing.status, 409);

  // The write in flight holds the lock too, for the write's own window and no longer.
  assert.equal((await tokenControl(gateway, claim, 'begin')).status, 200);
  await refusedEverywhere();
  const applying = gateway.managementStorage.snapshot(CREDENTIAL_ACTION_KEY);
  await gateway.managementStorage.put(CREDENTIAL_ACTION_KEY, { ...applying, beganAt: Date.now() - 121_000 });
  assert.equal((await (await gateway.api('/api/source-actions')).json()).blockingAction, null);
  await gateway.managementStorage.put(CREDENTIAL_ACTION_KEY, applying);
  await refusedEverywhere();

  assert.equal((await tokenControl(gateway, claim, 'complete')).status, 200);
  assert.equal((await (await gateway.api('/api/source-actions')).json()).blockingAction, null);
  assert.equal((await gateway.view()).editingEnabled, true);
  assert.equal((await (await runtimeAction(gateway)).prepare()).status, 200);
}));

test('an approval nobody finished stops holding the lock when it expires, and a record that cannot be read holds nothing', async () => fixture(async (gateway) => {
  await preparedTokenChange(gateway);
  const stored = gateway.managementStorage.snapshot(CREDENTIAL_ACTION_KEY);
  await gateway.managementStorage.put(CREDENTIAL_ACTION_KEY, { ...stored, issuedAt: stored.issuedAt - 601_000, expiresAt: stored.expiresAt - 601_000 });
  assert.equal((await (await gateway.api('/api/source-actions')).json()).blockingAction, null);
  assert.equal((await gateway.view()).editingEnabled, true);
  // Unlike a source or update journal, this record is evidence of no provider write: it must never lock a gateway for good.
  await gateway.managementStorage.put(CREDENTIAL_ACTION_KEY, { ...stored, status: 'unknown_future_status' });
  assert.equal((await (await gateway.api('/api/source-actions')).json()).blockingAction, null);
  assert.equal((await prepareTokenChange(gateway)).status, 200);
}));

test('Team names what setup recorded at its token step, as a fixed word and never more', async () => fixture(async (gateway) => {
  delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
  assert.equal((await gateway.view()).managementCredentialChoice, null);
  for (const choice of ['skipped', 'provided']) {
    await gateway.managementStorage.put(MANAGEMENT_CHOICE_KEY, { schemaVersion: 1, choice });
    const view = await gateway.view();
    assert.deepEqual([view.managementCredentialConfigured, view.managementCredentialChoice], [false, choice]);
  }
  for (const invalid of [{ schemaVersion: 1, choice: 'held' }, { schemaVersion: 2, choice: 'skipped' },
    { schemaVersion: 1, choice: 'provided', value: 'never-stored' }, 'skipped']) {
    await gateway.managementStorage.put(MANAGEMENT_CHOICE_KEY, invalid);
    assert.equal((await gateway.view()).managementCredentialChoice, null);
  }
  // Without a token this answer reads storage only.
  assert.deepEqual(gateway.provider.requests.filter(({ pathname }) => pathname.includes('/tokens/verify')), []);
  gateway.env.ANKKA_MANAGEMENT_TOKEN = MANAGEMENT_TOKEN;
  await gateway.managementStorage.put(MANAGEMENT_CHOICE_KEY, { schemaVersion: 1, choice: 'skipped' });
  const installed = await gateway.view();
  assert.deepEqual([installed.managementCredentialConfigured, installed.managementCredentialChoice], [true, 'skipped']);
}));

test('management token status reads only local presence and setup choice, with no provider calls or state changes', async () => fixture(async (gateway) => {
  const path = '/api/management-credential/status';
  const baseline = gateway.provider.requests.length;
  for (const configured of [false, true]) {
    if (configured) gateway.env.ANKKA_MANAGEMENT_TOKEN = MANAGEMENT_TOKEN;
    else delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
    for (const choice of [null, 'provided', 'skipped']) {
      await gateway.managementStorage.put(MANAGEMENT_CHOICE_KEY, { schemaVersion: 1, choice });
      const before = [...await gateway.managementStorage.list()];
      const response = await gateway.api(path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { schemaVersion: 1,
        managementCredentialConfigured: configured, managementCredentialChoice: choice });
      assert.deepEqual([...await gateway.managementStorage.list()], before);
    }
  }
  assert.equal((await gateway.api(path, { email: MEMBER })).status, 401);
  assert.equal((await gateway.api(path, { extraHeaders: { 'cf-access-jwt-assertion': 'invalid' } })).status, 401);
  gateway.env.ANKKA_SERVICE_CLIENT_ID = SERVICE_CLIENT;
  assert.equal((await gateway.serviceApi(path)).status, 403);
  const rejected = await gateway.api(path, { method: 'POST' });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET');
  assert.deepEqual(gateway.provider.requests.slice(baseline), []);
}));

test('management verification overlaps three reads, waits for both writes and leaves local status available', async () => fixture(async (gateway) => {
  let active = 0;
  let peak = 0;
  let tokenChecked = false;
  let writes = 0;
  let peakWrites = 0;
  let localStatus;
  gateway.provider.hook(async ({ record }) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      if (record.pathname.endsWith('/tokens/verify')) {
        assert.equal(active, 1);
        await nextTurn();
        tokenChecked = true;
        return;
      }
      assert.equal(tokenChecked, true);
      if (record.method === 'PUT') {
        writes += 1;
        peakWrites = Math.max(peakWrites, writes);
        // This read must bypass the mutation queue, including while a provider write is pending.
        localStatus = await (await gateway.api('/api/management-credential/status')).json();
        await nextTurn();
        writes -= 1;
      } else await nextTurn();
    } finally { active -= 1; }
  });
  assert.equal((await verifyToken(gateway)).status, 'verified');
  assert.equal(peak, 3);
  assert.equal(peakWrites, 2);
  assert.equal(active, 0);
  assert.equal(writes, 0);
  assert.equal(localStatus.managementCredentialConfigured, true);
}));

test('verification proves both permissions by writing the gateway’s own Portal and policy back unchanged, in seven calls', async () => fixture(async (gateway) => {
  const before = await gateway.view();
  const portalBefore = structuredClone(gateway.provider.state.portal);
  const policiesBefore = structuredClone([...gateway.provider.state.policies]);
  const portalApp = app(gateway, 'mcp_portal');
  const baseline = gateway.provider.requests.length;

  assert.deepEqual(await verifyToken(gateway), {
    schemaVersion: 1, status: 'verified', token: 'active', portals: 'verified', accessPolicies: 'verified',
  });
  const calls = gateway.provider.requests.slice(baseline);
  assert.deepEqual(calls.map(({ method, pathname, search }) => `${method} ${pathname}${search}`).sort(), [
    `GET /client/v4/accounts/${ACCOUNT_ID}/tokens/verify`,
    `GET ${PORTAL_PATH}${portalBefore.id}`,
    `PUT ${PORTAL_PATH}${portalBefore.id}`,
    `GET ${PORTAL_PATH}${portalBefore.id}`,
    `GET /client/v4/accounts/${ACCOUNT_ID}/access/apps/${portalApp.id}`,
    `GET /client/v4/accounts/${ACCOUNT_ID}/access/apps/${portalApp.id}/policies?page=1&per_page=100`,
    `PUT /client/v4/accounts/${ACCOUNT_ID}/access/apps/${portalApp.id}/policies/${policy(gateway, 'mcp_portal').id}`,
  ].sort());
  assert.ok(calls[0].pathname.endsWith('/tokens/verify'));
  assert.deepEqual(calls.filter(({ pathname }) => pathname.startsWith(PORTAL_PATH)).map(({ method }) => method),
    ['GET', 'PUT', 'GET']);
  assert.deepEqual(calls.filter(({ pathname }) => pathname.includes('/access/apps/')).map(({ method }) => method),
    ['GET', 'GET', 'PUT']);

  // The two writes are the only ones, each to a resource this gateway's receipts name, each with what was just read.
  const writes = calls.filter(({ method }) => method === 'PUT');
  assert.equal(writes.length, 2);
  const portalWrite = writes.find(({ pathname }) => pathname.startsWith(PORTAL_PATH));
  const policyWrite = writes.find(({ pathname }) => pathname.includes('/policies/'));
  const { id: _portalId, servers, ...portalFields } = portalBefore;
  assert.deepEqual(portalWrite.body, { ...portalFields, servers });
  const { id: _policyId, ...policyFields } = policiesBefore.find(([id]) => id === portalApp.id)[1][0];
  assert.deepEqual(policyWrite.body, policyFields);

  // Nothing changed: not in Cloudflare, not in what the gateway saved, and nothing it reads afterwards looks like drift.
  assert.deepEqual(gateway.provider.state.portal, portalBefore);
  assert.deepEqual([...gateway.provider.state.policies], policiesBefore);
  const after = await gateway.view();
  assert.deepEqual([after.revision, after.members], [before.revision, before.members]);
  assert.ok(after.observedAt);
  assert.deepEqual(await verifyToken(gateway), {
    schemaVersion: 1, status: 'verified', token: 'active', portals: 'verified', accessPolicies: 'verified',
  });
  assert.doesNotMatch(JSON.stringify([...await gateway.managementStorage.list()]), /synthetic-account-management-token/);
}));

test('verification of a Portal without sources sends the body the Portal was created with', async () => fixture(async (gateway) => {
  const baseline = gateway.provider.requests.length;
  assert.equal((await verifyToken(gateway)).status, 'verified');
  const write = gateway.provider.requests.slice(baseline).find(({ method, pathname }) => method === 'PUT' && pathname.startsWith(PORTAL_PATH));
  assert.equal(Object.hasOwn(write.body, 'servers'), false);
  assert.deepEqual(Object.keys(write.body).sort(), ['code_mode', 'description', 'hostname', 'name', 'secure_web_gateway']);
}, await portalOnlyClaim()));

test('verification names the missing permission, and a refusal of one check does not hide the other', async () => fixture(async (gateway) => {
  const refused = () => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null }, { status: 403 });
  const portalBefore = structuredClone(gateway.provider.state.portal);
  const policiesBefore = structuredClone([...gateway.provider.state.policies]);
  for (const [refuse, expected] of [
    [({ method, pathname }) => method === 'PUT' && pathname.startsWith(PORTAL_PATH),
      { status: 'permission_missing', portals: 'permission_missing', accessPolicies: 'verified' }],
    [({ method, pathname }) => method === 'PUT' && pathname.includes('/policies/'),
      { status: 'permission_missing', portals: 'verified', accessPolicies: 'permission_missing' }],
    [({ method }) => method === 'PUT',
      { status: 'permission_missing', portals: 'permission_missing', accessPolicies: 'permission_missing' }],
    // A token that cannot even read a family cannot edit it.
    [({ pathname }) => pathname.startsWith(PORTAL_PATH),
      { status: 'permission_missing', portals: 'permission_missing', accessPolicies: 'verified' }],
    [({ pathname }) => pathname.includes('/access/apps/'),
      { status: 'permission_missing', portals: 'verified', accessPolicies: 'permission_missing' }],
  ]) {
    gateway.provider.hook(({ record }) => refuse(record) ? refused() : undefined);
    assert.deepEqual(await verifyToken(gateway), { schemaVersion: 1, token: 'active', ...expected });
  }
  assert.deepEqual(gateway.provider.state.portal, portalBefore);
  assert.deepEqual([...gateway.provider.state.policies], policiesBefore);
}));

test('verification writes nothing to a resource that no longer matches the receipts, and says drift', async () => fixture(async (gateway) => {
  const original = structuredClone(gateway.provider.state.portal);
  gateway.provider.state.portal.name = 'Renamed in Cloudflare';
  let baseline = gateway.provider.requests.length;
  assert.deepEqual(await verifyToken(gateway), {
    schemaVersion: 1, status: 'drift', token: 'active', portals: 'drift', accessPolicies: 'verified',
  });
  assert.deepEqual(gateway.provider.requests.slice(baseline).filter(({ method, pathname }) => method === 'PUT' && pathname.startsWith(PORTAL_PATH)), []);
  assert.equal(gateway.provider.state.portal.name, 'Renamed in Cloudflare');
  gateway.provider.state.portal = original;

  // A membership changed in Cloudflare that the gateway has not read yet: the policy is left exactly as it is.
  policy(gateway, 'mcp_portal').include.push({ email: { email: NEW_PERSON } });
  const edited = structuredClone(policy(gateway, 'mcp_portal'));
  baseline = gateway.provider.requests.length;
  assert.deepEqual(await verifyToken(gateway), {
    schemaVersion: 1, status: 'drift', token: 'active', portals: 'verified', accessPolicies: 'drift',
  });
  assert.deepEqual(gateway.provider.requests.slice(baseline).filter(({ method, pathname }) => method === 'PUT' && pathname.includes('/policies/')), []);
  assert.deepEqual(policy(gateway, 'mcp_portal'), edited);
  // Team reads the change in; then both agree again and the same policy is proven.
  await gateway.view();
  assert.equal((await verifyToken(gateway)).status, 'verified');

  // A second policy on the Portal's application, or a deleted one, is drift too.
  gateway.provider.state.policies.get(app(gateway, 'mcp_portal').id).push({ ...edited, id: 'y'.repeat(32) });
  assert.equal((await verifyToken(gateway)).accessPolicies, 'drift');
}));

test('verification says missing, rejected, busy or unconfirmed without writing, each with the calls it needs and no more', async () => fixture(async (gateway) => {
  const count = async (run) => { const baseline = gateway.provider.requests.length; const result = await run(); return [result, gateway.provider.requests.slice(baseline)]; };
  delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
  let [result, calls] = await count(() => verifyToken(gateway));
  assert.deepEqual(result, { schemaVersion: 1, status: 'missing', token: 'missing', portals: 'not_checked', accessPolicies: 'not_checked' });
  assert.deepEqual(calls, []);

  gateway.env.ANKKA_MANAGEMENT_TOKEN = MANAGEMENT_TOKEN;
  for (const answer of [() => envelope(null, 401), () => envelope(null, 403), () => envelope({ status: 'expired' })]) {
    gateway.provider.hook(({ record }) => record.pathname.endsWith('/tokens/verify') ? answer() : undefined);
    [result, calls] = await count(() => verifyToken(gateway));
    assert.deepEqual(result, { schemaVersion: 1, status: 'rejected', token: 'rejected', portals: 'not_checked', accessPolicies: 'not_checked' });
    assert.equal(calls.length, 1);
  }
  gateway.provider.hook(({ record }) => record.pathname.endsWith('/tokens/verify') ? envelope(null, 503) : undefined);
  [result, calls] = await count(() => verifyToken(gateway));
  assert.deepEqual(result, { schemaVersion: 1, status: 'unconfirmed', token: 'unconfirmed', portals: 'not_checked', accessPolicies: 'not_checked' });
  assert.equal(calls.length, 1);

  gateway.provider.hook(({ record }) => record.method === 'PUT' ? envelope(null, 500) : undefined);
  [result, calls] = await count(() => verifyToken(gateway));
  assert.deepEqual(result, { schemaVersion: 1, status: 'unconfirmed', token: 'active', portals: 'unconfirmed', accessPolicies: 'unconfirmed' });
  assert.ok(calls.length <= 7);
  gateway.provider.hook(undefined);

  assert.equal((await (await runtimeAction(gateway)).prepare()).status, 200);
  [result, calls] = await count(() => verifyToken(gateway));
  assert.deepEqual(result, { schemaVersion: 1, status: 'busy', token: 'not_checked', portals: 'not_checked', accessPolicies: 'not_checked' });
  assert.deepEqual(calls, []);

  for (const [options, status] of [
    [{ email: MEMBER }, 401], [{ extraHeaders: { origin: 'https://foreign.example.com' } }, 403],
    [{ body: { schemaVersion: 1, write: false } }, 400], [{ method: 'GET', body: undefined }, 405],
  ]) {
    assert.equal((await gateway.api(TOKEN_VERIFY, { method: 'POST', body: { schemaVersion: 1 }, ...options })).status, status);
  }
}));

test('the dashboard client accepts every answer about the management token, in every state', async () => fixture(async (gateway) => {
  await dashboardClient(gateway, async (dashboard) => {
    // Team, with each word setup can have recorded, without a token and with one.
    delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
    for (const choice of [null, 'skipped', 'provided']) {
      if (choice !== null) await gateway.managementStorage.put(MANAGEMENT_CHOICE_KEY, { schemaVersion: 1, choice });
      assert.deepEqual(await dashboard.getManagementCredentialStatus(), { schemaVersion: 1,
        managementCredentialConfigured: false, managementCredentialChoice: choice });
      const team = await dashboard.getTeam();
      assert.deepEqual([team.managementCredentialConfigured, team.managementCredentialChoice, team.editingDisabledReason],
        [false, choice, 'management_credential_missing']);
    }
    assert.deepEqual(await dashboard.verifyManagementAccess(),
      { schemaVersion: 1, status: 'missing', token: 'missing', portals: 'not_checked', accessPolicies: 'not_checked' });

    // The prepared change, and the pointer every page reads while it is open.
    const prepared = await dashboard.prepareManagementCredentialAction();
    assert.equal(prepared.status, 'authorization_required');
    assert.equal(new URL(prepared.handoffUrl).pathname, '/__ankka/operation');
    assert.deepEqual((await dashboard.getSourceActions()).blockingAction, { kind: 'management_credential', actionId: prepared.actionId });
    assert.equal((await dashboard.getTeam()).editingDisabledReason, 'lifecycle_action_pending');
    await assert.rejects(dashboard.prepareRuntimeAction('update'), { status: 409 });
    gateway.env.ANKKA_MANAGEMENT_TOKEN = MANAGEMENT_TOKEN;
    assert.equal((await dashboard.verifyManagementAccess()).status, 'busy');
    // A second administrator is told why they cannot start one now.
    const refused = await gateway.api(TOKEN_ACTIONS, { method: 'POST', body: { schemaVersion: 1 }, email: OWNER });
    assert.deepEqual([refused.status, await refused.json()], [409, TOKEN_CONFLICT]);
    const claim = JSON.parse(Buffer.from(new URL(prepared.handoffUrl).hash.slice(1), 'base64url').toString('utf8'));
    assert.equal((await tokenControl(gateway, claim, 'fail', { failureCode: 'cancelled' })).status, 200);
    assert.equal((await dashboard.getSourceActions()).blockingAction, null);

    // With the token installed: configured, and verification in each state it can answer.
    const team = await dashboard.getTeam();
    assert.deepEqual([team.managementCredentialConfigured, team.managementCredentialChoice, team.editingEnabled], [true, 'provided', true]);
    assert.equal((await dashboard.verifyManagementAccess()).status, 'verified');
    const refusedWrite = () => Response.json({ success: false, errors: [{ code: 10000 }], result: null }, { status: 403 });
    gateway.provider.hook(({ record }) => record.method === 'PUT' && record.pathname.includes('/policies/') ? refusedWrite() : undefined);
    assert.deepEqual(await dashboard.verifyManagementAccess(),
      { schemaVersion: 1, status: 'permission_missing', token: 'active', portals: 'verified', accessPolicies: 'permission_missing' });
    gateway.provider.hook(({ record }) => record.method === 'PUT' ? envelope(null, 502) : undefined);
    assert.equal((await dashboard.verifyManagementAccess()).status, 'unconfirmed');
    gateway.provider.hook(({ record }) => record.pathname.endsWith('/tokens/verify') ? envelope(null, 401) : undefined);
    assert.equal((await dashboard.verifyManagementAccess()).status, 'rejected');
    gateway.provider.hook(undefined);
    gateway.provider.state.portal.name = 'Renamed in Cloudflare';
    assert.deepEqual(await dashboard.verifyManagementAccess(),
      { schemaVersion: 1, status: 'drift', token: 'active', portals: 'drift', accessPolicies: 'verified' });
  });
}));

const OAUTH_KEY = 'ankka-mcp-gateway/source-oauth/v1';
const OAUTH_ISSUER = 'https://identity.example.net';
const OAUTH_CALLBACK = '/__ankka/source-oauth/callback';

async function sourceOauthFixture(run, before = null) {
  return signInFixture(async (gateway) => {
    if (before) await before(gateway);
    const installed = await installSignInSource(gateway);
    const network = globalThis.fetch;
    const exchanges = [], imports = [], registrations = [];
    const accessToken = crypto.randomUUID(), refreshToken = crypto.randomUUID();
    let hook;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const intercepted = await hook?.(request);
      if (intercepted) return intercepted;
      const path = new URL(request.url);
      if (request.url === 'https://signin.example.net/.well-known/oauth-protected-resource') {
        return Response.json({ resource: SIGN_IN_URL, authorization_servers: [OAUTH_ISSUER], scopes_supported: ['records:read'] });
      }
      if (request.url === `${OAUTH_ISSUER}/.well-known/oauth-authorization-server`) {
        return Response.json({ issuer: OAUTH_ISSUER, authorization_endpoint: `${OAUTH_ISSUER}/authorize`,
          token_endpoint: `${OAUTH_ISSUER}/token`, registration_endpoint: `${OAUTH_ISSUER}/register`,
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true });
      }
      if (request.url === `${OAUTH_ISSUER}/register`) {
        const registration = await request.json();
        registrations.push(registration);
        return Response.json({ ...registration, client_id: 'synthetic-public-client' });
      }
      if (request.url === `${OAUTH_ISSUER}/token`) {
        exchanges.push(new URLSearchParams(await request.text()));
        return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 300, scope: 'records:read' });
      }
      if (path.origin === 'https://api.cloudflare.com' && path.pathname === `${SERVERS_PATH}/${installed.serverId}` && request.method === 'PUT') {
        imports.push(await request.json());
        connectSignInSource(gateway, installed.serverId);
        return envelope(gateway.provider.state.servers.get(installed.serverId));
      }
      if (path.origin === 'https://api.cloudflare.com' && path.pathname === `${SERVERS_PATH}/${installed.serverId}/sync`) return envelope({});
      return network(input, init);
    };
    const start = (overrides = {}) => gateway.api(`/api/source-actions/${installed.action.actionId}/authorize`, {
      method: 'POST', body: { schemaVersion: 1, revision: installed.sources.revision, sourceId: installed.source.id }, ...overrides,
    });
    async function begin() {
      const response = await start();
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json();
      const cookie = response.headers.get('set-cookie').split(';')[0];
      assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=300/u);
      return { body, url: new URL(body.authorizationUrl), cookie };
    }
    function finish(attempt, query = {}, options = {}) {
      const params = new URLSearchParams({ state: attempt.url.searchParams.get('state'), code: 'synthetic-authorization-code', iss: OAUTH_ISSUER, ...query });
      return gateway.api(`${OAUTH_CALLBACK}?${params}`, { extraHeaders: { cookie: attempt.cookie }, ...options });
    }
    try {
      await run({ ...gateway, installed, start, begin, finish, exchanges, imports, registrations, accessToken, refreshToken,
        oauthHook(next) { hook = next; } });
    } finally { globalThis.fetch = network; }
  }, await portalOnlyClaim());
}

test('source OAuth connects through the customer callback with PKCE; tokens never enter storage or browser responses', async () => {
  await sourceOauthFixture(async (gateway) => {
    const attempt = await gateway.begin();
    assert.equal(attempt.url.origin, OAUTH_ISSUER);
    assert.equal(attempt.url.searchParams.get('redirect_uri'), `${MANAGEMENT_ORIGIN}${OAUTH_CALLBACK}`);
    assert.equal(attempt.url.searchParams.get('resource'), SIGN_IN_URL);
    assert.equal(attempt.url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(gateway.registrations[0].token_endpoint_auth_method, 'none');
    const callbacks = await Promise.all([gateway.finish(attempt), gateway.finish(attempt)]);
    // Access verification is asynchronous, so either callback can reach the
    // mutation queue first. Exactly one may exchange and import the grant.
    assert.deepEqual(callbacks.map((response) => response.headers.get('location')).sort(), [
      `${MANAGEMENT_ORIGIN}/sources?source_oauth=connected`, `${MANAGEMENT_ORIGIN}/sources?source_oauth=failed`,
    ]);
    assert.equal(gateway.exchanges.length, 1);
    assert.equal(gateway.imports.length, 1);
    assert.equal(gateway.exchanges[0].get('redirect_uri'), `${MANAGEMENT_ORIGIN}${OAUTH_CALLBACK}`);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(gateway.exchanges[0].get('code_verifier')));
    assert.equal(Buffer.from(digest).toString('base64url'), attempt.url.searchParams.get('code_challenge'));
    const imported = JSON.parse(gateway.imports[0].auth_credentials);
    assert.equal(imported.tokens.access_token, gateway.accessToken);
    assert.equal(imported.tokens.refresh_token, gateway.refreshToken);
    assert.equal(imported.registration_info.redirect_uris[0], `${MANAGEMENT_ORIGIN}${OAUTH_CALLBACK}`);
    assert.equal(gateway.managementStorage.snapshot(OAUTH_KEY), undefined);
    const evidence = JSON.stringify([attempt.body, callbacks.map((response) => [...response.headers]), gateway.managementStorage.writes]);
    assert.ok(!evidence.includes(gateway.accessToken));
    assert.ok(!evidence.includes(gateway.refreshToken));
    assert.equal(portalMapping(gateway, gateway.installed.serverId), undefined);
    assert.deepEqual(gateway.managementStorage.snapshot(SOURCES_KEY).sources.find((source) => source.id === gateway.installed.source.id).enabledTools, []);
  });
});

test('source OAuth refuses wrong actors, cross-origin starts, missing management authority and stale revisions before registration', async () => {
  await sourceOauthFixture(async (gateway) => {
    assert.equal((await gateway.start({ email: OWNER })).status, 409);
    assert.equal((await gateway.start({ extraHeaders: { origin: 'https://elsewhere.example.net' } })).status, 403);
    assert.equal((await gateway.start({ extraHeaders: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await gateway.start({ body: { schemaVersion: 1, revision: 999, sourceId: gateway.installed.source.id } })).status, 409);
    delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
    assert.equal((await gateway.start()).status, 409);
    assert.equal(gateway.registrations.length, 0);
  });
});

test('source OAuth browser and administrator binding reject copied callbacks without consuming the valid attempt', async () => {
  await sourceOauthFixture(async (gateway) => {
    const attempt = await gateway.begin();
    for (const options of [{ email: OWNER }, { extraHeaders: {} }, { extraHeaders: { cookie: '__Host-ankka-source-oauth=' + 'A'.repeat(43) } }]) {
      const response = await gateway.finish(attempt, {}, options);
      assert.equal(response.headers.get('location'), `${MANAGEMENT_ORIGIN}/sources?source_oauth=failed`);
      assert.equal(gateway.exchanges.length, 0);
    }
    assert.equal((await gateway.finish(attempt)).headers.get('location'), `${MANAGEMENT_ORIGIN}/sources?source_oauth=connected`);
  });
});

test('source OAuth expires, binds the issuer and rejects action or ownership drift before exchanging a code', async () => {
  for (const change of ['expiry', 'issuer', 'renewed', 'ownership', 'draft', 'lifecycle']) {
    await sourceOauthFixture(async (gateway) => {
      const attempt = await gateway.begin();
      if (change === 'expiry') await gateway.managementStorage.put(OAUTH_KEY, { ...gateway.managementStorage.snapshot(OAUTH_KEY), expiresAt: Date.now() - 1 });
      if (change === 'renewed') {
        const actions = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
        actions.actions.at(-1).actionKeyHash = await prefixedSha256('replacement');
        await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, actions);
      }
      if (change === 'ownership') gateway.provider.state.servers.get(gateway.installed.serverId).description = 'different-owner';
      if (change === 'draft') {
        const sources = gateway.managementStorage.snapshot(SOURCES_KEY);
        sources.revision++;
        await gateway.managementStorage.put(SOURCES_KEY, sources);
      }
      if (change === 'lifecycle') {
        const update = await runtimeAction(gateway, { operation: 'update', release: 'gateway-v9.9.9' });
        assert.equal((await update.prepare()).status, 200);
      }
      const response = await gateway.finish(attempt, change === 'issuer' ? { iss: 'https://different.example.net' } : {});
      assert.equal(response.headers.get('location'), `${MANAGEMENT_ORIGIN}/sources?source_oauth=failed`, change);
      assert.equal(gateway.exchanges.length, 0, change);
      assert.equal(gateway.imports.length, 0, change);
      assert.equal(gateway.managementStorage.snapshot(OAUTH_KEY), undefined, change);
    });
  }
});

test('source OAuth rejects manual clients and unsafe discovery endpoints without importing credentials', async () => {
  for (const change of ['manual', 'redirect', 'private', 'cross_origin', 'no_pkce']) {
    await sourceOauthFixture(async (gateway) => {
      gateway.oauthHook(async (request) => {
        if (change === 'manual' && request.url.endsWith('/register')) return Response.json({ ...await request.json(), client_id: 'manual-client', client_secret: 'synthetic-rejected-secret' });
        if (!request.url.endsWith('/.well-known/oauth-authorization-server')) return undefined;
        if (change === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.net/metadata' } });
        if (change === 'manual') return undefined;
        return Response.json({ issuer: OAUTH_ISSUER, authorization_endpoint: `${OAUTH_ISSUER}/authorize`,
          token_endpoint: change === 'private' ? 'https://127.0.0.1/token' : change === 'cross_origin' ? 'https://elsewhere.example.net/token' : `${OAUTH_ISSUER}/token`,
          registration_endpoint: `${OAUTH_ISSUER}/register`, code_challenge_methods_supported: change === 'no_pkce' ? ['plain'] : ['S256'] });
      });
      const response = await gateway.start();
      assert.equal(response.status, 409, change);
      assert.equal((await response.json()).error, 'source_oauth_unavailable');
      assert.equal(gateway.managementStorage.snapshot(OAUTH_KEY), undefined);
      assert.equal(gateway.imports.length, 0);
    });
  }
});

test('source OAuth restart invalidates the previous callback and provider denial is fixed text', async () => {
  await sourceOauthFixture(async (gateway) => {
    const old = await gateway.begin();
    const attempt = await gateway.begin();
    assert.equal((await gateway.finish(old)).headers.get('location'), `${MANAGEMENT_ORIGIN}/sources?source_oauth=failed`);
    const query = new URLSearchParams({ state: attempt.url.searchParams.get('state'), error: 'access_denied', iss: OAUTH_ISSUER, error_description: 'synthetic-private-error' });
    const response = await gateway.api(`${OAUTH_CALLBACK}?${query}`, { extraHeaders: { cookie: attempt.cookie } });
    assert.equal(response.headers.get('location'), `${MANAGEMENT_ORIGIN}/sources?source_oauth=cancelled`);
    assert.equal(await response.text(), '');
    assert.equal(gateway.exchanges.length, 0);
    assert.equal(gateway.managementStorage.snapshot(OAUTH_KEY), undefined);
  });
});

test('source OAuth never imports after ownership changes during exchange and gives fixed results for import or sync failure', async () => {
  for (const failure of ['ownership', 'import', 'sync']) {
    await sourceOauthFixture(async (gateway) => {
      const attempt = await gateway.begin();
      gateway.oauthHook((request) => {
        if (failure === 'ownership' && request.url === `${OAUTH_ISSUER}/token`) {
          gateway.provider.state.servers.get(gateway.installed.serverId).description = 'another-owner';
        }
        if ((failure === 'import' && request.method === 'PUT') || (failure === 'sync' && request.url.endsWith('/sync'))) {
          return Response.json({ error: gateway.accessToken }, { status: 503 });
        }
        return undefined;
      });
      const response = await gateway.finish(attempt);
      assert.equal(response.headers.get('location'), `${MANAGEMENT_ORIGIN}/sources?source_oauth=${failure === 'sync' ? 'sync_pending' : 'failed'}`);
      assert.equal(gateway.exchanges.length, 1);
      assert.equal(gateway.imports.length, failure === 'sync' ? 1 : 0);
      assert.equal(gateway.managementStorage.snapshot(OAUTH_KEY), undefined);
      assert.ok(!JSON.stringify([...response.headers]).includes(gateway.accessToken));
      await gateway.finish(attempt);
      assert.equal(gateway.exchanges.length, 1);
    });
  }
});

const SOURCE_REMOVAL_KEY = 'ankka-mcp-gateway/source-removal/v1';
async function removeSource(gateway, sourceId, options = {}) {
  const sources = await (await gateway.api('/api/sources')).json();
  return gateway.api(`/api/sources/${sourceId ?? sources.sources[0].id}`, {
    method: 'DELETE', body: { schemaVersion: 1, revision: sources.revision }, ...options,
  });
}

test('a paused source with a 6 MiB synced catalogue can list tools and be removed', () => signInFixture(async (gateway) => {
  const installed = await installSignInSource(gateway);
  const tools = manyTools(263).map((tool) => ({ ...tool, inputSchema: { type: 'object',
    description: 'Synthetic schema documentation. '.repeat(800) } }));
  connectSignInSource(gateway, installed.serverId, tools);
  const bytes = Buffer.byteLength(JSON.stringify(gateway.provider.state.servers.get(installed.serverId)));
  assert.ok(bytes > 6 * 1024 * 1024 && bytes < 8 * 1024 * 1024);
  const catalogue = await gateway.api(installed.toolsPath);
  assert.equal(catalogue.status, 200, await catalogue.clone().text());
  const listed = await catalogue.json();
  assert.equal(listed.state, 'ready');
  assert.equal(listed.tools.length, tools.length);
  assert.ok(!JSON.stringify(listed).includes('Synthetic schema documentation'), 'raw schemas stay out of dashboard responses');
  const response = await removeSource(gateway, installed.source.id);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).sources.some((source) => source.id === installed.source.id), false);
  assert.equal(gateway.provider.state.servers.has(installed.serverId), false);
}));

for (const declared of [true, false]) test(`source removal refuses a catalogue above 8 MiB (${declared ? 'declared' : 'streamed'}) without deleting`, () => signInFixture(async (gateway) => {
  const installed = await installSignInSource(gateway);
  let cancelled = false;
  gateway.provider.hook(({ record }) => {
    if (record.method !== 'GET' || !record.pathname.endsWith(`/mcp/servers/${installed.serverId}`)) return undefined;
    const headers = { 'content-type': 'application/json' };
    if (declared) headers['content-length'] = String(8 * 1024 * 1024 + 1);
    return new Response(new ReadableStream({
      start(controller) {
        if (!declared) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024));
          controller.enqueue(new Uint8Array(1));
        }
      },
      cancel() { cancelled = true; },
    }), { headers });
  });
  const baseline = gateway.provider.requests.length;
  const response = await removeSource(gateway, installed.source.id);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'source_removal_ownership_conflict');
  assert.equal(cancelled, true);
  assertNoMutation(gateway.provider, baseline);
  assert.equal(gateway.managementStorage.snapshot(SOURCE_REMOVAL_KEY), undefined);
  assert.equal(gateway.provider.state.servers.has(installed.serverId), true);
}));

for (const chosen of [false, true]) test(`a paused source can be removed ${chosen ? 'after choosing tools' : 'without connecting or installing it'}`, () => signInFixture(async (gateway) => {
  const installed = await installSignInSource(gateway);
  if (chosen) {
    connectSignInSource(gateway, installed.serverId);
    const selected = await chooseTools(gateway, installed, ['records_search']);
    assert.equal(selected.status, 200, await selected.clone().text());
  }
  const beforePortal = structuredClone(gateway.provider.state.portal);
  const beforeControl = gateway.managementStorage.snapshot(CONTROL_KEY);
  const rootReceipt = canonicalJson(gateway.storage.snapshot());
  await gateway.managementStorage.put(OAUTH_KEY, { sourceId: installed.source.id, actionId: installed.action.actionId });
  const baseline = gateway.provider.requests.length;
  const response = await removeSource(gateway, installed.source.id);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).sources.some((source) => source.id === installed.source.id), false);
  assert.deepEqual(gateway.provider.state.portal, beforePortal, 'the paused source was never attached');
  assert.deepEqual(gateway.managementStorage.snapshot(CONTROL_KEY), beforeControl);
  assert.equal(canonicalJson(gateway.storage.snapshot()), rootReceipt);
  assert.equal(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.some((action) => action.sourceId === installed.source.id), false);
  assert.equal(gateway.managementStorage.snapshot(OAUTH_KEY), null);
  assert.equal(gateway.provider.state.servers.has(installed.serverId), false);
  const writes = gateway.provider.requests.slice(baseline).filter((request) => request.method !== 'GET');
  assert.deepEqual(writes.map((request) => request.method), ['DELETE', 'DELETE', 'DELETE']);
  assert.equal((await resumeInstallation(gateway, installed)).status, 409, 'the old installation cannot restart');
}));

test('paused-source removal resumes without replaying a delete and blocks installation resumption', () => signInFixture(async (gateway) => {
  const installed = await installSignInSource(gateway);
  let intercepted = false;
  gateway.provider.hook(({ record, state }) => {
    if (!intercepted && record.method === 'DELETE' && record.pathname.endsWith(`/mcp/servers/${installed.serverId}`)) {
      intercepted = true;
      state.servers.delete(installed.serverId);
      return new Response(null, { status: 503 });
    }
  });
  const first = await removeSource(gateway, installed.source.id);
  assert.equal((await first.json()).error, 'source_removal_recovery_required');
  const removal = gateway.managementStorage.snapshot(SOURCE_REMOVAL_KEY);
  assert.notEqual(removal.actionId, installed.action.actionId);
  const baseline = gateway.provider.requests.length;
  assert.equal((await resumeInstallation(gateway, installed)).status, 409);
  assertNoMutation(gateway.provider, baseline);
  const resumed = await removeSource(gateway, installed.source.id);
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.equal(gateway.provider.requests.filter((request) => request.method === 'DELETE' &&
    request.pathname.endsWith(`/mcp/servers/${installed.serverId}`)).length, 1);
}));

for (const fault of ['pending-write', 'receipt-drift', 'source-drift', 'portal-drift', 'missing-token', 'other-actor', 'bridge']) {
  test(`paused-source removal retains its records on ${fault}`, () => signInFixture(async (gateway) => {
    const installed = await installSignInSource(gateway);
    const actions = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY);
    const action = actions.actions.at(-1);
    if (fault === 'pending-write') action.portalUpdate = { phase: 'send_armed', desiredHash: `sha256:${'a'.repeat(64)}` };
    if (fault === 'receipt-drift') action.resources[0].desiredHash = `sha256:${'b'.repeat(64)}`;
    if (fault === 'other-actor') action.actorEmail = 'different-admin@example.com';
    await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, actions);
    if (fault === 'source-drift') {
      const sources = gateway.managementStorage.snapshot(SOURCES_KEY);
      sources.sources.find((source) => source.id === installed.source.id).label = 'Changed elsewhere';
      await gateway.managementStorage.put(SOURCES_KEY, sources);
    }
    if (fault === 'portal-drift') gateway.provider.state.portal.servers.push({ id: installed.serverId, server_id: installed.serverId });
    if (fault === 'missing-token') delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
    if (fault === 'bridge') await gateway.managementStorage.put(`ankka-mcp-gateway/bigquery-source/v1/${installed.source.id}`, { retained: true });
    const before = gateway.managementStorage.snapshot(SOURCES_KEY);
    const baseline = gateway.provider.requests.length;
    const response = await removeSource(gateway, installed.source.id);
    assert.equal(response.status, 409, await response.clone().text());
    if (fault === 'pending-write') assert.equal((await response.json()).error, 'source_removal_requires_cleanup');
    assert.deepEqual(gateway.managementStorage.snapshot(SOURCES_KEY), before);
    assertNoMutation(gateway.provider, baseline);
    assert.equal(gateway.provider.state.servers.has(installed.serverId), true);
  }));
}

test('individual source removal deletes only its resources and preserves Team and full gateway teardown', async () => fixture(async (gateway) => {
  const originalReceipt = canonicalJson(gateway.storage.snapshot());
  const before = await gateway.view();
  const source = before.sources[0];
  const removed = await removeSource(gateway, source.id);
  assert.equal(removed.status, 200, await removed.clone().text());
  const sources = await removed.json();
  assert.deepEqual(sources.sources, []);
  assert.equal(sources.pendingRemoval, null);
  assert.deepEqual(gateway.provider.state.portal.servers, []);
  assert.equal(gateway.provider.state.servers.size, 0);
  assert.equal(gateway.provider.state.apps.size, 1);
  assert.deepEqual((await gateway.view()).members.map((member) => member.sourceIds), before.members.map(() => []));
  assert.equal(canonicalJson(gateway.storage.snapshot()), originalReceipt);
  assert.equal(gateway.managementStorage.snapshot(SOURCE_REMOVAL_KEY), null);
  assert.equal((await (await gateway.api('/api/status')).json()).source, null);
  const teardown = await gateway.currentTeardown();
  assert.equal(teardown.prepared.status, 200, await teardown.prepared.clone().text());
  const proof = await teardown.send('prove');
  assert.equal(proof.status, 200, await proof.clone().text());
  const applied = await teardown.send('apply');
  assert.equal(applied.status, 200, await applied.clone().text());
}));

test('individual source removal preserves other source mappings and allows reinstallation without old access', async () => fixture(async (gateway) => {
  const additional = await prepareNewSource(gateway);
  assert.equal((await gateway.apply(additional, {}, null)).status, 200);
  const initial = (await gateway.view()).sources.find((source) => source.id !== additional.source.id);
  const removed = await removeSource(gateway, initial.id);
  assert.equal(removed.status, 200, await removed.clone().text());
  const remaining = await removed.json();
  assert.deepEqual(remaining.sources.map((source) => source.id), [additional.source.id]);
  assert.equal(gateway.provider.state.portal.servers.length, 1);
  assert.equal((await gateway.view()).sources.length, 1);
  const removedAdditional = await removeSource(gateway, additional.source.id);
  assert.equal(removedAdditional.status, 200, await removedAdditional.clone().text());
  assert.equal((await gateway.view()).sources.length, 0);
  const newInstall = await prepareNewSource(gateway);
  assert.equal((await gateway.apply(newInstall, {}, null)).status, 200);
  assert.equal((await gateway.view()).members.every((member) => member.sourceIds.length === 0), true);
}));

test('individual source removal deletes an unstarted draft without a management token or provider write', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  assert.equal((await gateway.api(`/api/source-actions/${prepared.claim.actionId}`, { method: 'DELETE' })).status, 200);
  delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
  const baseline = gateway.provider.requests.length;
  const removed = await removeSource(gateway, prepared.source.id);
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal((await removed.json()).sources.some((source) => source.id === prepared.source.id), false);
  assertNoMutation(gateway.provider, baseline);
}));

for (const fault of ['portal', 'server', 'policy', 'application']) {
  test(`individual source removal resumes after a lost ${fault} response without replaying the successful write`, async () => fixture(async (gateway) => {
    let intercepted;
    gateway.provider.hook(({ record, state }) => {
      if (intercepted) return undefined;
      if (fault === 'portal' && record.method === 'PUT' && record.pathname.includes('/mcp/portals/')) {
        state.portal = { ...state.portal, ...structuredClone(record.body) };
      } else if (fault === 'server' && record.method === 'DELETE' && record.pathname.includes('/mcp/servers/')) {
        state.servers.delete(record.pathname.split('/').at(-1));
      } else if (fault === 'policy' && record.method === 'DELETE' && record.pathname.includes('/policies/')) {
        const appId = record.pathname.split('/').at(-3);
        state.policies.set(appId, []);
      } else if (fault === 'application' && record.method === 'DELETE' && /\/apps\/[^/]+$/u.test(record.pathname)) {
        const appId = record.pathname.split('/').at(-1);
        state.apps.delete(appId); state.policies.delete(appId);
      } else return undefined;
      intercepted = { pathname: record.pathname, method: record.method };
      throw new Error('synthetic-lost-response');
    });
    const first = await removeSource(gateway);
    assert.equal(first.status, 409, await first.clone().text());
    assert.ok(intercepted);
    assert.ok(gateway.managementStorage.snapshot(SOURCE_REMOVAL_KEY));
    const list = await (await gateway.api('/api/sources')).json();
    assert.equal(list.pendingRemoval.sourceId, list.sources[0].id);
    const snapshot = await (await gateway.api('/api/source-actions')).json();
    assert.equal(snapshot.blockingAction.kind, 'source_removal');
    const baseline = gateway.provider.requests.length;
    gateway.reloadManagement();
    gateway.provider.hook(undefined);
    const resumed = await removeSource(gateway);
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.equal(gateway.provider.requests.slice(baseline).some((record) =>
      record.pathname === intercepted.pathname && record.method === intercepted.method), false);
    assert.equal((await gateway.view()).sources.length, 0);
    for (const write of gateway.managementStorage.writes) {
      assert.equal(JSON.stringify(write).includes(gateway.env.ANKKA_MANAGEMENT_TOKEN), false);
    }
  }));
}

for (const drift of ['server', 'application', 'policy', 'foreign-policy', 'portal', 'foreign-portal']) {
  test(`individual source removal refuses ${drift} drift before any provider write`, async () => fixture(async (gateway) => {
    const sourceApp = app(gateway);
    if (drift === 'server') gateway.provider.state.server.description = 'foreign';
    if (drift === 'application') sourceApp.name = 'foreign';
    if (drift === 'policy') policy(gateway).name = 'foreign';
    if (drift === 'foreign-policy') gateway.provider.state.policies.get(sourceApp.id).push({ ...policy(gateway), id: 'foreign-policy' });
    if (drift === 'portal') gateway.provider.state.portal.name = 'foreign';
    if (drift === 'foreign-portal') gateway.provider.hook(({ record }) => {
      if (record.method !== 'GET') return undefined;
      if (record.pathname.endsWith('/mcp/portals')) return envelope([{ id: gateway.provider.state.portal.id }, { id: 'foreign' }]);
      if (record.pathname.endsWith('/mcp/portals/foreign')) return envelope({ id: 'foreign', servers: gateway.provider.state.portal.servers });
      return undefined;
    });
    const baseline = gateway.provider.requests.length;
    const result = await removeSource(gateway);
    assert.equal(result.status, 409, await result.clone().text());
    assert.equal((await result.json()).error, 'source_removal_ownership_conflict');
    assertNoMutation(gateway.provider, baseline);
    assert.equal(gateway.managementStorage.snapshot(SOURCE_REMOVAL_KEY), undefined);
  }));
}

test('individual source removal rejects stale revisions, non-admins, cross-origin writes and extra authority', async () => fixture(async (gateway) => {
  const baseline = gateway.provider.requests.length;
  for (const [options, status] of [
    [{ body: { schemaVersion: 1, revision: 999 } }, 409],
    [{ email: MEMBER }, 401],
    [{ extraHeaders: { origin: 'https://foreign.example.com' } }, 403],
    [{ body: { schemaVersion: 1, revision: 1, providerId: 'foreign' } }, 400],
  ]) {
    const response = await removeSource(gateway, undefined, options);
    assert.equal(response.status, status, await response.clone().text());
  }
  assertNoMutation(gateway.provider, baseline);
}));

test('individual source removal retains managed BigQuery receipts even without a retained source action', async () => fixture(async (gateway) => {
  const baseline = gateway.provider.requests.length;
  const sources = await (await gateway.api('/api/sources')).json();
  const sourceId = sources.sources[0].id;
  await gateway.managementStorage.put(`ankka-mcp-gateway/bigquery-source/v1/${sourceId}`, { synthetic: 'retained receipt' });
  const bridge = await removeSource(gateway, sourceId);
  assert.equal((await bridge.json()).error, 'source_removal_managed_bigquery');
  assertNoMutation(gateway.provider, baseline);
}));

test('individual source removal requires a token for installed sources', async () => fixture(async (gateway) => {
  delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
  const baseline = gateway.provider.requests.length;
  const result = await removeSource(gateway);
  assert.equal((await result.json()).error, 'source_removal_credential_required');
  assertNoMutation(gateway.provider, baseline);
}));

test('individual source removal refuses corrupt progress and pending source authorization', async () => fixture(async (gateway) => {
  const prepared = await prepareNewSource(gateway);
  const baseline = gateway.provider.requests.length;
  const blocked = await removeSource(gateway);
  assert.equal((await blocked.json()).error, 'source_removal_action_conflict');
  await gateway.managementStorage.put(SOURCE_REMOVAL_KEY, { sourceId: prepared.source.id });
  const invalid = await gateway.api(`/api/sources/${prepared.source.id}`, { method: 'DELETE', body: {
    schemaVersion: 1, revision: prepared.sources.revision,
  } });
  assert.equal((await invalid.json()).error, 'source_removal_unavailable');
  assertNoMutation(gateway.provider, baseline);
}));

test('individual source removal locks source, Team, credential and gateway mutations until resumed', async () => fixture(async (gateway) => {
  const team = await gateway.view();
  gateway.provider.hook(({ record }) => record.method === 'PUT' && record.pathname.includes('/mcp/portals/')
    ? envelope(null, 503) : undefined);
  assert.equal((await removeSource(gateway)).status, 409);
  gateway.provider.hook(undefined);
  const sources = await (await gateway.api('/api/sources')).json();
  const baseline = gateway.provider.requests.length;
  const sourceSave = await gateway.api('/api/sources', { method: 'PUT', body: { schemaVersion: 1,
    revision: sources.revision, source: { label: 'Another source', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: ['company_lookup'] } } });
  assert.equal(sourceSave.status, 409);
  const teamSave = await gateway.api('/api/team-actions', { method: 'POST', body: {
    schemaVersion: 1, expectedRevision: team.revision, members: team.members,
  } });
  assert.equal(teamSave.status, 409);
  const teardown = await gateway.currentTeardown();
  assert.equal(teardown.prepared.status, 409);
  const credential = await gateway.api('/api/management-credential/actions', { method: 'POST', body: { schemaVersion: 1 } });
  assert.equal(credential.status, 409);
  assertNoMutation(gateway.provider, baseline);
  const resumed = await removeSource(gateway);
  assert.equal(resumed.status, 200, await resumed.clone().text());
}));

test('individual source removal checks a foreign application policy introduced after preflight', async () => fixture(async (gateway) => {
  const sourceApp = app(gateway);
  gateway.provider.hook(({ record, state }) => {
    if (record.method === 'DELETE' && record.pathname.includes('/mcp/servers/')) {
      state.policies.get(sourceApp.id).push({ id: 'foreign-policy', decision: 'allow', include: [] });
    }
  });
  const result = await removeSource(gateway);
  assert.equal(result.status, 409, await result.clone().text());
  assert.equal(gateway.provider.state.apps.has(sourceApp.id), true);
  assert.equal(gateway.provider.state.policies.get(sourceApp.id).some((entry) => entry.id === 'foreign-policy'), true);
  assert.equal(gateway.managementStorage.snapshot(SOURCES_KEY).sources.length, 1);
}));

test('individual source removal leaves an asynchronously accepted delete pending until absence is verified', async () => fixture(async (gateway) => {
  gateway.provider.hook(({ record }) => record.method === 'DELETE' && record.pathname.includes('/policies/')
    ? new Response(null, { status: 202 }) : undefined);
  const first = await removeSource(gateway);
  assert.equal(first.status, 409, await first.clone().text());
  assert.equal(gateway.managementStorage.snapshot(SOURCES_KEY).sources.length, 1);
  assert.equal(gateway.managementStorage.snapshot(SOURCE_REMOVAL_KEY).step, 2);
  assert.equal(gateway.managementStorage.snapshot(SOURCE_REMOVAL_KEY).pending, true);
  gateway.provider.hook(undefined);
  assert.equal((await removeSource(gateway)).status, 200);
}));

test('individual source removal atomically commits after an interrupted final storage write', async () => fixture(async (gateway) => {
  const put = gateway.managementStorage.put.bind(gateway.managementStorage);
  let injected = false;
  gateway.managementStorage.put = async (key, value) => {
    if (!injected && key?.[SOURCE_REMOVAL_KEY] === null) {
      injected = true;
      throw new Error('synthetic-atomic-storage-failure');
    }
    return put(key, value);
  };
  const first = await removeSource(gateway);
  assert.equal(first.status, 409);
  assert.equal(injected, true);
  assert.equal(gateway.managementStorage.snapshot(SOURCE_REMOVAL_KEY).step, 4);
  assert.equal(gateway.managementStorage.snapshot(SOURCES_KEY).sources.length, 1);
  gateway.reloadManagement();
  const baseline = gateway.provider.requests.length;
  const resumed = await removeSource(gateway);
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assertNoMutation(gateway.provider, baseline);
  assert.equal((await gateway.view()).sources.length, 0);
}));

test('individual source removal refuses a resource recreated after a verified deletion', async () => fixture(async (gateway) => {
  const server = structuredClone(gateway.provider.state.server);
  gateway.provider.hook(({ record }) => record.method === 'DELETE' && record.pathname.includes('/policies/') ? envelope(null, 503) : undefined);
  assert.equal((await removeSource(gateway)).status, 409);
  gateway.provider.hook(undefined);
  gateway.provider.state.servers.set(server.id, server);
  const baseline = gateway.provider.requests.length;
  const resumed = await removeSource(gateway);
  assert.equal(resumed.status, 409);
  assertNoMutation(gateway.provider, baseline);
  assert.equal(gateway.provider.state.servers.has(server.id), true);
}));

const MANAGEMENT_ID = 'source-616e6b6b616d6370';
const MANAGEMENT_AUDIENCE = 'synthetic-management-source-audience';

test('API source management is always advertised and requires live assignment and an exact tool allowlist', () => fixture(async (gateway) => {
  const seen = [];
  gateway.env.API_SOURCE_RUNTIME = { fetch: async (request) => {
    assert.equal(request.url, 'https://api-source-runtime.invalid/manage');
    assert.deepEqual([...request.headers.keys()], ['content-type']);
    const command = await request.json();
    seen.push(command);
    return Response.json({ revision: 2, operation: command.operation });
  } };
  await installManagementSource(gateway, ['get_api_source_runtime', 'save_api_source_draft']);
  const listed = await managementRpc(gateway, 'tools/list', {});
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ['get_api_source_runtime', 'save_api_source_draft']);
  const definitionJson = '{\n"label":"Synthetic API",\n"tools":[]\n}';
  const saved = await managementRpc(gateway, 'tools/call', { name: 'save_api_source_draft', arguments: { connectionKey: 'inventory', revision: 1, definitionJson } });
  assert.equal(saved.body.result.structuredContent.ok, true);
  assert.deepEqual(seen, [{ operation: 'save', connectionKey: 'inventory', revision: 1, definitionJson }]);
  assert.equal((await managementRpc(gateway, 'tools/call', { name: 'activate_api_source', arguments: { revision: 2 } })).body.error.code, -32602);
  assert.equal((await managementRpc(gateway, 'tools/call', { name: 'get_api_source_runtime' }, { email: MEMBER })).response.status, 401);
  delete gateway.env.API_SOURCE_RUNTIME;
  assert.equal((await managementRpc(gateway, 'tools/list', {})).body.result.tools.length, 2);
  assert.equal((await managementRpc(gateway, 'tools/call', { name: 'get_api_source_runtime' })).body.result.structuredContent.ok, false);
  assert.equal(seen.length, 1);
}));

async function installManagementSource(gateway, enabledTools = null, recover = null) {
  const discovery = await (await gateway.api('/api/sources/discover', { method: 'POST', body: { url: `${MANAGEMENT_ORIGIN}/api/mcp` } })).json();
  assert.ok(discovery.tools.length > 10);
  const current = await (await gateway.api('/api/sources')).json();
  const savedResponse = await gateway.api('/api/sources', { method: 'PUT', body: {
    schemaVersion: 1, revision: current.revision,
    source: { label: 'Gateway Management', url: `${MANAGEMENT_ORIGIN}/api/mcp`, authMode: 'oauth',
      enabledTools: enabledTools ?? discovery.tools.map((tool) => tool.name).sort() },
  } });
  assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
  const saved = await savedResponse.json();
  const source = saved.sources.find((item) => item.id === MANAGEMENT_ID);
  assert.equal(source.onBehalfOfUser, true);
  assert.equal(Object.hasOwn(source, 'initialManager'), false);
  assert.equal(gateway.managementStorage.snapshot(SOURCES_KEY).sources.find((item) => item.id === MANAGEMENT_ID).initialManager, ADMIN);
  const begun = await gateway.api('/api/source-actions', { method: 'POST', body: {
    schemaVersion: 1, revision: saved.revision, sourceId: source.id,
  } });
  assert.equal(begun.status, 409, await begun.clone().text());
  const actions = await (await gateway.api('/api/source-actions')).json();
  const action = actions.actions.find((item) => item.sourceId === source.id);
  assert.equal(action.state, 'recovery_required');
  if (recover) await recover({ action, source, saved });
  const server = [...gateway.provider.state.servers.values()].find((item) => item.hostname === source.url);
  assert.ok(server, await begun.clone().text());
  server.tools = discovery.tools.map((tool) => ({ name: tool.name }));
  server.status = 'ready';
  server.authentication_status = 'authenticated';
  const application = [...gateway.provider.state.apps.values()].find((item) => item.domain === 'manage.example.com/api/mcp');
  assert.ok(application);
  application.aud = MANAGEMENT_AUDIENCE;
  assert.equal(application.oauth_configuration.enabled, true);
  assert.deepEqual(application.oauth_configuration.dynamic_client_registration.allowed_uris, [
    'https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/*', 'https://www.cursor.com/agents/mcp/oauth/callback',
    `${MANAGEMENT_ORIGIN}/__ankka/source-oauth/callback`,
    `https://dash.cloudflare.com/${ACCOUNT_ID}/one/access-controls/ai-controls/mcp-server/oauth-callback/${server.id}`,
    'https://oauth-callbacks.cloudflareaccess.com/cdn-cgi/access/outbound-oauth-callback',
  ]);
  // Browser consent and protocol routes must reach the Worker instead of the
  // dashboard's SPA fallback under the exact signed deployment contract.
  for (const destination of application.destinations.filter((entry) => entry.type === 'public')) {
    const path = new URL(`https://${destination.uri}`).pathname;
    assert.ok(APPROVED_CLOUDFLARE_CONTRACT.assets.runWorkerFirst.some((pattern) =>
      pattern.endsWith('*') && path.startsWith(pattern.slice(0, -1))), path);
  }

  assert.equal(application.type, 'self_hosted');
  const portalApplication = [...gateway.provider.state.apps.values()].find((item) =>
    item.destinations?.some((entry) => entry.mcp_server_id === server.id));
  assert.equal(portalApplication.type, 'mcp');
  assert.deepEqual(portalApplication.destinations, [{ type: 'via_mcp_server_portal', mcp_server_id: server.id }]);
  assert.equal(portalApplication.domain, undefined);
  assert.deepEqual(application.destinations, [
    { type: 'public', uri: 'manage.example.com/api/mcp' },
    { type: 'public', uri: 'manage.example.com/__ankka/operation' },
    { type: 'public', uri: 'manage.example.com/__ankka/install/oauth/callback' }]);
  const resumed = await gateway.api(`/api/source-actions/${action.actionId}/renew`, { method: 'POST', body: {
    schemaVersion: 1, revision: saved.revision, sourceId: source.id,
  } });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  await dashboardClient(gateway, async (dashboard) => {
    const installed = (await dashboard.getSources()).sources.find((item) => item.id === MANAGEMENT_ID);
    assert.equal(installed.status, 'installed');
    assert.equal(Object.hasOwn(installed, 'initialManager'), false);
  });
  return { source, application, portalApplication, server };
}

async function managementRpc(gateway, method, params, { email = ADMIN, audience = MANAGEMENT_AUDIENCE, extraHeaders = {} } = {}) {
  const response = await worker.fetch(new Request(`${MANAGEMENT_ORIGIN}/api/mcp`, {
    method: 'POST', headers: { ...await gateway.headers(email, audience), ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), gateway.env);
  return { response, body: await response.json() };
}

test('Gateway Management installs as an ordinary assigned source with its own protected origin', () => fixture(async (gateway) => {
  const { source, server } = await installManagementSource(gateway);
  const teamResponse = await gateway.api('/api/team');
  assert.equal(teamResponse.status, 200, await teamResponse.clone().text());
  const team = await teamResponse.json();
  assert.ok(team.members.find((item) => item.email === ADMIN).sourceIds.includes(source.id));
  assert.ok(team.members.filter((item) => item.email !== ADMIN).every((item) => !item.sourceIds.includes(source.id)));
  const portal = gateway.provider.state.portal;
  assert.equal(portal.servers.find((entry) => entry.server_id === server.id).on_behalf, true);
  const initialized = await managementRpc(gateway, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
  assert.equal(initialized.response.status, 200);
  assert.equal(initialized.body.result.serverInfo.name, 'ankka-gateway-management');
  const listed = await managementRpc(gateway, 'tools/list', {});
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'save_gateway_team' && tool.annotations.readOnlyHint === false));
  const status = await managementRpc(gateway, 'tools/call', { name: 'get_gateway_status', arguments: {} });
  assert.equal(status.body.result.structuredContent.ok, true);
  assert.equal(JSON.stringify(status.body).includes(gateway.env.ANKKA_MANAGEMENT_TOKEN), false);
}));

test('management source assignment authorizes a non-administrator and live removal rejects the same token', () => fixture(async (gateway) => {
  const { source } = await installManagementSource(gateway);
  let team = await (await gateway.api('/api/team')).json();
  const member = team.members.find((item) => item.email === MEMBER);
  assert.ok(member);
  member.sourceIds.push(source.id);
  member.sourceIds.sort();
  const assigned = await gateway.api('/api/team-actions', { method: 'POST', body: {
    schemaVersion: 1, expectedRevision: team.revision, members: team.members,
  } });
  assert.equal(assigned.status, 200, await assigned.clone().text());
  const read = await managementRpc(gateway, 'tools/call', { name: 'get_gateway_team', arguments: {} }, { email: MEMBER });
  assert.equal(read.body.result.structuredContent.ok, true);
  team = read.body.result.structuredContent.result;
  const change = await managementRpc(gateway, 'tools/call', { name: 'save_gateway_team', arguments: {
    expectedRevision: team.revision, members: [...team.members, { email: NEW_PERSON, sourceIds: [] }],
  } }, { email: MEMBER });
  assert.equal(change.body.result.structuredContent.ok, true, JSON.stringify(change.body));
  team = await (await gateway.api('/api/team')).json();
  team.members.find((item) => item.email === MEMBER).sourceIds = [];
  assert.equal((await gateway.api('/api/team-actions', { method: 'POST', body: {
    schemaVersion: 1, expectedRevision: team.revision, members: team.members,
  } })).status, 200);
  const denied = await managementRpc(gateway, 'tools/call', { name: 'get_gateway_status', arguments: {} }, { email: MEMBER });
  assert.equal(denied.response.status, 401);
}));

test('management MCP rejects unassigned callers, other audiences, drift, cross-origin requests and arbitrary tools', () => fixture(async (gateway) => {
  const { application } = await installManagementSource(gateway);
  for (const options of [{ email: MEMBER }, { audience: gateway.env.CF_ACCESS_AUD },
    { extraHeaders: { 'cf-access-authenticated-user-email': MEMBER } }]) {
    const result = await managementRpc(gateway, 'tools/call', { name: 'get_gateway_status', arguments: {} }, options);
    assert.equal(result.response.status, 401);
  }
  const cross = await managementRpc(gateway, 'tools/list', {}, { extraHeaders: { origin: 'https://foreign.example.net' } });
  assert.equal(cross.response.status, 403);
  const before = gateway.provider.requests.length;
  for (const params of [{ name: 'fetch', arguments: { url: 'https://foreign.example.net' } },
    { name: 'save_gateway_team', arguments: { accountId: ACCOUNT_ID } },
    { name: 'get_gateway_status', arguments: { authorization: 'synthetic-never-reflected' } }]) {
    const invalid = await managementRpc(gateway, 'tools/call', params);
    assert.equal(invalid.body.error.code, -32602);
    assert.equal(JSON.stringify(invalid.body).includes('synthetic-never-reflected'), false);
  }
  assertNoMutation(gateway.provider, before);
  application.destinations.push({ type: 'public', uri: 'foreign.example.net/mcp' });
  assert.equal((await managementRpc(gateway, 'tools/list', {})).response.status, 401);
}));

test('management MCP hands provider consent to the browser and reads sanitized registration diagnostics', () => sourceOauthFixture(async (gateway) => {
  const actionId = gateway.installed.action.actionId;
  const prepared = await managementRpc(gateway, 'tools/call', { name: 'authorize_mcp_source', arguments: { actionId } });
  const handoff = prepared.body.result.structuredContent.result;
  assert.equal(handoff.status, 'user_authorization_required');
  assert.equal(gateway.registrations.length, 0);
  const headers = await gateway.headers(ADMIN, MANAGEMENT_AUDIENCE);
  const page = await worker.fetch(new Request(handoff.authorizationUrl, { headers }), gateway.env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Continue to provider/u);
  gateway.oauthHook((request) => request.url.endsWith('/register')
    ? Response.json({ error: 'synthetic-provider-detail-never-reflected' }, { status: 400 }) : undefined);
  const failed = await worker.fetch(new Request(handoff.authorizationUrl, { method: 'POST', headers }), gateway.env);
  assert.equal(failed.status, 409);
  const diagnostic = await managementRpc(gateway, 'tools/call', { name: 'diagnose_mcp_source', arguments: { sourceId: gateway.installed.source.id } });
  assert.deepEqual(diagnostic.body.result.structuredContent.result.authorization, {
    stage: 'client_registration', httpStatus: 400, status: 'failed',
    at: diagnostic.body.result.structuredContent.result.authorization.at,
  });
  assert.equal(JSON.stringify(diagnostic.body).includes('synthetic-provider-detail-never-reflected'), false);
  gateway.oauthHook(undefined);
  const started = await worker.fetch(new Request(handoff.authorizationUrl, { method: 'POST', headers }), gateway.env);
  assert.equal(started.status, 303, await started.clone().text());
  const authorization = new URL(started.headers.get('location'));
  assert.equal(authorization.searchParams.get('redirect_uri'), `${MANAGEMENT_ORIGIN}/api/mcp/oauth/callback`);
  const callback = new URL(`${MANAGEMENT_ORIGIN}/api/mcp/oauth/callback`);
  callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'synthetic-authorization-code', iss: OAUTH_ISSUER });
  const finished = await worker.fetch(new Request(callback, { headers: { ...headers,
    cookie: started.headers.get('set-cookie').split(';')[0] } }), gateway.env);
  assert.equal(finished.headers.get('location'), `${MANAGEMENT_ORIGIN}/api/mcp/result?source_oauth=connected`);
  assert.equal(gateway.exchanges.length, 1);
  assert.equal(gateway.imports.length, 1);
  const evidence = JSON.stringify([prepared.body, diagnostic.body, gateway.managementStorage.writes]);
  assert.equal(evidence.includes(gateway.accessToken), false);
  assert.equal(evidence.includes(gateway.refreshToken), false);
}, installManagementSource));

test('management source remains usable after completed installation actions leave the bounded journal', () => fixture(async (gateway) => {
  await installManagementSource(gateway);
  await gateway.managementStorage.put(SOURCE_ACTIONS_KEY, { schemaVersion: 1, revision: 99, actions: [] });
  const result = await managementRpc(gateway, 'tools/call', { name: 'get_gateway_status', arguments: {} });
  assert.equal(result.body.result.structuredContent.ok, true);
}));


test('assigned managers can finish lifecycle consent but do not gain dashboard or credential APIs', () => fixture(async (gateway) => {
  const { application, portalApplication } = await installManagementSource(gateway);
  for (const app of [application, portalApplication]) {
    const policy = gateway.provider.state.policies.get(app.id)[0];
    if (!policy.include.some((entry) => entry.email?.email === MEMBER)) policy.include.push({ email: { email: MEMBER } });
  }
  const headers = await gateway.headers(MEMBER, MANAGEMENT_AUDIENCE);
  for (const path of ['/__ankka/operation', '/__ankka/operation/oauth/start', '/__ankka/install/oauth/callback']) {
    assert.equal(await verifyAccess(new Request(`${MANAGEMENT_ORIGIN}${path}`, { headers }), gateway.env), MEMBER);
  }
  for (const path of ['/api/bigquery', '/api/management-credential/status']) {
    assert.equal(await verifyAccess(new Request(`${MANAGEMENT_ORIGIN}${path}`, { headers }), gateway.env), false);
  }
  assert.equal(await verifyAccess(new Request(`${MANAGEMENT_ORIGIN}/__ankka/operation`, { headers }), {}), false);
  gateway.provider.state.policies.get(portalApplication.id)[0].include = [{ email: { email: ADMIN } }];
  assert.equal(await verifyAccess(new Request(`${MANAGEMENT_ORIGIN}/__ankka/operation`, { headers }), gateway.env), false);
}));

test('management tool allowlists restrict discovery and execution, including direct calls', () => fixture(async (gateway) => {
  await installManagementSource(gateway, ['get_gateway_status']);
  const listed = await managementRpc(gateway, 'tools/list', {});
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ['get_gateway_status']);
  const before = gateway.provider.requests.length;
  const denied = await managementRpc(gateway, 'tools/call', { name: 'save_gateway_team', arguments: { expectedRevision: 1, members: [] } });
  assert.equal(denied.body.error.code, -32602);
  assertNoMutation(gateway.provider, before);
  assert.equal((await managementRpc(gateway, 'tools/call', { name: 'get_gateway_status', arguments: {} })).body.result.structuredContent.ok, true);
}));

test('management MCP creates, applies and removes a URL source through the shared journal', () => fixture(async (gateway) => {
  await installManagementSource(gateway);
  const call = async (name, args = {}) => {
    const result = await managementRpc(gateway, 'tools/call', { name, arguments: args });
    assert.equal(result.body.result.structuredContent.ok, true, JSON.stringify(result.body));
    return result.body.result.structuredContent.result;
  };
  const sources = await call('list_mcp_sources');
  const saved = await call('save_mcp_source_draft', { revision: sources.revision, source: {
    label: 'Synthetic extra source', url: NEW_SOURCE_URL, authMode: 'none', enabledTools: ['company_lookup'],
  } });
  const source = saved.sources.find((item) => item.url === NEW_SOURCE_URL);
  await call('apply_mcp_source', { revision: saved.revision, sourceId: source.id });
  const installed = await call('list_mcp_sources');
  assert.equal(installed.sources.find((item) => item.id === source.id).status, 'installed');
  await call('remove_mcp_source', { revision: installed.revision, sourceId: source.id });
  assert.equal((await call('list_mcp_sources')).sources.some((item) => item.id === source.id), false);
}));

test('management MCP can remove its own ordinary source and then denies the same caller', () => fixture(async (gateway) => {
  const { application, portalApplication, server } = await installManagementSource(gateway);
  const current = await (await gateway.api('/api/sources')).json();
  const removal = await managementRpc(gateway, 'tools/call', { name: 'remove_mcp_source', arguments: {
    revision: current.revision, sourceId: MANAGEMENT_ID,
  } });
  assert.equal(removal.body.result.structuredContent.ok, true, JSON.stringify(removal.body));
  assert.equal(gateway.provider.state.apps.has(application.id), false);
  assert.equal(gateway.provider.state.apps.has(portalApplication.id), false);
  assert.equal(gateway.provider.state.servers.has(server.id), false);
  assert.equal((await managementRpc(gateway, 'tools/list', {})).response.status, 401);
}));

test('management MCP does not expose gateway deletion before its browser recovery path is qualified', () => fixture(async (gateway) => {
  await installManagementSource(gateway);
  const result = await managementRpc(gateway, 'tools/call', { name: 'review_gateway_teardown', arguments: {} });
  assert.equal(result.body.error.code, -32602);
}));


test('management rollback binds consent preparation to the reviewed release and digest', () => fixture(async (gateway) => {
  await installManagementSource(gateway);
  await runtimeAction(gateway, { release: gateway.env.ANKKA_GATEWAY_RELEASE });
  const review = await managementRpc(gateway, 'tools/call', { name: 'review_gateway_update', arguments: {} });
  const target = review.body.result.structuredContent.result.rollback;
  assert.equal(target.available, true);
  const args = { approvedRelease: target.release, approvedArtifactSha256: `sha256:${'7'.repeat(64)}` };
  const before = gateway.provider.requests.length;
  const refused = await managementRpc(gateway, 'tools/call', { name: 'rollback_gateway_update', arguments: args });
  assert.equal(refused.body.result.structuredContent.error.code, 'runtime_action_conflict');
  const prepared = await managementRpc(gateway, 'tools/call', { name: 'rollback_gateway_update', arguments: {
    ...args, approvedArtifactSha256: target.artifactSha256,
  } });
  assert.equal(prepared.body.result.structuredContent.ok, true, JSON.stringify(prepared.body));
  const handoff = prepared.body.result.structuredContent.result;
  assert.equal(handoff.status, 'user_authorization_required');
  assert.equal(new URL(handoff.handoffUrl).origin, MANAGEMENT_ORIGIN);
  assertNoMutation(gateway.provider, before);
}));

for (const accountLookup of ['available', 'unavailable', 'collision']) {
  test(`management installation recovers an unacknowledged application only after authoritative lookup (${accountLookup})`, () => fixture(async (gateway) => {
    let rejected = false;
    gateway.provider.hook(({ record }) => {
      if (!rejected && record.method === 'POST' && record.pathname.endsWith('/access/apps') && record.body.type === 'mcp') {
        rejected = true;
        return envelope(null, 400);
      }
    });
    await installManagementSource(gateway, null, async ({ action, source, saved }) => {
      const journal = gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.find((entry) => entry.actionId === action.actionId);
      assert.equal(journal.resources.length, 1);
      assert.equal(journal.pending.kind, 'source_access_application');
      assert.equal(journal.pending.provider, null);
      await expireSourceAction(gateway, action.actionId);
      gateway.reloadManagement();
      const renew = () => gateway.api(`/api/source-actions/${action.actionId}/renew`, { method: 'POST', body: {
        schemaVersion: 1, revision: saved.revision, sourceId: source.id,
      } });
      const accountPath = `/client/v4/accounts/${ACCOUNT_ID}/access/apps`;
      if (accountLookup !== 'available') {
        gateway.provider.hook(({ record }) => {
          if (record.method !== 'GET' || record.pathname !== accountPath) return undefined;
          if (accountLookup === 'unavailable') return envelope(null, 403);
          const attempt = gateway.provider.requests.findLast((entry) => entry.method === 'POST' && entry.body?.type === 'mcp');
          return envelope([{ ...attempt.body, id: 'synthetic-foreign-app', destinations: [] }]);
        });
        const baseline = gateway.provider.requests.length;
        assert.equal((await renew()).status, 409);
        assertNoMutation(gateway.provider, baseline);
        assert.equal(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.find((entry) => entry.actionId === action.actionId).pending.provider, null);
        await expireSourceAction(gateway, action.actionId);
      }
      gateway.provider.hook(undefined);
      const baseline = gateway.provider.requests.length;
      assert.equal((await renew()).status, 409, 'waits for OAuth after provisioning');
      const requests = gateway.provider.requests.slice(baseline);
      const listed = requests.findIndex((entry) => entry.method === 'GET' && entry.pathname === accountPath);
      const created = requests.findIndex((entry) => entry.method === 'POST');
      assert.ok(listed >= 0 && created > listed);
      assert.equal(gateway.managementStorage.snapshot(SOURCE_ACTIONS_KEY).actions.find((entry) => entry.actionId === action.actionId).resources.length, 5);
      gateway.reloadManagement();
    });
    assert.equal((await managementRpc(gateway, 'tools/list', {})).response.status, 200);
  }));
}

test('removing the administrator management assignment retains browser recovery but revokes MCP authority', () => fixture(async (gateway) => {
  const { application, portalApplication } = await installManagementSource(gateway);
  const team = await gateway.view();
  team.members.find((member) => member.email === ADMIN).sourceIds = [];
  const saved = await gateway.api('/api/team-actions', { method: 'POST', body: {
    schemaVersion: 1, expectedRevision: team.revision, members: team.members,
  } });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.ok(gateway.provider.state.policies.get(application.id)[0].include.some((entry) => entry.email?.email === ADMIN));
  assert.ok(!gateway.provider.state.policies.get(portalApplication.id)[0].include.some((entry) => entry.email?.email === ADMIN));
  assert.equal((await managementRpc(gateway, 'tools/list', {})).response.status, 401);
  const headers = await gateway.headers(ADMIN, MANAGEMENT_AUDIENCE);
  assert.equal(await verifyAccess(new Request(`${MANAGEMENT_ORIGIN}/__ankka/operation`, { headers }), gateway.env), ADMIN);
  gateway.reloadManagement();
  assert.equal((await gateway.api('/api/team')).status, 200);
}));

test('management assignment synchronizes both policies and resumes an interrupted authentication policy update', () => fixture(async (gateway) => {
  const { source, application, portalApplication } = await installManagementSource(gateway);
  const team = await gateway.view();
  const input = { schemaVersion: 1, expectedRevision: team.revision,
    members: [...team.members, { email: NEW_PERSON, sourceIds: [source.id] }] };
  gateway.provider.hook(({ record }) => record.method === 'PUT' && record.pathname.includes(`/apps/${application.id}/policies/`)
    ? envelope(null, 503) : undefined);
  assert.equal((await gateway.api('/api/team-actions', { method: 'POST', body: input })).status, 409);
  assert.ok(gateway.provider.state.policies.get(portalApplication.id)[0].include.some((entry) => entry.email?.email === NEW_PERSON));
  assert.ok(!gateway.provider.state.policies.get(application.id)[0].include.some((entry) => entry.email?.email === NEW_PERSON));
  assert.equal((await managementRpc(gateway, 'tools/list', {}, { email: NEW_PERSON })).response.status, 401);
  gateway.reloadManagement();
  gateway.provider.hook(undefined);
  const resumed = await gateway.api('/api/team-actions', { method: 'POST', body: input });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.ok(gateway.provider.state.policies.get(application.id)[0].include.some((entry) => entry.email?.email === NEW_PERSON));
  assert.equal((await managementRpc(gateway, 'tools/list', {}, { email: NEW_PERSON })).response.status, 200);
  const current = await gateway.view();
  const revoked = await gateway.api('/api/team-actions', { method: 'POST', body: {
    schemaVersion: 1, expectedRevision: current.revision,
    members: current.members.filter((member) => member.email !== NEW_PERSON),
  } });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  for (const app of [application, portalApplication]) {
    assert.ok(!gateway.provider.state.policies.get(app.id)[0].include.some((entry) => entry.email?.email === NEW_PERSON));
  }
  assert.equal((await managementRpc(gateway, 'tools/list', {}, { email: NEW_PERSON })).response.status, 401);
}));

test('built-in API sources install, isolate data access, update Team policies and remove with normal receipts', () => fixture(async (gateway) => {
  const endpoint = `${MANAGEMENT_ORIGIN}/api/api-sources/inventory/mcp`;
  const tool = { name: 'getStock', description: 'Read stock.', inputSchema: { type: 'object' } };
  const invoked = [];
  gateway.env.API_SOURCE_RUNTIME = { fetch: async (request) => {
    const command = await request.json();
    invoked.push(command);
    return Response.json(command.operation === 'catalogue' ? [tool] : { ok: true, result: { quantity: 7 } });
  } };
  const current = await (await gateway.api('/api/sources')).json();
  const savedResponse = await gateway.api('/api/sources', { method: 'PUT', body: {
    schemaVersion: 1, revision: current.revision,
    source: { label: 'Inventory', url: endpoint, authMode: 'oauth', enabledTools: ['getStock'] },
  } });
  assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
  const saved = await savedResponse.json();
  const source = saved.sources.find((item) => item.url === endpoint);
  assert.match(source.id, /^source-a9[a-f0-9]{14}$/);
  assert.equal(source.onBehalfOfUser, true);
  const started = await gateway.api('/api/source-actions', { method: 'POST', body: {
    schemaVersion: 1, revision: saved.revision, sourceId: source.id,
  } });
  assert.equal(started.status, 409, await started.clone().text());
  const action = (await (await gateway.api('/api/source-actions')).json()).actions.find((entry) => entry.sourceId === source.id);
  const server = [...gateway.provider.state.servers.values()].find((entry) => entry.hostname === endpoint);
  assert.ok(server);
  server.tools = [{ name: 'getStock' }]; server.status = 'ready'; server.authentication_status = 'authenticated';
  const native = [...gateway.provider.state.apps.values()].find((entry) => entry.domain === 'manage.example.com/api/api-sources/inventory/mcp');
  assert.ok(native);
  native.aud = 'synthetic-inventory-audience';
  assert.deepEqual(native.destinations, [{ type: 'public', uri: 'manage.example.com/api/api-sources/inventory/mcp' }]);
  const rpc = async (method, params = {}, email = MEMBER, audience = native.aud) => {
    const response = await worker.fetch(new Request(endpoint, { method: 'POST',
      headers: await gateway.headers(email, audience), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }), gateway.env);
    return { status: response.status, body: await response.json() };
  };
  // Draft catalogue is available to the administrator for Portal synchronization, never tool execution.
  assert.equal((await rpc('tools/list', {}, ADMIN)).status, 200);
  assert.equal((await rpc('tools/call', { name: 'getStock' }, ADMIN)).status, 401);
  const resumed = await gateway.api(`/api/source-actions/${action.actionId}/renew`, { method: 'POST', body: {
    schemaVersion: 1, revision: saved.revision, sourceId: source.id,
  } });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.equal((await rpc('tools/call', { name: 'getStock' })).status, 401);
  const team = await gateway.view();
  assert.ok(team);
  const change = async (members) => gateway.api('/api/team-actions', { method: 'POST', body: {
    schemaVersion: 1, expectedRevision: (await gateway.view()).revision, members,
  } });
  const assigned = await change(team.members.map((member) => ({ ...member,
    sourceIds: member.email === MEMBER ? [...member.sourceIds, source.id].sort() : member.sourceIds,
  })));
  assert.equal(assigned.status, 200, await assigned.clone().text());
  assert.equal((await rpc('tools/call', { name: 'getStock', arguments: {} })).body.result.isError, false);
  assert.equal((await rpc('tools/call', { name: 'save_api_source_draft' })).body.error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'getStock' }, MEMBER, MANAGEMENT_AUDIENCE)).status, 401);
  assert.equal((await managementRpc(gateway, 'tools/list', {}, { email: MEMBER, audience: native.aud })).response.status, 401);
  assert.ok(invoked.some((command) => command.operation === 'call' && command.connectionKey === 'inventory'));
  const revoked = await gateway.view();
  assert.equal((await change(revoked.members.map((member) => ({ ...member,
    sourceIds: member.sourceIds.filter((id) => id !== source.id),
  })))).status, 200);
  assert.equal((await rpc('tools/call', { name: 'getStock' })).status, 401);
  const sources = await (await gateway.api('/api/sources')).json();
  const removed = await gateway.api(`/api/sources/${source.id}`, { method: 'DELETE', body: { schemaVersion: 1, revision: sources.revision } });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal(gateway.provider.state.apps.has(native.id), false);
  assert.equal((await rpc('tools/list')).status, 401);
}));
