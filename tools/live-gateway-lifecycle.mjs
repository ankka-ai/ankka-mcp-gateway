import { qualifyLiveGatewayManagement } from './live-gateway-management.mjs';

export class LiveLifecycleError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireCondition(value, code) {
  if (!value) throw new LiveLifecycleError(code);
}
const terminalAction = (value) => ['succeeded', 'failed', 'recovery_required'].includes(value?.status);
const exactRelease = (value, expected) => value?.release === expected.release && value.artifactSha256 === expected.artifactSha256;

/** Each write is preceded by a private checkpoint. Never retry an unknown write.
 * OAuth is reviewed in the runner's own browser; routine management uses the
 * gateway's account token. The operator token belongs only to the provider port.
 */
export async function qualifyLiveGatewayLifecycle({ config, browser, provider, publishB, checkpoint, notify }) {
  const installer = (path, options) => browser.request(config.installerOrigin, path, options);
  const management = (path, options) => browser.request(config.managementOrigin, path, options);
  await provider.assertFresh();
  const session = await browser.login(config.installerOrigin);
  requireCondition(session?.session?.phase === 'draft' && session.session.provision === null, 'fresh_installer_session_required');
  await checkpoint({ stage: 'installation', status: 'started' });
  const planned = await installer('/api/plan', { method: 'POST', body: {}, csrfToken: session.csrfToken });
  requireCondition(planned?.session?.plan?.releaseId === config.releaseA.release, 'installer_release_mismatch');
  const started = await installer('/api/bootstrap', { method: 'POST', body: {}, csrfToken: session.csrfToken });
  const installed = await browser.consent(started.authorizationUrl, () => installer('/api/session'),
    (value) => ['handed_off', 'failed', 'cleanup_required'].includes(value?.session?.phase));
  requireCondition(installed.session.phase === 'handed_off', 'bootstrap_not_completed');
  const provision = installed.session.provision;
  await checkpoint({ stage: 'installation', status: 'shell_installed', provision });
  const bootstrapOrigin = browser.adoptBootstrap(provision);
  await provider.assertWorker(provision);
  // The real installer page consumes its one-time handoff. Do not race it.
  await browser.waitFor(() => browser.request(bootstrapOrigin, '/__ankka/install/setup'),
    (value) => Array.isArray(value?.availableZones));
  const configured = await browser.request(bootstrapOrigin, '/__ankka/install/configuration', {
    method: 'POST', body: { schemaVersion: 1, basics: config.basics, firstSource: null },
  });
  requireCondition(configured?.plan?.releaseId === config.releaseA.release &&
    configured.plan.releaseArtifactSha256 === config.releaseA.artifactSha256, 'setup_release_mismatch');
  await checkpoint({ stage: 'installation', status: 'configured', plan: configured.plan });
  const setup = await browser.request(bootstrapOrigin, '/__ankka/install/oauth/start', { method: 'POST', body: {} });
  await browser.consent(setup.authorizationUrl, () => management('/api/status'), (value) => value?.schemaVersion === 1);
  const updateA = await management('/api/update');
  requireCondition(exactRelease(updateA.current, config.releaseA), 'installed_release_mismatch');
  await checkpoint({ stage: 'installation', status: 'passed' });

  notify('Install the approved management token directly as the gateway secret in Cloudflare. This command never receives that token.');
  await browser.waitFor(() => management('/api/team'), (value) =>
    value?.managementCredentialConfigured === true && value.editingEnabled === true);
  const source = await qualifyLiveGatewayManagement({ request: management, source: config.source, checkpoint });
  const inventory = await provider.capture(provision);
  await checkpoint({ stage: 'inventory', status: 'passed', inventory });

  await checkpoint({ stage: 'update', status: 'started' });
  await publishB();
  await browser.waitFor(() => management('/api/update'), (value) => exactRelease(value?.available, config.releaseB));
  const update = await management('/api/update-actions', { method: 'POST', body: {
    schemaVersion: 1, operation: 'update', expectedTarget: config.releaseB,
  } });
  requireCondition(/^action_[A-Za-z0-9_-]{32}$/u.test(update?.actionId), 'update_action_invalid');
  await checkpoint({ stage: 'update', status: 'recorded', actionId: update.actionId });
  await browser.continueHandoff(update.handoffUrl, 'update');
  const updated = await browser.waitFor(() => management(`/api/update-actions/${update.actionId}`), terminalAction);
  requireCondition(updated.status === 'succeeded' && exactRelease((await management('/api/update')).current, config.releaseB), 'update_not_verified');
  const sources = await management('/api/sources');
  const team = await management('/api/team');
  requireCondition(sources.applyMode === 'account_token' && sources.sources?.some((item) =>
    item.id === source.sourceId && item.status === 'installed') && team.managementCredentialConfigured === true &&
    team.editingEnabled === true && JSON.stringify(team.members) === JSON.stringify(source.baselineMembers), 'update_did_not_preserve_management');
  await checkpoint({ stage: 'update', status: 'passed' });

  await checkpoint({ stage: 'interrupted_removal', status: 'started' });
  await browser.loseNextTeardownCallbackResponse();
  const first = await beginRemoval(management, browser, checkpoint);
  await browser.waitFor(async () => ({ interrupted: browser.interruptionObserved() }), (value) => value.interrupted);
  const firstAction = await management(`/api/teardown-actions/${first.actionId}`);
  requireCondition(firstAction.status === 'succeeded', 'interrupted_removal_not_completed');
  await provider.assertDependenciesAbsent(inventory);
  await checkpoint({ stage: 'interrupted_removal', status: 'passed' });
  // Fresh consent must recover the durable completion without recreating anything.
  await beginRemoval(management, browser, checkpoint);
  const receipt = await browser.waitFor(() => installer('/api/teardown'), (value) => value?.canAuthorize === true);
  requireCondition(receipt.hostname === config.basics.managementHostname && receipt.revocationUnconfirmed === false, 'removal_receipt_invalid');
  await checkpoint({ stage: 'root_removal', status: 'receipt_saved', handoff: receipt.handoff });
  await browser.clearRemovalSession();
  await installer('/api/teardown/import', { method: 'POST', body: { handoff: receipt.handoff } });
  const recovered = await installer('/api/teardown');
  requireCondition(recovered.handoff === receipt.handoff && recovered.canAuthorize === true, 'receipt_recovery_failed');
  await finishLiveGatewayRemoval({ browser, installer, provider, inventory, checkpoint });
  await checkpoint({ stage: 'lifecycle', status: 'passed' });
}

async function beginRemoval(management, browser, checkpoint) {
  await checkpoint({ stage: 'dependency_removal', status: 'started' });
  const action = await management('/api/teardown-actions', { method: 'POST', body: { schemaVersion: 1 } });
  requireCondition(/^action_[A-Za-z0-9_-]{32}$/u.test(action?.actionId), 'removal_action_invalid');
  await checkpoint({ stage: 'dependency_removal', status: 'recorded', actionId: action.actionId });
  await browser.continueHandoff(action.handoffUrl, 'teardown');
  return action;
}

/** Also used by the explicit recovery command with the saved receipt/inventory. */
export async function finishLiveGatewayRemoval({ browser, installer, provider, inventory, checkpoint }) {
  const review = await installer('/api/teardown');
  if (review.canAuthorize) {
    await checkpoint({ stage: 'root_removal', status: 'started' });
    const authorization = await installer('/api/teardown/authorize', { method: 'POST', body: {}, csrfToken: review.csrfToken });
    await browser.consent(authorization.authorizationUrl, () => installer('/api/teardown'), (value) =>
      value?.steps?.length === 5 && value.steps.every((step) => step.done) || Boolean(value?.failureReason));
  }
  const removed = await installer('/api/teardown');
  requireCondition(removed.steps?.length === 5 && removed.steps.every((step) => step.done) &&
    removed.canAuthorize === false && removed.revocationUnconfirmed === false && !removed.failureReason, 'root_removal_not_verified');
  await provider.assertAllAbsent(inventory);
  await checkpoint({ stage: 'root_removal', status: 'passed' });
}
