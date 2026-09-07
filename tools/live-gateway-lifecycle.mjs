import * as v from 'valibot';
import { qualifyLiveGatewayManagement } from './live-gateway-management.mjs';
import { LiveGatewayBrowserError } from './live-gateway-origin.mjs';
import { hostnameResolvesDirectly } from './live-gateway-dns.mjs';

export class LiveLifecycleError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireCondition(value, code) {
  if (!value) throw new LiveLifecycleError(code);
}
const terminalAction = (value) => ['succeeded', 'failed', 'recovery_required'].includes(value?.status);
const exactRelease = (value, expected) => value?.release === expected.release && value.artifactSha256 === `sha256:${expected.artifactSha256}`;

/** Each write is preceded by a private checkpoint. Never retry an unknown write.
 * OAuth is reviewed in the runner's own browser; routine management uses the
 * gateway's account token. The operator token belongs only to the provider port.
 */
export async function qualifyLiveGatewayLifecycle({ config, browser, provider, publishB, checkpoint, notify, resolves = hostnameResolvesDirectly, proveService = null }) {
  const installer = (path, options) => browser.request(config.installerOrigin, path, options);
  const management = (path, options) => browser.request(config.managementOrigin, path, options);
  await provider.assertFresh();
  let session = await browser.login(config.installerOrigin);
  if (session?.session?.phase !== 'draft' || session.session.provision !== null) {
    // An attached browser may still hold the previous installation's session. The installer issues a fresh
    // draft for a draft, failed or handed-off session and keeps the old one's evidence; anything else stops here.
    requireCondition(['draft', 'failed', 'handed_off'].includes(session?.session?.phase), 'fresh_installer_session_required');
    await installer('/api/session/new', { method: 'POST', body: {}, csrfToken: session.csrfToken });
    session = await installer('/api/session');
  }
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
  // The consent callback sends the browser to the management hostname before its record exists, and a negative
  // answer is cached for the zone's negative TTL. The runner therefore reads the provider until the custom domain is
  // attached and only then touches the hostname; the browser is held off that origin for the same window.
  // The custom domain is listed a few seconds before its record is served; the first system lookup in that gap
  // would be cached negatively, so the hostname must also resolve when the DNS servers are asked directly.
  const managementHostname = new URL(config.managementOrigin).hostname;
  await browser.consent(setup.authorizationUrl,
    async () => (await provider.managementDomainReady(provision) && await resolves(managementHostname) ? management('/api/status') : null),
    (value) => value?.schemaVersion === 1, { holdOrigin: config.managementOrigin });
  const updateA = await management('/api/update');
  requireCondition(exactRelease(updateA.current, config.releaseA), 'installed_release_mismatch');
  await checkpoint({ stage: 'installation', status: 'passed' });
  await continueLiveGatewayLifecycle({ config, browser, provider, provision, publishB, checkpoint, notify, proveService });
}

/**
 * Everything after a passed installation, also entered by `--resume-installed` with the provision recovered from
 * the journal: management token wait, management exercise, inventory, signed update, interrupted and completed removal.
 */
export async function continueLiveGatewayLifecycle({ config, browser, provider, provision, publishB, checkpoint, notify, proveService = null }) {
  const management = (path, options) => browser.request(config.managementOrigin, path, options);
  notify('Install the approved management token directly as the gateway secret in Cloudflare. This command never receives that token.');
  await browser.waitFor(() => management('/api/team'), (value) =>
    value?.managementCredentialConfigured === true && value.editingEnabled === true);
  // A dashboard deployment reaches the edge gradually; the sources view must show the token-managed mode too before
  // the exercise starts, or consecutive reads can straddle two Worker versions.
  await browser.waitFor(() => management('/api/sources'), (value) =>
    value?.applyMode === 'account_token' && value.installationEnabled === true);
  const source = await qualifyLiveGatewayManagement({ request: management, source: config.source, checkpoint });
  const inventory = await provider.capture(provision);
  await checkpoint({ stage: 'inventory', status: 'passed', inventory });
  await finishLiveGatewayLifecycle({ config, browser, provider, inventory, source, publishB, checkpoint, proveService });
}

/**
 * The signed update, the service-identity proof over the updated runtime, and the interrupted, then completed, removal.
 * Also entered by `--resume-installed` after an update action failed terminally, with the inventory from the journal
 * and the installed source read back from the gateway. `proveService` runs after the update and before any removal
 * write, so the refusals it records come from a gateway that still carries the updated service binding and is whole.
 */
export async function finishLiveGatewayLifecycle({ config, browser, provider, inventory, source, publishB, checkpoint, proveService = null }) {
  const management = (path, options) => browser.request(config.managementOrigin, path, options);
  await checkpoint({ stage: 'update', status: 'started' });
  await publishB();
  await browser.waitFor(() => management('/api/update'), (value) => exactRelease(value?.available, config.releaseB));
  const update = await management('/api/update-actions', { method: 'POST', body: {
    schemaVersion: 1, operation: 'update', expectedTarget: { ...config.releaseB, artifactSha256: `sha256:${config.releaseB.artifactSha256}` },
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
  if (proveService !== null) await proveService();
  await removeLiveGateway({ config, browser, provider, inventory, checkpoint, phase: 'interrupted' });
}

/**
 * The interrupted dependency removal and the receipt-backed root removal. `phase` is `interrupted` for the whole
 * sequence and `root` when the journal already proved the interrupted removal; `--resume-installed` enters both.
 */
export async function removeLiveGateway({ config, browser, provider, inventory, checkpoint, phase = 'interrupted' }) {
  const installer = (path, options) => browser.request(config.installerOrigin, path, options);
  const management = (path, options) => browser.request(config.managementOrigin, path, options);
  if (phase === 'interrupted') {
    await checkpoint({ stage: 'interrupted_removal', status: 'started' });
    await browser.loseNextTeardownCallbackResponse();
    const first = await beginRemoval(management, browser, checkpoint);
    // The interruption is observed either at the browser (the lost callback response) or on the gateway, whose
    // action ends in recovery_required when its completion was cut short; both leave a durable completion for a
    // fresh consent to recover.
    const outcome = await browser.waitFor(async () => browser.interruptionObserved()
      ? { interrupted: true, action: await management(`/api/teardown-actions/${first.actionId}`) }
      : { interrupted: false, action: await management(`/api/teardown-actions/${first.actionId}`) },
    (value) => value.interrupted || ['succeeded', 'recovery_required', 'failed'].includes(value.action?.status));
    if (outcome.action?.status === 'succeeded') {
      await provider.assertDependenciesAbsent(inventory);
      await checkpoint({ stage: 'interrupted_removal', status: 'passed', actionId: first.actionId });
    } else {
      requireCondition(outcome.action?.status === 'recovery_required', 'interrupted_removal_not_completed');
      await checkpoint({ stage: 'interrupted_removal', status: 'recovery_required', actionId: first.actionId, failureCode: outcome.action.failureCode ?? null });
    }
  }
  // Fresh consent must recover the durable completion without recreating anything. While dependencies remain, each
  // consent continues their removal on the gateway; once they are gone the gateway hands the receipt to the installer.
  let receipt = null;
  for (let round = 0; receipt === null && round < 4; round += 1) {
    const action = await beginRemoval(management, browser, checkpoint);
    const outcome = await browser.waitFor(async () => {
      try {
        const review = await installer('/api/teardown');
        if (review?.canAuthorize === true) return { review, action: null };
      } catch (error) {
        if (!(error instanceof LiveGatewayBrowserError && error.code === 'gateway_http_rejected')) throw error;
      }
      return { review: null, action: await management(`/api/teardown-actions/${action.actionId}`) };
    }, (value) => value.review !== null || ['succeeded', 'recovery_required', 'failed'].includes(value.action?.status));
    if (outcome.review !== null) { receipt = outcome.review; break; }
    requireCondition(outcome.action.status !== 'failed', 'dependency_removal_failed');
    if (outcome.action.status === 'succeeded') await provider.assertDependenciesAbsent(inventory);
    await checkpoint({ stage: 'dependency_removal', status: outcome.action.status, actionId: action.actionId, failureCode: outcome.action.failureCode ?? null });
  }
  requireCondition(receipt !== null, 'removal_receipt_unavailable');
  requireCondition(receipt.hostname === config.basics.managementHostname, 'removal_receipt_invalid');
  // A receipt that carries the gateway's unconfirmed-revocation warning is saved with the warning recorded: the root
  // removal still runs and is verified, and the run then stops as root_removal_revocation_unconfirmed, never a pass.
  await checkpoint({ stage: 'root_removal', status: 'receipt_saved', handoff: receipt.handoff, revocationUnconfirmed: receipt.revocationUnconfirmed === true });
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

/**
 * Also used by the explicit recovery command with the saved receipt/inventory. The hosted job's outcome is recorded
 * before the stop code names it: a failed step keeps its reason word and the steps done, a job whose five steps
 * finished under an unconfirmed grant revocation is verified absent and still stopped as such (never a pass), and
 * anything else is not verified.
 */
export async function finishLiveGatewayRemoval({ browser, installer, provider, inventory, checkpoint }) {
  const review = await installer('/api/teardown');
  if (review.canAuthorize) {
    await checkpoint({ stage: 'root_removal', status: 'started' });
    const authorization = await installer('/api/teardown/authorize', { method: 'POST', body: {}, csrfToken: review.csrfToken });
    await browser.consent(authorization.authorizationUrl, () => installer('/api/teardown'), (value) =>
      value?.steps?.length === 5 && value.steps.every((step) => step.done) || Boolean(value?.failureReason));
  }
  const removed = await installer('/api/teardown');
  const outcome = rootRemovalOutcome(removed);
  if (outcome.failureReason !== null) {
    await checkpoint({ stage: 'root_removal', status: 'failed', ...outcome });
    throw new LiveLifecycleError('root_removal_failed');
  }
  if (outcome.stepsDone === 5 && outcome.stepCount === 5 && outcome.canAuthorize === false && outcome.revocationUnconfirmed === true) {
    // The five steps finished; independent absence is still proven, and the historical flag stays in the record.
    await provider.assertAllAbsent(inventory);
    await checkpoint({ stage: 'root_removal', status: 'removed_revocation_unconfirmed', ...outcome });
    throw new LiveLifecycleError('root_removal_revocation_unconfirmed');
  }
  if (!(outcome.stepsDone === 5 && outcome.stepCount === 5 && outcome.canAuthorize === false && outcome.revocationUnconfirmed === false)) {
    await checkpoint({ stage: 'root_removal', status: 'not_verified', ...outcome });
    throw new LiveLifecycleError('root_removal_not_verified');
  }
  await provider.assertAllAbsent(inventory);
  await checkpoint({ stage: 'root_removal', status: 'passed' });
}

/** The hosted job's view reduced to what the journal and the stop diagnostics may carry: counts, flags and the fixed reason word. */
export function rootRemovalOutcome(view) {
  const steps = Array.isArray(view?.steps) ? view.steps : [];
  const reason = v.is(v.pipe(v.string(), v.regex(/^[a-z0-9_]{1,120}$/u)), view?.failureReason) ? view.failureReason : null;
  return { stepsDone: steps.filter((step) => step?.done === true).length, stepCount: steps.length, failureReason: reason,
    canAuthorize: view?.canAuthorize === true, revocationUnconfirmed: view?.revocationUnconfirmed === true };
}
