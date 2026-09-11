import { describe, expect, it } from 'vitest';
import { GATEWAY_ROOT_REMOVAL_STEPS } from '../src/gateway-teardown-job';
import { ROOT_TEST } from './gateway-teardown-fixture';
import { gatewayRootProviderFixture as fixture, ATTEMPT, NEXT_ATTEMPT, TOKEN } from './gateway-teardown-provider-fixture';

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
