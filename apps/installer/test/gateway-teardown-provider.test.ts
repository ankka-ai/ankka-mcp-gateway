import { describe, expect, it } from 'vitest';
import { GATEWAY_ROOT_REMOVAL_STEPS } from '../src/gateway-teardown-job';
import {
  foreignScriptNeedsRead, gatewayTeardownFailureReason, GatewayTeardownCallBudget, GatewayTeardownProviderError,
  GATEWAY_TEARDOWN_CALL_BUDGET, GATEWAY_TEARDOWN_SETTLEMENT_RESERVE,
} from '../src/gateway-teardown-provider';
import { ROOT_TEST } from './gateway-teardown-fixture';
import { gatewayRootProviderFixture as fixture, ATTEMPT, NEXT_ATTEMPT, TOKEN } from './gateway-teardown-provider-fixture';

const CREATED = '2026-09-01T12:00:00.000000Z';
const BEFORE = '2026-08-31T23:59:59.000000Z';
const AFTER = '2026-09-03T08:00:00.000000Z';

describe('fixed hosted gateway root removal', () => {
  it('retires only the signed namespace and removes the recorded root in order', async () => {
    const test = await fixture();
    const result = await test.run();
    expect(result.verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.mutations).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.live).toEqual({ worker: false, namespace: false, domain: false, application: false, policy: false, retired: true });
    expect(JSON.stringify(test.writes)).not.toContain(TOKEN);
    expect(result.phase).toBe('exchanging'); // The wrapper must still revoke its grant.
  });

  it.each(GATEWAY_ROOT_REMOVAL_STEPS)('resolves a lost %s response on fresh consent without sending twice', async (step) => {
    const test = await fixture();
    test.failAfter(step);
    await expect(test.run()).rejects.toMatchObject({ code: 'provider_unknown' });
    expect(test.current().pendingStep).toBe(step);
    test.renew();
    test.failAfter(null);
    expect((await test.run(NEXT_ATTEMPT)).verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.mutations).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
  });

  it('requires a fresh consent before retrying a write that left the resource present', async () => {
    const test = await fixture();
    test.failBefore('management_domain');
    await expect(test.run()).rejects.toThrow('teardown_management_domain_provider_unknown');
    await expect(test.run()).rejects.toThrow('teardown_job_conflict');
    test.renew(); test.failBefore(null);
    expect((await test.run(NEXT_ATTEMPT)).verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.mutations).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
  });

  it.each(['policy', 'binding', 'service', 'namespace', 'domain'] as const)('refuses a foreign %s before any mutation', async (kind) => {
    const test = await fixture(); test.drift(kind);
    await expect(test.run()).rejects.toMatchObject({ code: 'foreign_dependency' });
    expect(test.mutations).toEqual([]);
  });

  it('refuses a changed application, policy name, or wrong Cloudflare account', async () => {
    const test = await fixture();
    test.application.domain = 'foreign.example.com';
    await expect(test.run()).rejects.toMatchObject({ code: 'identity_mismatch' });
    test.application.domain = ROOT_TEST.hostname;
    test.policy.name = 'foreign policy';
    await expect(test.run()).rejects.toMatchObject({ code: 'foreign_dependency' });
    await expect(test.run(ATTEMPT, 'f'.repeat(32))).rejects.toMatchObject({ stage: 'account' });
    expect(test.mutations).toEqual([]);
  });

  it('allows bounded namespace-list propagation only behind the exact retirement module', async () => {
    const test = await fixture(); test.lag();
    expect((await test.run()).verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.mutations).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
  });

  it('retries a transient provider error on a strict-inventory read and still removes the root', async () => {
    const test = await fixture(); test.flakyReads(2);
    expect((await test.run()).verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.mutations).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
  });

  it('retries a transient owner settings error while the retirement upload settles', async () => {
    const test = await fixture(); test.flakySettings(2);
    expect((await test.run()).verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.mutations).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
  });

  it('stops a settling step with a bounded absence_not_proven when the owner settings never recover', async () => {
    const test = await fixture(); test.flakySettings(100);
    await expect(test.run()).rejects.toMatchObject({ stage: 'retire_namespace', code: 'absence_not_proven' });
    expect(test.current().pendingStep).toBe('retire_namespace');
    expect(test.mutations).toEqual(['retire_namespace']);
  });

  it('allows bounded deployment-list propagation after the namespace listing drops the class', async () => {
    const test = await fixture(); test.lag('deployment');
    expect((await test.run()).verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.mutations).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
  });

  it('leaves an unsettled retirement pending for a fresh consent instead of judging the stale version foreign', async () => {
    const test = await fixture(); test.lag('deployment', 100);
    await expect(test.run()).rejects.toMatchObject({ stage: 'retire_namespace', code: 'absence_not_proven' });
    expect(test.current().pendingStep).toBe('retire_namespace');
    expect(test.mutations).toEqual(['retire_namespace']);
    test.lag('deployment', 0); test.renew();
    expect((await test.run(NEXT_ATTEMPT)).verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.mutations).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
  });

  it('accepts the inherited secrets on the retirement version and refuses any other binding on it', async () => {
    const test = await fixture(); test.foreignVersionBinding();
    await expect(test.run()).rejects.toMatchObject({ stage: 'retire_namespace', code: 'absence_not_proven' });
    expect(test.mutations).toEqual(['retire_namespace']);
  });

  it('still refuses a foreign active version outside a settling window', async () => {
    const test = await fixture(); test.live.namespace = false; test.live.retired = true; test.lag('deployment', 100);
    await expect(test.run()).rejects.toMatchObject({ stage: 'retirement_version', code: 'identity_mismatch' });
    expect(test.mutations).toEqual([]);
  });

  it('removes the root beside a declared Service Auth policy, which leaves with the application, and still refuses a foreign one', async () => {
    const test = await fixture({ servicePolicy: true });
    expect((await test.run()).verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.mutations).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    const foreign = await fixture({ servicePolicy: true }); foreign.drift('policy');
    await expect(foreign.run()).rejects.toMatchObject({ code: 'foreign_dependency' });
    expect(foreign.mutations).toEqual([]);
    // Without a declaration, a second policy of any shape is foreign.
    const undeclared = await fixture(); undeclared.drift('policy');
    await expect(undeclared.run()).rejects.toMatchObject({ code: 'foreign_dependency' });
  });

  it('rejects tampered retirement bytes before any provider mutation', async () => {
    const test = await fixture();
    const bundle = Object.freeze({ ...test.bundle, payload: Object.freeze(test.bundle.payload.map((entry) => entry === test.retirement
      ? Object.freeze({ ...entry, bytes: new Blob(['arbitrary code']) }) : entry)) });
    await expect(test.run(ATTEMPT, ROOT_TEST.accountId, bundle)).rejects.toThrow();
    expect(test.mutations).toEqual([]);
  });
});

describe('bounded finalizer reads', () => {
  it.each([
    [BEFORE, CREATED, false], [CREATED, CREATED, true], [AFTER, CREATED, true],
    [undefined, CREATED, true], [AFTER, undefined, true], [BEFORE, undefined, true],
    ['not a time', CREATED, true], [BEFORE, 'not a time', true],
  ])('reads a foreign script modified %s against an owner created %s: %s', (modifiedOn, createdOn, expected) => {
    expect(foreignScriptNeedsRead(modifiedOn, createdOn)).toBe(expected);
  });

  it('scans foreign scripts once per attempt and skips those last modified before the owner Worker existed', async () => {
    const test = await fixture(); test.createdOwner(CREATED);
    // A script older than the gateway cannot bind it; the fixture gives it a binding to prove it is never read.
    test.addForeignScript('older-script', BEFORE, 'namespace');
    test.addForeignScript('newer-script', AFTER);
    test.addForeignScript('undated-script', undefined);
    expect((await test.run()).verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.mutations).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    expect(test.readCount('/workers/scripts/older-script/settings')).toBe(0);
    expect(test.readCount('/workers/scripts/newer-script/settings')).toBe(1);
    expect(test.readCount('/workers/scripts/undated-script/settings')).toBe(1);
    // The listing is read for the scan and again only when the Worker's own deletion settles.
    expect(test.readCount('/workers/scripts')).toBe(2);
  });

  it.each(['namespace', 'service'] as const)('still refuses a newer script that binds the %s before any mutation', async (binding) => {
    const test = await fixture(); test.createdOwner(CREATED);
    test.addForeignScript('newer-script', AFTER, binding);
    await expect(test.run()).rejects.toMatchObject({ stage: 'worker_bindings', code: 'foreign_dependency' });
    expect(test.mutations).toEqual([]);
  });

  it('reads every foreign script when the owner listing carries no creation time', async () => {
    const test = await fixture();
    test.addForeignScript('older-script', BEFORE, 'namespace');
    await expect(test.run()).rejects.toMatchObject({ stage: 'worker_bindings', code: 'foreign_dependency' });
    expect(test.mutations).toEqual([]);
  });

  it('re-reads only the resource about to be deleted before each deletion and the owner side while a write settles', async () => {
    const test = await fixture(); test.createdOwner(CREATED);
    test.addForeignScript('newer-script', AFTER);
    expect((await test.run()).verifiedSteps).toEqual(GATEWAY_ROOT_REMOVAL_STEPS);
    const base = `/client/v4/accounts/${ROOT_TEST.accountId}`;
    const application = `/client/v4/zones/${ROOT_TEST.zoneId}/access/apps/${ROOT_TEST.applicationId}`;
    // Preflight, the identity re-read before the Worker deletion, and the settle after it.
    expect(test.readCount(`${base}/workers/workers/${ROOT_TEST.workerName}`)).toBe(3);
    // Preflight and the retirement's settle: the namespace listing and the owner's settings.
    expect(test.readCount(`${base}/workers/durable_objects/namespaces`)).toBe(2);
    expect(test.readCount(`${base}/workers/scripts/${ROOT_TEST.workerName}/settings`)).toBe(2);
    // The retirement version is read once, when the namespace listing has dropped the class.
    expect(test.readCount(`${base}/workers/scripts/${ROOT_TEST.workerName}/deployments`)).toBe(1);
    // Preflight, the identity re-read before the deletion, and the settle after it; listings only in preflight and settle.
    expect(test.readCount(`${base}/workers/domains/${ROOT_TEST.domainId}`)).toBe(3);
    expect(test.readCount(`${base}/workers/domains`)).toBe(2);
    expect(test.readCount(`${application}/policies/${ROOT_TEST.policyId}`)).toBe(3);
    expect(test.readCount(`${application}/policies`)).toBe(2);
    expect(test.readCount(application)).toBe(3);
    expect(test.reads).toHaveLength(28);
  });

  it('counts every provider and journal call and stops before the cap with the one resumable reason', async () => {
    const budget = new GatewayTeardownCallBudget(2);
    expect(GATEWAY_TEARDOWN_CALL_BUDGET - GATEWAY_TEARDOWN_SETTLEMENT_RESERVE).toBe(new GatewayTeardownCallBudget().limit);
    const calls: string[] = [];
    const port = budget.port({ read: async () => { calls.push('read'); return null; }, compareAndSet: async () => { calls.push('write'); return true; } });
    budget.charge('exchange');
    await port.read();
    expect(budget.spent).toBe(2);
    await expect(port.compareAndSet(1, await (await fixture()).current())).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(() => budget.charge('account')).toThrow(GatewayTeardownProviderError);
    expect(calls).toEqual(['read']);
    expect(gatewayTeardownFailureReason(new GatewayTeardownProviderError('worker_list', 'budget_exhausted'))).toBe('budget_exhausted');
    expect(gatewayTeardownFailureReason(new GatewayTeardownProviderError('worker_read', 'identity_mismatch'))).toBe('worker_read_identity_mismatch');
  });

  it('stops at a provider read with the budget reason itself, never as a retried transport error', async () => {
    const test = await fixture();
    // Three reads fit (the Worker by name and id, the namespace listing); the script listing would be the fourth.
    await expect(test.run(ATTEMPT, ROOT_TEST.accountId, test.bundle, new GatewayTeardownCallBudget(3)))
      .rejects.toMatchObject({ stage: 'worker_list', code: 'budget_exhausted' });
    expect(test.reads).toHaveLength(3);
    expect(test.mutations).toEqual([]);
  });
});
