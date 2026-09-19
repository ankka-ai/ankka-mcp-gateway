import * as v from 'valibot';

import type { BoundaryValue } from '../src/boundary';
import { canonicalJson } from '../src/canonical-json';
import {
  buildFixedRelayAuthorization,
  relayCloudflareAuthorizationCode,
} from '../src/cloudflare-code-relay';
import { base64UrlDecode, base64UrlEncode } from '../src/crypto';
import type { CustomerCloudflareTransport } from '../src/customer-cloudflare-grant';
import {
  CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH,
  CUSTOMER_OPERATION_OAUTH_START_PATH,
  CUSTOMER_OPERATION_ROOT_PATH,
  CUSTOMER_OPERATION_UPDATE_PATH,
  CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH,
} from '../src/customer-install-paths';
import {
  CUSTOMER_SERVING_RELEASE_HEADER, CustomerRuntimeUpdateDriver, customerUpdateProgressSchema, type CustomerUpdateOutcome,
} from '../src/customer-update-driver';
import {
  CUSTOMER_OPERATION_COOKIE,
  createCustomerOperationRouter,
  customerOperationCookiePresent,
  type CustomerManagementCredentialControl,
  type CustomerOperationActionView,
  type CustomerOperationAttempt,
  type CustomerOperationAttemptPort,
  type CustomerOperationResult,
  type CustomerOperationRouterDependencies,
  type CustomerOperationRuntimeUpdateInput,
} from '../src/customer-operation-router';
import { responseJson } from './boundary';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://manage.example.com';
const ACCOUNT_ID = 'a'.repeat(32);
const INSTALL_ID = `acg-${'b'.repeat(24)}`;
const CLIENT_ID = 'c'.repeat(32);
const ACCESS_TOKEN = `token_${'d'.repeat(32)}`;
const RELAY_KEY = base64UrlEncode(new Uint8Array(32).fill(9));
const RELAY_TICKET = `${'r'.repeat(64)}.${'s'.repeat(43)}`;
const ACTION_ID = `action_${'k'.repeat(32)}`;
const ACTION_KEY = base64UrlEncode(new Uint8Array(32).fill(5));
const RELEASE = 'gateway-v0.1.34';
const ARTIFACT_SHA256 = 'f'.repeat(64);
const ACTION_EXPIRES_AT = NOW + 600_000;
const SOURCE_SCOPES = 'zone-access.write mcp-portals.write';
// The exact publicSourceAction projection returned by the installed runtime.
const APPLIED_SOURCE_ACTION = {
  schemaVersion: 1,
  actionId: ACTION_ID,
  sourceId: `source-${'e'.repeat(16)}`,
  status: 'succeeded',
  expiresAt: new Date(ACTION_EXPIRES_AT).toISOString(),
  failureCode: null,
};

const baseClaim = {
  schemaVersion: 1,
  actionId: ACTION_ID,
  actionKey: ACTION_KEY,
  actorEmail: 'admin@example.com',
  accountId: ACCOUNT_ID,
  controlPlaneOrigin: 'https://deploy.example.com',
  workerName: 'ankka-gateway',
  workersSubdomain: 'customer',
  managementOrigin: ORIGIN,
  releaseIdentity: {
    schemaVersion: 1,
    channel: 'canary',
    controlPlaneOrigin: 'https://deploy.example.com',
    release: RELEASE,
    keyId: 'release-2026-09-dev1',
    publicKey: 'p'.repeat(43),
    artifactSha256: ARTIFACT_SHA256,
  },
  expiresAt: ACTION_EXPIRES_AT,
};

function handoff(claim: typeof baseClaim): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(claim)));
}

function json(value: BoundaryValue): Response {
  return Response.json(value);
}

function cookieValue(response: Response): string {
  const serialized = response.headers.getSetCookie().find((value) => value.startsWith(`${CUSTOMER_OPERATION_COOKIE}=`));
  if (serialized === undefined) throw new Error('operation cookie missing');
  return serialized.split(';', 1)[0] ?? '';
}

function attemptPort() {
  let stored: CustomerOperationAttempt | null = null;
  const writes: string[] = [];
  const port: CustomerOperationAttemptPort = {
    read: async () => stored,
    write: async (attempt) => {
      stored = attempt;
      writes.push(JSON.stringify(attempt));
    },
    clear: async () => {
      stored = null;
    },
  };
  return { port, writes, current: () => stored };
}

interface Harness {
  readonly transport: CustomerCloudflareTransport;
  readonly calls: string[];
  readonly revoked: () => boolean;
}

function transport(scope = SOURCE_SCOPES, account: 'reachable' | 'refused' = 'reachable'): Harness {
  const calls: string[] = [];
  let revoked = false;
  return {
    calls,
    revoked: () => revoked,
    transport: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/oauth2/token')) {
        return json({ access_token: ACCESS_TOKEN, token_type: 'bearer', scope });
      }
      if (url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/`)) {
        if (account === 'refused') {
          return new Response(JSON.stringify({
            success: false, errors: [{ code: 10000, message: 'Authentication error' }], messages: [], result: null,
          }), { status: 403, headers: { 'content-type': 'application/json' } });
        }
        return json({ success: true, errors: [], messages: [], result: [] });
      }
      if (url.endsWith('/oauth2/revoke')) {
        revoked = true;
        return json({ revoked: true });
      }
      throw new Error('unexpected request');
    },
  };
}

interface ApplyRecord {
  readonly body: string;
  readonly signature: string;
}

function dependencies(input: {
  readonly port: CustomerOperationAttemptPort;
  readonly harness: Harness;
  readonly action: CustomerOperationActionView | null;
  readonly applied: ApplyRecord[];
  readonly applyStatus?: number;
  readonly applyResponse?: BoundaryValue;
  /** A provider step the apply names next to its error code. */
  readonly applyDetail?: string;
  readonly operational?: boolean;
  readonly runtimeAction?: CustomerOperationActionView | null;
  readonly updates?: CustomerOperationRuntimeUpdateInput[];
  readonly updateResult?: CustomerOperationResult;
  /** The attempt record as the updater sees it: cleared before the upload can replace the Worker. */
  readonly attemptsDuringUpdate?: (CustomerOperationAttempt | null)[];
  /** The management object's update driver and its alarm, for tests that follow the upload behind the page. */
  readonly onUpdateDriver?: (driver: CustomerRuntimeUpdateDriver, alarm: { due: boolean }) => void;
}): CustomerOperationRouterDependencies {
  let outcome: CustomerUpdateOutcome | null = null;
  const alarm = { due: false };
  const driver = new CustomerRuntimeUpdateDriver({
    outcomes: { read: async () => outcome, write: async (value) => { outcome = value; } },
    transport: input.harness.transport,
    publicClientId: CLIENT_ID,
    runRuntimeUpdate: async (update) => {
      input.updates?.push(update);
      input.attemptsDuringUpdate?.push(await input.port.read());
      update.onStage?.('current_verified');
      update.onStage?.('assets_uploaded');
      update.onStage?.('uploading');
      return input.updateResult ?? 'applied';
    },
    now: () => NOW + 4,
    schedule: async () => { alarm.due = true; },
  });
  input.onUpdateDriver?.(driver, alarm);
  return {
    attempts: input.port,
    transport: input.harness.transport,
    assertOperational: async () => {
      if (input.operational === false) throw new Error('operation_unavailable');
    },
    readSourceAction: async (actionId) => actionId === ACTION_ID ? input.action : null,
    readRuntimeAction: async (actionId) => actionId === ACTION_ID ? input.runtimeAction ?? null : null,
    startRuntimeUpdate: (start) => driver.start(start),
    updateView: (attemptId) => driver.view(attemptId),
    issueRelayTicket: async (operation) => {
      if (!['source-add', 'bigquery-add', 'upgrade', 'rollback'].includes(operation)) throw new Error('unexpected operation');
      return { relayTicket: RELAY_TICKET, expiresAt: NOW + 120_000 };
    },
    beginRelay: async ({ operation, gatewayState, pkceChallenge, gatewayCallback }) =>
      buildFixedRelayAuthorization({
        clientId: CLIENT_ID,
        relayStateKey: RELAY_KEY,
        gateway: { accountId: ACCOUNT_ID, installId: INSTALL_ID, callback: gatewayCallback },
        operation,
        gatewayState,
        pkceChallenge,
        nonce: base64UrlEncode(new Uint8Array(32).fill(8)),
        now: NOW + 2,
      }),
    applySourceAction: async ({ body, signature }) => {
      input.applied.push({ body, signature });
      return input.applyStatus === undefined
        ? json(input.applyResponse ?? APPLIED_SOURCE_ACTION)
        : Response.json(
          input.applyDetail === undefined
            ? { schemaVersion: 1, error: 'source_action_rejected' }
            : { schemaVersion: 1, error: 'source_action_rejected', detail: input.applyDetail },
          { status: input.applyStatus },
        );
    },
    now: () => NOW + 4,
  };
}

/** `release` is the one the management object itself runs: the installed release until an upload restarts it on the target. */
function router(deps: CustomerOperationRouterDependencies, release = RELEASE) {
  return createCustomerOperationRouter({
    accountId: ACCOUNT_ID,
    installId: INSTALL_ID,
    publicClientId: CLIENT_ID,
    managementOrigin: ORIGIN,
    workerName: 'ankka-gateway',
    workersSubdomain: 'customer',
    release,
    artifactSha256: ARTIFACT_SHA256,
  }, deps);
}

function startRequest(claim: typeof baseClaim): Request {
  return new Request(`${ORIGIN}${CUSTOMER_OPERATION_OAUTH_START_PATH}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, handoff: handoff(claim) }),
  });
}

const authorizationSchema = v.strictObject({
  schemaVersion: v.literal(1),
  authorizationUrl: v.string(),
});

const errorSchema = v.strictObject({
  schemaVersion: v.literal(1),
  error: v.string(),
});

const runtimeClaim = {
  schemaVersion: 2,
  actionType: 'runtime_update',
  actionId: ACTION_ID,
  actionKey: ACTION_KEY,
  actorEmail: 'admin@example.com',
  accountId: ACCOUNT_ID,
  controlPlaneOrigin: 'https://deploy.example.com',
  workerName: 'ankka-gateway',
  workersSubdomain: 'customer',
  managementOrigin: ORIGIN,
  operation: 'update',
  from: { release: RELEASE, artifactSha256: `sha256:${ARTIFACT_SHA256}`, versionId: '11111111-1111-4111-8111-111111111111' },
  to: { release: 'gateway-v0.1.35', artifactSha256: `sha256:${'e'.repeat(64)}`, versionId: null },
  expiresAt: ACTION_EXPIRES_AT,
};

function runtimeStartRequest(claim = runtimeClaim): Request {
  return new Request(`${ORIGIN}${CUSTOMER_OPERATION_OAUTH_START_PATH}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      handoff: base64UrlEncode(new TextEncoder().encode(JSON.stringify(claim))),
    }),
  });
}

/** One poll of the update page, as the management object receives it from an entrypoint of the named release. */
function progressRequest(attemptId: string, servingRelease?: string): Request {
  return new Request(`${ORIGIN}${CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH}?attempt=${attemptId}`,
    servingRelease === undefined ? {} : { headers: { [CUSTOMER_SERVING_RELEASE_HEADER]: servingRelease } });
}

/** Starts an attempt and walks the code relay the way the live relay does; returns the callback URL and cookie. */
async function authorize(target: ReturnType<typeof router>, request = startRequest(baseClaim), scopes = SOURCE_SCOPES) {
  const start = await target.fetch(request);
  expect(start.status).toBe(200);
  const cookie = cookieValue(start);
  const authorization = await responseJson(start, authorizationSchema);
  const url = new URL(authorization.authorizationUrl);
  expect(url.searchParams.get('scope')).toBe(scopes);
  expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
  const relayState = url.searchParams.get('state');
  if (relayState === null) throw new Error('relay state missing');
  const callback = await relayCloudflareAuthorizationCode({
    code: `code_${'e'.repeat(32)}`,
    state: relayState,
    relayStateKey: RELAY_KEY,
    now: NOW + 3,
  });
  return { cookie, callback: new URL(callback.location) };
}

async function verifySignature(record: ApplyRecord): Promise<boolean> {
  const keyBytes = base64UrlDecode(ACTION_KEY);
  const owned = new Uint8Array(keyBytes.byteLength);
  owned.set(keyBytes);
  const key = await crypto.subtle.importKey('raw', owned.buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const hex = record.signature.slice('sha256='.length);
  const signature = Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(record.body));
}

const applyClaimSchema = v.strictObject({
  schemaVersion: v.literal(1),
  actionId: v.string(),
  actionKey: v.string(),
  actorEmail: v.string(),
  accountId: v.string(),
  issuedAt: v.number(),
  expiresAt: v.number(),
  cloudflareAccessToken: v.string(),
});

describe('gateway-local operation router', () => {
  it.each([
    { schemaVersion: 1, actionId: ACTION_ID, status: 'succeeded' },
    { ...APPLIED_SOURCE_ACTION, actionId: `action_${'x'.repeat(32)}` },
    { ...APPLIED_SOURCE_ACTION, sourceId: 'invalid' },
    { ...APPLIED_SOURCE_ACTION, expiresAt: 'invalid' },
    { ...APPLIED_SOURCE_ACTION, status: 'recovery_required' },
    { ...APPLIED_SOURCE_ACTION, failureCode: 'source_action_recovery_required' },
    { ...APPLIED_SOURCE_ACTION, unexpected: true },
  ])('rejects an incomplete, mismatched, or unsuccessful apply receipt %#', async (applyResponse) => {
    const attempts = attemptPort();
    const harness = transport();
    const target = router(dependencies({
      port: attempts.port, harness, applied: [], applyResponse,
      action: { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT },
    }));
    const { cookie, callback } = await authorize(target);
    const response = await target.fetch(new Request(callback, { headers: { cookie } }));
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('sourceActionResult')).toBe('failed');
    expect(location.searchParams.get('sourceActionReason')).toBe('apply_response_invalid');
    expect(harness.revoked()).toBe(true);
    expect(attempts.current()).toBeNull();
  });

  it('turns a source handoff into one source-add consent, applies with the grant, and revokes it', async () => {
    const attempts = attemptPort();
    const harness = transport();
    const applied: ApplyRecord[] = [];
    const target = router(dependencies({
      port: attempts.port, harness, applied,
      action: { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT },
    }));

    const page = await target.fetch(new Request(`${ORIGIN}${CUSTOMER_OPERATION_ROOT_PATH}`));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain(CUSTOMER_OPERATION_OAUTH_START_PATH);
    expect(html).toContain('history.replaceState');

    const { cookie, callback } = await authorize(target);
    const pending = attempts.current();
    expect(pending?.phase).toBe('authorizing');
    expect(pending?.actionId).toBe(ACTION_ID);
    expect(pending?.operation).toBe('source-add');
    expect(customerOperationCookiePresent(new Request(ORIGIN, { headers: { cookie } }))).toBe(true);
    expect(callback.pathname).toBe(CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH);

    const result = await target.fetch(new Request(callback, { headers: { cookie } }));
    expect(result.status).toBe(303);
    const location = new URL(result.headers.get('location') ?? '');
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe('/sources');
    expect(location.searchParams.get('sourceAction')).toBe(ACTION_ID);
    expect(location.searchParams.get('sourceActionResult')).toBe('applied');
    expect(result.headers.getSetCookie().some((value) =>
      value.startsWith(`${CUSTOMER_OPERATION_COOKIE}=;`))).toBe(true);

    expect(applied).toHaveLength(1);
    const record = applied[0];
    if (record === undefined) throw new Error('apply missing');
    const claim = v.parse(applyClaimSchema, JSON.parse(record.body));
    expect(canonicalJson(claim)).toBe(record.body);
    expect(claim).toEqual({
      schemaVersion: 1,
      actionId: ACTION_ID,
      actionKey: ACTION_KEY,
      actorEmail: 'admin@example.com',
      accountId: ACCOUNT_ID,
      issuedAt: NOW + 4,
      expiresAt: ACTION_EXPIRES_AT,
      cloudflareAccessToken: ACCESS_TOKEN,
    });
    await expect(verifySignature(record)).resolves.toBe(true);
    expect(harness.calls).toContain(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/portals`,
    );
    expect(harness.calls.some((call) => call.includes('/client/v4/accounts?'))).toBe(false);
    expect(harness.revoked()).toBe(true);
    expect(attempts.current()).toBeNull();
    const persisted = attempts.writes.join('\n');
    expect(persisted).not.toContain(ACCESS_TOKEN);
    expect(persisted).not.toContain(ACTION_KEY);
    expect(persisted).not.toContain(cookie.split('.')[2] ?? 'verifier');

    // The spent attempt cannot be replayed.
    const replay = await target.fetch(new Request(callback, { headers: { cookie } }));
    expect(replay.status).toBe(400);
    await expect(responseJson(replay, errorSchema)).resolves.toEqual({
      schemaVersion: 1, error: 'oauth_callback_rejected',
    });
    expect(applied).toHaveLength(1);
  });

  it('turns a runtime update handoff into one upgrade consent, answers with the update page, and uploads behind it by alarm', async () => {
    const attempts = attemptPort();
    const applied: ApplyRecord[] = [];
    const updates: CustomerOperationRuntimeUpdateInput[] = [];
    const attemptsDuringUpdate: (CustomerOperationAttempt | null)[] = [];
    const upgradeTransport = transport('workers-scripts.write');
    let driver: CustomerRuntimeUpdateDriver | null = null;
    let alarm = { due: false };
    const upgradeTarget = router(dependencies({
      port: attempts.port, harness: upgradeTransport, applied, updates, attemptsDuringUpdate, action: null,
      runtimeAction: { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT },
      onUpdateDriver: (value, flag) => { driver = value; alarm = flag; },
    }));
    const { cookie, callback } = await authorize(upgradeTarget, runtimeStartRequest(), 'workers-scripts.write');
    const pending = attempts.current();
    expect(pending?.kind).toBe('runtime');
    expect(pending?.operation).toBe('upgrade');
    expect(pending?.target).toEqual({ release: 'gateway-v0.1.35', artifactSha256: `sha256:${'e'.repeat(64)}` });
    expect(pending?.controlPlaneOrigin).toBe('https://deploy.example.com');
    expect(attempts.writes.join('\n')).not.toContain(ACTION_KEY);
    const attemptId = pending?.attemptId ?? '';

    const result = await upgradeTarget.fetch(new Request(callback, { headers: { cookie } }));
    expect(result.status).toBe(303);
    const location = new URL(result.headers.get('location') ?? '');
    // The callback exchanged and checked the account, then left the upload to the management object.
    expect(location.pathname).toBe(CUSTOMER_OPERATION_UPDATE_PATH);
    expect([...location.searchParams.keys()]).toEqual(['attempt']);
    expect(location.searchParams.get('attempt')).toBe(attemptId);
    expect(updates).toEqual([]);
    expect(upgradeTransport.revoked()).toBe(false);
    expect(attempts.current()).toBeNull();
    expect(upgradeTransport.calls).toContain(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/workers/ankka-gateway`,
    );
    // The page and its progress route: fixed words, the stage, nothing of the grant or the key.
    const page = await upgradeTarget.fetch(new Request(location));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH);
    for (const secret of [ACCESS_TOKEN, ACTION_KEY]) expect(html).not.toContain(secret);
    const progress = async (servingRelease?: string) => {
      const response = await upgradeTarget.fetch(progressRequest(attemptId, servingRelease));
      expect(response.status).toBe(200);
      return v.parse(customerUpdateProgressSchema, await response.json());
    };
    // The target comes from the attempt; the serving release is whatever the forwarding entrypoint named, never this object's own.
    expect(await progress(RELEASE)).toEqual({ schemaVersion: 1, attemptId, status: 'running', stage: 'authorized', result: null, reason: null, redirectUrl: null,
      applied: false, targetRelease: 'gateway-v0.1.35', servingRelease: RELEASE });
    // An entrypoint from before the header names nothing, and a value that is no release is not repeated.
    expect((await progress()).servingRelease).toBeNull();
    expect((await progress('gateway-v0.1.35<script>')).servingRelease).toBeNull();
    expect(alarm.due).toBe(true);
    if (driver === null) throw new Error('driver missing');
    const running: CustomerRuntimeUpdateDriver = driver;
    expect(await running.continue()).toBe('settled');
    expect(applied).toHaveLength(0);
    expect(updates.map(({ onStage: _onStage, ...update }) => update)).toEqual([{
      accessToken: ACCESS_TOKEN,
      actionId: ACTION_ID,
      actionKey: ACTION_KEY,
      actorEmail: 'admin@example.com',
      actionExpiresAt: ACTION_EXPIRES_AT,
      controlPlaneOrigin: 'https://deploy.example.com',
      operation: 'update',
      target: { release: 'gateway-v0.1.35', artifactSha256: `sha256:${'e'.repeat(64)}` },
    }]);
    // The upload replaces the Worker; the version that runs afterwards may not
    // be able to clear this version's record, so it is gone before the update.
    expect(attemptsDuringUpdate).toEqual([null]);
    expect(upgradeTransport.revoked()).toBe(true);
    // Applied, and the previous version still answers at the browser's location: the page waits on these two.
    const settled = await progress(RELEASE);
    expect(settled.status).toBe('settled'); expect(settled.result).toBe('applied'); expect(settled.stage).toBeNull();
    expect(settled.applied).toBe(true); expect(settled.targetRelease).toBe('gateway-v0.1.35'); expect(settled.servingRelease).toBe(RELEASE);
    // Where the page hands over is what it always was, whichever release serves the answer.
    expect(settled.redirectUrl).toBe(`${ORIGIN}/settings?runtimeAction=${ACTION_ID}&runtimeActionResult=applied`);
    const served = await progress('gateway-v0.1.35');
    expect(served).toEqual({ ...settled, servingRelease: 'gateway-v0.1.35' });
    expect(await running.continue()).toBe('idle');
    expect((await upgradeTarget.fetch(new Request(`${ORIGIN}${CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH}?attempt=attempt_${'z'.repeat(24)}`))).status).toBe(404);
    expect((await upgradeTarget.fetch(new Request(`${ORIGIN}${CUSTOMER_OPERATION_UPDATE_PATH}?attempt=${attemptId}&code=secret`))).status).toBe(404);
  });

  it('hands the browser to the dashboard without a result when the version that started the update is gone', async () => {
    const attempts = attemptPort();
    const applied: ApplyRecord[] = [];
    const upgradeTransport = transport('workers-scripts.write');
    let driver: CustomerRuntimeUpdateDriver | null = null;
    const deps = dependencies({
      port: attempts.port, harness: upgradeTransport, applied, action: null,
      runtimeAction: { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT },
      onUpdateDriver: (value) => { driver = value; },
    });
    const upgradeTarget = router(deps);
    const { cookie, callback } = await authorize(upgradeTarget, runtimeStartRequest(), 'workers-scripts.write');
    const attemptId = attempts.current()?.attemptId ?? '';
    expect((await upgradeTarget.fetch(new Request(callback, { headers: { cookie } }))).status).toBe(303);
    if (driver === null) throw new Error('driver missing');
    // The object restarts on the new version before the upload's pass records its end: the running record stays.
    const restarted = new CustomerRuntimeUpdateDriver({
      outcomes: { read: () => driver === null ? Promise.resolve(null) : driver.view(attemptId).then((view) =>
        view === null ? null : { schemaVersion: 1, attemptId, actionId: view.actionId, operation: 'update', status: 'running', result: null, reason: null,
          targetRelease: view.targetRelease }),
        write: async () => undefined },
      transport: upgradeTransport.transport, publicClientId: CLIENT_ID, runRuntimeUpdate: async () => 'applied', now: () => NOW + 4,
      schedule: async () => undefined,
    });
    const view = await restarted.view(attemptId);
    expect(view).toEqual({ status: 'settled', stage: null, actionId: ACTION_ID, result: null, reason: null, targetRelease: 'gateway-v0.1.35' });
    expect(await restarted.continue()).toBe('idle');
    // No result was recorded, yet the object that answers runs the target: that proves the upload, so the page waits
    // for Cloudflare to serve it. The dashboard is still told no result, and its action poll decides.
    const answer = async (release: string) => v.parse(customerUpdateProgressSchema, await (await router(
      { ...deps, updateView: (id) => restarted.view(id) }, release,
    ).fetch(progressRequest(attemptId, RELEASE))).json());
    expect(await answer('gateway-v0.1.35')).toEqual({ schemaVersion: 1, attemptId, status: 'settled', stage: null, result: null, reason: null,
      redirectUrl: `${ORIGIN}/settings?runtimeAction=${ACTION_ID}`, applied: true, targetRelease: 'gateway-v0.1.35', servingRelease: RELEASE });
    // An object that restarted for another reason still runs the installed release: nothing was applied, nothing to wait for.
    expect((await answer(RELEASE)).applied).toBe(false);
  });

  it('names the release a rollback returns to as the target, through the same page and progress route', async () => {
    const attempts = attemptPort();
    const rollbackTransport = transport('workers-scripts.write');
    let driver: CustomerRuntimeUpdateDriver | null = null;
    const target = router(dependencies({
      port: attempts.port, harness: rollbackTransport, applied: [], action: null,
      runtimeAction: { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT },
      onUpdateDriver: (value) => { driver = value; },
    }));
    const { cookie, callback } = await authorize(target, runtimeStartRequest({ ...runtimeClaim, operation: 'rollback',
      to: { release: 'gateway-v0.1.33', artifactSha256: `sha256:${'e'.repeat(64)}`, versionId: null },
    }), 'workers-scripts.write');
    const attemptId = attempts.current()?.attemptId ?? '';
    expect(attempts.current()?.operation).toBe('rollback');
    const landed = await target.fetch(new Request(callback, { headers: { cookie } }));
    expect(new URL(landed.headers.get('location') ?? '').pathname).toBe(CUSTOMER_OPERATION_UPDATE_PATH);
    if (driver === null) throw new Error('driver missing');
    const running: CustomerRuntimeUpdateDriver = driver;
    expect(await running.continue()).toBe('settled');
    const progress = v.parse(customerUpdateProgressSchema, await (await target.fetch(progressRequest(attemptId, RELEASE))).json());
    expect(progress).toEqual({ schemaVersion: 1, attemptId, status: 'settled', stage: null, result: 'applied', reason: null,
      redirectUrl: `${ORIGIN}/settings?runtimeAction=${ACTION_ID}&runtimeActionResult=applied`,
      applied: true, targetRelease: 'gateway-v0.1.33', servingRelease: RELEASE });
  });

  it('reports a failed update as not applied, so the page hands over at once', async () => {
    const attempts = attemptPort();
    const upgradeTransport = transport('workers-scripts.write');
    let driver: CustomerRuntimeUpdateDriver | null = null;
    const target = router(dependencies({
      port: attempts.port, harness: upgradeTransport, applied: [], action: null, updateResult: 'failed',
      runtimeAction: { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT },
      onUpdateDriver: (value) => { driver = value; },
    }));
    const { cookie, callback } = await authorize(target, runtimeStartRequest(), 'workers-scripts.write');
    const attemptId = attempts.current()?.attemptId ?? '';
    expect((await target.fetch(new Request(callback, { headers: { cookie } }))).status).toBe(303);
    if (driver === null) throw new Error('driver missing');
    const running: CustomerRuntimeUpdateDriver = driver;
    expect(await running.continue()).toBe('settled');
    const progress = v.parse(customerUpdateProgressSchema, await (await target.fetch(progressRequest(attemptId, RELEASE))).json());
    expect(progress.applied).toBe(false);
    expect(progress.redirectUrl).toBe(`${ORIGIN}/settings?runtimeAction=${ACTION_ID}&runtimeActionResult=failed&runtimeActionReason=update_failed`);
  });

  it('fails without applying when the grant does not reach the installed account', async () => {
    const attempts = attemptPort();
    const harness = transport(SOURCE_SCOPES, 'refused');
    const applied: ApplyRecord[] = [];
    const target = router(dependencies({
      port: attempts.port, harness, applied,
      action: { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT },
    }));
    const { cookie, callback } = await authorize(target);
    const result = await target.fetch(new Request(callback, { headers: { cookie } }));
    expect(result.status).toBe(303);
    const location = new URL(result.headers.get('location') ?? '');
    expect(location.searchParams.get('sourceActionResult')).toBe('failed');
    expect(location.searchParams.get('sourceActionReason')).toBe('grant_account_mismatch_http_403_code_10000');
    expect(applied).toHaveLength(0);
    expect(harness.revoked()).toBe(true);
    expect(attempts.current()).toBeNull();
  });

  it('cancels nothing itself when consent is denied and reports it to the Sources page', async () => {
    const attempts = attemptPort();
    const harness = transport();
    const applied: ApplyRecord[] = [];
    const target = router(dependencies({
      port: attempts.port, harness, applied,
      action: { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT },
    }));
    const { cookie, callback } = await authorize(target);
    callback.searchParams.delete('code');
    callback.searchParams.set('error', 'authorization_rejected');
    const result = await target.fetch(new Request(callback, { headers: { cookie } }));
    expect(result.status).toBe(303);
    const location = new URL(result.headers.get('location') ?? '');
    expect(location.searchParams.get('sourceActionResult')).toBe('denied');
    expect(applied).toHaveLength(0);
    expect(harness.calls).toHaveLength(0);
    expect(attempts.current()).toBeNull();
  });

  it('still revokes the grant and clears the attempt when the gateway refuses the apply', async () => {
    const attempts = attemptPort();
    const harness = transport();
    const applied: ApplyRecord[] = [];
    const target = router(dependencies({
      port: attempts.port, harness, applied, applyStatus: 409,
      applyDetail: 'source_access_policy_create_blocked_http_400_code_12130',
      action: { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT },
    }));
    const { cookie, callback } = await authorize(target);
    const result = await target.fetch(new Request(callback, { headers: { cookie } }));
    expect(result.status).toBe(303);
    const location = new URL(result.headers.get('location') ?? '');
    expect(location.searchParams.get('sourceActionResult')).toBe('failed');
    // The apply's own error code and the provider step it names travel as one reason word.
    expect(location.searchParams.get('sourceActionReason')).toBe(
      'apply_source_action_rejected_source_access_policy_create_blocked_http_400_code_12130',
    );
    expect(applied).toHaveLength(1);
    expect(harness.revoked()).toBe(true);
    expect(attempts.current()).toBeNull();
  });

  it('refuses a handoff that names another gateway, release, or action state', async () => {
    const attempts = attemptPort();
    const harness = transport();
    const applied: ApplyRecord[] = [];
    const ready = { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT };
    for (const [claim, action, status, error] of [
      [{ ...baseClaim, accountId: 'e'.repeat(32) }, ready, 400, 'operation_invalid'],
      [{ ...baseClaim, managementOrigin: 'https://other.example.com' }, ready, 400, 'operation_invalid'],
      [{ ...baseClaim, releaseIdentity: { ...baseClaim.releaseIdentity, release: 'gateway-v0.1.33' } }, ready, 400, 'operation_invalid'],
      [{ ...baseClaim, expiresAt: NOW }, ready, 400, 'operation_invalid'],
      [baseClaim, { status: 'applying', expiresAt: ACTION_EXPIRES_AT }, 409, 'operation_conflict'],
      [baseClaim, { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT + 1 }, 409, 'operation_conflict'],
      [baseClaim, null, 409, 'operation_conflict'],
    ] as const) {
      const target = router(dependencies({ port: attempts.port, harness, applied, action }));
      const response = await target.fetch(startRequest(claim));
      expect(response.status).toBe(status);
      await expect(responseJson(response, errorSchema)).resolves.toEqual({ schemaVersion: 1, error });
    }
    expect(attempts.writes).toHaveLength(0);
    expect(harness.calls).toHaveLength(0);
  });

  it('keeps one live attempt per gateway and refuses cross-site or unauthenticated starts', async () => {
    const attempts = attemptPort();
    const harness = transport();
    const applied: ApplyRecord[] = [];
    const target = router(dependencies({
      port: attempts.port, harness, applied,
      action: { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT },
    }));
    const crossSite = await target.fetch(new Request(`${ORIGIN}${CUSTOMER_OPERATION_OAUTH_START_PATH}`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, handoff: handoff(baseClaim) }),
    }));
    expect(crossSite.status).toBe(403);

    await authorize(target);
    await attempts.port.write({
      schemaVersion: 1,
      attemptId: `attempt_${'z'.repeat(24)}`,
      kind: 'source',
      operation: 'source-add',
      actionId: `action_${'m'.repeat(32)}`,
      actorEmail: 'admin@example.com',
      actionExpiresAt: ACTION_EXPIRES_AT,
      controlPlaneOrigin: 'https://deploy.example.com',
      target: null,
      stateHash: 'h'.repeat(43),
      phase: 'authorizing',
      expiresAt: NOW + 300_000,
    });
    const blocked = await target.fetch(startRequest(baseClaim));
    expect(blocked.status).toBe(409);
    await expect(responseJson(blocked, errorSchema)).resolves.toEqual({ schemaVersion: 1, error: 'operation_pending' });

    const bare = await target.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH}?code=${'e'.repeat(32)}&state=${'s'.repeat(43)}`));
    expect(bare.status).toBe(400);

    const closed = router(dependencies({ port: attempts.port, harness, applied, action: null, operational: false }));
    const unavailable = await closed.fetch(new Request(`${ORIGIN}${CUSTOMER_OPERATION_ROOT_PATH}`));
    expect(unavailable.status).toBe(503);
    expect(applied).toHaveLength(0);
  });
});

describe('BigQuery credential custody in the gateway callback', () => {
  it('holds the OAuth code until a same-origin key upload and consumes the grant exactly once', async () => {
    const port = attemptPort();
    const scopes = 'zone-access.write mcp-portals.write workers-scripts.write workers-routes.read';
    const harness = transport(scopes);
    const runBigQuerySetup = vi.fn(async () => json(APPLIED_SOURCE_ACTION));
    const target = router({ ...dependencies({ port: port.port, harness, action: null, applied: [] }),
      readBigQueryAction: async () => ({ status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT }), runBigQuerySetup });
    const result = await authorize(target, startRequest(Object.assign({}, baseClaim, { actionType: 'bigquery_setup' })), scopes);
    const page = await target.fetch(new Request(result.callback, { headers: { cookie: result.cookie } }));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(await page.text()).toContain('Google service-account JSON key');
    expect(harness.calls).toEqual([]);
    expect(port.current()?.phase).toBe('authorizing');
    const body = { code: result.callback.searchParams.get('code'), state: result.callback.searchParams.get('state'), serviceAccountJson: 'synthetic-google-key' };
    const upload = (origin: string) => new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH}`, {
      method: 'POST', headers: { cookie: result.cookie, origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await target.fetch(upload('https://foreign.example.com'))).status).toBe(400);
    expect(harness.calls).toEqual([]);
    const applied = await target.fetch(upload(ORIGIN));
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ redirectUrl: `${ORIGIN}/sources?sourceAction=${ACTION_ID}&sourceActionResult=applied` });
    expect(runBigQuerySetup).toHaveBeenCalledExactlyOnceWith({ actionId: ACTION_ID, actionKey: ACTION_KEY,
      actorEmail: 'admin@example.com', accessToken: ACCESS_TOKEN, actionExpiresAt: ACTION_EXPIRES_AT, serviceAccountJson: body.serviceAccountJson });
    expect(harness.revoked()).toBe(true);
    expect(port.writes.join('\n')).not.toContain(body.serviceAccountJson);
    expect(port.writes.join('\n')).not.toContain(ACCESS_TOKEN);
    expect(result.cookie).not.toContain(body.serviceAccountJson);
    expect((await target.fetch(upload(ORIGIN))).status).toBe(400);
    expect(runBigQuerySetup).toHaveBeenCalledTimes(1);
  });
});

describe('management token custody in the gateway callback', () => {
  // Synthetic values in Cloudflare's two account token forms, assembled at run time so no literal has a credential's form.
  const PASTED_VALUE = `cfat_${'Qx7m'.repeat(10)}${'5d'.repeat(4)}`;
  const LEGACY_VALUE = `${'Pw-_'.repeat(10)}`;
  const SCOPE = 'workers-scripts.write';
  const SECRET_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/ankka-gateway/secrets`;
  const managementClaim = {
    schemaVersion: 1,
    actionType: 'management_credential',
    actionId: ACTION_ID,
    actionKey: ACTION_KEY,
    actorEmail: 'admin@example.com',
    accountId: ACCOUNT_ID,
    controlPlaneOrigin: 'https://deploy.example.com',
    workerName: 'ankka-gateway',
    workersSubdomain: 'customer',
    managementOrigin: ORIGIN,
    release: RELEASE,
    artifactSha256: `sha256:${ARTIFACT_SHA256}`,
    expiresAt: ACTION_EXPIRES_AT,
  };

  interface ProviderCall { readonly method: string; readonly url: string; readonly body: string; readonly authorization: string | null }

  function flow(options: {
    readonly secretStatus?: number | 'throws';
    readonly exchangeStatus?: number;
    readonly actor?: string | null;
    readonly action?: CustomerOperationActionView | null;
    readonly refuse?: readonly CustomerManagementCredentialControl['command'][];
    readonly relay?: 'unavailable';
  } = {}) {
    const attempts = attemptPort();
    const calls: ProviderCall[] = [];
    const controls: CustomerManagementCredentialControl[] = [];
    let revoked = false;
    const provider: CustomerCloudflareTransport = async (input, init) => {
      const request = new Request(input, init);
      const call = { method: request.method, url: request.url, body: await request.text(), authorization: request.headers.get('authorization') };
      calls.push(call);
      if (call.url.endsWith('/oauth2/token')) {
        return (options.exchangeStatus ?? 200) === 200
          ? json({ access_token: ACCESS_TOKEN, token_type: 'bearer', scope: SCOPE })
          : Response.json({ error: 'invalid_grant' }, { status: options.exchangeStatus ?? 400 });
      }
      if (call.url.endsWith('/oauth2/revoke')) { revoked = true; return json({ revoked: true }); }
      if (call.url === SECRET_URL) {
        if (options.secretStatus === 'throws') throw new Error(`network failure while sending ${call.body}`);
        // A body that must never be read: it echoes what was written, as a careless provider might.
        return new Response(JSON.stringify({ success: true, result: { name: 'ANKKA_MANAGEMENT_TOKEN', echoed: call.body } }), {
          status: options.secretStatus ?? 201, headers: { 'content-type': 'application/json' },
        });
      }
      if (call.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/`)) {
        return json({ success: true, errors: [], messages: [], result: {} });
      }
      throw new Error('unexpected request');
    };
    const base = dependencies({ port: attempts.port, harness: { transport: provider, calls: [], revoked: () => revoked }, action: null, applied: [] });
    const target = router({
      ...base,
      issueRelayTicket: async (operation) => {
        if (options.relay === 'unavailable') throw new Error('relay_rejected');
        expect(operation).toBe('management-credential');
        return { relayTicket: RELAY_TICKET, expiresAt: NOW + 120_000 };
      },
      readManagementCredentialAction: async (actionId) => actionId !== ACTION_ID ? null
        : options.action === undefined ? { status: 'authorization_required', expiresAt: ACTION_EXPIRES_AT } : options.action,
      controlManagementCredentialAction: async (control) => {
        controls.push(control);
        return options.refuse?.includes(control.command) !== true;
      },
      verifyAdministrator: async () => options.actor === undefined ? 'admin@example.com' : options.actor,
    });
    const start = () => new Request(`${ORIGIN}${CUSTOMER_OPERATION_OAUTH_START_PATH}`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, handoff: base64UrlEncode(new TextEncoder().encode(JSON.stringify(managementClaim))) }),
    });
    return { attempts, calls, controls, target, start, revoked: () => revoked };
  }

  function post(result: Awaited<ReturnType<typeof authorize>>, body: Record<string, string | boolean | null>, origin = ORIGIN): Request {
    return new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH}`, {
      method: 'POST', headers: { cookie: result.cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  function credentials(result: Awaited<ReturnType<typeof authorize>>) {
    return { code: result.callback.searchParams.get('code'), state: result.callback.searchParams.get('state') };
  }

  const answerSchema = v.strictObject({
    schemaVersion: v.literal(1), result: v.string(), reason: v.nullable(v.string()), redirectUrl: v.string(),
  });

  it('serves the paste page of the gateway after consent, without exchanging anything yet', async () => {
    const f = flow();
    const result = await authorize(f.target, f.start(), SCOPE);
    expect(f.attempts.current()).toMatchObject({ kind: 'management_credential', operation: 'management-credential', phase: 'authorizing' });
    const page = await f.target.fetch(new Request(result.callback, { headers: { cookie: result.cookie } }));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(
      /^default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-[A-Za-z0-9_-]+'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'$/u);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.getSetCookie()).toEqual([]);
    const html = await page.text();
    expect(html).toContain('Add your management token');
    // The link and the name carry the management hostname, as script literals the page assigns after checking the origin.
    expect(html).toContain(JSON.stringify('https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22access%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22mcp_portals%22%2C%22type%22%3A%22edit%22%7D%5D&name=Ankka%20gateway%20manage.example.com'));
    expect(html).toContain(JSON.stringify('Ankka gateway manage.example.com'));
    // One field, never echoed, never part of a form submission.
    expect(html.match(/<input\b/gu)).toHaveLength(1);
    expect(html).toContain('<input id="token" type="password" autocomplete="off"');
    expect(html).not.toMatch(/<input[^>]*\bname=/u);
    expect(html).toContain("history.replaceState(null,'',location.pathname)");
    expect(f.calls).toEqual([]);
    expect(f.controls).toEqual([]);
    expect(f.attempts.current()?.phase).toBe('authorizing');
  });

  it.each([['the scannable form', PASTED_VALUE, 201], ['the earlier form, replacing a secret', LEGACY_VALUE, 200]])(
    'writes %s as the Worker secret with one provider call, revokes the grant, and answers with fixed words', async (_name, value, secretStatus) => {
      const f = flow({ secretStatus });
      const result = await authorize(f.target, f.start(), SCOPE);
      const response = await f.target.fetch(post(result, { ...credentials(result), managementToken: value }));
      expect(response.status).toBe(200);
      const serialized = await response.text();
      expect(v.parse(answerSchema, JSON.parse(serialized))).toEqual({
        schemaVersion: 1, result: 'applied', reason: null,
        redirectUrl: `${ORIGIN}/settings?managementCredentialAction=${ACTION_ID}&managementCredentialActionResult=applied`,
      });

      // Exchange, one read that binds the grant to this account's Worker, the one write, the revocation. Nothing else.
      expect(f.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'POST https://dash.cloudflare.com/oauth2/token',
        `GET https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/workers/ankka-gateway`,
        `PUT ${SECRET_URL}`,
        'POST https://dash.cloudflare.com/oauth2/revoke',
      ]);
      const write = f.calls[2];
      expect(JSON.parse(write?.body ?? 'null')).toEqual({ name: 'ANKKA_MANAGEMENT_TOKEN', text: value, type: 'secret_text' });
      expect(write?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(f.revoked()).toBe(true);

      // The value went into exactly one request and appears nowhere else this flow can write to.
      expect(f.calls.filter((call) => call.body.includes(value))).toEqual([write]);
      expect(f.calls.some((call) => call.url.includes(value))).toBe(false);
      expect(serialized).not.toContain(value);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.getSetCookie().join('\n')).not.toContain(value);
      expect(result.cookie).not.toContain(value);
      expect(f.attempts.writes.join('\n')).not.toContain(value);
      expect(JSON.stringify(f.controls)).not.toContain(value);
      expect(JSON.stringify(f.controls)).not.toContain(ACCESS_TOKEN);

      // The gateway's own record moved to its write first and to its end afterwards; the attempt was spent before the write.
      expect(f.controls).toEqual([
        { actionId: ACTION_ID, actionKey: ACTION_KEY, actionExpiresAt: ACTION_EXPIRES_AT, command: 'begin' },
        { actionId: ACTION_ID, actionKey: ACTION_KEY, actionExpiresAt: ACTION_EXPIRES_AT, command: 'complete' },
      ]);
      expect(f.attempts.current()).toBeNull();
      expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0');

      // A replay finds nothing to exchange.
      expect((await f.target.fetch(post(result, { ...credentials(result), managementToken: value }))).status).toBe(400);
      expect(f.calls).toHaveLength(4);
    });

  it('never retries the write, never reads its answer, and keeps nothing of a failure but the status', async () => {
    const refused = flow({ secretStatus: 403 });
    const first = await authorize(refused.target, refused.start(), SCOPE);
    const response = await refused.target.fetch(post(first, { ...credentials(first), managementToken: PASTED_VALUE }));
    const serialized = await response.text();
    expect(v.parse(answerSchema, JSON.parse(serialized))).toMatchObject({ result: 'failed', reason: 'secret_write_http_403' });
    expect(serialized).not.toContain(PASTED_VALUE);
    expect(refused.calls.filter((call) => call.url === SECRET_URL)).toHaveLength(1);
    expect(refused.revoked()).toBe(true);
    expect(refused.controls.map((control) => [control.command, control.failureCode])).toEqual([
      ['begin', undefined], ['fail', 'secret_write_http_403'],
    ]);

    // A transport that throws with the request body in its message: the message is dropped, the word says unconfirmed.
    const lost = flow({ secretStatus: 'throws' });
    const second = await authorize(lost.target, lost.start(), SCOPE);
    const unconfirmed = await lost.target.fetch(post(second, { ...credentials(second), managementToken: PASTED_VALUE }));
    const lostAnswer = await unconfirmed.text();
    expect(v.parse(answerSchema, JSON.parse(lostAnswer))).toMatchObject({ result: 'failed', reason: 'secret_write_unconfirmed' });
    expect(lostAnswer).not.toContain(PASTED_VALUE);
    expect(lost.calls.filter((call) => call.url === SECRET_URL)).toHaveLength(1);
    expect(JSON.stringify(lost.controls)).not.toContain(PASTED_VALUE);
    expect(lost.revoked()).toBe(true);
  });

  it('says plainly that the approval ran out when Cloudflare no longer honours the code, and writes nothing', async () => {
    const f = flow({ exchangeStatus: 400 });
    const result = await authorize(f.target, f.start(), SCOPE);
    const response = await f.target.fetch(post(result, { ...credentials(result), managementToken: PASTED_VALUE }));
    expect(v.parse(answerSchema, await response.json())).toEqual({
      schemaVersion: 1, result: 'failed', reason: 'approval_expired',
      redirectUrl: `${ORIGIN}/settings?managementCredentialAction=${ACTION_ID}&managementCredentialActionResult=failed&managementCredentialActionReason=approval_expired`,
    });
    expect(f.calls.map((call) => call.url)).toEqual(['https://dash.cloudflare.com/oauth2/token']);
    expect(f.calls[0]?.body).not.toContain(PASTED_VALUE);
    // The lock is given back at once, with the reason.
    expect(f.controls).toEqual([{ actionId: ACTION_ID, actionKey: ACTION_KEY, actionExpiresAt: ACTION_EXPIRES_AT, command: 'fail', failureCode: 'approval_expired' }]);
  });

  it('refuses a wrong paste before anything is spent, so the same approval takes the next paste', async () => {
    const f = flow();
    const result = await authorize(f.target, f.start(), SCOPE);
    for (const wrong of ['cfut_' + 'a'.repeat(40), 'cfk_' + 'b'.repeat(40), ` ${PASTED_VALUE}`, `${PASTED_VALUE}${'x'.repeat(40)}`, 'short', '']) {
      const response = await f.target.fetch(post(result, { ...credentials(result), managementToken: wrong }));
      expect(response.status, wrong).toBe(400);
      const serialized = await response.text();
      expect(JSON.parse(serialized)).toEqual({ schemaVersion: 1, error: 'management_token_invalid' });
      expect(response.headers.getSetCookie(), wrong).toEqual([]);
    }
    expect(f.calls).toEqual([]);
    expect(f.controls).toEqual([]);
    expect(f.attempts.current()?.phase).toBe('authorizing');
    const accepted = await f.target.fetch(post(result, { ...credentials(result), managementToken: PASTED_VALUE }));
    expect(v.parse(answerSchema, await accepted.json()).result).toBe('applied');
  });

  it('accepts the paste only same-origin, under the cookie and state of its own attempt, from the administrator who prepared it', async () => {
    const f = flow();
    const result = await authorize(f.target, f.start(), SCOPE);
    const body = { ...credentials(result), managementToken: PASTED_VALUE };
    expect((await f.target.fetch(post(result, body, 'https://foreign.example.com'))).status).toBe(400);
    expect((await f.target.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH}`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))).status).toBe(400);
    expect((await f.target.fetch(post(result, { ...body, extra: true }))).status).toBe(400);
    expect((await f.target.fetch(post(result, { ...body, serviceAccountJson: 'synthetic-google-key' }))).status).toBe(400);
    expect(f.calls).toEqual([]);
    const wrongState = await f.target.fetch(post(result, { ...body, state: 's'.repeat(43) }));
    expect(wrongState.status).toBe(400);
    expect(f.calls).toEqual([]);

    for (const actor of ['other-admin@example.com', null]) {
      const foreign = flow({ actor });
      const started = await authorize(foreign.target, foreign.start(), SCOPE);
      expect((await foreign.target.fetch(new Request(started.callback, { headers: { cookie: started.cookie } }))).status).toBe(400);
      const again = await authorize(foreign.target, foreign.start(), SCOPE);
      expect((await foreign.target.fetch(post(again, { ...credentials(again), managementToken: PASTED_VALUE }))).status).toBe(400);
      expect(foreign.calls).toEqual([]);
    }
  });

  it('gives the lifecycle lock back at once when the change ends without a write', async () => {
    const identity = { actionId: ACTION_ID, actionKey: ACTION_KEY, actionExpiresAt: ACTION_EXPIRES_AT };
    // Stopped on the paste page.
    const stopped = flow();
    const first = await authorize(stopped.target, stopped.start(), SCOPE);
    const cancelled = await stopped.target.fetch(post(first, { ...credentials(first), cancel: true }));
    expect(v.parse(answerSchema, await cancelled.json())).toEqual({
      schemaVersion: 1, result: 'cancelled', reason: null,
      redirectUrl: `${ORIGIN}/settings?managementCredentialAction=${ACTION_ID}&managementCredentialActionResult=cancelled`,
    });
    expect(stopped.controls).toEqual([{ ...identity, command: 'fail', failureCode: 'cancelled' }]);
    expect(stopped.calls).toEqual([]);
    expect(stopped.attempts.current()).toBeNull();

    // Declined in Cloudflare.
    const declined = flow();
    const second = await authorize(declined.target, declined.start(), SCOPE);
    const denial = new URL(second.callback);
    denial.searchParams.delete('code');
    denial.searchParams.set('error', 'authorization_rejected');
    const denied = await declined.target.fetch(new Request(denial, { headers: { cookie: second.cookie } }));
    expect(denied.status).toBe(303);
    expect(denied.headers.get('location')).toBe(`${ORIGIN}/settings?managementCredentialAction=${ACTION_ID}&managementCredentialActionResult=denied`);
    expect(declined.controls).toEqual([{ ...identity, command: 'fail', failureCode: 'authorization_denied' }]);

    // The paste page reloaded: its code lived in script memory only.
    const reloaded = flow();
    const third = await authorize(reloaded.target, reloaded.start(), SCOPE);
    const bare = await reloaded.target.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH}`, { headers: { cookie: third.cookie } }));
    expect(bare.status).toBe(303);
    expect(bare.headers.get('location')).toBe(`${ORIGIN}/settings?managementCredentialAction=${ACTION_ID}&managementCredentialActionResult=failed&managementCredentialActionReason=paste_page_closed`);
    expect(reloaded.controls).toEqual([{ ...identity, command: 'fail', failureCode: 'paste_page_closed' }]);
    expect(reloaded.attempts.current()).toBeNull();

    // A relay that does not know the operation yet: no consent can start, and the change does not linger.
    const old = flow({ relay: 'unavailable' });
    const unavailable = await old.target.fetch(old.start());
    expect(unavailable.status).toBe(503);
    await expect(responseJson(unavailable, errorSchema)).resolves.toEqual({ schemaVersion: 1, error: 'authorization_unavailable' });
    expect(old.controls).toEqual([{ ...identity, command: 'fail', failureCode: 'authorization_unavailable' }]);
    expect(old.attempts.current()).toBeNull();
  });

  it('writes nothing when the gateway no longer holds the action, and refuses a handoff for another release or an unknown action', async () => {
    const gone = flow({ refuse: ['begin'] });
    const result = await authorize(gone.target, gone.start(), SCOPE);
    const response = await gone.target.fetch(post(result, { ...credentials(result), managementToken: PASTED_VALUE }));
    expect(v.parse(answerSchema, await response.json())).toMatchObject({ result: 'failed', reason: 'action_unavailable' });
    expect(gone.calls.some((call) => call.url === SECRET_URL)).toBe(false);
    expect(gone.calls.some((call) => call.body.includes(PASTED_VALUE))).toBe(false);
    expect(gone.revoked()).toBe(true);

    const unknown = flow({ action: null });
    expect((await unknown.target.fetch(unknown.start())).status).toBe(409);
    const spent = flow({ action: { status: 'succeeded', expiresAt: ACTION_EXPIRES_AT } });
    expect((await spent.target.fetch(spent.start())).status).toBe(409);

    const f = flow();
    for (const claim of [
      { ...managementClaim, release: 'gateway-v0.1.33' },
      { ...managementClaim, artifactSha256: `sha256:${'0'.repeat(64)}` },
      { ...managementClaim, accountId: 'b'.repeat(32) },
      { ...managementClaim, managementToken: PASTED_VALUE },
    ]) {
      const rejected = await f.target.fetch(new Request(`${ORIGIN}${CUSTOMER_OPERATION_OAUTH_START_PATH}`, {
        method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, handoff: base64UrlEncode(new TextEncoder().encode(JSON.stringify(claim))) }),
      }));
      expect(rejected.status).toBe(400);
    }
    expect(f.controls).toEqual([]);
  });

  it('lets the same administrator start again: an approval whose action the gateway replaced does not hold the next one', async () => {
    const f = flow();
    await authorize(f.target, f.start(), SCOPE);
    // The gateway keeps one record; the earlier action is gone from it once its administrator prepares the next.
    const earlier = f.attempts.current();
    if (earlier === null) throw new Error('attempt missing');
    await f.attempts.port.write({ ...earlier, actionId: `action_${'m'.repeat(32)}` });
    const next = await f.target.fetch(f.start());
    expect(next.status).toBe(200);
  });
});
