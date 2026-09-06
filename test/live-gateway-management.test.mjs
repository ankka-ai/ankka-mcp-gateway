import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyLiveGatewayManagement } from '../tools/live-gateway-management.mjs';

function fixture({ applyMode = 'account_token', loseApply = false, unverifiedTeam = false, oauthApply = false } = {}) {
  const calls = [], checkpoints = [];
  const actionId = `action_${'A'.repeat(32)}`;
  const source = { url: 'https://synthetic.example.com/mcp', tool: 'synthetic_status' };
  let sources = [], members = [], revision = 0;
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === '/api/team') return { schemaVersion: 1, editingEnabled: true, managementCredentialConfigured: true,
      observedAt: unverifiedTeam ? null : '2026-09-01T00:00:00.000Z', revision, members };
    if (path === '/api/sources/discover') return { status: 'discovered', authentication: 'none', endpoint: source.url, tools: [{ name: source.tool }] };
    if (path === '/api/sources') {
      if (options.method === 'PUT') sources = [{ id: 'synthetic', status: 'draft', ...options.body.source }];
      return { schemaVersion: 1, applyMode, installationEnabled: true, revision: 1, sources };
    }
    if (path === '/api/source-actions') {
      sources = sources.map((item) => ({ ...item, status: 'installed' }));
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
  return { calls, checkpoints, run: () => qualifyLiveGatewayManagement({ source, request, checkpoint: async (value) => { checkpoints.push(value); } }) };
}

test('management qualification verifies source installation and grants then removes only the synthetic member', async () => {
  const f = fixture();
  assert.equal((await f.run()).sourceId, 'synthetic');
  const writes = f.calls.filter((call) => call.path === '/api/team-actions');
  assert.deepEqual(writes.map((call) => call.body.members), [[{ email: 'qualification@example.com', sourceIds: ['synthetic'] }], []]);
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
  assert.equal(f.calls.filter((call) => call.path === '/api/source-actions').length, 1);
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
