import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { AdminState } from '../payload/worker/index.js';
import {
  ACCOUNT_ID,
  INSTALLATION_ID,
  canonicalJson,
  cloudflareProvider,
  installReadyGateway,
  prefixedSha256,
  withProviderFetch,
} from './payload-lifecycle.mjs';

// Team connect pages against the real Worker and synthetic Cloudflare state.
const ADMIN = 'admin@example.com';
const MEMBER = 'member@example.com';
const TEAMMATE = 'teammate@example.com';
const STRANGER = 'stranger@example.com';
const MANAGEMENT_ORIGIN = 'https://manage.example.com';
const CONNECT_AUD = 'c0'.repeat(32);
const CONNECT_NAME = `ankka-${INSTALLATION_ID}-connect`;
const CONNECT_DESTINATION = 'manage.example.com/__ankka/connect';
const TEAM_ID = 'team-aaaaaaaaaaaaaaaa';
const SOURCE_EXAMPLE = 'Which reference records changed this week?';
const GENERAL_EXAMPLE = 'What can you help me with today?';

function envelope(result, status = 200) {
  return Response.json({ success: status >= 200 && status < 300, errors: [], messages: [], result }, { status });
}

// Team groups, token verification and policy updates on top of the shared resource fake.
// A created self-hosted application gets an audience tag, as Cloudflare assigns one.
function connectProvider() {
  const groups = new Map();
  let groupSerial = 0;
  let appSerial = 0;
  let hook;
  const groupRoot = `/client/v4/accounts/${ACCOUNT_ID}/access/groups`;
  const provider = cloudflareProvider({
    async onRequest(context) {
      const intercepted = await hook?.(context);
      if (intercepted instanceof Response) return intercepted;
      const { record, state } = context;
      if (record.pathname === groupRoot && record.method === 'POST') {
        const id = `synthetic-access-group-${groupSerial += 1}`;
        groups.set(id, { id, account_id: ACCOUNT_ID, name: record.body.name, include: record.body.include, exclude: [], require: [] });
        return envelope(groups.get(id));
      }
      if (record.pathname === groupRoot && record.method === 'GET') return envelope([...groups.values()]);
      if (record.pathname.startsWith(`${groupRoot}/`)) {
        const id = decodeURIComponent(record.pathname.slice(groupRoot.length + 1));
        if (record.method === 'GET') return groups.has(id) ? envelope(groups.get(id)) : envelope(null, 404);
        if (record.method === 'PUT') {
          groups.set(id, { id, account_id: ACCOUNT_ID, name: record.body.name, include: record.body.include, exclude: [], require: [] });
          return envelope(groups.get(id));
        }
      }
      if (record.pathname === `/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`) return envelope({ status: 'active' });
      if (record.method === 'POST' && record.pathname.endsWith('/access/apps') && record.body?.type === 'self_hosted' &&
          record.body.name === CONNECT_NAME) {
        const id = `connect${String(appSerial += 1).padStart(25, '0')}`;
        state.apps.set(id, { id, aud: CONNECT_AUD, ...record.body });
        state.policies.set(id, []);
        return envelope(state.apps.get(id));
      }
      for (const root of [`/client/v4/zones/${'2'.repeat(32)}/access/apps`, `/client/v4/accounts/${ACCOUNT_ID}/access/apps`]) {
        if (record.method !== 'PUT' || !record.pathname.startsWith(`${root}/`)) continue;
        const [appId, , policyId] = record.pathname.slice(root.length + 1).split('/');
        const policies = state.policies.get(appId);
        const index = policies?.findIndex((policy) => policy.id === policyId) ?? -1;
        if (index < 0) return envelope(null, 404);
        policies[index] = { id: policyId, ...structuredClone(record.body) };
        return envelope(policies[index]);
      }
      return undefined;
    },
  });
  return { ...provider, groups, hook(next) { hook = next; } };
}

// The dashboard build as Workers static assets serve it: an unknown path answers with the dashboard's index.html.
const SHELL = '<!doctype html><html lang="en"><head><meta name="ankka-page" content="team-connect" />' +
  '<script type="module" crossorigin src="/assets/admin-0123abcd.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/admin-4567cdef.css"></head><body><div id="root"></div></body></html>';
function staticAssets() {
  const files = new Map([
    ['/team-connect', ['text/html; charset=utf-8', SHELL]],
    ['/assets/admin-0123abcd.js', ['application/javascript', 'export {};']],
    ['/assets/admin-4567cdef.css', ['text/css', 'body{}']],
  ]);
  return { async fetch(request) {
    const [type, body] = files.get(new URL(request.url).pathname) ?? ['text/html; charset=utf-8', '<!doctype html><div id="root"></div>'];
    return new Response(body, { headers: { 'content-type': type } });
  } };
}

let accessKeyPair;

async function fixture(run) {
  const provider = connectProvider();
  const gateway = await installReadyGateway({ provider });
  gateway.env.ANKKA_MANAGEMENT_TOKEN = 'synthetic-account-management-token-never-store';
  gateway.env.ASSETS = staticAssets();
  const namespace = gateway.env.ADMIN_STATE;
  const instances = new Map();
  gateway.env.ADMIN_STATE = {
    ...namespace,
    get(name) {
      if (!instances.has(name)) instances.set(name, new AdminState({ storage: gateway.objects.get(name).storage }, gateway.env));
      return { fetch: (request) => instances.get(name).fetch(request) };
    },
  };
  accessKeyPair ??= crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const keys = await accessKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const kid = `synthetic-connect-key-${crypto.randomUUID()}`;
  async function headers(email, audience) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode({
      iss: gateway.env.CF_ACCESS_ISSUER, aud: [audience], email, nbf: now - 1, exp: now + 300 })}`;
    const signed = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned));
    return { 'cf-access-authenticated-user-email': email,
      'cf-access-jwt-assertion': `${unsigned}.${Buffer.from(signed).toString('base64url')}` };
  }
  async function api(path, { method = 'GET', body, email = ADMIN, origin = MANAGEMENT_ORIGIN } = {}) {
    const init = { method, headers: { ...await headers(email, gateway.env.CF_ACCESS_AUD), 'content-type': 'application/json', origin } };
    if (body !== undefined) init.body = canonicalJson(body);
    return worker.fetch(new Request(`${MANAGEMENT_ORIGIN}${path}`, init), gateway.env);
  }
  async function page(path, email, audience = CONNECT_AUD) {
    return worker.fetch(new Request(`${MANAGEMENT_ORIGIN}${path}`, { headers: await headers(email, audience) }), gateway.env);
  }
  async function enable(enabled = true) {
    const response = await api('/api/connect/page', { method: 'POST', body: { schemaVersion: 1, enabled } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function teardownRefusal() {
    const issuedAt = Date.now();
    const stub = gateway.env.ADMIN_STATE.get('v1:management');
    const response = await stub.fetch(new Request('https://admin-state.invalid/teardown-actions/prepare-current', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: canonicalJson({
        schemaVersion: 1, actionId: `action_${'E'.repeat(32)}`,
        actionKeyHash: await prefixedSha256(Buffer.alloc(32, 4).toString('base64url')), actorEmail: ADMIN,
        installationId: gateway.readyReceipt.installationId, issuedAt, expiresAt: issuedAt + 600_000 }),
    }));
    return response.status === 200 ? null : (await response.json()).error;
  }
  const connectApps = () => [...provider.state.apps.values()].filter((app) => app.name === CONNECT_NAME);
  const network = async (request) => request.url === `${gateway.env.CF_ACCESS_ISSUER}/cdn-cgi/access/certs`
    ? Response.json({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }) : provider.fetch(request);
  return withProviderFetch(network, () => run({ ...gateway, provider, api, page, enable, teardownRefusal, connectApps }));
}

/** Adds a direct member without sources and a Marketing team with the installed source. */
async function withTeam(gateway) {
  const response = await gateway.api('/api/team');
  assert.equal(response.status, 200, await response.clone().text());
  const before = await response.json();
  const sourceId = before.sources[0].id;
  const saved = await gateway.api('/api/team-actions', { method: 'POST', body: {
    schemaVersion: 1, expectedRevision: before.revision,
    members: [...before.members.filter((member) => ![MEMBER, TEAMMATE].includes(member.email)),
      { email: MEMBER, sourceIds: [] }, { email: TEAMMATE, sourceIds: [] }],
    teams: [{ id: TEAM_ID, name: 'Marketing', memberEmails: [TEAMMATE], sourceIds: [sourceId] }],
  } });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await saved.json()).action.status, 'succeeded');
  return sourceId;
}

async function saveExamples(gateway, revision, examples) {
  return gateway.api('/api/connect/examples', { method: 'PUT', body: { schemaVersion: 1, expectedRevision: revision, examples } });
}

test('the connect page API is administrator-only and starts with the page off', async () => fixture(async (gateway) => {
  const response = await gateway.api('/api/connect');
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { schemaVersion: 1, revision: 0, examples: [], updatedAt: null, updatedBy: null,
    page: { status: 'off', failureCode: null }, managementCredentialConfigured: true });
  await withTeam(gateway);
  assert.equal((await gateway.api('/api/connect', { email: MEMBER })).status, 401);
  const crossOrigin = await gateway.api('/api/connect/examples', { method: 'PUT', origin: 'https://elsewhere.example',
    body: { schemaVersion: 1, expectedRevision: 0, examples: [] } });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await gateway.api('/api/connect/page')).status, 405);
}));

test('examples are revisioned and may only name installed sources', async () => fixture(async (gateway) => {
  const sourceId = (await (await gateway.api('/api/team')).json()).sources[0].id;
  const examples = [
    { id: 'example-aaaaaaaaaaaa', prompt: SOURCE_EXAMPLE, answer: 'A list of changed records with who changed them.', sourceIds: [sourceId] },
    { id: 'example-bbbbbbbbbbbb', prompt: GENERAL_EXAMPLE, sourceIds: [] },
  ];
  const saved = await saveExamples(gateway, 0, examples);
  assert.equal(saved.status, 200, await saved.clone().text());
  const body = await saved.json();
  assert.equal(body.revision, 1);
  assert.deepEqual(body.examples, examples);
  assert.equal(body.updatedBy, ADMIN);
  assert.equal((await saveExamples(gateway, 0, examples)).status, 409);
  for (const invalid of [
    [{ ...examples[0], sourceIds: ['source-0000000000000000'] }],
    [examples[0], { ...examples[1], id: examples[0].id }],
    [{ ...examples[0], prompt: 'x'.repeat(601) }],
    [{ ...examples[0], prompt: ' padded ' }],
    [{ ...examples[0], answer: 'x'.repeat(301) }],
    [{ ...examples[0], answer: '' }],
    [{ ...examples[0], extra: true }],
  ]) {
    const response = await saveExamples(gateway, 1, invalid);
    assert.equal(response.status, 400, canonicalJson(invalid));
    assert.equal((await response.json()).error, 'connect_examples_invalid');
  }
}));

test('turning the page on creates one sign-in application, and removal waits until it is off', async () => fixture(async (gateway) => {
  const on = await gateway.enable();
  assert.deepEqual(on.page, { status: 'on', failureCode: null });
  const [application] = gateway.connectApps();
  assert.equal(gateway.connectApps().length, 1);
  assert.equal(application.type, 'self_hosted');
  assert.equal(application.domain, CONNECT_DESTINATION);
  assert.deepEqual(application.destinations, [{ type: 'public', uri: CONNECT_DESTINATION }]);
  assert.equal(application.app_launcher_visible, false);
  const policies = gateway.provider.state.policies.get(application.id);
  assert.equal(policies.length, 1);
  assert.deepEqual({ ...policies[0], id: undefined }, { id: undefined, name: `Connect page viewers [${CONNECT_NAME}]`,
    decision: 'allow', include: [{ everyone: {} }], exclude: [], require: [] });

  const posts = gateway.provider.posts().length;
  assert.deepEqual((await gateway.enable()).page, { status: 'on', failureCode: null });
  assert.equal(gateway.provider.posts().length, posts, 'an enabled page is not created again');
  assert.equal(await gateway.teardownRefusal(), 'teardown_connect_page_present');

  const off = await gateway.enable(false);
  assert.deepEqual(off.page, { status: 'off', failureCode: null });
  assert.equal(gateway.connectApps().length, 0);
  assert.notEqual(await gateway.teardownRefusal(), 'teardown_connect_page_present');
  assert.doesNotMatch(JSON.stringify([...await gateway.objects.get('v1:management').storage.list()]), /synthetic-account-management-token/);
}));

test('a lost creation response is adopted by its exact name on the next attempt', async () => fixture(async (gateway) => {
  let dropped = false;
  gateway.provider.hook(async ({ record, state }) => {
    if (dropped || record.method !== 'POST' || record.body?.name !== CONNECT_NAME) return undefined;
    dropped = true;
    state.apps.set('connect-lost', { id: 'connect-lost', aud: CONNECT_AUD, ...record.body });
    state.policies.set('connect-lost', []);
    return Response.json({ success: false, errors: [], messages: [], result: null }, { status: 500 });
  });
  const first = await gateway.enable();
  assert.deepEqual(first.page, { status: 'enabling', failureCode: 'connect_page_unconfirmed' });
  assert.equal(await gateway.teardownRefusal(), 'teardown_connect_page_present');
  const second = await gateway.enable();
  assert.deepEqual(second.page, { status: 'on', failureCode: null });
  assert.deepEqual(gateway.connectApps().map((app) => app.id), ['connect-lost']);
}));

test('another application on the page path is never adopted or deleted', async () => fixture(async (gateway) => {
  gateway.provider.state.apps.set('foreign-app', { id: 'foreign-app', aud: CONNECT_AUD, name: 'Someone else', type: 'self_hosted',
    domain: CONNECT_DESTINATION, destinations: [{ type: 'public', uri: CONNECT_DESTINATION }] });
  gateway.provider.state.policies.set('foreign-app', []);
  assert.deepEqual((await gateway.enable()).page, { status: 'enabling', failureCode: 'connect_page_conflict' });
  assert.deepEqual((await gateway.enable(false)).page, { status: 'off', failureCode: null });
  assert.ok(gateway.provider.state.apps.has('foreign-app'));
  assert.equal(gateway.provider.deletes().length, 0);
}));

test('the page cannot be turned on without the management token', async () => fixture(async (gateway) => {
  delete gateway.env.ANKKA_MANAGEMENT_TOKEN;
  const response = await gateway.api('/api/connect/page', { method: 'POST', body: { schemaVersion: 1, enabled: true } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'connect_management_credential_missing');
  assert.equal(gateway.connectApps().length, 0);
}));

test('the page is the dashboard build, served under its own path behind a sign-in', async () => fixture(async (gateway) => {
  await withTeam(gateway);
  assert.equal((await gateway.page('/__ankka/connect', TEAMMATE)).status, 404, 'a page that is off shows nothing');
  await gateway.enable();
  for (const path of ['/__ankka/connect', `/__ankka/connect/${TEAM_ID}`]) {
    const shell = await gateway.page(path, STRANGER);
    assert.equal(shell.status, 200, 'the shell carries no gateway data');
    assert.match(shell.headers.get('content-security-policy'), /default-src 'none'; script-src 'self'/u);
    assert.equal(shell.headers.get('cache-control'), 'private, no-store');
    const html = await shell.text();
    assert.ok(html.includes('src="/__ankka/connect/assets/admin-0123abcd.js"'));
    assert.ok(html.includes('href="/__ankka/connect/assets/admin-4567cdef.css"'));
    assert.ok(!html.includes('="/assets/'));
  }
  const unsigned = await worker.fetch(new Request(`${MANAGEMENT_ORIGIN}/__ankka/connect`), gateway.env);
  assert.equal(unsigned.status, 401);
  assert.equal((await gateway.page('/__ankka/connect', TEAMMATE, gateway.env.CF_ACCESS_AUD)).status, 401,
    'a dashboard sign-in is not a sign-in to this page');
  const script = await gateway.page('/__ankka/connect/assets/admin-0123abcd.js', TEAMMATE);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/u);
  assert.equal((await gateway.page('/__ankka/connect/assets/admin-ffffffff.js', TEAMMATE)).status, 404,
    'the dashboard fallback page is never served as a script');
  for (const path of ['/__ankka/connect/extra', '/__ankka/connect/assets/../index.html', '/__ankka/connect/assets/index.html']) {
    assert.equal((await gateway.page(path, TEAMMATE)).status, 404, path);
  }
  delete gateway.env.ASSETS;
  assert.equal((await gateway.page('/__ankka/connect', TEAMMATE)).status, 503);
}));

test('each person sees their own sources and only the examples those sources can answer', async () => fixture(async (gateway) => {
  const sourceId = await withTeam(gateway);
  assert.equal((await saveExamples(gateway, 0, [
    { id: 'example-aaaaaaaaaaaa', prompt: SOURCE_EXAMPLE, answer: 'A list of changed records.', sourceIds: [sourceId] },
    { id: 'example-bbbbbbbbbbbb', prompt: GENERAL_EXAMPLE, sourceIds: [] },
  ])).status, 200);
  assert.equal((await gateway.page('/__ankka/connect/view', TEAMMATE)).status, 404);
  await gateway.enable();

  const teammate = await gateway.page('/__ankka/connect/view', TEAMMATE);
  assert.equal(teammate.status, 200);
  assert.equal(teammate.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await teammate.json(), {
    schemaVersion: 1, gateway: { name: 'Example Gateway', mcpUrl: 'https://mcp.example.com/mcp' },
    viewer: { email: TEAMMATE }, team: null,
    sources: [{ id: sourceId, name: 'Company context', icon: null }],
    examples: [
      { id: 'example-aaaaaaaaaaaa', prompt: SOURCE_EXAMPLE, sourceIds: [sourceId], answer: 'A list of changed records.' },
      { id: 'example-bbbbbbbbbbbb', prompt: GENERAL_EXAMPLE, sourceIds: [] },
    ],
  });
  const member = await (await gateway.page('/__ankka/connect/view', MEMBER)).json();
  assert.deepEqual(member.sources, []);
  assert.deepEqual(member.examples.map((example) => example.id), ['example-bbbbbbbbbbbb'],
    'an example needing a source the person lacks is left out');

  const stranger = await gateway.page('/__ankka/connect/view', STRANGER);
  assert.equal(stranger.status, 403);
  assert.deepEqual(await stranger.json(), { schemaVersion: 1, error: 'connect_not_member' });
  assert.equal((await gateway.page('/__ankka/connect/view', TEAMMATE, gateway.env.CF_ACCESS_AUD)).status, 401);
  assert.equal((await gateway.page('/__ankka/connect/view?other=1', TEAMMATE)).status, 400);
}));

test('a team page is shown to its members and administrators only', async () => fixture(async (gateway) => {
  const sourceId = await withTeam(gateway);
  await gateway.enable();
  const teammate = await gateway.page(`/__ankka/connect/view?team=${TEAM_ID}`, TEAMMATE);
  assert.equal(teammate.status, 200);
  const view = await teammate.json();
  assert.deepEqual(view.team, { id: TEAM_ID, name: 'Marketing' });
  assert.deepEqual(view.sources.map((source) => source.id), [sourceId]);
  const admin = await gateway.page(`/__ankka/connect/view?team=${TEAM_ID}`, ADMIN);
  assert.equal(admin.status, 200);
  assert.equal((await admin.json()).viewer.email, ADMIN);
  const other = await gateway.page(`/__ankka/connect/view?team=${TEAM_ID}`, MEMBER);
  assert.equal(other.status, 403);
  assert.equal((await other.json()).error, 'connect_other_team');
  const missing = await gateway.page('/__ankka/connect/view?team=team-bbbbbbbbbbbbbbbb', TEAMMATE);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'connect_team_missing');
}));

test('a connector icon is fetched only for a source the visitor can use', async () => fixture(async (gateway) => {
  const sourceId = await withTeam(gateway);
  await gateway.enable();
  const before = gateway.provider.requests.length;
  assert.equal((await gateway.page(`/__ankka/connect/icons/${sourceId}`, MEMBER)).status, 404);
  assert.equal((await gateway.page('/__ankka/connect/icons/source-0000000000000000', TEAMMATE)).status, 404);
  assert.equal(gateway.provider.requests.length, before, 'no Cloudflare request for a refused icon');
}));
