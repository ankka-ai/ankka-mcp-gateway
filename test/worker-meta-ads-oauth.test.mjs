import assert from 'node:assert/strict';
import test from 'node:test';
import { withProviderFetch } from './payload-lifecycle.mjs';
import { pausedGateway, sourceUrl } from '../apps/installer/test-runtime/paused-source-fixture.mjs';

// Public provider URLs select the production policy. Every response and token
// is synthetic; all requests are intercepted, including Cloudflare imports.
const ENDPOINT = 'https://mcp.facebook.com/ads';
const ISSUER = 'https://www.facebook.com/ads';
const METADATA = 'https://www.facebook.com/.well-known/oauth-authorization-server/ads';
const PERMISSIONS = 'https://graph.facebook.com/v26.0/me/permissions';
const READ_SCOPE = 'ads_mcp_management ads_read';
const APP_ID = '123456789012345'; // Synthetic public Meta App ID.
const OAUTH_KEY = 'ankka-mcp-gateway/source-oauth/v1';
const config = {
  issuer: ISSUER, authorization_endpoint: 'https://www.facebook.com/v26.0/dialog/oauth',
  token_endpoint: 'https://graph.facebook.com/v26.0/oauth/access_token',
  registration_endpoint: 'https://mcp.facebook.com/.well-known/register/ads',
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
};
const permissionData = (granted = `${READ_SCOPE} public_profile`) => ({
  data: [...granted.split(' ').map((permission) => ({ permission, status: 'granted' })),
    { permission: 'ads_management', status: 'declined' }],
});

async function metaFixture(run, { endpoint = ENDPOINT, issuers = [ISSUER], metadata = {},
  supported = [...READ_SCOPE.split(' '), 'ads_management', 'business_management', 'catalog_management'],
  input = {}, tokenScope, metadataRedirect, permissions = () => Response.json(permissionData()) } = {}) {
  const gateway = await pausedGateway({ endpoint });
  const stub = gateway.env.ADMIN_STATE.get('v1:management');
  const registrations = [], imports = [], calls = [];
  const accessToken = crypto.randomUUID(), refreshToken = crypto.randomUUID();
  const post = (path, body) => stub.fetch(new Request(`https://admin-state.invalid${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  await withProviderFetch(async (request) => {
    const url = new URL(request.url);
    calls.push({ url: url.href, method: request.method });
    assert.equal(request.redirect, 'manual');
    assert.ok(!url.href.includes(accessToken));
    assert.equal(request.headers.has('cookie'), false);
    if (url.href === PERMISSIONS) {
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('authorization'), `Bearer ${accessToken}`);
      return permissions();
    }
    if (url.origin === 'https://api.cloudflare.com') {
      if (request.method === 'PUT') {
        imports.push(JSON.parse((await request.json()).auth_credentials));
        return Response.json({ success: true, result: {} });
      }
      if (url.pathname.endsWith('/sync')) return Response.json({ success: true, result: {} });
      return Response.json({ success: true, result: gateway.provider.state.servers.get(gateway.action.resources[0].provider.id) });
    }
    assert.equal(request.headers.has('authorization'), false);
    if (url.href === endpoint) return new Response(null, { status: 401, headers: {
      'www-authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${url.pathname}"`,
    } });
    if (url.href === `${new URL(endpoint).origin}/.well-known/oauth-protected-resource${new URL(endpoint).pathname}`) {
      return Response.json({ resource: endpoint, authorization_servers: issuers, scopes_supported: supported });
    }
    if (url.href === METADATA) {
      // Meta's live endpoint redirects unidentified Cloudflare Workers requests
      // to unsupportedbrowser. An honest explicit client identifier avoids it.
      if (request.headers.get('user-agent') !== 'Ankka-MCP-Gateway' || metadataRedirect) {
        return new Response(null, { status: 302, headers: {
          location: metadataRedirect ?? 'https://www.facebook.com/unsupportedbrowser',
        } });
      }
      return Response.json({ ...config, ...metadata });
    }
    if (url.href === config.registration_endpoint) {
      registrations.push(await request.json());
      assert.fail('Meta must use the pre-registered App ID, not dynamic registration');
    }
    if (url.href === config.token_endpoint) {
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get('client_id'), APP_ID);
      assert.equal(body.get('resource'), endpoint);
      assert.ok(body.get('code_verifier'));
      const response = { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600 };
      if (tokenScope !== undefined) response.scope = tokenScope;
      return Response.json(response);
    }
    assert.fail(`Unexpected outbound destination: ${url.origin}`);
  }, async () => {
    const startInput = { schemaVersion: 1, actionId: gateway.action.actionId,
      sourceId: gateway.source.id, revision: gateway.revision, actorEmail: 'admin@example.com' };
    if (endpoint === ENDPOINT) startInput.metaAppId = APP_ID;
    const started = await post('/source-oauth/start', { ...startInput, ...input });
    await run({ started, registrations, imports, calls, storage: gateway.storage, sourceId: gateway.source.id, accessToken, refreshToken,
      async finish() {
        const authorization = new URL((await started.clone().json()).authorizationUrl);
        return post('/source-oauth/callback', { actorEmail: 'admin@example.com', state: authorization.searchParams.get('state'),
          browser: started.headers.get('set-cookie').split(';')[0].split('=')[1], code: 'synthetic-code', denied: false, issuer: null });
      } });
    assert.equal(JSON.stringify(gateway.storage.writes).includes(accessToken), false);
    assert.equal(JSON.stringify(gateway.storage.writes).includes(refreshToken), false);
  });
}

test('Meta uses a pre-registered App ID with PKCE and imports only provider-confirmed read permissions', async () => {
  // Facebook can omit token scope; the fixed permissions read proves the grant.
  await metaFixture(async ({ started, finish, registrations, imports, calls, storage, accessToken, refreshToken }) => {
    assert.equal(started.status, 200);
    const authorization = new URL((await started.clone().json()).authorizationUrl);
    assert.equal(`${authorization.origin}${authorization.pathname}`, config.authorization_endpoint);
    assert.equal(authorization.searchParams.get('scope'), READ_SCOPE);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('client_id'), APP_ID);
    assert.equal(registrations.length, 0);
    assert.equal((await finish()).status, 200);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].tokens.access_token, accessToken);
    assert.equal(imports[0].tokens.refresh_token, refreshToken);
    assert.equal(imports[0].tokens.scope, `${READ_SCOPE} public_profile`);
    assert.equal(imports[0].registration_info.scope, READ_SCOPE);
    assert.equal(imports[0].registration_info.client_id, APP_ID);
    assert.equal(imports[0].registration_info.token_endpoint_auth_method, 'none');
    assert.deepEqual(imports[0].config.scopes_supported, READ_SCOPE.split(' '));
    assert.equal(imports[0].config.token_endpoint, config.token_endpoint);
    assert.equal(calls.filter((call) => call.url === PERMISSIONS).length, 1);
    assert.equal(storage.snapshot(OAUTH_KEY), undefined);
    assert.equal((await finish()).status, 409, 'callback replay cannot exchange or import again');
    assert.equal(imports.length, 1);
  });
});

test('Meta refuses issuer drift and endpoint changes before registering or sending credentials', async () => {
  const cases = [
    { issuers: ['https://identity.example.net'] },
    { issuers: [ISSUER, 'https://identity.example.net'] },
    { metadata: { issuer: 'https://www.facebook.com/' } },
    { metadata: { token_endpoint: 'https://graph.facebook.com/v26.0/other' } },
    { metadata: { token_endpoint: 'https://graph.facebook.com/v27.0/oauth/access_token' } },
    { metadata: { token_endpoint: 'https://www.facebook.com/token' } },
    { metadata: { authorization_endpoint: 'https://www.facebook.com/v26.0/dialog/oauth?scope=ads_management' } },
    { metadata: { registration_endpoint: 'https://mcp.facebook.com/.well-known/register/other' } },
    { metadata: { registration_endpoint: 'https://mcp.facebook.com.example.net/register' } },
    { metadata: { code_challenge_methods_supported: ['plain'] } },
    { metadataRedirect: 'https://www.facebook.com/unsupportedbrowser' },
    { metadataRedirect: 'https://identity.example.net/discovery' },
    { endpoint: sourceUrl },
    { endpoint: 'https://mcp.facebook.com/other' },
  ];
  for (const options of cases) await metaFixture(async ({ started, registrations, imports, storage }) => {
    assert.equal(started.status, 409, JSON.stringify(options));
    assert.equal((await started.json()).error, 'source_oauth_unavailable');
    assert.equal(registrations.length, 0);
    assert.equal(imports.length, 0);
    assert.equal(storage.snapshot(OAUTH_KEY), undefined);
  }, options);
});

test('Meta refuses missing read capabilities', async () => {
  for (const options of [{ supported: ['ads_read'] }, { supported: ['ads_mcp_management', 'ads_management'] }]) {
    await metaFixture(async ({ started, imports, storage }) => {
      assert.equal(started.status, 409);
      assert.equal((await started.json()).error, 'source_oauth_scope_unsupported');
      assert.equal(imports.length, 0);
      assert.equal(storage.snapshot(OAUTH_KEY), undefined);
    }, options);
  }
});

test('Meta requires a public numeric App ID and never falls back to registration or accepts secrets', async () => {
  for (const metaAppId of [undefined, null, 12345, '', '0', '123 456', '1'.repeat(33), 'synthetic-app-secret']) {
    await metaFixture(async ({ started, registrations, imports, storage }) => {
      assert.equal(started.status, 409);
      assert.equal((await started.json()).error, 'source_oauth_meta_app_required');
      assert.equal(registrations.length, 0);
      assert.equal(imports.length, 0);
      assert.equal(storage.snapshot(OAUTH_KEY), undefined);
    }, { input: { metaAppId } });
  }
  for (const options of [{ input: { client_secret: 'synthetic-never-accepted' } },
    { endpoint: sourceUrl, input: { metaAppId: APP_ID } }]) {
    await metaFixture(async ({ started, registrations, storage }) => {
      assert.equal(started.status, 400);
      assert.equal((await started.json()).error, 'source_oauth_invalid');
      assert.equal(registrations.length, 0);
      assert.equal(storage.snapshot(OAUTH_KEY), undefined);
    }, options);
  }
});

test('Meta rejects write permissions, missing reads, ambiguous or incomplete permission evidence before import', async () => {
  const cases = [
    { tokenScope: `${READ_SCOPE} ads_management` },
    { tokenScope: 'ads_read' },
    { tokenScope: `${READ_SCOPE} ads_read` },
    { permissions: () => Response.json(permissionData('ads_read public_profile')) },
    { tokenScope: READ_SCOPE, permissions: () => Response.json({ data: [
      ...permissionData().data.filter((entry) => entry.status === 'granted'),
      { permission: 'ads_management', status: 'granted' },
    ] }) },
    { permissions: () => Response.json(permissionData(`${READ_SCOPE} business_management`)) },
    { permissions: () => Response.json(permissionData(`${READ_SCOPE} email`)) },
    { permissions: () => Response.json({ data: [...permissionData().data, { permission: 'ads_read', status: 'expired' }] }) },
    { permissions: () => Response.json({ data: [{ permission: 'ads_read', status: 'unknown' }, { permission: 'ads_mcp_management', status: 'granted' }] }) },
    { permissions: () => Response.json({ ...permissionData(), paging: { next: 'https://graph.facebook.com/more' } }) },
    { permissions: () => Response.json({ ...permissionData(), error: { code: 190 } }) },
    { permissions: () => Response.json({ data: [] }) },
    { permissions: () => Response.json({ data: Array.from({ length: 101 }, (_, index) => ({ permission: `read_${index}`, status: 'declined' })) }) },
  ];
  for (const options of cases) await metaFixture(async ({ started, finish, imports, storage }) => {
    assert.equal(started.status, 200);
    const finished = await finish();
    assert.equal(finished.status, 409);
    assert.equal((await finished.json()).error, 'source_oauth_scope_unsupported');
    assert.equal(imports.length, 0);
    assert.equal(storage.snapshot(OAUTH_KEY), undefined);
  }, options);
});

test('Meta does not forward its token through redirects or import an unverifiable grant', async () => {
  for (const permissions of [
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.net/permissions' } }),
    () => new Response(null, { status: 503 }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => new Response('x'.repeat(65_537), { headers: { 'content-type': 'application/json' } }),
  ]) await metaFixture(async ({ started, finish, imports, storage, sourceId }) => {
    assert.equal(started.status, 200);
    assert.equal((await finish()).status, 409);
    assert.equal(imports.length, 0);
    assert.equal(storage.snapshot(OAUTH_KEY), undefined);
    assert.equal(storage.snapshot(`ankka-mcp-gateway/source-oauth-diagnostic/v1/${sourceId}`).stage, 'permission_check');
  }, { permissions });
});
