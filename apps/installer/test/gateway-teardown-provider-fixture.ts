import { expect } from 'vitest';
import type { BoundaryObject } from '../src/boundary';
import { authorizeGatewayTeardownJob, consumeGatewayTeardownCallback, settleGatewayTeardownAttempt,
  type GatewayTeardownJob, type GatewayRootRemovalStep } from '../src/gateway-teardown-job';
import { executeGatewayRootRemoval } from '../src/gateway-teardown-provider';
import type { FetchTransport } from '../src/oauth';
import { gatewayTeardownFixture, ROOT_TEST } from './gateway-teardown-fixture';

export const ATTEMPT = `attempt_${'a'.repeat(24)}`;
export const NEXT_ATTEMPT = `attempt_${'b'.repeat(24)}`;
const HASHES = { stateHash: 's'.repeat(43), verifierHash: 'v'.repeat(43) };
export const TOKEN = 'synthetic-removal-grant';
const VERSION = '11111111-1111-4111-8111-111111111111';
const PREVIOUS = '22222222-2222-4222-8222-222222222222';

export async function gatewayRootProviderFixture({ servicePolicy = false } = {}) {
  const data = await gatewayTeardownFixture({ servicePolicy });
  const root = ROOT_TEST;
  let job = consumeGatewayTeardownCallback({
    job: authorizeGatewayTeardownJob({ job: data.job, attemptId: ATTEMPT, ...HASHES, now: root.now }),
    attemptId: ATTEMPT, ...HASHES, now: root.now,
  });
  const live = { worker: true, namespace: true, domain: true, application: true, policy: true, retired: false };
  let clock = root.now;
  const mutations: GatewayRootRemovalStep[] = [];
  const writes: GatewayTeardownJob[] = [];
  let readExternalJob: (() => Promise<GatewayTeardownJob | null>) | null = null;
  const domain: BoundaryObject = { id: root.domainId, hostname: root.hostname, service: root.workerName, zone_id: root.zoneId };
  const application = { id: root.applicationId, name: data.statement.management.applicationName,
    aud: data.statement.management.applicationAud, type: 'self_hosted', domain: String(root.hostname) };
  const policy = { id: root.policyId, name: data.statement.management.policyName, decision: 'allow', precedence: 1,
    include: [{ email: { email: 'changed-admin@example.com' } }], exclude: [], require: [] };
  const service = servicePolicy ? { id: root.servicePolicyId, name: data.statement.management.servicePolicyName ?? '', decision: 'non_identity',
    precedence: 2, include: [{ service_token: { token_id: 'b'.repeat(32) } }], exclude: [], require: [] } : null;
  let foreignPolicy = false;
  let sharedNamespace = false;
  let sharedService = false;
  let additionalNamespace = false;
  let extraDomain = false;
  let failAfter: GatewayRootRemovalStep | null = null;
  let failBefore: GatewayRootRemovalStep | null = null;
  let namespaceLag = 0;
  let deploymentLag = 0;
  let settingsFlaky = 0;
  let foreignVersionBinding = false;
  const ok = <Value>(result: Value): Response => Response.json({ success: true, errors: [], messages: [], result });
  const absent = (): Response => Response.json({ success: false }, { status: 404 });
  const failure = (): Response => Response.json({ success: false, errors: [{ message: TOKEN }] }, { status: 503 });
  const port = {
    read: async () => job,
    compareAndSet: async (expected: number | null, value: GatewayTeardownJob) => {
      if (expected !== job.revision) return false;
      writes.push(value);
      job = value;
      return true;
    },
  };
  const transport: FetchTransport = async (input, init) => {
    if (readExternalJob !== null) {
      const external = await readExternalJob();
      if (external === null) throw new Error('fixture_job_missing');
      job = external;
    }
    const request = new Request(input, init);
    expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    const path = new URL(request.url).pathname;
    const base = `/client/v4/accounts/${root.accountId}`;
    const app = `/client/v4/zones/${root.zoneId}/access/apps/${root.applicationId}`;
    if (request.method === 'GET') {
      if (path === `${base}/workers/workers/${root.workerName}` || path === `${base}/workers/workers/${root.workerId}`) {
        return live.worker ? ok({ id: root.workerId, name: root.workerName, tail_consumers: [] }) : absent();
      }
      if (path === `${base}/workers/durable_objects/namespaces`) {
        const found = live.namespace || (namespaceLag > 0 && live.retired);
        if (live.retired && namespaceLag > 0) namespaceLag -= 1;
        return ok([...(found ? [{ id: root.namespaceId, script: root.workerName, class: 'AdminState', use_sqlite: true }] : []),
          ...(additionalNamespace ? [{ id: 'e'.repeat(32), script: root.workerName, class: 'ForeignState', use_sqlite: true }] : [])]);
      }
      if (path === `${base}/workers/scripts`) return ok([...(live.worker ? [{ id: root.workerName }] : []), ...((sharedNamespace || sharedService) ? [{ id: 'foreign-worker' }] : [])]);
      if (path === `${base}/workers/scripts/${root.workerName}/settings`) {
        // The owner Worker's settings endpoint can 5xx transiently right after its retirement upload.
        if (live.retired && settingsFlaky > 0) { settingsFlaky -= 1; return failure(); }
        return ok({ bindings: live.retired ? [] : [{ type: 'durable_object_namespace', name: 'ADMIN_STATE', class_name: 'AdminState', namespace_id: root.namespaceId }] });
      }
      if (path === `${base}/workers/scripts/foreign-worker/settings`) return ok({ bindings: sharedService ? [{ type: 'service', name: 'FOREIGN', service: root.workerName }] : [{ type: 'durable_object_namespace', name: 'FOREIGN', namespace_id: root.namespaceId }] });
      if (path === `${base}/workers/domains`) return ok([...(live.domain ? [domain] : []), ...(extraDomain ? [{ ...domain, id: 'other-domain', hostname: 'other.example.com' }] : [])]);
      if (path === `${base}/workers/domains/${root.domainId}`) return live.domain ? ok(domain) : absent();
      if (path === app) return live.application ? ok(application) : absent();
      if (path === `${app}/policies`) return ok([...(live.policy ? [policy] : []), ...(service !== null && live.application ? [service] : []), ...(foreignPolicy ? [{ ...policy, id: 'foreign-policy' }] : [])]);
      if (path === `${app}/policies/${root.policyId}`) return live.policy ? ok(policy) : absent();
      if (path === `${base}/workers/scripts/${root.workerName}/deployments`) {
        // The deployment listing can still show the previous version after the namespace listing dropped the class.
        const stale = live.retired && deploymentLag > 0;
        if (stale) deploymentLag -= 1;
        return ok({ deployments: [{ versions: [{ version_id: stale ? PREVIOUS : VERSION, percentage: 100 }] }] });
      }
      if (path === `${base}/workers/workers/${root.workerId}/versions/${PREVIOUS}`) return ok({
        id: PREVIOUS, main_module: 'index.js', compatibility_date: '2026-08-08',
        bindings: [{ type: 'durable_object_namespace', name: 'ADMIN_STATE', class_name: 'AdminState', namespace_id: root.namespaceId }],
        modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: btoa('export default { fetch() { return new Response(null); } };') }],
      });
      if (path === `${base}/workers/workers/${root.workerId}/versions/${VERSION}`) return ok({
        id: VERSION, main_module: 'index.js', compatibility_date: '2026-08-08',
        // Secrets outlive the retirement upload; a foreign binding never belongs to the retirement version.
        bindings: [{ type: 'secret_text', name: 'ANKKA_GATEWAY_OWNERSHIP_WRAP_KEY' }, { type: 'secret_text', name: 'ANKKA_MANAGEMENT_TOKEN' },
          ...(foreignVersionBinding ? [{ type: 'plain_text', name: 'FOREIGN', text: 'value' }] : [])],
        modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: btoa(await data.retirement.bytes.text()) }],
      });
    }
    let step: GatewayRootRemovalStep;
    if (request.method === 'PUT' && path === `${base}/workers/scripts/${root.workerName}`) {
      step = 'retire_namespace';
      expect(job.pendingStep).toBe(step);
      const form = await request.formData();
      const metadata = form.get('metadata');
      const module = form.get('index.js');
      if (!(metadata instanceof Blob) || !(module instanceof Blob)) throw new Error('fixture_form_invalid');
      expect(JSON.parse(await metadata.text())).toEqual({ bindings: [], compatibility_date: '2026-08-08', compatibility_flags: [],
        exports: { AdminState: { state: 'deleted', type: 'durable-object' } }, main_module: 'index.js', observability: { enabled: false } });
      expect(await module.text()).toBe(await data.retirement.bytes.text());
      if (failBefore === step) return failure();
      live.namespace = false; live.retired = true;
    } else if (request.method === 'DELETE' && path === `${base}/workers/domains/${root.domainId}`) {
      step = 'management_domain'; if (failBefore === step) return failure(); live.domain = false;
    } else if (request.method === 'DELETE' && path === `${app}/policies/${root.policyId}`) {
      step = 'management_policy'; if (failBefore === step) return failure(); live.policy = false;
    } else if (request.method === 'DELETE' && path === app) {
      step = 'management_application'; if (failBefore === step) return failure(); live.application = false;
    } else if (request.method === 'DELETE' && path === `${base}/workers/workers/${root.workerId}`) {
      step = 'worker'; if (failBefore === step) return failure(); live.worker = false;
    } else throw new Error('unexpected_fixture_request');
    expect(job.pendingStep).toBe(step);
    mutations.push(step);
    if (failAfter === step) return failure();
    // The provider answers deletions unevenly: custom-domain detachment is 200 with no body, Worker deletion 204, Access an envelope.
    if (step === 'management_domain') return new Response('', { status: 200 });
    if (step === 'worker') return new Response(null, { status: 204 });
    return ok({});
  };
  return {
    ...data, live, mutations, writes, application, policy, domain, transport,
    readJobFrom: (read: () => Promise<GatewayTeardownJob | null>) => { readExternalJob = read; },
    run: (attemptId = ATTEMPT, accountId = root.accountId, bundle = data.bundle) => executeGatewayRootRemoval({
      port, trust: data.trust, bundle, attemptId, accessToken: TOKEN, authorizedAccountId: accountId, transport,
      now: () => clock++, wait: async () => undefined,
    }),
    current: () => job,
    failAfter: (step: GatewayRootRemovalStep | null) => { failAfter = step; },
    failBefore: (step: GatewayRootRemovalStep | null) => { failBefore = step; },
    drift: (kind: 'policy' | 'binding' | 'service' | 'namespace' | 'domain') => {
      foreignPolicy = kind === 'policy'; sharedNamespace = kind === 'binding'; sharedService = kind === 'service'; additionalNamespace = kind === 'namespace'; extraDomain = kind === 'domain';
    },
    foreignVersionBinding: () => { foreignVersionBinding = true; },
    lag: (listing: 'namespace' | 'deployment' = 'namespace', reads = 2) => { if (listing === 'namespace') namespaceLag = reads; else deploymentLag = reads; },
    flakySettings: (reads = 2) => { settingsFlaky = reads; },
    renew: () => {
      job = settleGatewayTeardownAttempt({ job, attemptId: ATTEMPT, revocation: 'confirmed', now: clock++ });
      job = authorizeGatewayTeardownJob({ job, attemptId: NEXT_ATTEMPT, ...HASHES, now: clock++ });
      job = consumeGatewayTeardownCallback({ job, attemptId: NEXT_ATTEMPT, ...HASHES, now: clock++ });
    },
  };
}
