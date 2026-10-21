import assert from 'node:assert/strict';
import test from 'node:test';
import { withProviderFetch } from './payload-lifecycle.mjs';
import { pausedGateway, sourceUrl } from '../apps/installer/test-runtime/paused-source-fixture.mjs';

// The public endpoint selects the Klaviyo policy. Every response and token is
// synthetic; all requests are intercepted, including Cloudflare imports.
const ENDPOINT = 'https://mcp.klaviyo.com/mcp';
const SERVER_URL = `${ENDPOINT}?include-output-schemas=false&read-only=true`;
const ISSUER = 'https://mcp.klaviyo.com';
const METADATA = 'https://mcp.klaviyo.com/.well-known/oauth-protected-resource/mcp';

const serverOf = (gateway) => gateway.provider.state.servers.get(gateway.action.resources[0].provider.id);

test('Klaviyo installs a read-only server without output schemas and keeps the saved endpoint plain', async () => {
  const gateway = await pausedGateway({ endpoint: ENDPOINT });
  assert.equal(gateway.source.url, ENDPOINT);
  assert.equal(serverOf(gateway).hostname, SERVER_URL);
});

test('Other sources use their saved endpoint as the server URL', async () => {
  const gateway = await pausedGateway();
  assert.equal(serverOf(gateway).hostname, sourceUrl);
});

for (const legacy of [false, true]) test(`Klaviyo signs in for the plain endpoint and imports into ${legacy ? 'a server created before the options' : 'the read-only server'}`, async () => {
  const gateway = await pausedGateway({ endpoint: ENDPOINT });
  // A server created by an earlier release keeps the plain URL and must still be recognised.
  if (legacy) serverOf(gateway).hostname = ENDPOINT;
  const expectedHostname = legacy ? ENDPOINT : SERVER_URL;
  const stub = gateway.env.ADMIN_STATE.get('v1:management');
  const imports = [], tokenRequests = [];
  const accessToken = crypto.randomUUID(), refreshToken = crypto.randomUUID();
  const post = (path, body) => stub.fetch(new Request(`https://admin-state.invalid${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  await withProviderFetch(async (request) => {
    const url = new URL(request.url);
    if (url.origin === 'https://api.cloudflare.com') {
      if (request.method === 'PUT') {
        imports.push(JSON.parse((await request.json()).auth_credentials));
        return Response.json({ success: true, result: {} });
      }
      if (url.pathname.endsWith('/sync')) return Response.json({ success: true, result: {} });
      return Response.json({ success: true, result: serverOf(gateway) });
    }
    assert.equal(request.headers.has('authorization'), false);
    if (url.href === ENDPOINT) {
      return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${METADATA}"` } });
    }
    if (url.href === METADATA) return Response.json({ resource: ENDPOINT, authorization_servers: [ISSUER] });
    if (url.href === `${ISSUER}/.well-known/oauth-authorization-server`) return Response.json({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`, response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true,
    });
    if (url.href === `${ISSUER}/register`) return Response.json({ ...(await request.json()), client_id: 'synthetic-public-client' });
    if (url.href === `${ISSUER}/token`) {
      tokenRequests.push(new URLSearchParams(await request.text()));
      return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600 });
    }
    assert.fail(`Unexpected outbound destination: ${url.href}`);
  }, async () => {
    const started = await post('/source-oauth/start', { schemaVersion: 1, actionId: gateway.action.actionId,
      sourceId: gateway.source.id, revision: gateway.revision, actorEmail: 'admin@example.com' });
    assert.equal(started.status, 200, await started.clone().text());
    const authorization = new URL((await started.json()).authorizationUrl);
    assert.equal(`${authorization.origin}${authorization.pathname}`, `${ISSUER}/authorize`);
    assert.equal(authorization.searchParams.get('resource'), ENDPOINT);
    assert.equal(authorization.searchParams.has('scope'), false);
    const finished = await post('/source-oauth/callback', { actorEmail: 'admin@example.com',
      state: authorization.searchParams.get('state'), browser: started.headers.get('set-cookie').split(';')[0].split('=')[1],
      code: 'synthetic-code', denied: false, issuer: ISSUER });
    assert.equal(finished.status, 200, await finished.clone().text());
    assert.deepEqual(await finished.json(), { result: 'connected' });
  });
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].get('resource'), ENDPOINT);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].config.resource, ENDPOINT);
  assert.equal(imports[0].tokens.access_token, accessToken);
  assert.equal(serverOf(gateway).hostname, expectedHostname);
  assert.equal(JSON.stringify(gateway.storage.writes).includes(accessToken), false);
  assert.equal(JSON.stringify(gateway.storage.writes).includes(refreshToken), false);
});
