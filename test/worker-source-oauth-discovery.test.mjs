import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectMcpSource, verifyManagedSource } from '../payload/worker/index.js';
import { withProviderFetch } from './payload-lifecycle.mjs';
import { pausedGateway } from '../apps/installer/test-runtime/paused-source-fixture.mjs';

const ENDPOINT = 'https://catalog.example.net/mcp';
const PATH_METADATA = 'https://catalog.example.net/.well-known/oauth-protected-resource/mcp';
const ROOT_METADATA = 'https://catalog.example.net/.well-known/oauth-protected-resource';
const ISSUER = 'https://identity.example.net';
const TOOLS = [{ name: 'records_search', annotations: { readOnlyHint: true, destructiveHint: false } }];
const metadata = () => ({ resource: ENDPOINT, authorization_servers: [ISSUER] });

async function discoveryFixture(run, respond) {
  const calls = [];
  await withProviderFetch(async (request) => {
    calls.push(request);
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.headers.get('cookie'), null);
    assert.equal(request.redirect, 'manual');
    assert.ok(request.signal);
    if (request.url === ENDPOINT) {
      const message = await request.json();
      assert.equal(message.method, 'tools/list', 'inspection never calls a tool');
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    }
    assert.ok([PATH_METADATA, ROOT_METADATA].includes(request.url));
    assert.equal(request.method, 'GET');
    return respond(request);
  }, () => run(calls));
}

test('public tool discovery still requires OAuth when exact resource metadata is published', async () => {
  for (const location of [PATH_METADATA, ROOT_METADATA]) {
    await discoveryFixture(async (calls) => {
      const result = await inspectMcpSource(ENDPOINT);
      assert.equal(result.authMode, 'oauth');
      assert.equal(result.tools[0].name, 'records_search');
      assert.equal(calls.length, location === PATH_METADATA ? 2 : 3);
      await assert.rejects(verifyManagedSource({ url: ENDPOINT, authMode: 'none', enabledTools: ['records_search'] }),
        { code: 'source_authentication_changed' });
    }, (request) => request.url === location ? Response.json(metadata()) : new Response(null, { status: 404 }));
  }
});

test('public sources without OAuth metadata remain public, including HTML catch-all routes', async () => {
  for (const response of [() => new Response(null, { status: 404 }), () => new Response(null, { status: 405 }),
    () => new Response('<html>Public landing page</html>', { headers: { 'content-type': 'text/html' } })]) {
    await discoveryFixture(async (calls) => {
      assert.equal((await inspectMcpSource(ENDPOINT)).authMode, 'none');
      assert.equal(calls.length, 3);
    }, response);
  }
});

test('unsafe, mismatched or unavailable metadata never silently classifies a source as public', async () => {
  const cases = [
    [() => Response.json({ ...metadata(), resource: 'https://elsewhere.example.net/mcp' }), 'source_authentication_unsupported'],
    [() => Response.json({ ...metadata(), authorization_servers: ['https://127.0.0.1/oauth'] }), 'source_authentication_unsupported'],
    [() => Response.json({ ...metadata(), authorization_servers: [] }), 'source_authentication_unsupported'],
    [() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.net/metadata' } }), 'source_protocol_invalid'],
    [() => new Response(null, { status: 503 }), 'source_unreachable'],
    [() => { throw new Error('synthetic untrusted upstream detail'); }, 'source_unreachable'],
    [() => new Response('{', { headers: { 'content-type': 'application/json' } }), 'source_response_invalid'],
  ];
  for (const [response, code] of cases) {
    await discoveryFixture(async (calls) => {
      await assert.rejects(inspectMcpSource(ENDPOINT), { code, message: code });
      assert.equal(calls.length, 2);
    }, response);
  }
});

test('oversized OAuth metadata is cancelled without reading an unbounded body', async () => {
  let cancelled = false;
  await discoveryFixture(async () => {
    await assert.rejects(inspectMcpSource(ENDPOINT), { code: 'source_response_invalid' });
    assert.equal(cancelled, true);
  }, () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-type': 'application/json', 'content-length': '65537' },
  }));
});

// The public endpoint selects the real provider policy; every response below
// is synthetic and all network requests are intercepted locally.
const GORGIAS_URL = 'https://mcp.gorgias.com/mcp';
const READ_SCOPE = 'openid email profile offline tickets:read';
const OAUTH_KEY = 'ankka-mcp-gateway/source-oauth/v1';

async function gorgiasFixture(run, { granted = READ_SCOPE, supported = [...READ_SCOPE.split(' '), 'tickets:write', 'account:write'], registeredScope } = {}) {
  const gateway = await pausedGateway({ endpoint: GORGIAS_URL, publicCatalogue: true });
  const stub = gateway.env.ADMIN_STATE.get('v1:management');
  const registrations = [], imports = [];
  const accessToken = crypto.randomUUID();
  const post = (path, body) => stub.fetch(new Request(`https://admin-state.invalid${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  await withProviderFetch(async (request) => {
    const url = new URL(request.url);
    if (request.url === GORGIAS_URL) return new Response(null, { status: 405 });
    if (request.url === 'https://mcp.gorgias.com/.well-known/oauth-protected-resource/mcp') {
      return Response.json({ resource: GORGIAS_URL, authorization_servers: [ISSUER], scopes_supported: supported });
    }
    if (request.url === `${ISSUER}/.well-known/oauth-authorization-server`) return Response.json({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`, code_challenge_methods_supported: ['S256'],
    });
    if (request.url === `${ISSUER}/register`) {
      const registration = await request.json();
      registrations.push(registration);
      const registered = { ...registration, client_id: 'synthetic-public-client' };
      if (registeredScope !== undefined) registered.scope = registeredScope;
      return Response.json(registered);
    }
    if (request.url === `${ISSUER}/token`) {
      const tokens = { access_token: accessToken, token_type: 'Bearer' };
      if (granted !== null) tokens.scope = granted;
      return Response.json(tokens);
    }
    if (url.origin === 'https://api.cloudflare.com') {
      if (request.method === 'PUT') {
        imports.push(JSON.parse((await request.json()).auth_credentials));
        return Response.json({ success: true, result: {} });
      }
      if (url.pathname.endsWith('/sync')) return Response.json({ success: true, result: {} });
      return Response.json({ success: true, result: gateway.provider.state.servers.get(gateway.action.resources[0].provider.id) });
    }
    assert.fail('Unexpected outbound request');
  }, async () => {
    const started = await post('/source-oauth/start', { schemaVersion: 1, actionId: gateway.action.actionId,
      sourceId: gateway.source.id, revision: gateway.revision, actorEmail: 'admin@example.com' });
    await run({ started, registrations, imports, storage: gateway.storage, accessToken,
      async finish() {
        const authorization = new URL((await started.clone().json()).authorizationUrl);
        return post('/source-oauth/callback', { actorEmail: 'admin@example.com', state: authorization.searchParams.get('state'),
          browser: started.headers.get('set-cookie').split(';')[0].split('=')[1], code: 'synthetic-code', denied: false, issuer: null });
      } });
  });
}

test('Gorgias requests only ticket-read and identity scopes and imports the confirmed grant', async () => {
  await gorgiasFixture(async ({ started, finish, registrations, imports, storage, accessToken }) => {
    assert.equal(started.status, 200);
    const authorization = new URL((await started.clone().json()).authorizationUrl);
    assert.equal(authorization.searchParams.get('scope'), READ_SCOPE);
    assert.equal(registrations[0].scope, READ_SCOPE);
    assert.equal((await finish()).status, 200);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].tokens.scope, READ_SCOPE);
    assert.equal(imports[0].registration_info.scope, READ_SCOPE);
    assert.deepEqual(imports[0].config.scopes_supported, READ_SCOPE.split(' '));
    assert.equal(storage.snapshot(OAUTH_KEY), undefined);
    assert.equal(JSON.stringify(storage.writes).includes(accessToken), false);
  });
});

test('Gorgias rejects missing, write-capable or unrequested grants before credential import', async () => {
  for (const granted of [null, 'openid', `${READ_SCOPE} tickets:write`, `${READ_SCOPE} customers:read`]) {
    await gorgiasFixture(async ({ started, finish, imports, storage }) => {
      assert.equal(started.status, 200);
      const finished = await finish();
      assert.equal(finished.status, 409);
      assert.equal((await finished.json()).error, 'source_oauth_scope_unsupported');
      assert.equal(imports.length, 0);
      assert.equal(storage.snapshot(OAUTH_KEY), undefined);
    }, { granted });
  }
});

test('Gorgias refuses unavailable read scopes and registration scope expansion', async () => {
  for (const options of [{ supported: ['tickets:write'] }, { registeredScope: `${READ_SCOPE} tickets:write` }]) {
    await gorgiasFixture(async ({ started, imports, storage }) => {
      assert.equal(started.status, 409);
      assert.equal((await started.json()).error, 'source_oauth_scope_unsupported');
      assert.equal(imports.length, 0);
      assert.equal(storage.snapshot(OAUTH_KEY), undefined);
    }, options);
  }
});
