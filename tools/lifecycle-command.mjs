import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import * as v from 'valibot';

import { inventoryDeploymentCredential } from './lifecycle-credentials.mjs';
import {
  LifecycleJobError, LIFECYCLE_STAGES, approvalDigest, assertLifecycleJobApproved, credentialReferenceLabel,
  readLifecycleJob, stagesForJob, writeLifecycleJobApproval,
} from './lifecycle-job.mjs';
import {
  LifecycleRecordError, openLifecycleRecord, privateRunDirectory, requestLifecycleCancel, summarizeLifecycleRecord,
} from './lifecycle-record.mjs';

/**
 * The one lifecycle entry point for agents and operators. It approves a job,
 * runs its stages one child process at a time over the private record,
 * reports machine-readable results, and never prints a credential.
 *
 *   npm run lifecycle -- approve --job /private/job.json --approved-by <administrator email>
 *   npm run lifecycle -- run --job /private/job.json [--stage <name> | --from <name>] [--resume] [--interrupt-after <stage>:<n>]
 *   npm run lifecycle -- status --job /private/job.json
 *   npm run lifecycle -- cancel --job /private/job.json
 *   npm run lifecycle -- credentials --job /private/job.json
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const HELP = `Usage: npm run lifecycle -- <approve|run|status|cancel|credentials> --job /private/job.json [options]
approve      --approved-by <email>   Record approval of the job's exact target, release pair, operations and credential references.
run          [--stage <name> | --from <name>] [--resume] [--interrupt-after <stage>:<n>]
             Execute the approved stages in order, each in its own process over the private run record.
             --resume reopens an existing record; --interrupt-after terminates the named stage abruptly after n mutating provider responses.
status       Summarize the private record without network access. Never prints credentials, identifiers or the removal handoff.
cancel       Ask a running or resumed job to stop before its next mutation.
credentials  Probe what the deployment credential can read, by endpoint family.
Stages: ${LIFECYCLE_STAGES.join(', ')}. Results are passed, verified, failed, blocked, interrupted or not_run; qualified is always false for customer-path claims.`;

class LifecycleCommandError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}
function requireCondition(value, code, detail = null) { if (!value) throw new LifecycleCommandError(code, detail); }

function parseArguments(args) {
  const [command, ...rest] = args;
  const options = { flags: new Set() };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (['--job', '--stage', '--from', '--approved-by', '--interrupt-after'].includes(item)) {
      const value = rest[index + 1];
      requireCondition(v.is(v.string(), value) && !value.startsWith('--'), 'usage_invalid', item);
      options[item.slice(2)] = value; index += 1;
    } else if (item === '--resume') options.flags.add('resume');
    else throw new LifecycleCommandError('usage_invalid', item);
  }
  requireCondition(v.is(v.string(), options.job), 'usage_invalid', '--job');
  return { command, options };
}

/** Reads one credential into memory from the operator's store; the value never enters argv, logs or the record. */
async function resolveCredential(reference) {
  if ('env' in reference) {
    const value = process.env[reference.env];
    requireCondition(v.is(v.pipe(v.string(), v.minLength(20)), value), 'credential_unavailable', credentialReferenceLabel(reference));
    return value;
  }
  try {
    const { stdout } = await execute('security', ['find-generic-password', '-s', reference.keychain.service, '-a', reference.keychain.account, '-w'],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 65_536 });
    const value = stdout.trim();
    requireCondition(value.length >= 20, 'credential_unavailable', credentialReferenceLabel(reference));
    return value;
  } catch (error) {
    if (error instanceof LifecycleCommandError) throw error;
    throw new LifecycleCommandError('credential_unavailable', credentialReferenceLabel(reference));
  }
}

const STAGE_CREDENTIALS = Object.freeze({
  manage: ['management'], 'remove-dependencies': ['management'],
});

async function bundleStageRunner() {
  const outfile = resolve(root, 'apps/installer/dist/lifecycle/main.mjs');
  await build({
    absWorkingDir: root, entryPoints: [resolve(root, 'apps/installer/lifecycle/main.ts')], outfile,
    bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['node:*'],
    logLevel: 'silent', sourcemap: false, legalComments: 'none',
  });
  return outfile;
}

function runChild(bundle, stage, jobPath, runDirectory, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bundle, stage, jobPath, runDirectory], { cwd: root, env, stdio: 'inherit' });
    child.once('error', () => done({ code: 1, signal: null }));
    child.once('exit', (code, signal) => done({ code, signal }));
  });
}

async function recordState(runDirectory) {
  return JSON.parse(await readFile(join(runDirectory, 'record.json'), 'utf8'));
}

async function run(options) {
  const jobPath = resolve(options.job);
  const job = await readLifecycleJob(jobPath);
  const targetDigest = await assertLifecycleJobApproved(job);
  const resume = options.flags.has('resume') || options.stage !== undefined || options.from !== undefined;
  const selection = {};
  if (options.stage !== undefined) selection.stage = options.stage;
  if (options.from !== undefined) selection.from = options.from;
  const stages = stagesForJob(job, selection);
  let interrupt = null;
  if (options['interrupt-after'] !== undefined) {
    const match = /^([a-z-]+):([1-9]\d{0,4})$/u.exec(options['interrupt-after']);
    requireCondition(match !== null && stages.includes(match[1]), 'usage_invalid', '--interrupt-after');
    interrupt = { stage: match[1], count: match[2] };
  }
  // Credentials and the stage bundle come first: a missing credential must leave no run directory or record behind.
  const env = { ...process.env, ANKKA_LIFECYCLE_DEPLOYMENT_TOKEN: await resolveCredential(job.credentials.deployment) };
  delete env.ANKKA_LIFECYCLE_INTERRUPT_AFTER;
  if (stages.some((stage) => (STAGE_CREDENTIALS[stage] ?? []).includes('management'))) {
    env.ANKKA_LIFECYCLE_MANAGEMENT_TOKEN = await resolveCredential(job.credentials.management);
  }
  if (job.credentials.service !== undefined) env.ANKKA_LIFECYCLE_SERVICE_CLIENT_SECRET = await resolveCredential(job.credentials.service.secret);
  const bundle = await bundleStageRunner();
  if (!resume) await mkdir(job.runDirectory, { mode: 0o700, recursive: false }).catch(() => { throw new LifecycleCommandError('run_directory_exists'); });
  const runDirectory = await privateRunDirectory(job.runDirectory);
  const record = await openLifecycleRecord(runDirectory, { create: !resume, holdLock: true, jobId: job.jobId, targetDigest });
  try {
    await record.event('command', 'run', { stages: [...stages], resume });
    const results = {};
    let stopped = null;
    for (const stage of stages) {
      if (await record.cancelRequested()) { stopped = { stage, code: 'job_cancelled' }; results[stage] = { status: 'blocked', code: 'job_cancelled' }; break; }
      const stageEnv = interrupt?.stage === stage ? { ...env, ANKKA_LIFECYCLE_INTERRUPT_AFTER: interrupt.count } : env;
      process.stdout.write(`lifecycle: ${stage} started\n`);
      const exit = await runChild(bundle, stage, jobPath, runDirectory, stageEnv);
      const state = await recordState(runDirectory);
      let result = state.stages[stage] ?? null;
      if (exit.signal !== null || result === null) {
        result = { status: 'interrupted', code: exit.signal === null ? 'stage_exited_without_result' : `process_${exit.signal.toLowerCase()}` };
        await record.stage(stage, result);
      }
      results[stage] = { status: result.status, code: result.code ?? null };
      process.stdout.write(`lifecycle: ${stage} ${result.status}${result.code ? ` (${result.code})` : ''}\n`);
      if (!['passed', 'verified'].includes(result.status)) { stopped = { stage, code: result.code ?? null }; break; }
    }
    for (const stage of stages) results[stage] ??= { status: 'not_run', code: null };
    const summary = summarizeLifecycleRecord(await recordState(runDirectory));
    const report = { ...summary, run: results, stopped, nextAction: nextAction(stopped, results) };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return stopped === null ? 0 : ['blocked', 'interrupted'].includes(results[stopped.stage]?.status) ? 2 : 1;
  } finally {
    await record.close();
  }
}

function nextAction(stopped, results) {
  if (stopped === null) return 'complete';
  const status = results[stopped.stage]?.status;
  if (status === 'interrupted') return `inspect the private record, then rerun with --resume --from ${stopped.stage}`;
  if (stopped.code === 'job_cancelled') return 'the job was cancelled before its next mutation; remove the cancel marker to resume';
  if (status === 'blocked') return `resolve ${stopped.code ?? 'the blocking condition'} outside the runner, then rerun with --resume --from ${stopped.stage}`;
  return `inspect the private record for ${stopped.stage}; no mutation was retried automatically`;
}

export async function runLifecycleCommand(args) {
  if (args.length === 0 || args[0] === '--help') { process.stdout.write(`${HELP}\n`); return args.length === 0 ? 2 : 0; }
  const { command, options } = parseArguments(args);
  const jobPath = resolve(options.job);
  if (command === 'approve') {
    requireCondition(v.is(v.string(), options['approved-by']), 'usage_invalid', '--approved-by');
    const job = await readLifecycleJob(jobPath);
    const targetDigest = await approvalDigest(job);
    await writeLifecycleJobApproval(jobPath, job, { approvedBy: options['approved-by'], approvedAt: new Date().toISOString(), targetDigest });
    process.stdout.write(`${JSON.stringify({ jobId: job.jobId, approved: true, targetDigest, operations: job.operations })}\n`);
    return 0;
  }
  if (command === 'status') {
    const job = await readLifecycleJob(jobPath);
    const summary = summarizeLifecycleRecord(await recordState(await privateRunDirectory(job.runDirectory)));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  if (command === 'cancel') {
    const job = await readLifecycleJob(jobPath);
    await requestLifecycleCancel(job.runDirectory);
    process.stdout.write(`${JSON.stringify({ jobId: job.jobId, cancelRequested: true })}\n`);
    return 0;
  }
  if (command === 'credentials') {
    const job = await readLifecycleJob(jobPath);
    const token = await resolveCredential(job.credentials.deployment);
    const inventory = await inventoryDeploymentCredential({ token, accountId: job.target.accountId, zoneId: job.target.zoneId });
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return 0;
  }
  if (command === 'run') return run(options);
  throw new LifecycleCommandError('usage_invalid', command);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runLifecycleCommand(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LifecycleCommandError || error instanceof LifecycleJobError || error instanceof LifecycleRecordError) {
      process.stderr.write(`lifecycle: ${error.code}${error.detail ? ` (${error.detail})` : ''}\n`);
    } else {
      process.stderr.write('lifecycle: could not start. Check the job file, private paths and credential references.\n');
    }
    process.exitCode = 2;
  }
}
