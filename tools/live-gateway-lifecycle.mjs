import * as v from 'valibot';
import { qualifyLiveGatewayManagement } from './live-gateway-management.mjs';
import { LiveGatewayBrowserError, managementStepWord } from './live-gateway-origin.mjs';
import { hostnameResolvesDirectly } from './live-gateway-dns.mjs';

export class LiveLifecycleError extends Error {
  /** `status` is the HTTP status of a provider write Cloudflare refused; null for every other stop. */
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
function requireCondition(value, code) {
  if (!value) throw new LiveLifecycleError(code);
}
const terminalAction = (value) => ['succeeded', 'failed', 'recovery_required'].includes(value?.status);
const exactRelease = (value, expected) => value?.release === expected.release && value.artifactSha256 === `sha256:${expected.artifactSha256}`;

const timedOut = (error) => error instanceof LiveGatewayBrowserError && error.code === 'interactive_step_timed_out';

/**
 * The management step of the customer's own setup page, answered before the approval starts: the page shows its
 * Approve button only after an answer, and the shell locks the step once an approval runs. With the operator's opt-in
 * (`managementToken`) the token is entered there as a customer pastes it, by the browser port, which alone handles
 * the value; without it the runner chooses to continue without a token, as the page's other control does. True only
 * when the shell took the value. A value whose form the shell refuses is kept nowhere, and setup goes on without it,
 * as it does for a customer; a shell whose release predates the step offers none in its setup view and is asked
 * nothing. Any other refusal, and an answer that never arrives, stops the run like the setup writes around it.
 */
async function answerManagementStep({ browser, provision, configured, managementToken, checkpoint, notify }) {
  if (!v.is(v.object({ managementCredential: v.object({}) }), configured)) {
    await checkpoint({ stage: 'management_token', status: 'step_not_offered' });
    return false;
  }
  if (managementToken !== null) {
    await checkpoint({ stage: 'management_token', status: 'started' });
    try {
      const word = await managementToken.paste(browser, provision);
      await checkpoint({ stage: 'management_token', status: 'pasted_at_setup', word: managementStepWord(word) });
      notify?.('Management token entered at the new gateway\'s setup step, from your credential store, as a customer pastes it.');
      return true;
    } catch (error) {
      if (!(error instanceof LiveGatewayBrowserError) || error.code !== 'gateway_http_rejected' || error.status !== 400) throw error;
      await checkpoint({ stage: 'management_token', status: 'refused_at_setup', httpStatus: 400 });
      notify?.('The setup step refused the management token\'s form and kept nothing. Setup continues without it; this command installs it as the gateway secret after the installation.');
    }
  }
  const word = await browser.answerManagementStep(provision);
  await checkpoint({ stage: 'management_token', status: 'skipped_at_setup', word: managementStepWord(word) });
  return false;
}

/** Each write is preceded by a private checkpoint. Never retry an unknown write.
 * OAuth is reviewed in the runner's own browser; routine management uses the
 * gateway's account token. The operator token belongs only to the provider port.
 * `managementToken` is the operator's opt-in to the automatic management-token
 * step; without it the operator installs that secret in Cloudflare when prompted.
 */
export async function qualifyLiveGatewayLifecycle({ config, browser, provider, publishB, checkpoint, notify, resolves = hostnameResolvesDirectly, proveService = null, managementToken = null }) {
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
  // The installer page spends the one-time handoff on its first hop to the shell; that hop is held back until the
  // shell answers from here, so an edge that does not serve the fresh Worker yet cannot swallow the handoff.
  browser.holdHandoff();
  // The session is provisioned once the shell exists; it is handed off only when the page's handoff poll succeeds,
  // which the hold defers, so the consent ends at the provisioned session.
  const installed = await browser.consent(started.authorizationUrl, () => installer('/api/session'),
    (value) => ['provisioned', 'handed_off', 'failed', 'cleanup_required'].includes(value?.session?.phase));
  requireCondition(['provisioned', 'handed_off'].includes(installed.session.phase) && installed.session.provision !== null, 'bootstrap_not_completed');
  const provision = installed.session.provision;
  await checkpoint({ stage: 'installation', status: 'shell_installed', provision });
  const bootstrapOrigin = browser.adoptBootstrap(provision);
  await provider.assertWorker(provision);
  // Live from this vantage point: the shell refuses a sessionless read (403) or, once the page hopped, answers it.
  await browser.waitFor(async () => {
    try { return await browser.request(bootstrapOrigin, '/__ankka/install/setup'); }
    catch (error) { if (error?.code === 'gateway_http_rejected' && error.status === 403) return 'live'; throw error; }
  }, (value) => value === 'live' || Array.isArray(value?.availableZones));
  browser.releaseHandoff();
  // The real installer page consumes its one-time handoff. Do not race it.
  await browser.waitFor(() => browser.request(bootstrapOrigin, '/__ankka/install/setup'),
    (value) => Array.isArray(value?.availableZones));
  const configured = await browser.request(bootstrapOrigin, '/__ankka/install/configuration', {
    method: 'POST', body: { schemaVersion: 1, basics: config.basics, firstSource: null },
  });
  requireCondition(configured?.plan?.releaseId === config.releaseA.release &&
    configured.plan.releaseArtifactSha256 === config.releaseA.artifactSha256, 'setup_release_mismatch');
  await checkpoint({ stage: 'installation', status: 'configured', plan: configured.plan });
  const pastedAtSetup = await answerManagementStep({ browser, provision, configured, managementToken, checkpoint, notify });
  // The approval is the installation's write again: a stop from here on reads as the installation's, not the step's.
  await checkpoint({ stage: 'installation', status: 'approval_started' });
  const setup = await browser.request(bootstrapOrigin, '/__ankka/install/oauth/start', { method: 'POST', body: {} });
  // The consent callback sends the browser to the management hostname before its record exists, and a negative
  // answer is cached for the zone's negative TTL. The browser is therefore held off that origin, and the consent
  // window (the operator's ten minutes) ends when the provider lists the custom domain: the operator approved and
  // the converger finished. The record the custom domain creates is served by the zone's authoritative nameservers
  // only later, more than ten minutes after its creation at times, so the platform gets its own window, up to the
  // zone's negative TTL, before the first read; nothing but those authoritative servers is asked meanwhile.
  const managementHostname = new URL(config.managementOrigin).hostname;
  // The shell's authorization cookie lives five minutes; an approval after that is refused by the shell itself.
  notify?.('Approve the Stage 2 consent within five minutes of this notice: the shell refuses a later callback.');
  await browser.consent(setup.authorizationUrl, () => provider.managementDomainReady(provision), (ready) => ready === true,
    { holdOrigin: config.managementOrigin, keepHold: true });
  try {
    await browser.waitFor(async () => await resolves(managementHostname, { zone: config.basics.zoneName }) ? management('/api/status') : null,
      (value) => value?.schemaVersion === 1,
      { seconds: 2_700, instruction: `Waiting for ${managementHostname} to be served by the zone's nameservers (up to 45 minutes; the record has taken 25 minutes live).` });
  } finally {
    browser.release();
  }
  // The first reads after convergence can meet a transient 503 while the new runtime and its Access application
  // settle; a read is retried until it answers, and only then is the installed release judged.
  const updateA = await browser.waitFor(() => management('/api/update'), (value) => value?.current !== undefined);
  requireCondition(exactRelease(updateA.current, config.releaseA), 'installed_release_mismatch');
  await checkpoint({ stage: 'installation', status: 'passed' });
  await continueLiveGatewayLifecycle({ config, browser, provider, provision, publishB, checkpoint, notify, proveService, managementToken, pastedAtSetup });
}

/** The gateway's own view of its management token: the credential is there and the dashboard edits with it. */
const reportsManagementToken = (team) => team?.managementCredentialConfigured === true && team.editingEnabled === true;

/**
 * Whether the gateway reports the token this run pasted at setup: the customer's path, which needs no provider
 * write. False sends the run to that write, once, and the journal says why first: the shell's last word was `dropped`
 * (its object restarted or the hold ran out, so the install finished without the value), or the gateway never
 * reported the credential within the wait.
 */
async function pastedTokenReported({ browser, management, checkpoint, notify }) {
  if (browser.managementStepWord?.() === 'dropped') {
    await checkpoint({ stage: 'management_token', status: 'dropped_at_setup' });
    notify('The new gateway no longer held the pasted management token when it installed. This command installs it as the gateway secret instead.');
    return false;
  }
  try {
    await browser.waitFor(() => management('/api/team'), reportsManagementToken);
    return true;
  } catch (error) {
    if (!timedOut(error)) throw error;
    await checkpoint({ stage: 'management_token', status: 'not_reported' });
    notify('The gateway did not report the pasted management token. This command installs it as the gateway secret instead.');
    return false;
  }
}

/**
 * Everything after a passed installation, also entered by `--resume-installed` with the provision recovered from
 * the journal: management token wait, management exercise, inventory, signed update, interrupted and completed removal.
 * Without `managementToken` the operator installs the management token in Cloudflare and this command never receives
 * it. With it (the operator's opt-in) a token pasted at setup (`pastedAtSetup`) only has to be reported by the
 * gateway. The provider port's secret write is the fallback, and what a gateway whose setup had no step to paste
 * into gets, a resumed one included: once, behind a checkpoint, and only on a gateway that does not report the
 * credential yet, so a resumed run or a token installed by hand meanwhile is never written over. Either way the
 * gateway's own view decides when the run goes on.
 */
export async function continueLiveGatewayLifecycle({ config, browser, provider, provision, publishB, checkpoint, notify, proveService = null, managementToken = null, pastedAtSetup = false }) {
  const management = (path, options) => browser.request(config.managementOrigin, path, options);
  if (managementToken === null) {
    notify('Install the approved management token directly as the gateway secret in Cloudflare. This command never receives that token.');
  } else if (!pastedAtSetup || !await pastedTokenReported({ browser, management, checkpoint, notify })) {
    const team = await browser.waitFor(() => management('/api/team'), (value) => value?.schemaVersion === 1);
    if (team.managementCredentialConfigured === true) await checkpoint({ stage: 'management_token', status: 'already_configured' });
    else {
      await checkpoint({ stage: 'management_token', status: 'started' });
      await managementToken.install(provision);
      await checkpoint({ stage: 'management_token', status: 'installed_by_runner' });
      notify('Management token installed as the gateway secret by this command, from your credential store. Waiting for the gateway to report it.');
    }
  }
  await browser.waitFor(() => management('/api/team'), reportsManagementToken);
  // Without the opt-in the token the gateway now reports is the operator's own work.
  if (managementToken === null) await checkpoint({ stage: 'management_token', status: 'operator' });
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
  // An attached browser may still hold the hosted removal session of an earlier gateway; its job must never be read
  // as this gateway's receipt.
  await browser.clearRemovalSession();
  if (phase === 'interrupted') {
    await checkpoint({ stage: 'interrupted_removal', status: 'started' });
    await browser.loseNextTeardownReceiptHop();
    const first = await beginRemoval(management, browser, checkpoint);
    // The interruption is observed either at the browser (the removal page's dropped hop to the receipt page) or on
    // the gateway, whose action ends in recovery_required when its completion was cut short; both leave a durable
    // completion for a fresh consent to recover.
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
    // The gateway settles the cut action moments before the lost callback's answer reaches the browser, where the
    // interception spends itself on it; a tab replaced before that would carry the armed interception into recovery.
    try {
      await browser.waitFor(async () => browser.interruptionObserved(), (observed) => observed === true, { seconds: INTERRUPTION_OBSERVATION_SECONDS });
    } catch (error) {
      if (error instanceof LiveGatewayBrowserError && error.code === 'interactive_step_timed_out') throw new LiveLifecycleError('interruption_not_observed');
      throw error;
    }
    // The recovery rounds run in a tab that never carried the route, as they do in a fresh process. The replacement
    // is harmless, and it is not the remedy for the empty 403 the receipt hop met in recovery rounds: that refusal
    // comes from the fixture's connection reuse (see the recovery below), not from the tab.
    await browser.replaceTab('interruption_spent');
  }
  // Fresh consent must recover the durable completion without recreating anything. While dependencies remain, each
  // consent continues their removal on the gateway; once they are gone the gateway hands the receipt to the installer.
  let receipt = null;
  // The installer's view of a handed-over receipt; null until the gateway has handed one over.
  const heldReceipt = async () => {
    try {
      const review = await installer('/api/teardown');
      return review?.canAuthorize === true ? review : null;
    } catch (error) {
      if (error instanceof LiveGatewayBrowserError && error.code === 'gateway_http_rejected') return null;
      throw error;
    }
  };
  for (let round = 0; receipt === null && round < 4; round += 1) {
    // A lost callback response can hide a removal the gateway completed and handed over; the gateway then refuses a
    // new action, so a receipt the installer already holds is taken before any round is opened.
    receipt = await heldReceipt();
    if (receipt !== null) break;
    const action = await beginRemoval(management, browser, checkpoint);
    const outcome = await browser.waitFor(async () => {
      const review = await heldReceipt();
      if (review !== null) return { review, action: null };
      return { review: null, action: await management(`/api/teardown-actions/${action.actionId}`) };
    }, (value) => value.review !== null || ['succeeded', 'recovery_required', 'failed'].includes(value.action?.status));
    if (outcome.review !== null) { receipt = outcome.review; break; }
    if (outcome.action.status === 'succeeded') await provider.assertDependenciesAbsent(inventory);
    const landed = await landedRound(browser, heldReceipt);
    const receiptHop = browser.receiptHop?.() ?? null;
    const settled = { stage: 'dependency_removal', status: outcome.action.status, actionId: action.actionId, failureCode: outcome.action.failureCode ?? null, landing: landed.landing, receiptHop };
    // In the isolated fixture the gateway's hostname and the installer's are in the same zone under one certificate.
    // A browser that holds a live connection to the gateway reuses it for the removal page's hop to the installer,
    // and the edge refuses a request whose TLS name differs from its Host: an empty 403 that never reaches the
    // installer, for which Chrome commits its own error page. A customer's gateway never shares a zone with the
    // hosted installer (an installation on the installer's own zone would). Only once that refusal was observed and
    // the landing grace left the installer without a receipt does the receipt travel without the browser: from the
    // gateway's own record of the attempt to the installer's import, as the receipt page would have sent it. The
    // checkpoint says so before the import is written.
    const refused = outcome.action.status !== 'failed' && landed.review === null && landed.landing.page === 'error' && receiptHop?.status === 403;
    const recorded = refused ? await recordedReceipt(browser) : null;
    if (refused) settled.receiptImport = recorded === null ? 'unavailable_after_edge_refusal' : 'runner_after_edge_refusal';
    await checkpoint(settled);
    requireCondition(outcome.action.status !== 'failed', 'dependency_removal_failed');
    if (recorded === null) receipt = landed.review;
    else {
      await installer('/api/teardown/import', { method: 'POST', body: { handoff: recorded } });
      receipt = await heldReceipt();
    }
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

/** How long a settled round may take to land: the redirect, the installer page and its import, or the recovery page. */
export const LANDING_GRACE_SECONDS = 60;
/** How long the browser may take to observe the interruption once the gateway has settled the cut action: the lost
 * callback's answer, on which the interception spends itself, follows that settle by moments. */
export const INTERRUPTION_OBSERVATION_SECONDS = 60;

/**
 * The gateway settles a consent attempt by alarm behind its removal page, which then records the result word in its
 * own address (`removed` before it hops to the installer with the receipt, `recovery_required` with the reason word
 * otherwise). The round ends only once the tab has landed; a consent opened earlier would cut a receipt on its way.
 */
async function landedRound(browser, heldReceipt) {
  const read = async () => ({ review: await heldReceipt(), landing: browser.landing() });
  // The removal page names `removed` in its own address just before it hops to the installer with the receipt: that
  // word means the receipt is on its way, and only the held receipt ends the wait. A recovery result is final.
  const landed = (value) => value.review !== null || (value.landing.result !== null && value.landing.result !== 'removed');
  try {
    return await browser.waitFor(read, landed, { seconds: LANDING_GRACE_SECONDS });
  } catch (error) {
    if (!(error instanceof LiveGatewayBrowserError) || error.code !== 'interactive_step_timed_out') throw error;
    return read();
  }
}

/** How long the gateway's record of a refused hop's attempt may take to answer; a read that keeps failing leaves the
 * receipt to the next round. */
export const RECORDED_RECEIPT_SECONDS = 30;

/**
 * The receipt behind a hop the edge refused, from the gateway's own record of the attempt. The browser port keeps
 * the attempt to itself, so nothing here can journal it. A read that keeps being rejected ends without a receipt, as
 * a round without one always has, and the next round opens.
 */
async function recordedReceipt(browser) {
  try {
    return await browser.waitFor(() => browser.recordedReceipt(), () => true, { seconds: RECORDED_RECEIPT_SECONDS });
  } catch (error) {
    if (!(error instanceof LiveGatewayBrowserError) || error.code !== 'interactive_step_timed_out') throw error;
    return null;
  }
}

async function beginRemoval(management, browser, checkpoint) {
  await checkpoint({ stage: 'dependency_removal', status: 'started' });
  const action = await management('/api/teardown-actions', { method: 'POST', body: { schemaVersion: 1 } });
  requireCondition(/^action_[A-Za-z0-9_-]{32}$/u.test(action?.actionId), 'removal_action_invalid');
  await checkpoint({ stage: 'dependency_removal', status: 'recorded', actionId: action.actionId });
  // The round ends with the removal page's hop to the installer. A browser that holds a connection of the
  // installer's own uses it for that hop instead of reusing the gateway's, which the edge would refuse; a load that
  // fails is tolerated there and never stops the round.
  await browser.openInstallerConnection();
  await browser.continueHandoff(action.handoffUrl, 'teardown');
  return action;
}

/** How many consents a root removal may take when each attempt stops at its call budget; the hosted job resumes each from its verified steps. */
export const ROOT_REMOVAL_MAX_CONSENTS = 6;

/**
 * Also used by the explicit recovery command with the saved receipt/inventory. The hosted job's outcome is recorded
 * before the stop code names it: a failed step keeps its reason word and the steps done, a job whose five steps
 * finished under an unconfirmed grant revocation is verified absent and still stopped as such (never a pass), and
 * anything else is not verified. An attempt the job stopped at its call budget (`budget_exhausted`) is not a failure:
 * it asks for another authorization, and the next consent continues from the verified steps.
 */
export async function finishLiveGatewayRemoval({ browser, installer, provider, inventory, checkpoint }) {
  let removed = await installer('/api/teardown');
  for (let consent = 0; consent < ROOT_REMOVAL_MAX_CONSENTS && removed.canAuthorize; consent += 1) {
    await checkpoint({ stage: 'root_removal', status: 'started' });
    const authorization = await installer('/api/teardown/authorize', { method: 'POST', body: {}, csrfToken: removed.csrfToken });
    // The wait ends on the job's settled end, a failed step, or five verified steps whose attempt was cut before it
    // settled and has expired (the job then asks for another authorization).
    await browser.consent(authorization.authorizationUrl, () => installer('/api/teardown'), (value) =>
      value?.complete === true || Boolean(value?.failureReason) ||
      value?.steps?.length === 5 && value.steps.every((step) => step.done) && value.canAuthorize === true);
    removed = await installer('/api/teardown');
    const paused = rootRemovalOutcome(removed);
    if (paused.failureReason !== 'budget_exhausted' || !paused.canAuthorize) break;
    await checkpoint({ stage: 'root_removal', status: 'budget_exhausted', ...paused });
  }
  const outcome = rootRemovalOutcome(removed);
  if (outcome.failureReason !== null) {
    await checkpoint({ stage: 'root_removal', status: 'failed', ...outcome });
    throw new LiveLifecycleError('root_removal_failed');
  }
  const settled = outcome.complete && outcome.stepsDone === 5 && outcome.stepCount === 5 && outcome.canAuthorize === false;
  if (settled && outcome.revocationUnconfirmed === true) {
    // The job settled with the warning; independent absence is still proven, and the flag stays in the record.
    await provider.assertAllAbsent(inventory);
    await checkpoint({ stage: 'root_removal', status: 'removed_revocation_unconfirmed', ...outcome });
    throw new LiveLifecycleError('root_removal_revocation_unconfirmed');
  }
  if (!settled) {
    // Five verified steps with an unsettled job (the callback cut before its revoke and settlement) are not a pass.
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
    canAuthorize: view?.canAuthorize === true, complete: view?.complete === true, revocationUnconfirmed: view?.revocationUnconfirmed === true };
}
