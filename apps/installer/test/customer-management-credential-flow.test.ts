import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error The payload is validated as a release input, not a TS package.
import payloadWorker, { AdminState as PayloadAdminState } from '../../../payload/worker/index.js';
import type { BoundaryObject, BoundaryValue } from '../src/boundary';
import { buildFixedRelayAuthorization, relayCloudflareAuthorizationCode } from '../src/cloudflare-code-relay';
import { base64UrlDecode, base64UrlEncode } from '../src/crypto';
import type { CustomerCloudflareTransport } from '../src/customer-cloudflare-grant';
import { CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH, CUSTOMER_OPERATION_OAUTH_START_PATH } from '../src/customer-install-paths';
import { customerManagementCredentialControlRequest } from '../src/customer-management-credential-control';
import {
  CUSTOMER_OPERATION_COOKIE,
  createCustomerOperationRouter,
  type CustomerOperationAttempt,
} from '../src/customer-operation-router';

/**
 * The whole Settings flow with both real halves joined: the payload Worker
 * that prepares the change, records it and holds the lifecycle lock, and the
 * operation router that serves the paste page and writes the secret. Only
 * Cloudflare and the relay's seal are stand-ins. The contract between the two
 * halves (the handoff claim, the action view, the signed commands) is what a
 * unit test of either side alone cannot break.
 */
const ORIGIN = 'https://manage.example.com';
const ACCOUNT_ID = 'a'.repeat(32);
const INSTALL_ID = `acg-${'b'.repeat(24)}`;
const CLIENT_ID = 'c'.repeat(32);
const RELEASE = 'gateway-v0.1.34';
const ARTIFACT_SHA256 = 'f'.repeat(64);
const ISSUER = 'https://tenant.cloudflareaccess.com';
const AUDIENCE = 'access-audience-tag';
const ADMIN = 'admin@example.com';
const GRANT = `grant_${'d'.repeat(32)}`;
const RELAY_KEY = base64UrlEncode(new Uint8Array(32).fill(9));
// A synthetic value in Cloudflare's account token form, assembled at run time.
const PASTED_VALUE = `cfat_${'Zt4q'.repeat(10)}${'7b'.repeat(4)}`;
const ACTION_KEY = 'ankka-mcp-gateway/management-credential-action/v1';

const preparedSchema = v.strictObject({
  schemaVersion: v.literal(1), actionId: v.string(), status: v.literal('authorization_required'),
  expiresAt: v.string(), handoffUrl: v.string(),
});
const startedSchema = v.strictObject({ schemaVersion: v.literal(1), authorizationUrl: v.string() });
const answerSchema = v.strictObject({
  schemaVersion: v.literal(1), result: v.string(), reason: v.nullable(v.string()), redirectUrl: v.string(),
});
const snapshotSchema = v.looseObject({ blockingAction: v.nullable(v.looseObject({ kind: v.string(), actionId: v.string() })) });
const viewSchema = v.looseObject({ actionId: v.string(), status: v.string(), expiresAt: v.string() });

interface ManagementObject { fetch(request: Request): Promise<Response> }

/** The management object's storage, holding exactly the plain data the payload puts there. */
class MemoryStorage {
  readonly values = new Map<string, BoundaryValue>();
  async get(key: string): Promise<BoundaryValue | undefined> { return structuredClone(this.values.get(key)); }
  async put(key: string, value: BoundaryValue): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  serialized(): string { return JSON.stringify([...this.values]); }
}

async function gateway() {
  const storage = new MemoryStorage();
  // The one management object answers for every name, as the gateway's namespace does for `v1:management`.
  const objects = new Map<string, ManagementObject>();
  const env = {
    ADMIN_STATE: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (request: Request) => objects.get('v1:management')?.fetch(request) ?? new Response(null, { status: 503 }) }),
    },
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_ZONE_ID: 'e'.repeat(32), CLOUDFLARE_ZONE_NAME: 'example.com',
    ANKKA_INSTALL_ID: INSTALL_ID, ANKKA_GATEWAY_RELEASE: RELEASE, ANKKA_GATEWAY_RELEASE_SHA256: `sha256:${ARTIFACT_SHA256}`,
    ANKKA_MANAGEMENT_HOSTNAME: 'manage.example.com', ANKKA_UPDATE_CHANNEL: 'stable', ANKKA_UPDATE_KEY_ID: 'test-release-key',
    ANKKA_UPDATE_PUBLIC_KEY: 'A'.repeat(43), ANKKA_WORKERS_SUBDOMAIN: 'tenant', ANKKA_WORKER_NAME: 'ankka-gateway-test',
    ZERO_TRUST_READY: 'true', ADMIN_EMAILS: ADMIN, CF_ACCESS_AUD: AUDIENCE, CF_ACCESS_ISSUER: ISSUER,
  };
  const management: ManagementObject = new PayloadAdminState({ storage }, env);
  objects.set('v1:management', management);

  // An administrator's Access assertion, verified by the payload against the issuer's published key.
  const keys = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  // Each fixture publishes a newly generated key, so it needs its own signing-key ID.
  const kid = `synthetic-flow-key-${crypto.randomUUID()}`;
  const encode = (value: BoundaryObject) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode({
    iss: ISSUER, aud: [AUDIENCE], email: ADMIN, nbf: now - 1, exp: now + 300,
  })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned));
  const access = {
    'cf-access-authenticated-user-email': ADMIN,
    'cf-access-jwt-assertion': `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`,
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = v.is(v.instance(Request), input) ? input.url : String(input);
    if (url === `${ISSUER}/cdn-cgi/access/certs`) return Response.json({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
    throw new Error('unexpected network request');
  });

  const internal = (path: string, init?: RequestInit) => management.fetch(new Request(`https://admin-state.invalid${path}`, init));
  const prepare = () => payloadWorker.fetch(new Request(`${ORIGIN}/api/management-credential/actions`, {
    method: 'POST', headers: { ...access, origin: ORIGIN, 'content-type': 'application/json' }, body: '{"schemaVersion":1}',
  }), env);

  // Cloudflare: the exchange, the account probe, the one secret write, the revocation.
  const calls: { method: string; url: string; body: string }[] = [];
  const cloudflare: CustomerCloudflareTransport = async (input, init) => {
    const request = new Request(input, init);
    calls.push({ method: request.method, url: request.url, body: await request.text() });
    if (request.url.endsWith('/oauth2/token')) return Response.json({ access_token: GRANT, token_type: 'bearer', scope: 'workers-scripts.write' });
    if (request.url.endsWith('/oauth2/revoke')) return Response.json({ revoked: true });
    if (request.url.endsWith('/secrets')) return new Response('{"success":true}', { status: 201 });
    return Response.json({ success: true, errors: [], messages: [], result: {} });
  };

  let attempt: CustomerOperationAttempt | null = null;
  const attemptWrites: string[] = [];
  const router = createCustomerOperationRouter({
    accountId: ACCOUNT_ID, installId: INSTALL_ID, publicClientId: CLIENT_ID, managementOrigin: ORIGIN,
    workerName: 'ankka-gateway-test', workersSubdomain: 'tenant', release: RELEASE, artifactSha256: ARTIFACT_SHA256,
  }, {
    attempts: {
      read: async () => attempt,
      write: async (next) => { attempt = next; attemptWrites.push(JSON.stringify(next)); },
      clear: async () => { attempt = null; },
    },
    transport: cloudflare,
    assertOperational: async () => undefined,
    readSourceAction: async () => null,
    readRuntimeAction: async () => null,
    // As the gateway entrypoint wires them: the payload's own internal routes, in process.
    readManagementCredentialAction: async (actionId) => {
      const response = await internal(`/management-credential-actions/${actionId}`);
      if (response.status !== 200) return null;
      const view = v.parse(viewSchema, await response.json());
      return { status: view.status, expiresAt: Date.parse(view.expiresAt) };
    },
    controlManagementCredentialAction: async (control) =>
      (await management.fetch(await customerManagementCredentialControlRequest(control, Date.now()))).status === 200,
    verifyAdministrator: async () => ADMIN,
    issueRelayTicket: async () => ({ relayTicket: `${'r'.repeat(64)}.${'s'.repeat(43)}`, expiresAt: Date.now() + 120_000 }),
    beginRelay: ({ operation, gatewayState, pkceChallenge, gatewayCallback }) => buildFixedRelayAuthorization({
      clientId: CLIENT_ID, relayStateKey: RELAY_KEY, gateway: { accountId: ACCOUNT_ID, installId: INSTALL_ID, callback: gatewayCallback },
      operation, gatewayState, pkceChallenge, nonce: base64UrlEncode(new Uint8Array(32).fill(8)), now: Date.now(),
    }),
    applySourceAction: async () => new Response(null, { status: 500 }),
    startRuntimeUpdate: async () => 'failed',
    updateView: async () => null,
  });

  const blocking = async () => v.parse(snapshotSchema, await (await internal('/source-actions', { headers: { 'x-ankka-actor-email': ADMIN } })).json()).blockingAction;
  return { storage, management, prepare, router, calls, attemptWrites, blocking, recorded: () => storage.values.get(ACTION_KEY) };
}

/** Settings → operation page → Cloudflare → the relay → the gateway's callback, as the browser walks it. */
async function approve(f: Awaited<ReturnType<typeof gateway>>, handoffUrl: string) {
  const handoff = new URL(handoffUrl);
  expect(`${handoff.origin}${handoff.pathname}`).toBe(`${ORIGIN}/__ankka/operation`);
  const started = await f.router.fetch(new Request(`${ORIGIN}${CUSTOMER_OPERATION_OAUTH_START_PATH}`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, handoff: handoff.hash.slice(1) }),
  }));
  expect(started.status, await started.clone().text()).toBe(200);
  const cookie = started.headers.getSetCookie().find((value) => value.startsWith(`${CUSTOMER_OPERATION_COOKIE}=`))?.split(';', 1)[0] ?? '';
  const authorization = new URL(v.parse(startedSchema, await started.json()).authorizationUrl);
  expect(authorization.searchParams.get('scope')).toBe('workers-scripts.write');
  const relayed = await relayCloudflareAuthorizationCode({
    code: `code_${'e'.repeat(32)}`, state: authorization.searchParams.get('state') ?? '', relayStateKey: RELAY_KEY, now: Date.now(),
  });
  return { cookie, callback: new URL(relayed.location) };
}

describe('Settings management token flow, payload and router joined', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('prepares, approves, pastes once, writes one secret, and gives the lock back, with the value in exactly one request', async () => {
    const f = await gateway();
    const response = await f.prepare();
    expect(response.status, await response.clone().text()).toBe(200);
    const prepared = v.parse(preparedSchema, await response.json());
    expect(await f.blocking()).toEqual({ kind: 'management_credential', actionId: prepared.actionId });

    const { cookie, callback } = await approve(f, prepared.handoffUrl);
    const page = await f.router.fetch(new Request(callback, { headers: { cookie } }));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Ankka gateway manage.example.com');
    expect(f.calls).toEqual([]);

    const pasted = await f.router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH}`, {
      method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), managementToken: PASTED_VALUE }),
    }));
    const serialized = await pasted.text();
    expect(v.parse(answerSchema, JSON.parse(serialized))).toEqual({
      schemaVersion: 1, result: 'applied', reason: null,
      redirectUrl: `${ORIGIN}/settings?managementCredentialAction=${prepared.actionId}&managementCredentialActionResult=applied`,
    });

    expect(f.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /oauth2/token',
      `GET /client/v4/accounts/${ACCOUNT_ID}/workers/workers/ankka-gateway-test`,
      `PUT /client/v4/accounts/${ACCOUNT_ID}/workers/scripts/ankka-gateway-test/secrets`,
      'POST /oauth2/revoke',
    ]);
    // The value: in the one write, and in nothing the gateway stores, records, sets or answers.
    expect(f.calls.filter((call) => call.body.includes(PASTED_VALUE)).map((call) => call.method)).toEqual(['PUT']);
    expect(f.storage.serialized()).not.toContain(PASTED_VALUE);
    expect(f.attemptWrites.join('\n')).not.toContain(PASTED_VALUE);
    expect(serialized).not.toContain(PASTED_VALUE);
    expect(pasted.headers.getSetCookie().join('\n')).not.toContain(PASTED_VALUE);
    expect(f.storage.serialized()).not.toContain(GRANT);

    // The payload accepted the router's signed commands: begun, completed, and the lock is back.
    expect(f.recorded()).toMatchObject({ actionId: prepared.actionId, status: 'succeeded', failureCode: null, actorEmail: ADMIN });
    expect(await f.blocking()).toBeNull();
  });

  it('records every way the router ends a change without a write, in words the payload accepts, and unlocks at once', async () => {
    for (const failureCode of [
      'approval_expired', 'authorization_unavailable', 'authorization_denied', 'cancelled', 'paste_page_closed',
      'action_unavailable', 'attempt_invalid', 'unexpected', 'secret_write_refused', 'secret_write_unconfirmed',
      'secret_write_http_403', 'grant_scope_mismatch', 'grant_account_mismatch', 'grant_provider_unavailable_not_json_http_502',
    ]) {
      const f = await gateway();
      const prepared = v.parse(preparedSchema, await (await f.prepare()).json());
      const claim = v.parse(v.looseObject({ actionKey: v.string(), expiresAt: v.number() }),
        JSON.parse(new TextDecoder().decode(base64UrlDecode(new URL(prepared.handoffUrl).hash.slice(1)))));
      expect(await f.blocking()).not.toBeNull();
      const ended = await f.management.fetch(await customerManagementCredentialControlRequest({
        actionId: prepared.actionId, actionKey: claim.actionKey, actionExpiresAt: claim.expiresAt, command: 'fail', failureCode,
      }, Date.now()));
      expect(ended.status, failureCode).toBe(200);
      expect(f.recorded()).toMatchObject({ status: 'failed', failureCode });
      expect(await f.blocking()).toBeNull();
      vi.unstubAllGlobals();
    }
  });
});
