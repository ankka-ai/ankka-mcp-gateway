import assert from 'node:assert/strict';
import test from 'node:test';
import { lifecycleFailureReport, checkSignedConfigurationEndpoint, rootRemovalSummary } from '../tools/live-gateway-diagnostics.mjs';

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
  assert.deepEqual(result.rootRemoval, { status: 'failed', stepsDone: 1, stepCount: 5, failureReason: 'worker_bindings_provider_unknown', revocationUnconfirmed: true });
  assert.equal(JSON.stringify(result).includes('private-receipt'), false);
  assert.equal(rootRemovalSummary([{ stage: 'root_removal', status: 'started' }]), null);
  assert.deepEqual(rootRemovalSummary([{ stage: 'root_removal', status: 'passed' }]), { status: 'passed', stepsDone: 5, stepCount: 5, failureReason: null, revocationUnconfirmed: false });
  assert.deepEqual(rootRemovalSummary([{ stage: 'root_removal', status: 'removed_revocation_unconfirmed', stepsDone: 5, stepCount: 5, failureReason: null, revocationUnconfirmed: true }]),
    { status: 'removed_revocation_unconfirmed', stepsDone: 5, stepCount: 5, failureReason: null, revocationUnconfirmed: true });
});
