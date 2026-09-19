import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ORIGIN, OAUTH_CALLBACK_URL, OAUTH_EXCHANGE_URL, OAUTH_REVOKE_URL } from '../src/constants';
import { openGatewayTeardownCookie } from '../src/crypto';
import { gatewayTeardownJobId } from '../src/gateway-teardown-handoff';
import { GATEWAY_ROOT_REMOVAL_STEPS } from '../src/gateway-teardown-job';
import { GATEWAY_TEARDOWN_CALL_BUDGET } from '../src/gateway-teardown-provider';
import { GatewayTeardownStoreClient } from '../src/gateway-teardown-store-client';
import { createGatewayTeardownRouter, gatewayTeardownRefusalMessage, GATEWAY_TEARDOWN_COOKIE, GATEWAY_TEARDOWN_RELOAD_GUIDANCE } from '../src/gateway-teardown-router';
import type { ExactReleaseBundleIdentity } from '../src/exact-release-bundle';
import { TwoStageDeploySession, type TwoStageDeploySessionNamespace, type TwoStageDeploySessionTeardownDependencies } from '../src/two-stage-deploy-session';
import { ROOT_TEST } from './gateway-teardown-fixture';
import { gatewayRootProviderFixture, TOKEN } from './gateway-teardown-provider-fixture';
import { teardownSqliteFixture } from './gateway-teardown-sqlite-fixture';
import { ENCRYPTION_KEY, CLIENT_ID, CLIENT_SECRET } from './fixtures';

const viewSchema = v.object({ csrfToken: v.string(), canAuthorize: v.boolean(), complete: v.boolean(), revocationUnconfirmed: v.boolean(),
  removing: v.boolean(), message: v.string(), failureReason: v.nullable(v.string()), managementTokenName: v.nullable(v.string()),
  steps: v.array(v.object({ done: v.boolean(), current: v.boolean() })), handoff: v.string() });

async function fixture() {
  const provider = await gatewayRootProviderFixture();
  let time = ROOT_TEST.now;
  let cookie = '';
  let csrf = '';
  let grants = 0, revoked = 0;
  /** Every provider call and every Durable Object call since the last reset: what one invocation spends. */
  let subrequests = 0;
  const trace: string[] = [];
  /** The subrequests each finalizer pass spent, one entry per alarm. */
  const passes: number[] = [];
  let revokeFails = false, wrongAccount = false, extraScope = false, returnsRefresh = false, bundleFails = false;
  const instances = new Map<string, { sql: ReturnType<typeof teardownSqliteFixture>; stub: TwoStageDeploySession }>();
  const jobId = await gatewayTeardownJobId(provider.handoff);
  // The provider fixture reads the job before answering each call; that look is the test's, not the invocation's.
  const uncounted = new GatewayTeardownStoreClient({ fetch: (request) => {
    const instance = instances.get(`gateway-teardown:v1:${jobId}`);
    if (instance === undefined) throw new Error('fixture_instance_missing');
    return instance.stub.fetch(request);
  } });
  provider.readJobFrom(() => uncounted.read());
  const transport = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    subrequests += 1;
    const request = new Request(input, init), url = new URL(request.url);
    trace.push(`${request.method} ${url.pathname}`);
    if (url.href === OAUTH_EXCHANGE_URL) {
      grants += 1;
      const job = await uncounted.read(); expect(job?.phase).toBe('exchanging');
      const value = { access_token: TOKEN, token_type: 'bearer', scope: `workers-scripts.write zone-access.write${extraScope ? ' dns.write' : ''}` };
      return Response.json(returnsRefresh ? { ...value, refresh_token: 'synthetic-refresh-token' } : value);
    }
    if (url.href === OAUTH_REVOKE_URL) { revoked += 1; return new Response('', { status: revokeFails ? 503 : 200 }); }
    if (url.pathname === '/client/v4/accounts') throw new Error('Final removal must not list accounts');
    if (wrongAccount && url.pathname.startsWith(`/client/v4/accounts/${ROOT_TEST.accountId}/`)) {
      return Response.json({ success: false, errors: [], result: null }, { status: 403 });
    }
    return provider.transport(request);
  };
  const loadBundle = async (identity: ExactReleaseBundleIdentity) => {
    expect(identity).toEqual(provider.job.release);
    if (bundleFails) throw new Error('release_unavailable');
    return provider.bundle;
  };
  // The job object's finalizer: the same OAuth client and trust the router carries, and the test transport.
  const teardown: TwoStageDeploySessionTeardownDependencies = {
    oauth: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, trust: provider.trust, transport, loadBundle, wait: async () => undefined,
  };
  const object = (sql: ReturnType<typeof teardownSqliteFixture>) => new TwoStageDeploySession(sql.state, undefined, { now: () => time, teardown });
  const namespace: TwoStageDeploySessionNamespace = {
    idFromName: (name) => {
      const id: DurableObjectId = Object.create(null);
      Object.defineProperty(id, 'toString', { value: () => name });
      return id;
    },
    get: (id) => {
      const name = id.toString();
      let value = instances.get(name);
      if (value === undefined) {
        const sql = teardownSqliteFixture();
        value = { sql, stub: object(sql) };
        instances.set(name, value);
      }
      const instance = value;
      return { fetch: (request) => { subrequests += 1; trace.push(`journal ${new URL(request.url).pathname}`); return instance.stub.fetch(request); } };
    },
  };
  const port = new GatewayTeardownStoreClient({ fetch: (request) => namespace.get(namespace.idFromName(`gateway-teardown:v1:${jobId}`)).fetch(request) });
  /** Runs one due alarm of the job object, as the platform would in its own invocation; false when none is due. */
  const pass = async (): Promise<boolean> => {
    const instance = instances.get(`gateway-teardown:v1:${jobId}`);
    if (instance === undefined || instance.sql.alarm.at === null) return false;
    instance.sql.alarm.at = null;
    subrequests = 0; trace.length = 0;
    await instance.stub.alarm();
    passes.push(subrequests);
    return true;
  };
  const makeRouter = () => createGatewayTeardownRouter({ encryptionKey: ENCRYPTION_KEY,
    oauth: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, trust: provider.trust, release: provider.job.release, namespace }, {
    now: () => time, loadBundle, rateLimit: async () => undefined, transport,
  });
  let router = makeRouter();
  const send = async (path: string, body?: { handoff: string } | Record<string, never>, options: { origin?: string; csrf?: string; cookie?: string } = {}) => {
    const headers = new Headers({ cookie: options.cookie ?? cookie });
    if (body !== undefined) {
      headers.set('content-type', 'application/json'); headers.set('origin', options.origin ?? PUBLIC_ORIGIN);
      headers.set('x-csrf-token', options.csrf ?? csrf);
    }
    const response = await router.fetch(new Request(new URL(path, PUBLIC_ORIGIN), { method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? null : JSON.stringify(body) }));
    const updated = response.headers.get('set-cookie');
    if (updated !== null) cookie = updated.split(';')[0] ?? '';
    return response;
  };
  const view = async () => {
    const response = await send('/api/teardown');
    expect(response.status).toBe(200);
    const value = v.parse(viewSchema, await response.json()); csrf = value.csrfToken; return value;
  };
  const start = async () => {
    await view();
    const response = await send('/api/teardown/authorize', {});
    expect(response.status).toBe(200);
    const authorization = new URL(v.parse(v.object({ authorizationUrl: v.string() }), await response.json()).authorizationUrl);
    expect(authorization.searchParams.get('scope')?.split(' ').sort()).toEqual(['workers-scripts.write', 'zone-access.write']);
    const callback = new URL(OAUTH_CALLBACK_URL);
    callback.searchParams.set('state', authorization.searchParams.get('state') ?? '');
    callback.searchParams.set('code', 'synthetic-code-for-removal');
    return callback;
  };
  return { ...provider, send, view, start, port, grants: () => grants, revoked: () => revoked,
    subrequests: () => subrequests, resetSubrequests: () => { subrequests = 0; trace.length = 0; }, trace: () => trace.join('\n'),
    passes, pass,
    /** Runs the job object's alarms until none is due: the attempt's passes and its settlement. */
    settle: async () => { for (let count = 0; await pass(); count += 1) expect(count).toBeLessThan(200); },
    cookie: () => cookie, router: () => router,
    import: () => send('/api/teardown/import', { handoff: provider.handoff }),
    advance: () => { time += 86_400_001; },
    /** Past a receipt's ten-minute import window, inside the browser session's day. */
    closeImportWindow: () => { time += 600_001; },
    now: () => time,
    failBundle: (fails: boolean) => { bundleFails = fails; },
    /** A new object instance over the same storage: memory, and with it any held grant, is gone. */
    reopen: () => {
      for (const value of instances.values()) value.stub = object(value.sql);
      router = makeRouter(); cookie = ''; csrf = '';
    },
    /** Only the object instances restart; the browser session and router stay. */
    restartObjects: () => { for (const value of instances.values()) value.stub = object(value.sql); },
    alterGrant: (kind: 'revoke' | 'account' | 'scope' | 'refresh') => {
      revokeFails = kind === 'revoke'; wrongAccount = kind === 'account'; extraScope = kind === 'scope'; returnsRefresh = kind === 'refresh';
    },
    close: () => { for (const value of instances.values()) value.sql.close(); },
  };
}

describe('hosted removal browser callback and durable recovery', () => {
  it('reopens an existing job with equivalent fresh proof while preserving authority, progress, and revocation warnings', async () => {
    const f = await fixture();
    try {
      expect((await f.import()).status).toBe(200);
      const before = await f.port.read();
      f.advance(); f.reopen();
      const issuedAt = ROOT_TEST.now + 86_400_001;
      const statement = { ...f.statement, actionId: `action_${'z'.repeat(32)}`, issuedAt, expiresAt: issuedAt + 600_000,
        priorGrantRevocationUnconfirmed: true };
      const fresh = await f.sign(statement);
      expect((await f.send('/api/teardown/import', { handoff: fresh })).status).toBe(200);
      const resumed = await f.port.read();
      expect(resumed?.handoff).toBe(before?.handoff); expect(resumed?.acceptedAt).toBe(before?.acceptedAt);
      expect(resumed?.verifiedSteps).toEqual(before?.verifiedSteps); expect((await f.view()).revocationUnconfirmed).toBe(true);
      const drifted = await f.sign({ ...statement, management: { ...statement.management, policyId: 'foreign-policy' } });
      expect((await f.send('/api/teardown/import', { handoff: drifted })).status).toBe(409);
      const callback = await f.start(); expect((await f.send(callback.pathname + callback.search)).status).toBe(303);
      await f.settle();
      expect((await f.port.read())?.phase).toBe('removed_revocation_unconfirmed');
    } finally { f.close(); }
  });

  it('retains a content-free provider reason when a foreign dependency stops removal', async () => {
    const f = await fixture();
    try {
      await f.import(); f.drift('policy');
      const callback = await f.start(); await f.send(callback.pathname + callback.search);
      await f.settle();
      expect((await f.view()).failureReason).toBe('policy_list_foreign_dependency');
      expect(f.mutations).toEqual([]); expect(f.revoked()).toBe(1);
      const job = await f.port.read(); expect(job?.failureReason).not.toContain(TOKEN);
    } finally { f.close(); }
  });

  it('imports a signed handoff, removes the root, revokes its grant, and rejects callback replay', async () => {
    const test = await fixture();
    try {
      expect((await test.import()).status).toBe(200);
      const page = await test.send('/teardown'); expect(page.status).toBe(200);
      expect((await test.view()).canAuthorize).toBe(true); expect((await test.view()).complete).toBe(false);
      const callback = await test.start();
      const callbackCookie = test.cookie();
      const sealed = callbackCookie.slice(GATEWAY_TEARDOWN_COOKIE.length + 1);
      const opened = await openGatewayTeardownCookie(ENCRYPTION_KEY, sealed, ROOT_TEST.now);
      expect(callbackCookie).not.toContain(opened.attempt?.verifier);
      expect(JSON.stringify(await test.port.read())).not.toContain(opened.attempt?.verifier);
      test.resetSubrequests();
      const response = await test.send(callback.href);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(`${PUBLIC_ORIGIN}/teardown`);
      // The callback exchanged the code and bound the grant to the account; every provider step waits for the alarm.
      expect(test.subrequests(), test.trace()).toBeLessThanOrEqual(8);
      expect(test.grants()).toBe(1); expect(test.mutations).toEqual([]);
      const removing = await test.view();
      expect(removing.removing).toBe(true); expect(removing.canAuthorize).toBe(false); expect(removing.complete).toBe(false);
      expect(removing.message).toBe('Removing your gateway. This page updates itself.');
      // The token reminder belongs to the end: until the gateway is gone there is nothing to clean up after.
      expect(removing.managementTokenName).toBeNull();
      expect(removing.steps.map((step) => step.current)).toEqual([true, false, false, false, false]);
      await test.settle();
      const view = await test.view();
      expect(view.steps.every((step) => step.done)).toBe(true);
      expect(view.removing).toBe(false); expect(view.steps.some((step) => step.current)).toBe(false);
      expect(view.canAuthorize).toBe(false); expect(view.revocationUnconfirmed).toBe(false); expect(view.complete).toBe(true);
      // Removal cannot revoke the management token, so the finished page names the one setup pre-filled for this gateway.
      expect(view.managementTokenName).toBe(`Ankka gateway ${test.statement.management.hostname}`);
      expect(test.grants()).toBe(1); expect(test.revoked()).toBe(1);
      for (const spent of test.passes) expect(spent).toBeLessThanOrEqual(GATEWAY_TEARDOWN_CALL_BUDGET);
      expect((await test.send(callback.href, undefined, { cookie: callbackCookie })).status).toBe(409);
      expect(test.grants()).toBe(1);
      expect(JSON.stringify(await test.port.read())).not.toContain(TOKEN);
    } finally { test.close(); }
  });

  it('accepts the scope Cloudflare echoes beside the code and rejects any other echo or parameter without spending the attempt', async () => {
    const test = await fixture();
    try {
      await test.import();
      const callback = await test.start();
      const echoing = (scope: string) => { const url = new URL(callback.href); url.searchParams.set('scope', scope); return url.href; };
      expect((await test.send(echoing('workers-scripts.write zone-access.write dns.write'))).status).toBe(409);
      const extra = new URL(callback.href); extra.searchParams.set('iss', 'https://dash.cloudflare.com');
      expect((await test.send(extra.href)).status).toBe(409);
      expect(test.grants()).toBe(0); expect(test.mutations).toEqual([]);
      expect((await test.port.read())?.phase).toBe('authorizing');
      expect((await test.send(echoing('zone-access.write workers-scripts.write'))).status).toBe(303);
      await test.settle();
      expect((await test.port.read())?.phase).toBe('removed');
      expect(test.grants()).toBe(1); expect(test.mutations).toHaveLength(5);
    } finally { test.close(); }
  });

  it.each(['retire_namespace', 'worker'] as const)('recovers a lost %s response after the gateway and browser session are gone', async (step) => {
    const test = await fixture();
    try {
      await test.import(); test.failAfter(step);
      expect((await test.send((await test.start()).href)).status).toBe(303);
      await test.settle();
      expect((await test.port.read())?.phase).toBe('recovery_required');
      const acceptedAt = (await test.port.read())?.acceptedAt;
      test.advance(); test.reopen(); test.failAfter(null);
      expect((await test.import()).status).toBe(200); // Existing accepted authority survives import expiry.
      expect((await test.send((await test.start()).href)).status).toBe(303);
      await test.settle();
      expect((await test.port.read())?.phase).toBe('removed');
      expect((await test.port.read())?.acceptedAt).toBe(acceptedAt);
      expect(test.mutations).toHaveLength(5); expect(new Set(test.mutations).size).toBe(5);
    } finally { test.close(); }
  });

  it.each(['account', 'scope', 'refresh'] as const)('rejects an unexpected grant %s and still revokes every captured credential', async (kind) => {
    const test = await fixture();
    try {
      await test.import(); test.alterGrant(kind);
      expect((await test.send((await test.start()).href)).status).toBe(303);
      // A grant that cannot be used is revoked and the attempt settled before the callback answers.
      expect((await test.port.read())?.phase).toBe('recovery_required');
      expect(await test.pass()).toBe(false);
      expect(test.mutations).toEqual([]);
      expect(test.revoked()).toBe(kind === 'refresh' ? 2 : 1);
    } finally { test.close(); }
  });

  it('spends at most the call budget per pass and finishes a large account in one consent across passes', async () => {
    const test = await fixture();
    try {
      await test.import();
      test.createdOwner('2026-09-01T12:00:00.000000Z');
      // Enough recently modified scripts that the scan alone outgrows one pass; every pass has its own budget.
      for (let index = 0; index < 60; index += 1) test.addForeignScript(`recent-script-${index}`, '2026-09-03T08:00:00.000000Z');
      expect((await test.send((await test.start()).href)).status).toBe(303);
      await test.settle();
      expect(test.passes.length).toBeGreaterThan(2);
      for (const spent of test.passes) expect(spent).toBeLessThanOrEqual(GATEWAY_TEARDOWN_CALL_BUDGET);
      const job = await test.port.read();
      expect(job?.phase).toBe('removed');
      expect(job?.failureReason).toBeNull();
      for (let index = 0; index < 60; index += 1) expect(test.readCount(`/workers/scripts/recent-script-${index}/settings`)).toBe(1);
      expect(test.mutations).toEqual([...GATEWAY_ROOT_REMOVAL_STEPS]);
      expect(test.grants()).toBe(1); expect(test.revoked()).toBe(1);
    } finally { test.close(); }
  });

  it('loses the grant with the object and settles the attempt as recovery-required with an unconfirmed revocation', async () => {
    const test = await fixture();
    try {
      await test.import();
      test.createdOwner('2026-09-01T12:00:00.000000Z');
      for (let index = 0; index < 60; index += 1) test.addForeignScript(`recent-script-${index}`, '2026-09-03T08:00:00.000000Z');
      expect((await test.send((await test.start()).href)).status).toBe(303);
      expect(await test.pass()).toBe(true);
      expect((await test.view()).removing).toBe(true);
      // The object restarts between passes: nothing durable carries the grant, so the next alarm can only stop the attempt.
      test.restartObjects();
      await test.settle();
      const job = await test.port.read();
      expect(job?.phase).toBe('recovery_required');
      expect(job?.failureReason).toBe('grant_lost');
      expect(job?.revocation).toBe('unconfirmed');
      expect(test.revoked()).toBe(0);
      expect(test.mutations).toEqual([]);
      const view = await test.view();
      expect(view.canAuthorize).toBe(true); expect(view.revocationUnconfirmed).toBe(true);
      // A fresh consent resumes from the durable receipts and keeps the warning.
      expect((await test.send((await test.start()).href)).status).toBe(303);
      await test.settle();
      expect((await test.port.read())?.phase).toBe('removed_revocation_unconfirmed');
      expect(test.mutations).toEqual([...GATEWAY_ROOT_REMOVAL_STEPS]);
      expect(test.grants()).toBe(2); expect(test.revoked()).toBe(1);
    } finally { test.close(); }
  });

  it('reports unconfirmed revocation separately from verified resource removal', async () => {
    const test = await fixture();
    try {
      await test.import(); test.alterGrant('revoke');
      expect((await test.send((await test.start()).href)).status).toBe(303);
      await test.settle();
      expect((await test.port.read())?.phase).toBe('removed_revocation_unconfirmed');
      expect((await test.view()).revocationUnconfirmed).toBe(true);
    } finally { test.close(); }
  });

  it('rejects new expired/tampered imports, cross-origin writes, CSRF, and denied or expired callbacks without a grant', async () => {
    const test = await fixture();
    try {
      expect((await test.send('/api/teardown/import', { handoff: test.handoff }, { origin: 'https://foreign.example.com' })).status).toBe(403);
      expect((await test.send('/api/teardown/import', { handoff: test.handoff.replace('gateway_teardown_handoff_envelope', 'other') })).status).toBe(409);
      await test.import();
      expect((await test.send('/api/teardown/authorize', {}, { csrf: 'wrong' })).status).toBe(403);
      const denied = await test.start(); denied.searchParams.delete('code'); denied.searchParams.set('error', 'access_denied');
      expect((await test.send(denied.href)).status).toBe(303);
      const expired = await test.start(); test.advance();
      expect((await test.send(expired.href)).status).toBe(404);
      expect(test.grants()).toBe(0); expect(test.mutations).toEqual([]);
    } finally { test.close(); }
    const fresh = await fixture();
    try { fresh.advance(); expect((await fresh.import()).status).toBe(409); }
    finally { fresh.close(); }
  });

  it('says where a fresh receipt comes from when no reload can help, and keeps the reload wording for the rest', async () => {
    const refusalSchema = v.strictObject({ error: v.string(), message: v.optional(v.string()) });
    const refused = async (response: Response) => { expect(response.status).toBe(409); return v.parse(refusalSchema, await response.json()); };
    const test = await fixture();
    try {
      // No receipt and no session: nothing to reload into.
      expect(await refused(await test.send('/api/teardown'))).toEqual({ error: 'teardown_session_missing',
        message: gatewayTeardownRefusalMessage('teardown_session_missing') });
      // A failure of ours leaves the receipt usable: the page keeps its reload wording.
      test.failBundle(true);
      expect(await refused(await test.import())).toEqual({ error: 'teardown_unavailable' });
      test.failBundle(false);
      expect((await test.import()).status).toBe(200);
      // A second consent on the gateway re-signs the same removal; its receipt opens the job only inside its own window.
      const issuedAt = test.now();
      const second = await test.sign({ ...test.statement, actionId: `action_${'z'.repeat(32)}`, nonce: 'B'.repeat(43), issuedAt, expiresAt: issuedAt + 600_000 });
      expect((await test.send('/api/teardown/import', { handoff: second })).status).toBe(200);
      test.closeImportWindow();
      const expired = await refused(await test.send('/api/teardown/import', { handoff: second }));
      expect(expired).toEqual({ error: 'teardown_receipt_expired', message: gatewayTeardownRefusalMessage('teardown_receipt_expired', ROOT_TEST.hostname) });
      expect(expired.message).toContain(`management page at ${ROOT_TEST.hostname} and authorize the removal again`);
      expect(expired.message).not.toContain('Reload');
      // The accepted receipt is the saved recovery receipt: it still opens its job.
      expect((await test.import()).status).toBe(200);
      // An expired receipt that names another gateway than its certificate verifies at no time, so its hostname is never repeated.
      const misdirected = await test.sign({ ...test.statement, issuedAt, expiresAt: issuedAt + 600_000,
        management: { ...test.statement.management, hostname: 'other.example.com' } });
      const rejected = await refused(await test.send('/api/teardown/import', { handoff: misdirected }));
      expect(rejected).toEqual({ error: 'teardown_receipt_rejected', message: gatewayTeardownRefusalMessage('teardown_receipt_rejected') });
      expect(rejected.message).not.toContain('example.com');
      expect(await refused(await test.send('/api/teardown/import', { handoff: 'not a receipt' }))).toEqual(rejected);
      const drifted = await test.sign({ ...test.statement, issuedAt: test.now(), expiresAt: test.now() + 600_000,
        management: { ...test.statement.management, policyId: 'foreign-policy' } });
      expect(await refused(await test.send('/api/teardown/import', { handoff: drifted }))).toEqual(rejected);
      const html = await (await test.send('/teardown')).text();
      expect(html).toContain(JSON.stringify(GATEWAY_TEARDOWN_RELOAD_GUIDANCE));
      expect(html).toContain(JSON.stringify(gatewayTeardownRefusalMessage('teardown_receipt_rejected')));
      expect(html).toContain('refusal.message');
    } finally { test.close(); }
    // The first receipt of a removal, arriving after its window: no job exists, and the gateway it names can sign another.
    const late = await fixture();
    try {
      late.closeImportWindow();
      expect(await refused(await late.import())).toEqual({ error: 'teardown_receipt_expired',
        message: gatewayTeardownRefusalMessage('teardown_receipt_expired', ROOT_TEST.hostname) });
      expect(await late.port.read()).toBeNull();
    } finally { late.close(); }
  });
});
