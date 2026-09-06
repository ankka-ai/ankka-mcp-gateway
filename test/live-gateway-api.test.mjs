import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveGatewayApi } from '../tools/live-gateway-api.mjs';
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
