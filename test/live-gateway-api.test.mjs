import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveGatewayApi, createLiveGatewayServiceApi } from '../tools/live-gateway-api.mjs';
import { summarizeLiveJournal, validateLiveManagementConfig } from '../tools/live-gateway-command.mjs';

const origin = 'https://manage.example.com';
const email = 'operator@example.com';
const token = (claims = {}) => `synthetic.${Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url')}.synthetic`;
const run = async () => ({ stdout: token() });
const json = (value) => Response.json(value);

test('API mode sends only cached Access identity to the fixed origin and never follows redirects', async () => {
  const calls = [];
  const credential = token();
  const api = createLiveGatewayApi({ origin, email, run: async () => ({ stdout: credential }), transport: async (url, options) => {
    calls.push({ url, options }); return json(url.endsWith('/get-identity') ? { email } : { schemaVersion: 1 });
  } });
  await api.checkAccess();
  assert.deepEqual(await api.request('/api/team'), { schemaVersion: 1 });
  assert.equal(calls[1].url, origin + '/api/team');
  assert.equal(calls[1].options.headers.cookie, `CF_Authorization=${credential}`);
  assert.equal(calls[1].options.headers.authorization, undefined);
  assert.equal(calls[1].options.redirect, 'error');
  for (const [path, options] of [['https://other.example.com/api/team', {}], ['/api/team?token=x', {}],
    ['/api/team', { method: 'DELETE' }], ['/api/update-actions', { method: 'POST' }]]) {
    await assert.rejects(api.request(path, options), { code: 'api_request_outside_qualification' });
  }
  assert.equal(calls.length, 2);
});

test('expired or wrong-account authentication fails before any network call', async () => {
  for (const claims of [{ exp: 0 }, { email: 'other@example.com' }]) {
    const api = createLiveGatewayApi({ origin, email, run: async () => ({ stdout: token(claims) }), transport: assert.fail });
    await assert.rejects(api.checkAccess(), { code: claims.exp === 0 ? 'access_login_required' : 'access_identity_mismatch' });
  }
});

test('lost mutation is never retried and raw errors cannot expose credentials', async () => {
  let calls = 0;
  const secret = token();
  const api = createLiveGatewayApi({ origin, email, run, transport: async () => { calls++; throw new Error(secret); } });
  await assert.rejects(api.request('/api/team-actions', { method: 'POST', body: { members: [] } }), (error) => {
    assert.equal(error.code, 'api_request_failed');
    assert.equal(error.stack.includes(secret), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test('redirects, login pages, oversized and malformed responses cannot pass an API check', async () => {
  for (const [response, code] of [
    [new Response(null, { status: 302, headers: { location: 'https://other.example.com' } }), 'access_session_rejected'],
    [new Response('login', { headers: { 'content-type': 'text/html' } }), 'api_response_invalid'],
    [new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'application/json' } }), 'api_response_too_large'],
    [new Response('{', { headers: { 'content-type': 'application/json' } }), 'api_request_failed'],
  ]) {
    const api = createLiveGatewayApi({ origin, email, run, transport: async () => response });
    await assert.rejects(api.request('/api/team'), { code });
  }
});

test('management config is independent of release artifacts, browser and infrastructure credentials', () => {
  const config = { schemaVersion: 1, managementOrigin: origin, adminEmail: email,
    journal: '/private/test/management.json', source: { url: 'https://synthetic.example.com/mcp', tool: 'synthetic_status' } };
  assert.deepEqual(validateLiveManagementConfig(config), config);
  assert.throws(() => validateLiveManagementConfig({ ...config, token: 'must-not-be-in-config' }));
  assert.throws(() => validateLiveManagementConfig({ ...config, managementOrigin: 'http://manage.example.com' }));
  // The service identity enters the config by reference only: client and token ids are public, the secret stays in the store.
  const serviceAccess = { clientId: `${'a'.repeat(32)}.access`, tokenId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    secret: { keychain: { service: 'ankka-lifecycle-runner', account: 'access-client-secret' } },
    foreign: { clientId: `${'b'.repeat(32)}.access`, secret: { env: 'ANKKA_FOREIGN_SERVICE_SECRET' } } };
  assert.deepEqual(validateLiveManagementConfig({ ...config, serviceAccess }), { ...config, serviceAccess });
  assert.throws(() => validateLiveManagementConfig({ ...config, serviceAccess: { ...serviceAccess, secret: 'literal-secret-value-not-allowed' } }));
  assert.throws(() => validateLiveManagementConfig({ ...config, serviceAccess: { ...serviceAccess, clientId: 'not-a-client-id' } }));
});

test('API passes and recovery receipts never imply full lifecycle qualification', () => {
  const state = { schemaVersion: 1, scope: 'management_api', qualified: false, events: [
    { stage: 'management_api', status: 'passed' },
    { stage: 'root_removal', status: 'receipt_saved', handoff: 'private-receipt' },
    { stage: 'command', status: 'stopped', failureCode: 'api_request_failed' },
  ] };
  const result = summarizeLiveJournal(state);
  assert.equal(result.qualified, false);
  assert.equal(result.removalReceiptAvailable, true);
  assert.equal(JSON.stringify(result).includes('private-receipt'), false);
  assert.deepEqual(result.passed, ['management_api']);
  assert.equal(result.failureCode, 'api_request_failed');
  assert.equal(summarizeLiveJournal({ ...state, qualified: true }).qualified, false);
});

test('Access preflight requires the provider identity and rejects an HTML login page', async () => {
  for (const response of [json({ email: 'other@example.com' }), json({}), new Response('login')]) {
    const api = createLiveGatewayApi({ origin, email, run, transport: async () => response });
    await assert.rejects(api.checkAccess());
  }
});

test('service mode sends only the service-token headers, needs no cached session, and reports refusals as evidence', async () => {
  const calls = [];
  const clientId = `${'a'.repeat(32)}.access`;
  const secret = 'b'.repeat(64);
  const api = createLiveGatewayServiceApi({ origin, clientId, secret, transport: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/update-actions')) return new Response(JSON.stringify({ error: 'service_operation_denied' }), { status: 403, headers: { 'content-type': 'application/json' } });
    return json({ schemaVersion: 1 });
  } });
  assert.deepEqual(await api.request('/api/team'), { schemaVersion: 1 });
  assert.equal(calls[0].options.headers['cf-access-client-id'], clientId);
  assert.equal(calls[0].options.headers['cf-access-client-secret'], secret);
  assert.equal(calls[0].options.headers.cookie, undefined);
  assert.equal(calls[0].options.headers.origin, origin);
  assert.equal(await api.probe('/api/update-actions', { method: 'POST', body: { schemaVersion: 1 } }), 403);
  assert.equal(await api.probe('/api/team'), 200);
  await assert.rejects(api.request('/api/update-actions', { method: 'POST', body: {} }), { code: 'api_request_outside_qualification' });
  assert.throws(() => createLiveGatewayServiceApi({ origin, clientId: 'bad', secret }), { code: 'service_credential_invalid' });
  assert.throws(() => createLiveGatewayServiceApi({ origin, clientId, secret: 'short' }), { code: 'service_credential_invalid' });
});

test('service mode observes an Access login redirect as refusal evidence and never follows it', async () => {
  const clientId = `${'a'.repeat(32)}.access`;
  const secret = 'b'.repeat(64);
  const login = 'https://team.cloudflareaccess.com/cdn-cgi/access/login/manage.example.com?kid=x';
  const calls = [];
  const redirecting = (location) => createLiveGatewayServiceApi({ origin, clientId, secret, transport: async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 302, headers: { location } });
  } });
  const edge = redirecting(login);
  // The identity is refused at the edge: the probe reports the redirect by status instead of erroring.
  assert.equal(await edge.probe('/api/status'), 302);
  assert.equal(calls.at(-1).options.redirect, 'manual');
  // The exercise itself still treats any redirect as a rejected session.
  await assert.rejects(edge.request('/api/team'), { code: 'access_session_rejected' });
  // A redirect anywhere other than the Access login page is not refusal evidence.
  await assert.rejects(redirecting('https://elsewhere.example.com/').probe('/api/status'), { code: 'access_session_rejected' });
  await assert.rejects(redirecting('not a url').probe('/api/status'), { code: 'access_session_rejected' });
});
