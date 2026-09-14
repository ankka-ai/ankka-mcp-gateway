import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyLiveGatewayManagement } from '../tools/live-gateway-management.mjs';

const SYNTHETIC = 'qualification@example.com';

function fixture({
  applyMode = 'account_token', loseApply = false, unverifiedTeam = false, oauthApply = false, baseline = [], adminEmails = [],
  existing = null, pending = null, succeeded = null, wait = null, renewAfterWait = false,
} = {}) {
  const calls = [], checkpoints = [];
  const actionId = `action_${'A'.repeat(32)}`;
  const source = { url: 'https://synthetic.example.com/mcp', tool: 'synthetic_status' };
  let sources = existing === null ? [] : [{ id: 'synthetic', url: source.url, authMode: 'none', enabledTools: [source.tool], ...existing }];
  let members = baseline, revision = 0, action = pending, waited = 0;
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === '/api/team') return { schemaVersion: 1, editingEnabled: true, managementCredentialConfigured: true,
      adminEmails, observedAt: unverifiedTeam ? null : '2026-09-01T00:00:00.000Z', revision, members };
    if (path === '/api/sources/discover') return { status: 'discovered', authentication: 'none', endpoint: source.url, tools: [{ name: source.tool }] };
    if (path === '/api/sources') {
      if (options.method === 'PUT') sources = [{ id: 'synthetic', status: 'draft', ...options.body.source }];
      return { schemaVersion: 1, applyMode, installationEnabled: true, revision: 1, sources };
    }
    if (path === '/api/source-actions' && options.method === undefined) {
      const actions = [action, succeeded].filter((entry) => entry !== null);
      const blocking = action === null ? null : { kind: 'source', actionId: action.actionId, sourceId: action.sourceId };
      return { schemaVersion: 1, actions, blockingAction: blocking };
    }
    if (path === '/api/source-actions' || path === `/api/source-actions/${actionId}/renew`) {
      sources = sources.map((item) => ({ ...item, status: 'installed' }));
      action = null;
      if (loseApply) throw new Error('simulated_lost_response');
      return oauthApply ? { actionId, status: 'authorization_required', handoffUrl: 'https://installer.example.com/' } : { actionId, status: 'succeeded' };
    }
    if (path === `/api/source-actions/${actionId}`) return { actionId, sourceId: 'synthetic', status: 'succeeded' };
    if (path === '/api/team-actions') {
      assert.equal(options.body.expectedRevision, revision);
      members = options.body.members; revision += 1;
      return { action: { actionId, status: 'succeeded' } };
    }
    throw new Error('unexpected_request');
  };
  const sleep = wait === null ? null : async (milliseconds) => {
    waited += milliseconds;
    if (renewAfterWait) action = { ...action, state: 'recovery_required', canRenew: true };
  };
  return {
    calls, checkpoints, waited: () => waited,
    run: () => qualifyLiveGatewayManagement({ source, request, wait: sleep, checkpoint: async (value) => { checkpoints.push(value); } }),
  };
}

test('management qualification verifies source installation and grants then removes only the synthetic member', async () => {
  const f = fixture();
  assert.equal((await f.run()).sourceId, 'synthetic');
  const writes = f.calls.filter((call) => call.path === '/api/team-actions');
  assert.deepEqual(writes.map((call) => call.body.members), [[{ email: SYNTHETIC, sourceIds: ['synthetic'] }], []]);
  assert.deepEqual(f.checkpoints.filter((item) => item.status === 'passed').map((item) => item.stage), ['source_apply', 'team_grant', 'team_remove']);
});

test('unverified policy state or an OAuth-managed gateway stops before any mutation', async () => {
  for (const options of [{ applyMode: 'oauth_per_action' }, { unverifiedTeam: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run());
    assert.equal(f.calls.some((call) => call.method), false);
  }
});

test('a lost apply response is neither retried nor reported as success', async () => {
  const f = fixture({ loseApply: true });
  await assert.rejects(f.run(), /simulated_lost_response/);
  assert.equal(f.calls.filter((call) => call.path === '/api/source-actions' && call.method === 'POST').length, 1);
  assert.equal(f.calls.some((call) => call.path === '/api/team-actions'), false);
  assert.equal(f.checkpoints.some((item) => item.status === 'passed'), false);
  assert.deepEqual(f.checkpoints.at(-1), { stage: 'source_apply', status: 'started', sourceId: 'synthetic' });
});

test('an OAuth handoff cannot satisfy token-managed source qualification', async () => {
  const f = fixture({ oauthApply: true });
  await assert.rejects(f.run(), { code: 'source_action_not_completed_without_oauth' });
  assert.equal(f.checkpoints.at(-1).status, 'recorded');
  assert.equal(f.calls.some((call) => call.path === '/api/team-actions'), false);
});

test('fresh administrator-only membership is retained and unrelated members stop the run', async () => {
  const admin = { email: 'admin@example.com', sourceIds: [] };
  const f = fixture({ baseline: [admin], adminEmails: [admin.email] });
  await f.run();
  const writes = f.calls.filter(call => call.path === '/api/team-actions');
  assert.deepEqual(writes.at(-1).body.members, [admin]);
  assert.equal(writes[0].body.members[0], admin);
  for (const member of [{ email: 'other@example.com', sourceIds: [] }, { ...admin, sourceIds: ['existing'] }]) {
    const unsafe = fixture({ baseline: [member], adminEmails: [admin.email] });
    await assert.rejects(unsafe.run(), { code: 'fresh_team_required' });
    assert.equal(unsafe.calls.some(call => call.method), false);
  }
});

const stopped = {
  actionId: `action_${'A'.repeat(32)}`, sourceId: 'synthetic', status: 'applying', state: 'recovery_required',
  canRenew: true, expiresAt: new Date(Date.now() - 60_000).toISOString(),
};

test('re-entry renews a stopped source action through the renewal route and repeats no write', async () => {
  const admin = { email: 'admin@example.com', sourceIds: [] };
  const f = fixture({
    baseline: [admin, { email: SYNTHETIC, sourceIds: ['synthetic'] }], adminEmails: [admin.email],
    existing: { status: 'draft' }, pending: stopped,
  });
  assert.equal((await f.run()).sourceActionId, stopped.actionId);
  const mutations = f.calls.filter((call) => call.method !== undefined);
  assert.deepEqual(mutations.map((call) => `${call.method} ${call.path}`), [
    `POST /api/source-actions/${stopped.actionId}/renew`, 'POST /api/team-actions',
  ]);
  assert.deepEqual(mutations[0].body, { schemaVersion: 1, revision: 1, sourceId: 'synthetic' });
  assert.deepEqual(mutations[1].body.members, [admin]);
  // The roster is read only once the stopped action is reconciled; the gateway withholds it before that.
  assert.ok(f.calls.findIndex((call) => call.path === '/api/team') > f.calls.findIndex((call) => call.method === 'POST'));
  const foreign = fixture({
    baseline: [admin, { email: 'other@example.com', sourceIds: [] }], adminEmails: [admin.email],
    existing: { status: 'draft' }, pending: stopped,
  });
  await assert.rejects(foreign.run(), { code: 'fresh_team_required' });
  assert.equal(foreign.calls.some((call) => call.path === '/api/team-actions'), false);
  assert.deepEqual(f.checkpoints.map((item) => `${item.stage}:${item.status}`), [
    'source_apply:started', 'source_apply:renewed', 'source_apply:recorded', 'source_apply:passed',
    'team_grant:recovered', 'team_remove:started', 'team_remove:recorded', 'team_remove:passed',
  ]);
});

test('a stopped action inside its consent window is renewed only after the window elapses', async () => {
  const open = { ...stopped, state: 'applying', canRenew: false, expiresAt: new Date(Date.now() + 30_000).toISOString() };
  const waiting = fixture({ existing: { status: 'draft' }, pending: open, wait: true, renewAfterWait: true });
  await waiting.run();
  assert.ok(waiting.waited() > 30_000 && waiting.waited() < 45_000);
  assert.ok(waiting.checkpoints.some((item) => item.status === 'waiting'));
  assert.equal(waiting.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/renew')).length, 1);
  const unattended = fixture({ existing: { status: 'draft' }, pending: open });
  await assert.rejects(unattended.run(), { code: 'source_action_recovery_required' });
  assert.equal(unattended.calls.some((call) => call.method), false);
  const stillOpen = fixture({ existing: { status: 'draft' }, pending: open, wait: true });
  await assert.rejects(stillOpen.run(), { code: 'source_action_recovery_required' });
  assert.equal(stillOpen.calls.some((call) => call.method), false);
});

test('an installed source with its completed action is not applied again', async () => {
  const f = fixture({ existing: { status: 'installed' }, succeeded: { ...stopped, status: 'succeeded', state: 'succeeded', canRenew: false } });
  assert.equal((await f.run()).sourceActionId, stopped.actionId);
  assert.equal(f.calls.some((call) => call.method === 'POST' && call.path.startsWith('/api/source-actions')), false);
  assert.equal(f.calls.some((call) => call.method === 'PUT'), false);
  assert.deepEqual(f.checkpoints.filter((item) => item.stage === 'source_apply').map((item) => item.status), ['started', 'recovered', 'recorded', 'passed']);
  assert.deepEqual(f.calls.filter((call) => call.path === '/api/team-actions').map((call) => call.body.members.length), [1, 0]);
});

test('another pending lifecycle action or a foreign source stops the exercise before any write', async () => {
  const foreign = fixture({ existing: { status: 'draft', url: 'https://other.example.com/mcp' } });
  await assert.rejects(foreign.run(), { code: 'fresh_token_managed_gateway_required' });
  const blocked = fixture({ existing: { status: 'draft' }, pending: { ...stopped, sourceId: 'other' } });
  await assert.rejects(blocked.run(), { code: 'lifecycle_pending' });
  assert.equal(blocked.calls.some((call) => call.method), false);
});
