import { lifecycleFailureReport, checkSignedConfigurationEndpoint } from './live-gateway-diagnostics.mjs';
import { readFile, realpath, lstat, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as v from 'valibot';
import { validateGeneratedReviewedIsolatedCanaryDirectory } from '../apps/installer/scripts/generate-reviewed-canary.mjs';
import { openLiveGatewayBrowser, validateLiveBrowserOrigin, LiveGatewayBrowserError } from './live-gateway-browser.mjs';
import { createLiveGatewayApi, createLiveGatewayServiceApi, LiveGatewayApiError } from './live-gateway-api.mjs';
import { resolveOperatorCredential } from './operator-credential.mjs';
import { LiveGatewayAccessError } from './live-gateway-access.mjs';
import { qualifyLiveGatewayManagement, LiveManagementQualificationError } from './live-gateway-management.mjs';
import { createLiveGatewayProvider } from './live-gateway-provider.mjs';
import { qualifyLiveGatewayLifecycle, finishLiveGatewayRemoval, LiveLifecycleError } from './live-gateway-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = v.pipe(v.string(), v.minLength(1));
const identity = v.strictObject({ release: v.pipe(text, v.regex(/^gateway-v\d+\.\d+\.\d+$/u)), artifactSha256: v.pipe(text, v.regex(/^[a-f0-9]{64}$/u)) });
const keychainName = v.pipe(text, v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u));
const credentialReference = v.union([
  v.strictObject({ keychain: v.strictObject({ service: keychainName, account: keychainName }) }),
  v.strictObject({ env: v.pipe(text, v.regex(/^ANKKA_[A-Z0-9_]{2,60}$/u)) }),
]);
/**
 * The service identity an isolated installer deployment opts its gateways into, and the credentials the
 * management exercise uses as that identity. `foreign` names a second, unapproved service token whose
 * refusal is part of the proof; the secret values stay in the operator's store.
 */
const serviceAccess = v.strictObject({
  clientId: v.pipe(text, v.regex(/^[a-f0-9]{32}\.access$/u)),
  tokenId: v.pipe(text, v.regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)),
  secret: credentialReference,
  foreign: v.optional(v.strictObject({ clientId: v.pipe(text, v.regex(/^[a-f0-9]{32}\.access$/u)), secret: credentialReference })),
});
const schema = v.strictObject({
  schemaVersion: v.literal(1), accountId: v.pipe(text, v.regex(/^[a-f0-9]{32}$/u)), zoneId: v.pipe(text, v.regex(/^[a-f0-9]{32}$/u)),
  installerOrigin: text, managementOrigin: text,
  installerA: text, installerB: text, journal: text, releaseA: identity, releaseB: identity,
  browserProfile: v.optional(text), browserConnection: v.optional(v.literal('chrome')),
  basics: v.strictObject({ gatewayName: text, zoneName: text, managementHostname: text, portalHostname: text,
    adminEmail: v.pipe(text, v.email()), additionalAdminEmails: v.tuple([]) }),
  source: v.strictObject({ url: text, tool: text }),
  serviceAccess: v.optional(serviceAccess),
});
function requireCondition(value, code) { if (!value) throw new LiveLifecycleError(code); }

async function outsideRepository(path) {
  requireCondition(isAbsolute(path), 'private_path_required');
  const canonical = await realpath(path);
  requireCondition(relative(root, canonical).startsWith('..'), 'private_path_required');
  return canonical;
}
async function readPrivateJson(path) {
  await outsideRepository(path);
  const stat = await lstat(path);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size < 2 * 1024 * 1024, 'private_file_required');
  return JSON.parse(await readFile(path, 'utf8'));
}

export function validateLiveManagementConfig(input) {
  const result = v.safeParse(v.strictObject({
    schemaVersion: v.literal(1), managementOrigin: text, journal: text,
    adminEmail: v.pipe(text, v.email()), source: schema.entries.source, serviceAccess: v.optional(serviceAccess),
  }), input);
  requireCondition(result.success, 'management_config_invalid');
  validateLiveBrowserOrigin(result.output.managementOrigin);
  return result.output;
}

export function summarizeLiveJournal(state) {
  requireCondition(state?.schemaVersion === 1 && Array.isArray(state.events), 'journal_invalid');
  const passed = [...new Set(state.events.filter((event) => event.status === 'passed').map((event) => event.stage))];
  return {
    scope: state.scope ?? 'browser_lifecycle',
    qualified: (state.scope ?? 'browser_lifecycle') === 'browser_lifecycle' && state.qualified === true && passed.includes('lifecycle'),
    passed,
    lastStage: state.events.findLast((event) => event.stage !== 'command')?.stage ?? null,
    failureCode: state.events.findLast((event) => event.status === 'stopped')?.failureCode ?? null,
    removalReceiptAvailable: state.events.some((event) => event.stage === 'root_removal' && event.status === 'receipt_saved'),
  };
}

export function validateLiveLifecycleConfig(input) {
  const result = v.safeParse(schema, input);
  requireCondition(result.success, 'live_config_invalid');
  const config = result.output;
  requireCondition(!(config.browserProfile && config.browserConnection), 'browser_connection_invalid');
  validateLiveBrowserOrigin(config.installerOrigin); validateLiveBrowserOrigin(config.managementOrigin);
  const installer = new URL(config.installerOrigin).hostname;
  const management = new URL(config.managementOrigin).hostname;
  const zone = config.basics.zoneName;
  requireCondition(installer !== 'deploy.ankka.ai' && installer !== 'auth.ankka.ai' &&
    management === config.basics.managementHostname && management.endsWith(`.${zone}`) &&
    config.basics.portalHostname.endsWith(`.${zone}`) && installer.endsWith(`.${zone}`) &&
    new Set([installer, management, config.basics.portalHostname]).size === 3 &&
    config.releaseA.release !== config.releaseB.release && config.releaseA.artifactSha256 !== config.releaseB.artifactSha256,
  'isolated_release_pair_required');
  return config;
}

async function validateInstaller(config, directory, release) {
  await outsideRepository(directory);
  await validateGeneratedReviewedIsolatedCanaryDirectory(directory);
  const record = JSON.parse(await readFile(resolve(directory, 'reviewed-canary-record.json'), 'utf8'));
  requireCondition(record.deploymentTarget.accountId === config.accountId && record.deploymentTarget.zoneId === config.zoneId &&
    record.deploymentTarget.hostname === new URL(config.installerOrigin).hostname &&
    record.pin.release === release.release && record.pin.artifactSha256 === release.artifactSha256 &&
    record.pin.controlPlaneOrigin === config.installerOrigin, 'installer_target_mismatch');
  return record;
}

async function deployInstaller(config, directory, release) {
  await validateInstaller(config, directory, release);
  // The isolated installer opts its gateways into the configured service identity through its own deployment
  // variables; the reviewed installer files stay untouched and the hosted installer never carries them.
  const optIn = config.serviceAccess === undefined ? [] : [
    '--var', `ANKKA_SERVICE_ACCESS_CLIENT_ID:${config.serviceAccess.clientId}`,
    '--var', `ANKKA_SERVICE_ACCESS_TOKEN_ID:${config.serviceAccess.tokenId}`,
  ];
  const status = await new Promise((resolveStatus) => {
    const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy',
      '--config', resolve(directory, 'wrangler.canary.toml'), ...optIn], {
      cwd: directory, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore',
    });
    child.once('error', () => resolveStatus(-1)); child.once('exit', resolveStatus);
  });
  requireCondition(status === 0, 'isolated_installer_deploy_failed');
}

async function validateReleasePair(config) {
  const a = await validateInstaller(config, config.installerA, config.releaseA);
  const b = await validateInstaller(config, config.installerB, config.releaseB);
  requireCondition(a.pin.keyId === b.pin.keyId && a.pin.publicKey === b.pin.publicKey &&
    a.deploymentTarget.workerName === b.deploymentTarget.workerName, 'release_pair_trust_mismatch');
}

export async function runLiveLifecycleCommand(args) {
  const help = 'Usage: npm run validate:lifecycle:live -- --config /private/path/config.json [--recover-removal | --check-access | --preflight | --management-api | --status]\nFull browser lifecycle requires a prepared, published isolated signed A/B pair, Chrome, cloudflared, and CLOUDFLARE_API_TOKEN.\nFirst run cloudflared access login --quiet --app <isolated-installer-origin> in your normal browser.\n--check-access checks cached installer Access over HTTP without Chrome, deployment, or a journal.\n--preflight also validates the release pair and provider inventory without deployment.\n--management-api uses a minimal management config and cached gateway Access; no Chrome or infrastructure token. It installs one synthetic source and grants/removes synthetic membership. The source remains for lifecycle teardown.\n--status reports private journal progress without network access. Neither API checks nor removal recovery qualify the full browser lifecycle.\nCreates a fresh gateway, exercises account-token management and signed update, interrupts removal, and verifies recovery and absence.\nCloudflare infrastructure OAuth consent is separate from Access login. Add the management token directly in Cloudflare when prompted.\nRecovery imports the saved removal receipt; it does not restart installation or unknown writes.';
  if (args.length === 1 && args[0] === '--help') { console.log(help); return 0; }
  requireCondition((args.length === 2 || args.length === 3 && ['--recover-removal', '--check-access', '--preflight', '--management-api', '--status'].includes(args[2])) && args[0] === '--config', 'usage_invalid');
  const recover = args[2] === '--recover-removal';
  const apiOnly = args[2] === '--management-api';
  const input = await readPrivateJson(args[1]);
  if (args[2] === '--status') {
    console.log(JSON.stringify(summarizeLiveJournal(await readPrivateJson(input.journal)), null, 2));
    return 0;
  }
  const config = apiOnly ? validateLiveManagementConfig(input) : validateLiveLifecycleConfig(input);
  if (args[2] === '--check-access' || args[2] === '--preflight') {
    const probe = createLiveGatewayApi({ origin: config.installerOrigin, email: config.basics.adminEmail });
    await probe.checkAccess();
    if (args[2] === '--preflight') {
      await validateReleasePair(config);
      const endpointFailure = await checkSignedConfigurationEndpoint(config.installerOrigin);
      requireCondition(endpointFailure === null, endpointFailure);
      await createLiveGatewayProvider({ config, token: process.env.CLOUDFLARE_API_TOKEN }).assertFresh();
    }
    console.log('Read-only preflight passed. No browser, deployment, or lifecycle qualification. Cloudflare dashboard consent was not checked.');
    return 0;
  }
  if (config.browserProfile) {
    const profile = await outsideRepository(config.browserProfile);
    const profileStat = await lstat(profile);
    requireCondition(profileStat.isDirectory() && (profileStat.mode & 0o077) === 0 &&
      (await readFile(resolve(profile, '.ankka-lifecycle-profile'), 'utf8')) === 'Dedicated Ankka lifecycle test browser\n', 'dedicated_browser_profile_required');
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiOnly) requireCondition(v.is(text, token), 'operator_token_required');
  const parent = await outsideRepository(dirname(config.journal));
  requireCondition(isAbsolute(config.journal) && (await lstat(parent)).isDirectory() &&
    ((await lstat(parent)).mode & 0o077) === 0, 'private_journal_directory_required');
  const provider = apiOnly ? null : createLiveGatewayProvider({ config, token });
  let state = { schemaVersion: 1, config, scope: apiOnly ? 'management_api' : 'browser_lifecycle', events: [], qualified: false };
  if (recover) {
    state = await readPrivateJson(config.journal);
    requireCondition(JSON.stringify(state.config) === JSON.stringify(config) && Array.isArray(state.events), 'recovery_config_mismatch');
  }
  // Exclusive create makes accidental reruns fail before any cloud mutation.
  const journal = await open(config.journal, recover ? 'r+' : 'wx', 0o600);
  await journal.close();
  const lock = await open(`${config.journal}.lock`, 'wx', 0o600);
  let browser;
  const cancellation = new AbortController();
  const cancel = () => { cancellation.abort(); browser?.cancel(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  async function checkpoint(event) {
    state.events.push({ ...event, at: new Date().toISOString() });
    if (event.stage === 'lifecycle' && event.status === 'passed') state.qualified = true;
    const data = JSON.stringify(state, null, 2) + '\n';
    const pending = `${config.journal}.${randomUUID()}.tmp`;
    const output = await open(pending, 'wx', 0o600);
    try { await output.writeFile(data); await output.sync(); }
    finally { await output.close(); }
    await rename(pending, config.journal);
    const directory = await open(parent, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    console.log(`${event.stage}: ${event.status}`);
  }
  try {
    await checkpoint({ stage: recover ? 'recovery' : 'preflight', status: 'started' });
    if (apiOnly && config.serviceAccess !== undefined) {
      // The deployed protected routes as the service identity: no browser, no cached human session. Refusals of an
      // unapproved identity and of operations outside the allowlist are proven before the exercise.
      const service = config.serviceAccess;
      const api = createLiveGatewayServiceApi({ origin: config.managementOrigin, clientId: service.clientId,
        secret: await resolveOperatorCredential(service.secret), signal: cancellation.signal });
      if (service.foreign !== undefined) {
        const foreign = createLiveGatewayServiceApi({ origin: config.managementOrigin, clientId: service.foreign.clientId,
          secret: await resolveOperatorCredential(service.foreign.secret), signal: cancellation.signal });
        // The Access edge refuses an identity no policy admits with a redirect to its login page (or 401/403).
        const refusal = await foreign.probe('/api/status');
        requireCondition([302, 401, 403].includes(refusal), 'service_foreign_identity_not_refused');
        await checkpoint({ stage: 'service_rejection', status: 'foreign_identity_refused', httpStatus: refusal });
      }
      requireCondition(await api.probe('/api/status') === 200, 'service_identity_not_admitted');
      for (const [path, method] of [['/api/update-actions', 'POST'], ['/api/teardown-actions', 'POST'],
        [`/api/source-actions/action_${'A'.repeat(32)}`, 'DELETE'], [`/api/update-actions/action_${'A'.repeat(32)}`, 'GET']]) {
        const status = await api.probe(path, method === 'GET' ? {} : { method, body: { schemaVersion: 1 } });
        requireCondition(status === 403, 'service_operation_not_refused');
      }
      await checkpoint({ stage: 'service_rejection', status: 'operations_refused' });
      await checkpoint({ stage: 'access', status: 'passed', actor: 'service' });
      await qualifyLiveGatewayManagement({ request: api.request, source: config.source, checkpoint });
      await checkpoint({ stage: 'management_api', status: 'passed', actor: 'service' });
      console.log('Management API checks passed as the service identity over the deployed routes. Synthetic source remains installed. Full lifecycle is not qualified.');
      return 0;
    }
    if (apiOnly) {
      const api = createLiveGatewayApi({ origin: config.managementOrigin, email: config.adminEmail, signal: cancellation.signal });
      await api.checkAccess();
      await checkpoint({ stage: 'access', status: 'passed' });
      await qualifyLiveGatewayManagement({ request: api.request, source: config.source, checkpoint });
      await checkpoint({ stage: 'management_api', status: 'passed' });
      console.log('Management API checks passed. Synthetic source remains installed. Full lifecycle is not qualified.');
      return 0;
    }
    // Validate local artifacts and provider reads before opening Chrome or deploying.
    if (!recover) {
      await validateReleasePair(config);
      await provider.assertFresh();
    } else {
      requireCondition(state.events.some((event) => event.stage === 'root_removal' && event.status === 'receipt_saved' && event.handoff) &&
        state.events.some((event) => event.stage === 'inventory' && event.status === 'passed' && event.inventory), 'removal_receipt_required');
    }
    await createLiveGatewayApi({ origin: config.installerOrigin, email: config.basics.adminEmail, signal: cancellation.signal }).checkAccess();
    await checkpoint({ stage: 'preflight', status: 'passed' });
    browser = await openLiveGatewayBrowser({ ...config, notify: console.log });
    await browser.login(config.installerOrigin);
    await checkpoint({ stage: 'access', status: 'passed' });
    if (!recover) {
      await checkpoint({ stage: 'installer_deployment', status: 'started' });
      await deployInstaller(config, config.installerA, config.releaseA);
      await checkpoint({ stage: 'installer_deployment', status: 'passed' });
      const endpointFailure = await checkSignedConfigurationEndpoint(config.installerOrigin);
      requireCondition(endpointFailure === null, endpointFailure);
    }
    if (recover) {
      const receipt = state.events.findLast((event) => event.stage === 'root_removal' && event.status === 'receipt_saved');
      const inventory = state.events.findLast((event) => event.stage === 'inventory' && event.status === 'passed')?.inventory;
      requireCondition(receipt?.handoff && inventory, 'removal_receipt_required');
      await browser.login(config.installerOrigin);
      const installer = (path, options) => browser.request(config.installerOrigin, path, options);
      await installer('/api/teardown/import', { method: 'POST', body: { handoff: receipt.handoff } });
      await finishLiveGatewayRemoval({ browser, installer, provider, inventory, checkpoint });
      await checkpoint({ stage: 'recovery', status: 'passed' });
    } else await qualifyLiveGatewayLifecycle({ config, browser, provider, checkpoint, notify: console.log,
      publishB: () => deployInstaller(config, config.installerB, config.releaseB) });
    return 0;
  } catch (error) {
    const failureCode = error instanceof LiveLifecycleError || error instanceof LiveGatewayBrowserError || error instanceof LiveGatewayAccessError || error instanceof LiveGatewayApiError ||
      error instanceof LiveManagementQualificationError ? error.code : 'unexpected_failure';
    const diagnostics = await lifecycleFailureReport({ events: state.events, failureCode, httpStatus: error?.status, metrics: provider?.metrics });
    await checkpoint({ stage: 'command', status: 'stopped', failureCode, diagnostics });
    console.error(JSON.stringify(diagnostics));
    console.error(`Failure reference: ${failureCode}`);
    console.error('Live validation stopped. Keep the private journal and review the last recorded action before retrying. No automatic duplicate write or cleanup was attempted.');
    return 1;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    try { await browser?.close(); }
    finally { await lock.close(); await rm(`${config.journal}.lock`); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runLiveLifecycleCommand(process.argv.slice(2)); }
  catch (error) {
    if (error instanceof LiveGatewayAccessError) console.error(`Access check stopped: ${error.code}. Use cloudflared access login --quiet --app <isolated-installer-origin> in your normal browser, then rerun --check-access.`);
    else if (error instanceof LiveLifecycleError) console.error(`Live validation could not start: ${error.code}.`);
    else console.error('Live validation could not start. Check the config, private paths, credentials, and exclusive journal.');
    process.exitCode = 1;
  }
}
