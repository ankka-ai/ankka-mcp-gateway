import { readFile, realpath, lstat, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as v from 'valibot';
import { validateGeneratedReviewedIsolatedCanaryDirectory } from '../apps/installer/scripts/generate-reviewed-canary.mjs';
import { openLiveGatewayBrowser, validateLiveBrowserOrigin, LiveGatewayBrowserError } from './live-gateway-browser.mjs';
import { LiveManagementQualificationError } from './live-gateway-management.mjs';
import { createLiveGatewayProvider } from './live-gateway-provider.mjs';
import { qualifyLiveGatewayLifecycle, finishLiveGatewayRemoval, LiveLifecycleError } from './live-gateway-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = v.pipe(v.string(), v.minLength(1));
const identity = v.strictObject({ release: v.pipe(text, v.regex(/^gateway-v\d+\.\d+\.\d+$/u)), artifactSha256: v.pipe(text, v.regex(/^[a-f0-9]{64}$/u)) });
const schema = v.strictObject({
  schemaVersion: v.literal(1), accountId: v.pipe(text, v.regex(/^[a-f0-9]{32}$/u)), zoneId: v.pipe(text, v.regex(/^[a-f0-9]{32}$/u)),
  installerOrigin: text, managementOrigin: text,
  installerA: text, installerB: text, journal: text, releaseA: identity, releaseB: identity,
  browserProfile: v.optional(text),
  basics: v.strictObject({ gatewayName: text, zoneName: text, managementHostname: text, portalHostname: text,
    adminEmail: v.pipe(text, v.email()), additionalAdminEmails: v.tuple([]) }),
  source: v.strictObject({ url: text, tool: text }),
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

export function validateLiveLifecycleConfig(input) {
  const result = v.safeParse(schema, input);
  requireCondition(result.success, 'live_config_invalid');
  const config = result.output;
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
  const status = await new Promise((resolveStatus) => {
    const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy',
      '--config', resolve(directory, 'wrangler.canary.toml')], {
      cwd: directory, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore',
    });
    child.once('error', () => resolveStatus(-1)); child.once('exit', resolveStatus);
  });
  requireCondition(status === 0, 'isolated_installer_deploy_failed');
}

export async function runLiveLifecycleCommand(args) {
  const help = 'Usage: npm run validate:lifecycle:live -- --config /private/path/config.json [--recover-removal]\nRequires a prepared, published isolated signed A/B pair, Chrome, and CLOUDFLARE_API_TOKEN.\nCreates a fresh gateway, exercises account-token management and signed update, interrupts removal, and verifies recovery and absence.\nReview OAuth in the test browser. Add the management token directly in Cloudflare when prompted.\nRecovery imports the saved removal receipt; it does not restart installation or unknown writes.';
  if (args.length === 1 && args[0] === '--help') { console.log(help); return 0; }
  requireCondition((args.length === 2 || args.length === 3 && args[2] === '--recover-removal') && args[0] === '--config', 'usage_invalid');
  const recover = args.length === 3;
  const config = validateLiveLifecycleConfig(await readPrivateJson(args[1]));
  if (config.browserProfile) {
    const profile = await outsideRepository(config.browserProfile);
    const profileStat = await lstat(profile);
    requireCondition(profileStat.isDirectory() && (profileStat.mode & 0o077) === 0 &&
      (await readFile(resolve(profile, '.ankka-lifecycle-profile'), 'utf8')) === 'Dedicated Ankka lifecycle test browser\n', 'dedicated_browser_profile_required');
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  requireCondition(v.is(text, token), 'operator_token_required');
  const parent = await outsideRepository(dirname(config.journal));
  requireCondition(isAbsolute(config.journal) && (await lstat(parent)).isDirectory() &&
    ((await lstat(parent)).mode & 0o077) === 0, 'private_journal_directory_required');
  const provider = createLiveGatewayProvider({ config, token });
  let state = { schemaVersion: 1, config, events: [], qualified: false };
  if (recover) {
    state = await readPrivateJson(config.journal);
    requireCondition(JSON.stringify(state.config) === JSON.stringify(config) && Array.isArray(state.events), 'recovery_config_mismatch');
  }
  // Exclusive create makes accidental reruns fail before any cloud mutation.
  const journal = await open(config.journal, recover ? 'r+' : 'wx', 0o600);
  await journal.close();
  const lock = await open(`${config.journal}.lock`, 'wx', 0o600);
  let browser;
  const cancel = () => browser?.cancel();
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
    if (!recover) {
      const a = await validateInstaller(config, config.installerA, config.releaseA);
      const b = await validateInstaller(config, config.installerB, config.releaseB);
      requireCondition(a.pin.keyId === b.pin.keyId && a.pin.publicKey === b.pin.publicKey &&
        a.deploymentTarget.workerName === b.deploymentTarget.workerName, 'release_pair_trust_mismatch');
      await provider.assertFresh();
      await deployInstaller(config, config.installerA, config.releaseA);
    }
    browser = await openLiveGatewayBrowser({ ...config, notify: console.log });
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
    const failureCode = error instanceof LiveLifecycleError || error instanceof LiveGatewayBrowserError ||
      error instanceof LiveManagementQualificationError ? error.code : 'unexpected_failure';
    await checkpoint({ stage: 'command', status: 'stopped', failureCode });
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
  catch { console.error('Live validation could not start. Check the config, private paths, credentials, and exclusive journal.'); process.exitCode = 1; }
}
