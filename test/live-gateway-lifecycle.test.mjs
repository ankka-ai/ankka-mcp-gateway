import assert from 'node:assert/strict';
import test from 'node:test';
import { finishLiveGatewayRemoval, qualifyLiveGatewayLifecycle } from '../tools/live-gateway-lifecycle.mjs';
import { validateLiveLifecycleConfig } from '../tools/live-gateway-command.mjs';

const config = {
  schemaVersion: 1, accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32),
  installerOrigin: 'https://installer.example.com', managementOrigin: 'https://manage.example.com',
  installerA: '/private/test/a', installerB: '/private/test/b', journal: '/private/test/state.json',
  releaseA: { release: 'gateway-v0.0.1', artifactSha256: '1'.repeat(64) },
  releaseB: { release: 'gateway-v0.0.2', artifactSha256: '2'.repeat(64) },
  basics: { gatewayName: 'Synthetic gateway', zoneName: 'example.com', managementHostname: 'manage.example.com',
    portalHostname: 'portal.example.com', adminEmail: 'admin@example.com', additionalAdminEmails: [] },
  source: { url: 'https://synthetic.example.com/mcp', tool: 'synthetic_status' },
};

test('live config refuses production hosts, overlapping targets and identical release bytes', () => {
  assert.deepEqual(validateLiveLifecycleConfig(config), config);
  for (const changed of [
    { installerOrigin: 'https://deploy.ankka.ai' },
    { managementOrigin: config.installerOrigin },
    { releaseB: { ...config.releaseB, artifactSha256: config.releaseA.artifactSha256 } },
    { basics: { ...config.basics, portalHostname: 'foreign.invalid' } },
    { accountId: 'not-an-account' },
  ]) assert.throws(() => validateLiveLifecycleConfig({ ...config, ...changed }));
});

test('an uncertain bootstrap mutation is checkpointed once and never retried', async () => {
  const checkpoints = [], writes = [];
  const browser = {
    login: async () => ({ session: { phase: 'draft', provision: null }, csrfToken: 'synthetic' }),
    request: async (_origin, path) => {
      writes.push(path);
      if (path === '/api/plan') return { session: { plan: { releaseId: config.releaseA.release } } };
      throw new Error('response_lost');
    },
  };
  await assert.rejects(qualifyLiveGatewayLifecycle({ config, browser, provider: { assertFresh: async () => {} },
    checkpoint: async (event) => checkpoints.push(event) }), /response_lost/u);
  assert.deepEqual(writes, ['/api/plan', '/api/bootstrap']);
  assert.deepEqual(checkpoints, [{ stage: 'installation', status: 'started' }]);
});

test('a failed final removal never qualifies or runs the absence success path', async () => {
  const checkpoints = [];
  let verified = false;
  await assert.rejects(finishLiveGatewayRemoval({
    installer: async () => ({ canAuthorize: false, steps: [{ done: true }], failureReason: 'provider_conflict' }),
    provider: { assertAllAbsent: async () => { verified = true; } },
    checkpoint: async (event) => checkpoints.push(event),
  }), { code: 'root_removal_not_verified' });
  assert.equal(verified, false); assert.deepEqual(checkpoints, []);
});

test('successful hosted removal still requires independent provider absence', async () => {
  for (const absent of [false, true]) {
    const checkpoints = [], inventory = { synthetic: true };
    const run = finishLiveGatewayRemoval({ inventory,
      installer: async () => ({ canAuthorize: false, steps: Array.from({ length: 5 }, () => ({ done: true })), revocationUnconfirmed: false }),
      provider: { assertAllAbsent: async (value) => { assert.equal(value, inventory); if (!absent) throw new Error('resource_still_present'); } },
      checkpoint: async (event) => checkpoints.push(event),
    });
    if (absent) { await run; assert.deepEqual(checkpoints, [{ stage: 'root_removal', status: 'passed' }]); }
    else { await assert.rejects(run, /resource_still_present/u); assert.deepEqual(checkpoints, []); }
  }
});

test('complete orchestration proves token management, distinct update, lost callback and receipt recovery in order', async () => {
  const events = [], evidence = [];
  const installId = `acg-${'1'.repeat(24)}`;
  const provision = { installId, workerName: `ankka-gateway-${installId}`, bootstrapOrigin: `https://ankka-gateway-${installId}.synthetic.workers.dev` };
  const actionId = `action_${'A'.repeat(32)}`;
  const runtimeIdentity = (release) => ({ ...release, artifactSha256: `sha256:${release.artifactSha256}` });
  let current = runtimeIdentity(config.releaseA), available = null, sources = [], members = [], revision = 0;
  let interrupted = false, removed = false, consentCount = 0;
  const receipt = 'synthetic-signed-removal-receipt';
  const browser = {
    login: async () => ({ session: { phase: 'draft', provision: null }, csrfToken: 'synthetic' }),
    adoptBootstrap: () => provision.bootstrapOrigin,
    waitFor: async (read, accepts) => { const result = await read(); assert.ok(accepts(result)); return result; },
    consent: async (_url, read, accepts) => {
      consentCount += 1;
      if (consentCount === 3) removed = true;
      const result = await read(); assert.ok(accepts(result)); return result;
    },
    request: async (origin, path, options = {}) => {
      if (origin === config.installerOrigin) {
        if (path === '/api/plan') return { session: { plan: { releaseId: config.releaseA.release } } };
        if (path === '/api/bootstrap' || path === '/api/teardown/authorize') return { authorizationUrl: 'synthetic-consent' };
        if (path === '/api/session') return { session: { phase: 'handed_off', provision } };
        if (path === '/api/teardown') return { hostname: config.basics.managementHostname, handoff: receipt,
          canAuthorize: !removed, revocationUnconfirmed: false, csrfToken: 'synthetic', steps: Array.from({ length: 5 }, () => ({ done: removed })) };
        if (path === '/api/teardown/import') { assert.equal(options.body.handoff, receipt); evidence.push('receipt_imported'); return { imported: true }; }
      }
      if (origin === provision.bootstrapOrigin) {
        if (path.endsWith('/setup')) return { availableZones: [{}] };
        if (path.endsWith('/configuration')) return { plan: { releaseId: config.releaseA.release, releaseArtifactSha256: config.releaseA.artifactSha256 } };
        if (path.endsWith('/oauth/start')) return { authorizationUrl: 'synthetic-consent' };
      }
      if (path === '/api/status') return { schemaVersion: 1 };
      if (path === '/api/update') return { current, available };
      if (path === '/api/update-actions') assert.deepEqual(options.body.expectedTarget, runtimeIdentity(config.releaseB));
      if (path === '/api/update-actions' || path === '/api/teardown-actions') return { actionId, handoffUrl: 'synthetic-handoff' };
      if (path.startsWith('/api/update-actions/') || path.startsWith('/api/teardown-actions/')) return { status: 'succeeded' };
      if (path === '/api/team') return { schemaVersion: 1, editingEnabled: true, managementCredentialConfigured: true,
        observedAt: '2026-09-01T00:00:00.000Z', revision, members };
      if (path === '/api/sources/discover') return { status: 'discovered', authentication: 'none', endpoint: config.source.url, tools: [{ name: config.source.tool }] };
      if (path === '/api/sources') {
        if (options.method === 'PUT') sources = [{ id: 'synthetic', status: 'draft', ...options.body.source }];
        return { schemaVersion: 1, applyMode: 'account_token', installationEnabled: true, revision: 1, sources };
      }
      if (path === '/api/source-actions' && options.method === undefined) return { schemaVersion: 1, actions: [], blockingAction: null };
      if (path === '/api/source-actions') { sources[0].status = 'installed'; return { actionId, status: 'succeeded' }; }
      if (path.startsWith('/api/source-actions/')) return { sourceId: 'synthetic', status: 'succeeded' };
      if (path === '/api/team-actions') { members = options.body.members; revision += 1; return { action: { actionId, status: 'succeeded' } }; }
      throw new Error('unexpected_request');
    },
    continueHandoff: async (_url, kind) => { if (kind === 'update') current = runtimeIdentity(config.releaseB); else interrupted = true; },
    loseNextTeardownCallbackResponse: async () => evidence.push('interruption_armed'),
    interruptionObserved: () => interrupted,
    clearRemovalSession: async () => evidence.push('removal_cookie_cleared'),
  };
  await qualifyLiveGatewayLifecycle({ config, browser, notify: () => {},
    checkpoint: async (event) => events.push(event),
    publishB: async () => { available = runtimeIdentity(config.releaseB); evidence.push('release_b_activated'); },
    provider: { assertFresh: async () => {}, assertWorker: async () => {}, managementDomainReady: async () => true, capture: async () => ({ synthetic: true }),
      assertDependenciesAbsent: async () => evidence.push('dependencies_absent'), assertAllAbsent: async () => evidence.push('all_absent') },
  });
  assert.deepEqual(evidence, ['release_b_activated', 'interruption_armed', 'dependencies_absent', 'removal_cookie_cleared', 'receipt_imported', 'all_absent']);
  assert.deepEqual(events.at(-1), { stage: 'lifecycle', status: 'passed' });
  assert.ok(events.findIndex((event) => event.status === 'receipt_saved') < events.findIndex((event) => event.stage === 'root_removal' && event.status === 'started'));
});

test('an attached browser holding a handed-off installer session gets a fresh draft through the installer; a provisioning one stops', async () => {
  const provision = { installId: `acg-${'2'.repeat(24)}`, workerName: 'ankka-gateway-old', bootstrapOrigin: 'https://ankka-gateway-old.synthetic.workers.dev' };
  const requests = [];
  const browser = {
    login: async () => ({ session: { phase: 'handed_off', provision }, csrfToken: 'stale' }),
    request: async (_origin, path, options = {}) => {
      requests.push({ path, method: options.method ?? 'GET', csrfToken: options.csrfToken });
      if (path === '/api/session/new') return { session: { phase: 'draft', provision: null }, csrfToken: 'fresh' };
      if (path === '/api/session') return { session: { phase: 'draft', provision: null }, csrfToken: 'fresh' };
      if (path === '/api/plan') return { session: { plan: { releaseId: config.releaseA.release } } };
      throw new Error('stop_here');
    },
  };
  await assert.rejects(qualifyLiveGatewayLifecycle({ config, browser, provider: { assertFresh: async () => {} }, checkpoint: async () => {} }), /stop_here/u);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ['POST /api/session/new', 'GET /api/session', 'POST /api/plan', 'POST /api/bootstrap']);
  assert.equal(requests[0].csrfToken, 'stale');
  assert.equal(requests[2].csrfToken, 'fresh');
  const busy = { ...browser, login: async () => ({ session: { phase: 'provisioning', provision }, csrfToken: 'stale' }), request: async (_origin, path) => { requests.push({ path }); throw new Error('unexpected'); } };
  requests.length = 0;
  await assert.rejects(qualifyLiveGatewayLifecycle({ config, browser: busy, provider: { assertFresh: async () => {} }, checkpoint: async () => {} }), { code: 'fresh_installer_session_required' });
  assert.deepEqual(requests, []);
});


test('the Stage 2 consent holds the management origin and waits for the provider before the first management read', async () => {
  const provision = { installId: `acg-${'3'.repeat(24)}`, workerName: `ankka-gateway-acg-${'3'.repeat(24)}`, bootstrapOrigin: `https://ankka-gateway-acg-${'3'.repeat(24)}.synthetic.workers.dev` };
  const consents = [], managementReads = [];
  let ready = false;
  const browser = {
    login: async () => ({ session: { phase: 'draft', provision: null }, csrfToken: 'synthetic' }),
    adoptBootstrap: () => provision.bootstrapOrigin,
    waitFor: async (read) => read(),
    consent: async (_url, read, accepts, options) => {
      consents.push(options);
      if (consents.length === 1) return { session: { phase: 'handed_off', provision } };
      assert.equal(await read(), null); // not ready: no management request
      ready = true;
      const value = await read(); assert.ok(accepts(value)); return value;
    },
    request: async (origin, path) => {
      if (origin === config.installerOrigin) {
        if (path === '/api/plan') return { session: { plan: { releaseId: config.releaseA.release } } };
        if (path === '/api/bootstrap') return { authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth?synthetic' };
      }
      if (origin === provision.bootstrapOrigin) {
        if (path === '/__ankka/install/setup') return { availableZones: [] };
        if (path === '/__ankka/install/configuration') return { plan: { releaseId: config.releaseA.release, releaseArtifactSha256: config.releaseA.artifactSha256 } };
        if (path === '/__ankka/install/oauth/start') return { authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth?synthetic2' };
      }
      if (origin === config.managementOrigin) { managementReads.push(path); if (path === '/api/status') return { schemaVersion: 1 }; throw new Error('stop_here'); }
      throw new Error(`unexpected ${origin}${path}`);
    },
  };
  const provider = { assertFresh: async () => {}, assertWorker: async () => {}, managementDomainReady: async () => ready };
  await assert.rejects(qualifyLiveGatewayLifecycle({ config, browser, provider, checkpoint: async () => {}, notify: () => {} }), /stop_here/u);
  assert.deepEqual(consents.map((options) => options?.holdOrigin), [undefined, config.managementOrigin]);
  assert.deepEqual(managementReads, ['/api/status', '/api/update']);
});
