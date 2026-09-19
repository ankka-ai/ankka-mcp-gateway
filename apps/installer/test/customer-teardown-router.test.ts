import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical-json';
import { CLOUDFLARE_CODE_RELAY_CALLBACK } from '../src/cloudflare-code-relay';
import { exactOperationScopes } from '../src/cloudflare-operation-authority';
import { base64UrlDecode, base64UrlEncode, openCustomerTeardownCookie } from '../src/crypto';
import { operationSignature } from '../src/customer-operation-secrets';
import { parseCustomerTeardownAttempt, type CustomerTeardownAttempt, type CustomerTeardownAttemptPort } from '../src/customer-teardown-attempt';
import { CustomerTeardownRemovalDriver, type CustomerTeardownRemovalPorts } from '../src/customer-teardown-driver';
import { customerTeardownProgressSchema, type CustomerTeardownCompletion, type CustomerTeardownOutcome, type CustomerTeardownOutcomePort } from '../src/customer-teardown-progress';
import { createCustomerTeardownRouter, CUSTOMER_TEARDOWN_PATH, CUSTOMER_TEARDOWN_PROGRESS_PATH, CUSTOMER_TEARDOWN_START_PATH, type CustomerTeardownDependencies } from '../src/customer-teardown-router';
import { boundaryObjectSchema } from '../src/boundary';

const NOW = 1_800_000_000_000, ORIGIN = 'https://manage.example.com', HOSTED = 'https://deploy.example.com';
const KEY = base64UrlEncode(new Uint8Array(32).fill(5));
const ACCESS_TOKEN = `synthetic_${'t'.repeat(32)}`;
const KINDS = ['access_application', 'access_policy', 'dns_record', 'mcp_portal', 'mcp_server'] as const;
const SCOPES = exactOperationScopes('uninstall', KINDS).join(' ');
const config = { accountId: 'a'.repeat(32), installId: `acg-${'b'.repeat(24)}`, publicClientId: 'c'.repeat(32),
  managementOrigin: ORIGIN, controlPlaneOrigin: HOSTED, workerName: 'ankka-gateway', workersSubdomain: 'customer', encryptionKey: KEY };
const claim = { schemaVersion: 3, actionType: 'gateway_teardown', actionId: `action_${'d'.repeat(32)}`, actionKey: KEY,
  actorEmail: 'admin@example.com', accountId: config.accountId, installationId: config.installId,
  controlPlaneOrigin: HOSTED, managementOrigin: ORIGIN, workerName: config.workerName, workersSubdomain: config.workersSubdomain,
  gatewayName: 'Example gateway', portalHostname: 'mcp.example.com', expiresAt: NOW + 600_000 };
const completion = { schemaVersion: 1, actionId: claim.actionId, installationId: config.installId, status: 'gateway_removed',
  removedResourceCount: 7, readyReceiptChecksum: `sha256:${'e'.repeat(64)}`, dependencyResourcesHash: `sha256:${'f'.repeat(64)}` };
const SECRETS = [ACCESS_TOKEN, KEY, claim.actorEmail, config.accountId, 'synthetic lost pass response'];
type Options = { scope?: string; accountRefused?: boolean; refresh?: boolean; revokeFails?: boolean; applyFails?: boolean; wrongCompletion?: boolean; relayFails?: boolean;
  passes?: number; noProgress?: boolean; expireAfterPass?: boolean; lostPass?: boolean; scheduleFails?: boolean };
function fixture(options: Options = {}) {
  let at = NOW, stored: CustomerTeardownAttempt | null = null, outcome: CustomerTeardownOutcome | null = null, state = '', cookie = '', signatures = 0;
  const events: string[] = [], durableWrites: string[] = [], revoked: string[] = [], warnings: boolean[] = [];
  const requestIds: string[] = [];
  const alarm = { due: false };
  const port: CustomerTeardownAttemptPort = {
    read: async () => stored,
    compareAndSet: async (revision, value) => {
      if ((stored?.revision ?? null) !== revision) return false;
      stored = parseCustomerTeardownAttempt(value); durableWrites.push(canonicalJson(stored)); return true;
    },
  };
  const outcomes: CustomerTeardownOutcomePort = {
    read: async () => outcome,
    write: async (value) => { outcome = value; durableWrites.push(canonicalJson(value)); },
  };
  const transport = async (target: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(target);
    if (url.endsWith('/oauth/start/uninstall')) {
      if (options.relayFails) return Response.json({}, { status: 503 });
      const input = v.parse(v.strictObject({ relayTicket: v.string(), gatewayState: v.string(), pkceChallenge: v.string(), gatewayCallback: v.string() }), JSON.parse(String(init?.body)));
      state = input.gatewayState;
      const authorization = new URL('https://dash.cloudflare.com/oauth2/auth');
      authorization.search = new URLSearchParams({ response_type: 'code', client_id: config.publicClientId,
        redirect_uri: CLOUDFLARE_CODE_RELAY_CALLBACK, scope: SCOPES, state: `${'q'.repeat(64)}.${'s'.repeat(43)}`,
        code_challenge: input.pkceChallenge, code_challenge_method: 'S256' }).toString();
      return Response.json({ schemaVersion: 1, authorizationUrl: authorization.href });
    }
    if (url.endsWith('/oauth2/token')) {
      expect(stored?.phase).toBe('exchanging'); events.push('exchange');
      const result = { access_token: ACCESS_TOKEN, token_type: 'bearer', scope: options.scope ?? SCOPES };
      return Response.json(options.refresh ? { ...result, refresh_token: 'synthetic_refresh_token_never_persist' } : result);
    }
    if (url.endsWith('/oauth2/revoke')) {
      events.push('revoke'); revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
      return Response.json({}, { status: options.revokeFails ? 503 : 200 });
    }
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/access/ai-controls/mcp/portals`);
    events.push('probe'); return Response.json({ success: !options.accountRefused, result: [] }, { status: options.accountRefused ? 403 : 200 });
  };
  const command = async (kind: 'prove' | 'apply' | 'settle', body: string, signature: string): Promise<Response> => {
    expect(signature).toBe(await operationSignature(KEY, body));
    const input = v.parse(boundaryObjectSchema, JSON.parse(body));
    expect(input.actionId).toBe(claim.actionId); expect(input.installationId).toBe(config.installId); events.push(kind);
    if (kind === 'prove') return Response.json({ schemaVersion: 1, actionId: claim.actionId, status: 'authorized', receiptResourceKinds: KINDS, authority: {} });
    if (kind === 'settle') return Response.json({});
    expect(input.cloudflareAccessToken).toBe(ACCESS_TOKEN); expect(stored?.phase).toBe('exchanging');
    requestIds.push(v.parse(v.string(), input.requestId));
    if (options.applyFails) return Response.json({}, { status: 409 });
    if (options.lostPass) throw new Error('synthetic lost pass response');
    if (requestIds.length <= (options.passes ?? 0)) {
      if (options.expireAfterPass) at += 600_001;
      // Each pass reports the fixed words the removal page shows beside the opaque progress.
      const removedKinds = KINDS.slice(0, Math.min(KINDS.length, requestIds.length - 1));
      return Response.json({ schemaVersion: 1, actionId: claim.actionId, installationId: config.installId, status: 'removing',
        progress: `sha256:${(options.noProgress ? 1 : requestIds.length).toString(16).padStart(64, '0')}`,
        phase: requestIds.length === 1 ? 'sharing_preflight' : 'remove', removedKinds });
    }
    return Response.json(options.wrongCompletion ? { ...completion, installationId: `acg-${'0'.repeat(24)}` } : completion);
  };
  const signHandoff = async (result: CustomerTeardownCompletion, prior: boolean) => {
    expect(result).toEqual(completion); expect(events.at(-2)).toBe('revoke'); expect(events.at(-1)).toBe('settle');
    signatures++; warnings.push(prior); events.push('sign'); return 'synthetic_signed_handoff';
  };
  const ports: CustomerTeardownRemovalPorts = {
    attempts: port, outcomes, transport, publicClientId: config.publicClientId, accountId: config.accountId, installId: config.installId,
    controlPlaneOrigin: HOSTED, command, signHandoff, now: () => at,
    schedule: async () => { if (options.scheduleFails) throw new Error('synthetic alarm failure'); alarm.due = true; },
  };
  let driver = new CustomerTeardownRemovalDriver(ports);
  const dependencies: CustomerTeardownDependencies = {
    attempts: port, outcomes, now: () => at, assertOperational: async () => undefined, transport, command,
    issueRelayTicket: async (kinds) => { expect(kinds).toEqual(KINDS); return { relayTicket: `${'r'.repeat(64)}.${'s'.repeat(43)}`, expiresAt: at + 120_000 }; },
    startRemoval: (input) => driver.start(input),
    liveProgress: (attemptId) => driver.live(attemptId),
  };
  const router = createCustomerTeardownRouter(config, dependencies);
  async function start(changes: Partial<typeof claim> = {}, origin = ORIGIN) {
    const handoff = base64UrlEncode(new TextEncoder().encode(canonicalJson({ ...claim, expiresAt: at + 600_000, ...changes })));
    const response = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_TEARDOWN_START_PATH}`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, handoff }) }));
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''; return response;
  }
  const callbackRequest = () => new Request(`${ORIGIN}/__ankka/install/oauth/callback?code=synthetic_authorization_code&state=${state}`, { headers: { cookie } });
  /** One due alarm of the management object: one bounded pass, or the settlement. */
  const pass = async (): Promise<boolean> => {
    if (!alarm.due) return false;
    alarm.due = false;
    await driver.continue();
    return true;
  };
  const settle = async () => { for (let count = 0; await pass(); count += 1) expect(count).toBeLessThan(1_000); };
  const progress = async (attemptId: string) => {
    const response = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_TEARDOWN_PROGRESS_PATH}?attempt=${attemptId}`));
    expect(response.status).toBe(200);
    return v.parse(customerTeardownProgressSchema, await response.json());
  };
  /** Sends the callback and follows the removal to its end: the settled progress and where the browser was sent. */
  const remove = async () => {
    const response = await router.fetch(callbackRequest());
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    const attemptId = location.searchParams.get('attempt');
    if (attemptId === null) return { location, attemptId: null, view: null };
    await settle();
    return { location, attemptId, view: await progress(attemptId) };
  };
  return { router, start, callbackRequest, events, durableWrites, warnings, revoked, requestIds, pass, settle, progress, remove,
    callback: () => router.fetch(callbackRequest()), current: () => stored, outcome: () => outcome, cookie: () => cookie,
    signatures: () => signatures, later: () => { at += 600_001; }, options, alarmDue: () => alarm.due,
    /** A new object instance: the driver's memory, and with it the grant and the key, is gone. */
    restart: () => { driver = new CustomerTeardownRemovalDriver(ports); } };
}

describe('gateway-local teardown authorization', () => {
  it.each([
    [{ scope: `${SCOPES} workers-scripts.write` }, 'authorization'],
    [{ accountRefused: true }, 'account_access'],
    [{ applyFails: true }, 'removal'],
    [{ lostPass: true }, 'removal'],
    [{ wrongCompletion: true }, 'removal'],
    [{ passes: 4, noProgress: true }, 'no_progress'],
    [{ passes: 4, expireAfterPass: true }, 'expired'],
    [{ passes: 1000 }, 'pass_limit'],
    [{ revokeFails: true }, 'revocation'],
    [{ scheduleFails: true }, 'removal'],
  ] as const)('reports a bounded failure stage for %j', async (options, reason) => {
    const f = fixture(options); await f.start();
    const removed = await f.remove();
    let page: Response;
    if (removed.attemptId === null) {
      // A grant that cannot be used, or a pass that cannot be scheduled, ends the attempt before the callback answers.
      expect(removed.location.searchParams.get('result')).toBe('recovery_required');
      expect(removed.location.searchParams.get('reason')).toBe(reason);
      page = await f.router.fetch(new Request(removed.location));
    } else {
      expect(removed.view?.status).toBe('settled'); expect(removed.view?.result).toBe('recovery_required');
      expect(removed.view?.reason).toBe(reason); expect(removed.view?.handoffUrl).toBeNull();
      page = await f.router.fetch(new Request(removed.location));
    }
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain('Removal needs fresh authorization');
    for (const secret of SECRETS) expect(removed.location.href + html + JSON.stringify(removed.view)).not.toContain(secret);
    expect(f.signatures()).toBe(0);
    expect(f.current()?.phase).toBe('settled');
  });
  it('does not reflect unrecognized failure details and keeps old recovery links working', async () => {
    const f = fixture();
    for (const query of ['?result=recovery_required', '?result=recovery_required&reason=%3Cscript%3Eprivate-detail%3C/script%3E']) {
      const response = await f.router.fetch(new Request(`${ORIGIN}${CUSTOMER_TEARDOWN_PATH}${query}`));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Removal stopped. Return to Settings');
      expect(html).not.toContain('private-detail');
    }
    for (const query of ['?attempt=not-an-attempt', '?result=removed', '?attempt=attempt_' + 'a'.repeat(24) + '&code=secret', '?reason=denied']) {
      expect((await f.router.fetch(new Request(`${ORIGIN}${CUSTOMER_TEARDOWN_PATH}${query}`))).status).toBe(404);
    }
    expect((await f.router.fetch(new Request(`${ORIGIN}${CUSTOMER_TEARDOWN_PROGRESS_PATH}?attempt=attempt_${'a'.repeat(24)}`))).status).toBe(404);
    expect(f.events).toEqual([]);
  });

  it('answers the callback at once, runs one bounded pass per alarm with one request ID, then revokes before handoff', async () => {
    const f = fixture({ passes: 160 });
    await f.start();
    const response = await f.callback();
    expect(response.status).toBe(303);
    // The callback exchanged, checked the account and left; every pass waits for its alarm.
    expect(f.events).toEqual(['prove', 'exchange', 'probe']);
    expect(f.alarmDue()).toBe(true);
    const attemptId = new URL(response.headers.get('location') ?? '').searchParams.get('attempt') ?? '';
    expect((await f.progress(attemptId)).status).toBe('removing');
    let passes = 0;
    while (await f.pass()) passes += 1;
    // One pass per bounded apply, the last one completing; the settlement runs in that same alarm.
    expect(passes).toBe(161);
    expect(f.requestIds).toHaveLength(161); expect(new Set(f.requestIds).size).toBe(1);
    expect(f.signatures()).toBe(1); expect(f.revoked).toEqual([ACCESS_TOKEN]);
    expect(f.durableWrites.join('')).not.toContain(ACCESS_TOKEN);
    expect(f.durableWrites.join('')).not.toContain(KEY);
  });
  for (const options of [{ passes: 4, noProgress: true }, { passes: 4, expireAfterPass: true }, { lostPass: true }, { passes: 1000 }]) {
    it(`stops, revokes and withholds handoff when a pass cannot continue: ${JSON.stringify(options)}`, async () => {
      const f = fixture(options); await f.start(); const removed = await f.remove();
      expect(removed.view?.result).toBe('recovery_required');
      expect(f.signatures()).toBe(0); expect(f.revoked).toEqual([ACCESS_TOKEN]);
      expect(f.requestIds.length).toBe(options.noProgress ? 2 : options.passes === 1000 ? 768 : 1);
      const prior = f.requestIds[0];
      f.options.passes = 0; f.options.expireAfterPass = false; f.options.lostPass = false;
      await f.start(); const recovered = await f.remove();
      expect(recovered.view?.result).toBe('removed');
      expect(f.signatures()).toBe(1); expect(f.requestIds.at(-1)).not.toBe(prior);
    });
  }
  it('reviews without provider work, then proves, removes by alarm, revokes, settles and signs in order', async () => {
    const f = fixture({ passes: 2 }); const page = await f.router.fetch(new Request(`${ORIGIN}${CUSTOMER_TEARDOWN_PATH}`));
    expect(await page.text()).toContain('Two temporary Cloudflare approvals'); expect(f.events).toEqual([]);
    expect((await f.start()).status).toBe(200); const response = await f.callback(); expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(`${ORIGIN}${CUSTOMER_TEARDOWN_PATH}`);
    const attemptId = location.searchParams.get('attempt') ?? '';
    expect([...location.searchParams.keys()]).toEqual(['attempt']);
    expect(attemptId).toBe(f.current()?.attemptId);
    // The removal page: a loader and the step list, nothing of the grant, the key or the code.
    const progressPage = await f.router.fetch(new Request(location));
    expect(progressPage.status).toBe(200);
    const html = await progressPage.text();
    expect(html).toContain('this page updates itself'); expect(html).toContain(CUSTOMER_TEARDOWN_PROGRESS_PATH);
    for (const secret of SECRETS) expect(html).not.toContain(secret);
    expect(html).not.toContain('synthetic_authorization_code');
    let view = await f.progress(attemptId);
    expect(view.status).toBe('removing'); expect(view.result).toBeNull();
    expect(view.steps.map((step) => `${step.id}:${step.state}`)).toEqual(['sharing:active', ...KINDS.map((kind) => `${kind}:pending`), 'verification:pending']);
    await f.pass();
    view = await f.progress(attemptId);
    expect(view.steps[0]).toEqual({ id: 'sharing', label: 'Portal sharing check', state: 'active' });
    await f.pass();
    view = await f.progress(attemptId);
    expect(view.steps.map((step) => `${step.id}:${step.state}`)).toEqual(['sharing:done', 'access_application:done', 'access_policy:active',
      'dns_record:pending', 'mcp_portal:pending', 'mcp_server:pending', 'verification:pending']);
    await f.settle();
    view = await f.progress(attemptId);
    expect(view.status).toBe('settled'); expect(view.result).toBe('removed'); expect(view.reason).toBeNull();
    expect(view.steps.every((step) => step.state === 'done')).toBe(true);
    const handoffUrl = new URL(view.handoffUrl ?? '');
    expect(handoffUrl.origin + handoffUrl.pathname).toBe(`${HOSTED}/teardown`);
    expect(new TextDecoder().decode(base64UrlDecode(handoffUrl.hash.slice(1)))).toBe('synthetic_signed_handoff');
    expect(f.events).toEqual(['prove', 'exchange', 'probe', 'apply', 'apply', 'apply', 'revoke', 'settle', 'sign']);
    expect(f.current()?.phase).toBe('settled'); expect(f.revoked).toEqual([ACCESS_TOKEN]);
    const sealed = f.cookie().slice(f.cookie().indexOf('=') + 1), secret = await openCustomerTeardownCookie(KEY, sealed, NOW);
    for (const write of f.durableWrites) {
      expect(write).not.toContain(KEY); expect(write).not.toContain(secret.verifier); expect(write).not.toContain(ACCESS_TOKEN);
    }
    expect(sealed).not.toContain(secret.verifier); expect(sealed).not.toContain(KEY);
    // The page reloaded after the hop, or with the result word it recorded, still answers from the outcome.
    for (const query of [`?attempt=${attemptId}&result=removed`, `?attempt=${attemptId}`]) {
      expect((await f.router.fetch(new Request(`${ORIGIN}${CUSTOMER_TEARDOWN_PATH}${query}`))).status).toBe(200);
    }
    expect((await f.progress(attemptId)).handoffUrl).toBe(view.handoffUrl);
  });
  it('loses the grant and the key with the object and settles the attempt as interrupted with the revocation warning', async () => {
    const f = fixture({ passes: 4 }); await f.start();
    const response = await f.callback(); expect(response.status).toBe(303);
    const attemptId = new URL(response.headers.get('location') ?? '').searchParams.get('attempt') ?? '';
    expect(await f.pass()).toBe(true);
    f.restart();
    // Nothing durable carries the grant or the key: the next alarm can only end the attempt, unrevoked.
    await f.settle();
    const view = await f.progress(attemptId);
    expect(view.status).toBe('settled'); expect(view.result).toBe('recovery_required'); expect(view.reason).toBe('interrupted');
    expect(f.current()?.phase).toBe('settled'); expect(f.current()?.priorGrantRevocationUnconfirmed).toBe(true);
    expect(f.events).not.toContain('revoke'); expect(f.events).not.toContain('settle');
    // A fresh consent continues from the gateway's journal and carries the warning into the receipt.
    f.options.passes = 0;
    await f.start(); const recovered = await f.remove();
    expect(recovered.view?.result).toBe('removed'); expect(f.warnings).toEqual([true]);
  });
  it('reports an attempt whose window closed without a settlement as expired', async () => {
    const f = fixture({ passes: 4 }); await f.start();
    const response = await f.callback();
    const attemptId = new URL(response.headers.get('location') ?? '').searchParams.get('attempt') ?? '';
    f.later();
    const view = await f.progress(attemptId);
    expect(view.status).toBe('settled'); expect(view.result).toBe('recovery_required'); expect(view.reason).toBe('expired');
  });
  it('atomically spends a callback before a simultaneous replay can exchange', async () => {
    const f = fixture(); await f.start(); const request = f.callbackRequest();
    const responses = await Promise.all([f.router.fetch(new Request(request.url, { headers: request.headers })), f.router.fetch(new Request(request.url, { headers: request.headers }))]);
    expect(responses.map((r) => r.status).sort()).toEqual([303, 409]);
    expect(f.events.filter((e) => e === 'exchange')).toHaveLength(1);
    await f.settle();
    expect(f.signatures()).toBe(1);
    expect((await f.callback()).status).toBe(400);
  });
  for (const options of [{ scope: `${SCOPES} workers-scripts.write` }, { accountRefused: true }, { refresh: true }]) {
    it(`rejects an unusable grant before deletion: ${JSON.stringify(options)}`, async () => {
      const f = fixture(options); await f.start(); const response = await f.callback();
      expect(response.headers.get('location')).toContain('result=recovery_required');
      expect(f.alarmDue()).toBe(false);
      expect(f.events).not.toContain('apply'); expect(f.signatures()).toBe(0); expect(f.revoked).toContain(ACCESS_TOKEN);
      if (options.refresh) expect(f.revoked).toContain('synthetic_refresh_token_never_persist');
      expect(f.outcome()?.result).toBe('recovery_required');
    });
  }
  for (const options of [{ applyFails: true }, { wrongCompletion: true }, { revokeFails: true }]) {
    it(`cannot sign incomplete or unrevoked removal: ${JSON.stringify(options)}`, async () => {
      const priorWarning = options.revokeFails === true;
      const f = fixture(options); await f.start(); await f.remove();
      expect(f.signatures()).toBe(0); expect(f.current()?.phase).toBe('settled');
      expect(f.current()?.priorGrantRevocationUnconfirmed).toBe(options.revokeFails === true);
      f.options.applyFails = false; f.options.wrongCompletion = false; f.options.revokeFails = false;
      expect((await f.start()).status).toBe(200); await f.remove(); expect(f.signatures()).toBe(1); expect(f.warnings).toEqual([priorWarning]);
    });
  }
  it('rejects changed authority and cross-origin starts; denied and expired callbacks cannot exchange', async () => {
    const f = fixture(); expect((await f.start({}, 'https://foreign.example')).status).toBe(403);
    expect((await f.start({ installationId: `acg-${'0'.repeat(24)}` })).status).toBe(400); expect(f.events).toEqual([]);
    await f.start(); const request = f.callbackRequest(), url = new URL(request.url); url.searchParams.delete('code'); url.searchParams.set('error', 'authorization_rejected');
    const denied = await f.router.fetch(new Request(url, { headers: request.headers }));
    expect(denied.status).toBe(303); expect(denied.headers.get('location')).toBe(`${ORIGIN}${CUSTOMER_TEARDOWN_PATH}?result=recovery_required&reason=denied`);
    expect(f.events).not.toContain('exchange'); expect(f.current()?.phase).toBe('settled');
    await f.start(); f.later(); expect((await f.callback()).status).toBe(409); expect(f.events).not.toContain('exchange');
  });
  it('settles a refused relay so a fresh consent can start immediately', async () => {
    const f = fixture({ relayFails: true }); expect((await f.start()).status).toBe(503);
    expect(f.current()?.phase).toBe('settled'); f.options.relayFails = false; expect((await f.start()).status).toBe(200);
  });
});
