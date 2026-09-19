import { generateKeyPairSync } from 'node:crypto';
import { AdminState } from '../../../payload/worker/index.js';
import { installReadyGateway, ACCOUNT_ID, ZONE_ID, INSTALLATION_ID } from '../../../test/payload-lifecycle.mjs';
import { createBigQuerySetup } from '../src/customer-bigquery-setup';
import { bigQuerySourceNames } from '../src/customer-bigquery-contract';
import { base64UrlDecode } from '../src/crypto';
import { canonicalJson } from '../src/canonical-json';
import { operationSignature } from '../src/customer-operation-secrets';

const GOOGLE_KEY = JSON.stringify({ type: 'service_account', project_id: 'query-project', private_key_id: 'a'.repeat(40),
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey,
  client_email: 'synthetic-reader@query-project.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token' });

async function signedBigQuery(test, claim, fields) {
  const body = canonicalJson({ schemaVersion: 1, actionId: claim.actionId, actionKey: claim.actionKey,
    actorEmail: claim.actorEmail, accountId: ACCOUNT_ID, issuedAt: Date.now(), expiresAt: claim.expiresAt,
    cloudflareAccessToken: 'synthetic-cloudflare-operation-grant', ...fields });
  return test.runtime.fetch(new Request('https://admin-state.invalid/source-actions/bigquery', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      'x-ankka-source-action-signature': await operationSignature(claim.actionKey, body) }, body,
  }));
}

const body = { schemaVersion: 1, label: 'BigQuery analytics', configuration: {
  queryProjectId: 'query-project', allowedDatasets: [{ projectId: 'data-project', datasetId: 'reporting' }],
}, readOnlyConfirmed: true };
async function fixture() {
  const { env, objects } = await installReadyGateway();
  const storage = objects.get('v1:management').storage;
  const runtime = new AdminState({ storage }, env);
  const fetch = vi.fn(async () => { throw new Error('provider refused'); });
  const controller = createBigQuerySetup({ accountId: ACCOUNT_ID, zoneId: ZONE_ID, installationId: INSTALLATION_ID,
    accessIssuer: 'https://example.cloudflareaccess.com', zoneName: 'example.com', managementOrigin: 'https://manage.example.com',
    workerName: 'ankka-gateway', workersSubdomain: 'example', controlPlaneOrigin: 'https://deploy.ankka.ai',
    releaseIdentity: { schemaVersion: 1, channel: 'canary', controlPlaneOrigin: 'https://deploy.ankka.ai', release: 'gateway-v1.0.0',
      keyId: 'test-key', publicKey: 'p'.repeat(43), artifactSha256: 'a'.repeat(64) },
  }, { storage, runtime: (request) => runtime.fetch(request), fetch, runtimeSource: 'export default {}' });
  const sources = await (await runtime.fetch(new Request('https://admin-state.invalid/sources'))).json();
  const prepare = async () => controller.prepare(new Request('https://manage.example.com/api/bigquery', {
    method: 'POST', body: JSON.stringify({ ...body, revision: sources.revision }),
  }), 'admin@example.com', false);
  return { controller, storage, runtime, prepare, fetch };
}

describe('BigQuery setup with the production source-action state machine', () => {
  it('prepares the real source draft and same-origin handoff without a provider credential or grant', async () => {
    const test = await fixture();
    const prepared = await test.prepare();
    expect(prepared.status).toBe(200);
    const result = await prepared.json();
    const claim = JSON.parse(new TextDecoder().decode(base64UrlDecode(new URL(result.handoffUrl).hash.slice(1))));
    expect(claim).toMatchObject({ actionType: 'bigquery_setup', accountId: ACCOUNT_ID, releaseIdentity: { schemaVersion: 1, channel: 'canary' } });
    const current = await test.controller.readSourceAction(result.actionId);
    expect(current?.action.status).toBe('authorization_required');
    expect(current?.record).toMatchObject({ application: null, pending: null, ready: false });
    expect(await (await test.controller.list()).json()).toEqual({ schemaVersion: 1, available: true, setups: [{
      sourceId: result.sourceId, actionId: result.actionId, ready: false, credentialRequired: true,
      recoveryRequired: false, pendingResource: null, failure: null,
    }] });
    const stored = JSON.stringify(test.storage.writes);
    expect(stored).not.toContain(claim.actionKey);
    expect(test.fetch).not.toHaveBeenCalled();
    expect((await test.prepare()).status).toBe(409);
  });
  it('cancels and replaces an unstarted action when resuming; rejects a different operator', async () => {
    const test = await fixture();
    const first = await (await test.prepare()).json();
    const request = () => new Request('https://manage.example.com/api/bigquery/resume', {
      method: 'POST', body: JSON.stringify({ schemaVersion: 1, actionId: first.actionId }),
    });
    expect((await test.controller.prepare(request(), 'different@example.com', true)).status).toBe(409);
    const resumed = await test.controller.prepare(request(), 'admin@example.com', true);
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).actionId).not.toBe(first.actionId);
    expect(test.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['key', 'bigquery_google_key_invalid'],
    ['signing', 'bigquery_google_key_invalid'],
    ['token_network', 'bigquery_google_auth_unavailable'],
    ['token_refused', 'bigquery_google_auth_http_400'],
    ['token_response', 'bigquery_google_auth_response_invalid'],
    ['query_network', 'bigquery_google_query_unavailable'],
    ['query_refused', 'bigquery_google_query_http_403'],
    ['query_text_error', 'bigquery_google_query_rejected'],
    ['query_rpc_error', 'bigquery_google_query_rejected'],
    ['query_envelope', 'bigquery_google_response_invalid'],
    ['query_result', 'bigquery_google_response_invalid'],
  ])('retains %s failure across reads, permits a fresh attempt, and stores no credentials or provider text', async (failure, code) => {
    const test = await fixture();
    const prepared = await (await test.prepare()).json();
    const claim = JSON.parse(new TextDecoder().decode(base64UrlDecode(new URL(prepared.handoffUrl).hash.slice(1))));
    const sentinel = 'synthetic-private-provider-detail';
    test.fetch.mockImplementation(async (input) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        if (failure === 'token_network') throw new Error(sentinel);
        if (failure === 'token_refused') return new Response(sentinel, { status: 400 });
        if (failure === 'token_response') return Response.json({ error: sentinel });
        return Response.json({ access_token: 'synthetic-google-access-token', token_type: 'Bearer', expires_in: 3600 });
      }
      expect(String(input)).toBe('https://bigquery.googleapis.com/mcp');
      if (failure === 'query_network') throw new Error(sentinel);
      if (failure === 'query_refused') return new Response(sentinel, { status: 403 });
      if (failure === 'query_rpc_error') return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: sentinel } });
      if (failure === 'query_envelope') return Response.json({ error: { message: sentinel } });
      return Response.json({ result: { isError: failure === 'query_text_error', content: [{ type: 'text', text: sentinel }] } });
    });
    const input = { actionId: claim.actionId, actionKey: claim.actionKey,
      actorEmail: claim.actorEmail, accessToken: 'synthetic-cloudflare-operation-grant', actionExpiresAt: claim.expiresAt,
      serviceAccountJson: failure === 'key' ? 'synthetic-invalid-google-key'
        : failure === 'signing' ? JSON.stringify({ ...JSON.parse(GOOGLE_KEY), private_key: sentinel }) : GOOGLE_KEY };
    const response = await test.controller.run(input);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: code });
    expect((await test.controller.readSourceAction(claim.actionId))?.action.status).toBe('failed');
    const snapshot = await (await test.runtime.fetch(new Request('https://admin-state.invalid/source-actions',
      { headers: { 'x-ankka-actor-email': claim.actorEmail } }))).json();
    expect(snapshot).toMatchObject({ blockingAction: null, actions: [{ state: 'failed', failureCode: code, canCancel: false }] });
    expect((await test.controller.readSourceAction(claim.actionId))?.record).toMatchObject({
      application: null, workerVersion: null, domainId: null, pending: null });
    const providerCalls = test.fetch.mock.calls.length;
    expect((await test.controller.run(input)).status).toBe(409);
    expect(test.fetch).toHaveBeenCalledTimes(providerCalls);
    const resumed = await test.controller.prepare(new Request('https://manage.example.com/api/bigquery/resume', {
      method: 'POST', body: JSON.stringify({ schemaVersion: 1, actionId: claim.actionId }),
    }), claim.actorEmail, true);
    expect(resumed.status).toBe(200);
    const next = await resumed.json();
    expect(next.actionId).not.toBe(claim.actionId);
    expect((await test.controller.readSourceAction(next.actionId))?.action.status).toBe('authorization_required');
    const stored = JSON.stringify(test.storage.writes);
    for (const secret of ['synthetic-invalid-google-key', JSON.parse(GOOGLE_KEY).private_key,
      'synthetic-google-access-token', input.accessToken, claim.actionKey, sentinel]) expect(stored).not.toContain(secret);
  });
  it('refuses arbitrary diagnostic text and cannot turn a started deployment into a terminal preflight failure', async () => {
    const test = await fixture();
    const prepared = await (await test.prepare()).json();
    const claim = JSON.parse(new TextDecoder().decode(base64UrlDecode(new URL(prepared.handoffUrl).hash.slice(1))));
    expect((await signedBigQuery(test, claim, { bigqueryPhase: 'preflight_failed', bigqueryFailureCode: 'private-provider-text' })).status).toBe(409);
    expect((await signedBigQuery(test, claim, { bigqueryPhase: 'start' })).status).toBe(200);
    expect((await signedBigQuery(test, claim, { bigqueryPhase: 'preflight_failed', bigqueryFailureCode: 'bigquery_google_key_invalid' })).status).toBe(409);
    expect((await test.controller.readSourceAction(claim.actionId))?.action.status).toBe('applying');
    expect(JSON.stringify(test.storage.writes)).not.toContain('private-provider-text');
  });
  it.each(['collision', 'access_denied'])('retains provisioning write evidence and guards recovery after %s', async (outcome) => {
    const test = await fixture();
    const prepared = await (await test.prepare()).json();
    const claim = JSON.parse(new TextDecoder().decode(base64UrlDecode(new URL(prepared.handoffUrl).hash.slice(1))));
    const current = await test.controller.readSourceAction(claim.actionId);
    test.fetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-google-access-token', token_type: 'Bearer', expires_in: 3600 });
      if (url === 'https://bigquery.googleapis.com/mcp') return Response.json({ result: { content: [{ type: 'text', text: '{"jobComplete":true}' }] } });
      if (url.includes('/access/apps?')) return Response.json({ success: true, result: outcome === 'collision' ? [{ name: 'foreign', domain: current.record.hostname }] : [] });
      if (url.endsWith(`/zones/${ZONE_ID}/access/apps`)) return Response.json({ errors: [{ message: 'synthetic-provider-detail' }] }, { status: 403 });
      throw new Error('unexpected synthetic destination');
    });
    const key = JSON.stringify({ type: 'service_account', project_id: 'query-project', private_key_id: 'a'.repeat(40),
      private_key: generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey,
      client_email: 'synthetic-reader@query-project.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token' });
    const result = await test.controller.run({ actionId: claim.actionId, actionKey: claim.actionKey, actorEmail: claim.actorEmail,
      accessToken: 'synthetic-cloudflare-operation-grant', actionExpiresAt: claim.expiresAt, serviceAccountJson: key });
    expect(await result.json()).toEqual({ error: outcome === 'collision' ? 'bigquery_resource_collision' : 'bigquery_setup_failed' });
    expect(await (await test.controller.list()).json()).toEqual({ schemaVersion: 1, available: true, setups: [{
      sourceId: prepared.sourceId, actionId: claim.actionId, ready: false, credentialRequired: true,
      recoveryRequired: outcome === 'access_denied', pendingResource: outcome === 'access_denied' ? 'application' : null,
      failure: outcome === 'access_denied' ? { stage: 'application', httpStatus: 403 } : null,
    }] });
    const snapshot = await (await test.runtime.fetch(new Request('https://admin-state.invalid/source-actions', { headers: { 'x-ankka-actor-email': claim.actorEmail } }))).json();
    expect(snapshot.actions[0]).toMatchObject({ state: 'recovery_required', failureCode: 'bigquery_setup_required', canCancel: false, canRenew: true });
    const resumed = await test.controller.prepare(new Request('https://manage.example.com/api/bigquery/resume', { method: 'POST',
      body: JSON.stringify({ schemaVersion: 1, actionId: claim.actionId }) }), claim.actorEmail, true);
    expect(resumed.status).toBe(outcome === 'collision' ? 200 : 409);
    if (outcome === 'collision') expect((await resumed.json()).actionId).toBe(claim.actionId);
    expect(JSON.stringify(test.storage.writes)).not.toContain(JSON.parse(key).private_key);
    expect(JSON.stringify(test.storage.writes)).not.toContain('synthetic-provider-detail');
  });
  it('normalizes dataset order so retries name the same bridge and source', async () => {
    const datasets = [...body.configuration.allowedDatasets, { projectId: 'other-project', datasetId: 'reports' }];
    const first = await bigQuerySourceNames(INSTALLATION_ID, 'example.com', { ...body.configuration, allowedDatasets: datasets });
    const second = await bigQuerySourceNames(INSTALLATION_ID, 'example.com', { ...body.configuration, allowedDatasets: datasets.reverse() });
    expect(second).toEqual(first);
  });
});
