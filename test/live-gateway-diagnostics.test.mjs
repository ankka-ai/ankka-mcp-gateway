import assert from 'node:assert/strict';
import test from 'node:test';
import { lifecycleFailureReport, checkSignedConfigurationEndpoint, dependencyRemovalSummary, navigationFailureLabel, rootRemovalSummary, tabReopenings } from '../tools/live-gateway-diagnostics.mjs';

test('failed stage and safe recovery evidence survive unavailable metrics', async () => {
  const result = await lifecycleFailureReport({ failureCode: 'update_not_verified', httpStatus: 503, events: [
    { stage: 'installation', status: 'shell_installed', provision: { workerName: 'private' } },
    { stage: 'update', status: 'recorded', actionId: 'private-action' },
  ], metrics: async () => { throw Error('private-provider-token'); } });
  assert.equal(result.failedStage, 'update');
  assert.equal(result.httpStatus, 503);
  assert.equal(result.lastMutationStage, 'update');
  assert.equal(result.metricsStatus, 'unavailable');
  assert.equal(JSON.stringify(result).includes('private-'), false);
});
test('metrics admit numeric aggregates only, never provider dimensions or errors', async () => {
  const result = await lifecycleFailureReport({ failureCode: 'bootstrap_not_completed', events: [
    { stage: 'installation', status: 'shell_installed', provision: {} },
  ], metrics: async () => [{ dimensions: { scriptName: 'secret' }, sum: { requests: 2, errors: 1 }, quantiles: { cpuTimeP99: 120, memoryUsageBytesP99: 'secret' }, message: 'secret' }] });
  assert.equal(result.runtimeMetrics[0].requests, 2);
  assert.equal(result.runtimeMetrics[0].memoryUsageBytesP99, null);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('machine endpoint preflight catches browser Access redirects without following them', async () => {
  let calls = 0;
  const result = await checkSignedConfigurationEndpoint('https://installer.example.com', async (url, options) => {
    calls++; assert.equal(url, 'https://installer.example.com/api/bootstrap/configure');
    assert.equal(options.redirect, 'manual'); assert.equal(options.body, '{}');
    assert.equal(options.headers.authorization, undefined);
    return new Response(null, { status: 302, headers: { location: 'https://login.example.com/?secret=x' } });
  });
  assert.equal(result, 'configuration_endpoint_requires_browser_login'); assert.equal(calls, 1);
  assert.equal(await checkSignedConfigurationEndpoint('https://installer.example.com', async () => Response.json({}, { status: 400 })), null);
  assert.equal(await checkSignedConfigurationEndpoint('https://installer.example.com', async () => new Response('HTML', { status: 500 })), 'configuration_endpoint_unexpected_response');
});

test('the report carries the hosted root job\'s outcome: status, steps done, the reason word and the revocation flag', async () => {
  const events = [
    { stage: 'root_removal', status: 'receipt_saved', handoff: 'private-receipt' },
    { stage: 'root_removal', status: 'started' },
    { stage: 'root_removal', status: 'failed', stepsDone: 1, stepCount: 5, failureReason: 'worker_bindings_provider_unknown', canAuthorize: true, revocationUnconfirmed: true },
  ];
  const result = await lifecycleFailureReport({ failureCode: 'root_removal_failed', events });
  assert.deepEqual(result.rootRemoval, { status: 'failed', stepsDone: 1, stepCount: 5, failureReason: 'worker_bindings_provider_unknown', complete: false, revocationUnconfirmed: true });
  assert.equal(JSON.stringify(result).includes('private-receipt'), false);
  assert.equal(rootRemovalSummary([{ stage: 'root_removal', status: 'started' }]), null);
  assert.deepEqual(rootRemovalSummary([{ stage: 'root_removal', status: 'passed' }]), { status: 'passed', stepsDone: 5, stepCount: 5, failureReason: null, complete: true, revocationUnconfirmed: false });
  assert.deepEqual(rootRemovalSummary([{ stage: 'root_removal', status: 'removed_revocation_unconfirmed', stepsDone: 5, stepCount: 5, failureReason: null, complete: true, revocationUnconfirmed: true }]),
    { status: 'removed_revocation_unconfirmed', stepsDone: 5, stepCount: 5, failureReason: null, complete: true, revocationUnconfirmed: true });
});

test('the dependency-removal summary counts the rounds and keeps the last landing as fixed labels only', async () => {
  const actionId = `action_${'A'.repeat(32)}`;
  const events = [
    { stage: 'dependency_removal', status: 'started' }, { stage: 'dependency_removal', status: 'recorded', actionId },
    { stage: 'dependency_removal', status: 'recovery_required', actionId, failureCode: 'fresh_authorization_required', landing: { site: 'installer', page: 'receipt', result: null, reason: null } },
    { stage: 'dependency_removal', status: 'started' }, { stage: 'dependency_removal', status: 'recorded', actionId },
    { stage: 'dependency_removal', status: 'recovery_required', actionId, failureCode: 'fresh_authorization_required', landing: { site: 'gateway', page: 'removal', result: 'recovery_required', reason: 'removal' } },
  ];
  assert.deepEqual(dependencyRemovalSummary(events), { rounds: 2, lastStatus: 'recovery_required', lastFailureCode: 'fresh_authorization_required',
    lastLanding: { site: 'gateway', page: 'removal', result: 'recovery_required', reason: 'removal' } });
  assert.equal(dependencyRemovalSummary([{ stage: 'root_removal', status: 'started' }]), null);
  // A round the journal recorded without a landing, and a landing with words outside the vocabulary, summarize to null fields.
  assert.deepEqual(dependencyRemovalSummary([{ stage: 'dependency_removal', status: 'recorded', actionId }, { stage: 'dependency_removal', status: 'failed', actionId, failureCode: null, landing: { site: 'gateway', page: 'removal', result: 'recovery_required', reason: 'https://x/?secret' } }]),
    { rounds: 1, lastStatus: 'failed', lastFailureCode: null, lastLanding: { site: 'gateway', page: 'removal', result: 'recovery_required', reason: null } });
  const report = await lifecycleFailureReport({ failureCode: 'removal_receipt_unavailable', events });
  assert.equal(report.dependencyRemoval.rounds, 2);
  assert.equal(report.dependencyRemoval.lastLanding.reason, 'removal');
});

test('the report names why a navigation failed in the fixed vocabulary and counts the test tabs the runner reopened', async () => {
  const events = [
    { stage: 'update', status: 'recorded', actionId: 'private-action' },
    { stage: 'browser', status: 'tab_reopened', navigation: 'closed' },
  ];
  const result = await lifecycleFailureReport({ failureCode: 'navigation_failed', navigation: 'timeout', events });
  assert.equal(result.navigation, 'timeout');
  assert.equal(result.tabsReopened, 1);
  // The replacement is the runner's event: the failed stage is still the lifecycle's.
  assert.equal(result.failedStage, 'update');
  assert.equal(result.lastMutationStage, 'update');
  for (const value of ['https://x/?secret', 'Target closed', '', undefined, null]) {
    assert.equal((await lifecycleFailureReport({ failureCode: 'navigation_failed', navigation: value, events: [] })).navigation, null);
    assert.equal(navigationFailureLabel(value), null);
  }
  for (const value of ['closed', 'crashed', 'timeout', 'other']) assert.equal(navigationFailureLabel(value), value);
  const other = await lifecycleFailureReport({ failureCode: 'update_not_verified', events: [] });
  assert.equal(other.navigation, null);
  assert.equal(other.tabsReopened, 0);
  assert.equal(tabReopenings([{ stage: 'browser', status: 'tab_reopened' }, { stage: 'browser', status: 'tab_reopened' }, { stage: 'update', status: 'passed' }]), 2);
});
