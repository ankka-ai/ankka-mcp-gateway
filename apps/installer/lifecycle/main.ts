import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as v from 'valibot';

import type { BoundaryValue } from '../src/boundary';
import { fixedCloudflareOperationAuthority, type ExternalRunnerOperation } from '../src/cloudflare-operation-authority';
import { assertLifecycleJobApproved, lifecycleHostnames, readLifecycleJob, type LifecycleStage } from '../../../tools/lifecycle-job.mjs';
import { openLifecycleRecord, readInstallationSecrets, writeInstallationSecrets } from '../../../tools/lifecycle-record.mjs';
import { createLiveGatewayProvider } from '../../../tools/live-gateway-provider.mjs';
import {
  importPayloadModule, installationSecretsSchema, LifecycleStageError,
  type InstallationSecrets, type LifecycleContext, type PayloadModule,
} from './context';
import { loadLocalRelease, localControlPlane, type LoadedRelease } from './release';
import { bootstrapStage, convergeStage, preflightStage, verifyStage } from './stage-install';
import { manageStage } from './stage-manage';
import { removeDependenciesStage, removeRootStage, verifyAbsentStage } from './stage-remove';
import { updateStage } from './stage-update';
import { createGuardedTransport, LifecycleTransportError, stageFamilies, type RunnerEndpointFamily } from './transport';

/**
 * One stage in one process. The parent command resolved the credentials,
 * holds the run lock and decides what runs next; this process executes the
 * stage over the shared record and exits 0 (passed or verified), 1 (failed)
 * or 2 (blocked). An abrupt termination requested by the interruption hook
 * never reaches the exit path.
 */
const stageSchema = v.picklist(['preflight', 'bootstrap', 'converge', 'verify', 'manage', 'update', 'remove-dependencies', 'remove-root', 'verify-absent']);

interface StageAuthority {
  readonly operations: readonly ExternalRunnerOperation[];
  /** Gateway operations the payload's management code executes in-process with the management credential. */
  readonly gatewayOperations?: readonly ('source-add' | 'source-update' | 'source-remove')[];
  readonly provisioning?: boolean;
  readonly diagnostics?: boolean;
  /** The payload verifies the management credential against the account token endpoint before it uses it. */
  readonly tokenVerification?: boolean;
}

const STAGE_AUTHORITY: Readonly<Record<LifecycleStage, StageAuthority>> = Object.freeze({
  preflight: { operations: ['bootstrap', 'install', 'upgrade', 'uninstall', 'gateway-root-finalize'], diagnostics: true },
  bootstrap: { operations: ['bootstrap'] },
  converge: { operations: ['install'] },
  verify: { operations: ['install'] },
  manage: { operations: ['install'], gatewayOperations: ['source-add', 'source-update', 'source-remove'], provisioning: true, tokenVerification: true },
  update: { operations: ['upgrade'] },
  'remove-dependencies': { operations: ['uninstall'], tokenVerification: true },
  'remove-root': { operations: ['gateway-root-finalize'] },
  'verify-absent': { operations: ['uninstall', 'gateway-root-finalize', 'install'] },
});

const STAGES: Readonly<Record<LifecycleStage, (context: LifecycleContext) => Promise<BoundaryValue>>> = Object.freeze({
  preflight: preflightStage, bootstrap: bootstrapStage, converge: convergeStage, verify: verifyStage,
  manage: manageStage, update: updateStage,
  'remove-dependencies': removeDependenciesStage, 'remove-root': removeRootStage, 'verify-absent': verifyAbsentStage,
});

const VERIFYING_STAGES: ReadonlySet<LifecycleStage> = new Set(['verify', 'verify-absent']);

/** Production errors carry fixed codes and secret-free reasons; those, and only those, become the stage's diagnostic. */
const thrownSchema = v.looseObject({
  name: v.optional(v.string()),
  code: v.optional(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,79}$/u))),
  reason: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,159}$/u)))),
  stage: v.optional(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,79}$/u))),
  outcome: v.optional(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,39}$/u))),
});
type Thrown = v.InferOutput<typeof thrownSchema>;
interface StageOutcome { readonly status: 'failed' | 'blocked'; readonly code: string; readonly detail: string | null }

function unexpectedOutcome(thrown: Thrown | null): StageOutcome {
  const name = thrown?.name ?? 'error';
  if (thrown?.code !== undefined) {
    const parts = [name];
    if (thrown.stage !== undefined) parts.push(thrown.stage);
    if (thrown.outcome !== undefined) parts.push(thrown.outcome);
    if (thrown.reason) parts.push(thrown.reason);
    return { status: 'failed', code: thrown.code, detail: parts.join(':') };
  }
  return { status: 'failed', code: 'unexpected_failure', detail: thrown === null ? null : name };
}

function families(stage: LifecycleStage): ReadonlySet<RunnerEndpointFamily> {
  const authority = STAGE_AUTHORITY[stage];
  const admitted = new Set(stageFamilies({
    operations: authority.operations, provisioning: authority.provisioning === true, diagnostics: authority.diagnostics === true,
    tokenVerification: authority.tokenVerification === true,
  }));
  for (const operation of authority.gatewayOperations ?? []) {
    for (const family of fixedCloudflareOperationAuthority(operation).endpointFamilies) admitted.add(family);
  }
  return admitted;
}

async function runStage(stage: LifecycleStage, jobPath: string, runDirectory: string): Promise<number> {
  const deploymentToken = process.env.ANKKA_LIFECYCLE_DEPLOYMENT_TOKEN;
  if (!v.is(v.pipe(v.string(), v.minLength(20)), deploymentToken)) throw new LifecycleStageError('deployment_credential_unavailable', 'blocked');
  const interruptAfter = v.is(v.pipe(v.string(), v.regex(/^[1-9]\d{0,4}$/u)), process.env.ANKKA_LIFECYCLE_INTERRUPT_AFTER)
    ? Number(process.env.ANKKA_LIFECYCLE_INTERRUPT_AFTER) : null;
  const job = await readLifecycleJob(jobPath);
  const targetDigest = await assertLifecycleJobApproved(job);
  const record = await openLifecycleRecord(runDirectory, { holdLock: false, jobId: job.jobId, targetDigest });
  const hostnames = lifecycleHostnames(job);
  const realFetch = globalThis.fetch;
  const releases = new Map<'a' | 'b', Promise<LoadedRelease>>();
  const loaded: LoadedRelease[] = [];
  let payloadModule: Promise<PayloadModule> | undefined;
  const origins = new Map<string, ReadonlySet<string>>([[new URL(job.source.url).origin, new Set(['GET', 'POST'])]]);
  const guarded = createGuardedTransport({
    record, families: families(stage), origins, interruptAfter, realFetch,
    local: async (request) => localControlPlane(loaded)(request),
    terminate: () => {
      process.stderr.write(`lifecycle: interrupting abruptly after ${interruptAfter} mutating provider responses\n`);
      process.kill(process.pid, 'SIGKILL');
      throw new Error('terminated');
    },
  });
  // The release payload reaches the provider through the global fetch; the guard must see those calls too.
  globalThis.fetch = guarded.transport;
  const release = (which: 'a' | 'b'): Promise<LoadedRelease> => {
    let pending = releases.get(which);
    if (pending === undefined) {
      pending = loadLocalRelease(job.releases[which]).then((value) => { loaded.push(value); return value; });
      releases.set(which, pending);
    }
    return pending;
  };
  // The parent runs every stage from the repository root; the hand-authored payload is loaded from there.
  const payload = (): Promise<PayloadModule> => {
    payloadModule ??= importPayloadModule(pathToFileURL(resolve(process.cwd(), 'payload/worker/index.js')).href);
    return payloadModule;
  };
  const context: LifecycleContext = {
    job, hostnames, record,
    credentials: {
      deploymentToken,
      managementToken: v.is(v.pipe(v.string(), v.minLength(20)), process.env.ANKKA_LIFECYCLE_MANAGEMENT_TOKEN) ? process.env.ANKKA_LIFECYCLE_MANAGEMENT_TOKEN : null,
      serviceClientSecret: v.is(v.pipe(v.string(), v.minLength(20)), process.env.ANKKA_LIFECYCLE_SERVICE_CLIENT_SECRET) ? process.env.ANKKA_LIFECYCLE_SERVICE_CLIENT_SECRET : null,
    },
    transport: guarded.transport,
    provider: createLiveGatewayProvider({
      config: { accountId: job.target.accountId, zoneId: job.target.zoneId, source: { url: job.source.url },
        basics: { zoneName: job.target.zoneName, managementHostname: hostnames.management, portalHostname: hostnames.portal } },
      token: deploymentToken, transport: (input, init) => guarded.transport(input, init),
    }),
    now: Date.now,
    notify: (line) => { process.stdout.write(`${line}\n`); },
    release,
    payload,
    probeTransport: (input, init) => realFetch(input, init),
    allowOrigin: (origin, methods) => { origins.set(origin, new Set(methods)); },
    readInstallationSecrets: async () => {
      const value = await readInstallationSecrets(runDirectory);
      if (value === null) return null;
      const parsed = v.safeParse(installationSecretsSchema, value);
      if (!parsed.success) throw new LifecycleStageError('installation_secrets_invalid', 'blocked');
      return parsed.output;
    },
    writeInstallationSecrets: (value: InstallationSecrets) => writeInstallationSecrets(runDirectory, JSON.parse(JSON.stringify(value))),
  };
  await record.event(stage, 'started');
  try {
    const detail = await STAGES[stage](context);
    const status = VERIFYING_STAGES.has(stage) ? 'verified' : 'passed';
    await record.stage(stage, { status, code: null, detail });
    process.stdout.write(`${JSON.stringify({ stage, status, detail })}\n`);
    return 0;
  } catch (error) {
    const outcome = error instanceof LifecycleStageError ? { status: error.status, code: error.code, detail: error.detail }
      : error instanceof LifecycleTransportError ? { status: error.code === 'job_cancelled' ? 'blocked' as const : 'failed' as const, code: error.code, detail: error.detail }
        : unexpectedOutcome(v.safeParse(thrownSchema, error).success ? v.parse(thrownSchema, error) : null);
    await record.stage(stage, outcome);
    process.stdout.write(`${JSON.stringify({ stage, ...outcome })}\n`);
    return outcome.status === 'blocked' ? 2 : 1;
  } finally {
    globalThis.fetch = realFetch;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [stage, jobPath, runDirectory] = process.argv.slice(2);
  const parsed = v.safeParse(stageSchema, stage);
  if (!parsed.success || jobPath === undefined || runDirectory === undefined) {
    process.stderr.write('lifecycle stage runner: <stage> <job> <run-directory>\n');
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await runStage(parsed.output, jobPath, runDirectory);
    } catch (error) {
      const code = error instanceof LifecycleStageError ? error.code : v.is(v.looseObject({ code: v.string() }), error) ? error.code : 'stage_start_failed';
      process.stdout.write(`${JSON.stringify({ stage: parsed.output, status: 'blocked', code })}\n`);
      process.exitCode = 2;
    }
  }
}
