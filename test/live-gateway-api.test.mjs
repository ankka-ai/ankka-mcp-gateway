import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveGatewayApi, createLiveGatewayServiceApi } from '../tools/live-gateway-api.mjs';
import { proveServiceIdentity, summarizeLiveJournal, validateLiveManagementConfig } from '../tools/live-gateway-command.mjs';

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
  assert.equal(result.serviceIdentity, null);
  assert.equal(result.rootRemoval, null);
  assert.deepEqual(summarizeLiveJournal({ ...state, events: [...state.events,
    { stage: 'root_removal', status: 'failed', stepsDone: 1, stepCount: 5, failureReason: 'worker_bindings_provider_unknown', canAuthorize: true, revocationUnconfirmed: true }] }).rootRemoval,
  { status: 'failed', stepsDone: 1, stepCount: 5, failureReason: 'worker_bindings_provider_unknown', complete: false, revocationUnconfirmed: true });
  assert.equal(summarizeLiveJournal({ ...state, qualified: true }).qualified, false);
  // The service proof is summarized by outcome and layer, never by identity or secret.
  const proven = summarizeLiveJournal({ ...state, events: [
    { stage: 'service_identity', status: 'passed', httpStatus: 200, layer: 'admitted' },
    { stage: 'service_rejection', status: 'foreign_identity_refused', httpStatus: 302, layer: 'access_edge', code: null },
    { stage: 'service_rejection', status: 'operations_refused', httpStatus: 403, layer: 'gateway', code: 'service_operation_denied' },
    ...state.events] });
  assert.deepEqual(proven.serviceIdentity, { admitted: true, operationsRefused: true, foreignIdentity: { httpStatus: 302, layer: 'access_edge' } });
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
    if (url.endsWith('/api/update-actions')) return new Response(JSON.stringify({ schemaVersion: 1, error: 'service_operation_denied' }), { status: 403, headers: { 'content-type': 'application/json' } });
    return json({ schemaVersion: 1 });
  } });
  assert.deepEqual(await api.request('/api/team'), { schemaVersion: 1 });
  assert.equal(calls[0].options.headers['cf-access-client-id'], clientId);
  assert.equal(calls[0].options.headers['cf-access-client-secret'], secret);
  assert.equal(calls[0].options.headers.cookie, undefined);
  assert.equal(calls[0].options.headers.origin, origin);
  assert.deepEqual(await api.probe('/api/update-actions', { method: 'POST', body: { schemaVersion: 1 } }), { status: 403, layer: 'gateway', code: 'service_operation_denied' });
  assert.deepEqual(await api.probe('/api/team'), { status: 200, layer: 'admitted', code: null });
  await assert.rejects(api.request('/api/update-actions', { method: 'POST', body: {} }), { code: 'api_request_outside_qualification' });
  assert.throws(() => createLiveGatewayServiceApi({ origin, clientId: 'bad', secret }), { code: 'service_credential_invalid' });
  assert.throws(() => createLiveGatewayServiceApi({ origin, clientId, secret: 'short' }), { code: 'service_credential_invalid' });
});

test('a probe names the layer that refused: the gateway by its fixed JSON body, the Access edge by its own pages', async () => {
  const clientId = `${'a'.repeat(32)}.access`;
  const secret = 'b'.repeat(64);
  const answering = (response) => createLiveGatewayServiceApi({ origin, clientId, secret, transport: async () => response });
  const gatewayJson = (status, error) => new Response(JSON.stringify({ schemaVersion: 1, error }), { status, headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await answering(gatewayJson(401, 'access_required')).probe('/api/status'), { status: 401, layer: 'gateway', code: 'access_required' });
  assert.deepEqual(await answering(gatewayJson(403, 'service_operation_denied')).probe('/api/team'), { status: 403, layer: 'gateway', code: 'service_operation_denied' });
  // The edge's 403 page is HTML; a JSON body that is not the gateway's fixed shape is not the gateway's refusal either.
  assert.deepEqual(await answering(new Response('<html>forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } })).probe('/api/status'), { status: 403, layer: 'access_edge', code: null });
  assert.deepEqual(await answering(new Response(JSON.stringify({ error: 'service_operation_denied' }), { status: 403, headers: { 'content-type': 'application/json' } })).probe('/api/status'), { status: 403, layer: 'access_edge', code: null });
  assert.deepEqual(await answering(new Response(null, { status: 503 })).probe('/api/status'), { status: 503, layer: 'unknown', code: null });
  // An oversized body is never parsed as the gateway's refusal.
  assert.deepEqual(await answering(new Response(`{"schemaVersion":1,"error":"${'x'.repeat(20_000)}"}`, { status: 403, headers: { 'content-type': 'application/json' } })).probe('/api/status'), { status: 403, layer: 'access_edge', code: null });
});

test('the service proof admits the approved identity first, then records each refusal by the layer that answered', async () => {
  const approved = `${'a'.repeat(32)}.access`, foreign = `${'c'.repeat(32)}.access`;
  const login = 'https://team.cloudflareaccess.com/cdn-cgi/access/login/manage.example.com?kid=x';
  const gatewayJson = (status, error) => new Response(JSON.stringify({ schemaVersion: 1, error }), { status, headers: { 'content-type': 'application/json' } });
  const config = { managementOrigin: origin, serviceAccess: { clientId: approved, tokenId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    secret: { env: 'ANKKA_APPROVED_SECRET' }, foreign: { clientId: foreign, secret: { env: 'ANKKA_FOREIGN_SECRET' } } } };
  const credential = async (reference) => reference.env === 'ANKKA_APPROVED_SECRET' ? 'a'.repeat(64) : 'c'.repeat(64);
  const calls = [], events = [];
  const transport = async (url, options) => {
    const identity = options.headers['cf-access-client-id'];
    calls.push(`${identity === approved ? 'approved' : 'foreign'} ${options.method ?? 'GET'} ${new URL(url).pathname}`);
    if (identity === foreign) return new Response(null, { status: 302, headers: { location: login } });
    return url.endsWith('/api/status') ? json({ schemaVersion: 1 }) : gatewayJson(403, 'service_operation_denied');
  };
  const api = await proveServiceIdentity({ config, checkpoint: async (event) => events.push(event), transport, credential });
  assert.deepEqual(events, [
    { stage: 'service_identity', status: 'passed', httpStatus: 200, layer: 'admitted' },
    { stage: 'service_rejection', status: 'foreign_identity_refused', httpStatus: 302, layer: 'access_edge', code: null },
    { stage: 'service_rejection', status: 'operations_refused', httpStatus: 403, layer: 'gateway', code: 'service_operation_denied' },
  ]);
  assert.deepEqual(calls, ['approved GET /api/status', 'foreign GET /api/status', 'approved POST /api/update-actions', 'approved POST /api/teardown-actions',
    `approved DELETE /api/source-actions/action_${'A'.repeat(32)}`, `approved GET /api/update-actions/action_${'A'.repeat(32)}`]);
  assert.deepEqual(await api.request('/api/status'), { schemaVersion: 1 });
  // A foreign identity the gateway itself refuses is still a refusal, recorded at its layer.
  const gatewayRefusesForeign = async (url, options) => options.headers['cf-access-client-id'] === foreign ? gatewayJson(401, 'access_required') : transport(url, options);
  const recorded = [];
  await proveServiceIdentity({ config, checkpoint: async (event) => recorded.push(event), transport: gatewayRefusesForeign, credential });
  assert.deepEqual(recorded[1], { stage: 'service_rejection', status: 'foreign_identity_refused', httpStatus: 401, layer: 'gateway', code: 'access_required' });
  // Admitting the foreign identity, refusing the approved one, or an operation refused by the edge instead of the gateway all fail the proof.
  for (const [answer, code] of [
    [async (url, options) => options.headers['cf-access-client-id'] === foreign ? json({ schemaVersion: 1 }) : transport(url, options), 'service_foreign_identity_not_refused'],
    [async () => new Response(null, { status: 302, headers: { location: login } }), 'service_identity_not_admitted'],
    [async (url, options) => url.endsWith('/api/status') && options.headers['cf-access-client-id'] === approved ? json({ schemaVersion: 1 })
      : options.headers['cf-access-client-id'] === foreign ? new Response(null, { status: 302, headers: { location: login } })
        : new Response('<html>forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } }), 'service_operation_not_refused'],
  ]) {
    await assert.rejects(proveServiceIdentity({ config, checkpoint: async () => {}, transport: answer, credential }), { code });
  }
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
  // The identity is refused at the edge: the probe reports the redirect by status and layer instead of erroring.
  assert.deepEqual(await edge.probe('/api/status'), { status: 302, layer: 'access_edge', code: null });
  assert.equal(calls.at(-1).options.redirect, 'manual');
  // The exercise itself still treats any redirect as a rejected session.
  await assert.rejects(edge.request('/api/team'), { code: 'access_session_rejected' });
  // A redirect anywhere other than the Access login page is not refusal evidence.
  await assert.rejects(redirecting('https://elsewhere.example.com/').probe('/api/status'), { code: 'access_session_rejected' });
  await assert.rejects(redirecting('not a url').probe('/api/status'), { code: 'access_session_rejected' });
});
