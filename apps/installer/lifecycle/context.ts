import * as v from 'valibot';

import type { BoundaryValue } from '../src/boundary';
import type { CustomerGatewayOwnershipStorage } from '../src/customer-gateway-ownership-state';
import type { PreparedCustomerBootstrapClaim } from '../src/customer-bootstrap-request';
import type { CustomerStage2JournalPort } from '../src/customer-stage2-durable-state';
import { parseCustomerStage2Journal, type CustomerStage2Journal } from '../src/customer-stage2-journal';
import type { GatewayTeardownJobPort } from '../src/gateway-teardown-durable-state';
import { parseGatewayTeardownJob, type GatewayTeardownJob } from '../src/gateway-teardown-job';
import type { GatewayWorkerPlainTextBindingName } from '../src/cloudflare-worker-direct-upload';
import type { FetchTransport } from '../src/oauth';
import type { LifecycleJob } from '../../../tools/lifecycle-job.mjs';
import type { DurableStorageStandIn, LifecycleRecord } from '../../../tools/lifecycle-record.mjs';
import type { LiveGatewayProvider } from '../../../tools/live-gateway-provider.mjs';
import type { LoadedRelease } from './release';

/** A stage stops with one fixed code; `blocked` names a condition only the operator can change. */
export class LifecycleStageError extends Error {
  constructor(
    readonly code: string,
    readonly status: 'failed' | 'blocked' = 'failed',
    readonly detail: string | null = null,
  ) {
    super(code);
    this.name = 'LifecycleStageError';
  }
}

export function requireStage(condition: boolean, code: string, detail: string | null = null): asserts condition {
  if (!condition) throw new LifecycleStageError(code, 'failed', detail);
}

export interface LifecycleCredentials {
  readonly deploymentToken: string;
  readonly managementToken: string | null;
  readonly serviceClientSecret: string | null;
}

export interface LifecycleContext {
  readonly job: LifecycleJob;
  readonly hostnames: { readonly management: string; readonly portal: string };
  readonly record: LifecycleRecord;
  readonly credentials: LifecycleCredentials;
  readonly transport: FetchTransport;
  readonly provider: LiveGatewayProvider;
  readonly now: () => number;
  readonly notify: (line: string) => void;
  release(which: 'a' | 'b'): Promise<LoadedRelease>;
  payload(which: 'a' | 'b'): Promise<PayloadModule>;
  /** The checked-out payload's pure helpers (discovery, draft validation); Durable Object routes use the installed release. */
  checkoutPayload(): Promise<PayloadModule>;
  readInstallationSecrets(): Promise<InstallationSecrets | null>;
  writeInstallationSecrets(value: InstallationSecrets): Promise<void>;
}

/** Installation-owned key material, disposable with the installation. Never a Cloudflare credential. */
export const installationSecretsSchema = v.strictObject({
  schemaVersion: v.literal(1),
  capability: v.strictObject({
    bootstrapId: v.string(), secret: v.string(), secretCommitment: v.string(), expiresAt: v.pipe(v.number(), v.safeInteger()),
  }),
  bootstrapNonce: v.string(),
  ownershipWrapKey: v.string(),
  issuer: v.strictObject({ keyId: v.string(), publicKey: v.string(), privateKeyJwk: v.looseObject({ kty: v.literal('OKP'), crv: v.literal('Ed25519'), d: v.string(), x: v.string() }) }),
  publicClientId: v.string(),
  teardownActionKey: v.optional(v.string()),
});
export type InstallationSecrets = v.InferOutput<typeof installationSecretsSchema>;

/** Durable Object namespace and object stand-ins the payload accepts in-process. */
export interface DurableObjectStandIn { fetch(request: Request): Promise<Response> }

/** The record's storage stand-in read through the generic ownership-storage contract the production modules declare. */
export function ownershipStorage(storage: DurableStorageStandIn): CustomerGatewayOwnershipStorage {
  return {
    async get<Value = unknown>(key: string): Promise<Value | undefined> {
      // SAFETY: the ownership-state module names the stored type it wrote through put(); the record returns exactly that value.
      return await storage.get(key) as Value | undefined;
    },
    async put<Value>(key: string, value: Value): Promise<void> {
      await storage.put(key, JSON.parse(JSON.stringify(value)));
    },
  };
}
export interface DurableNamespaceStandIn {
  idFromName(name: string): string;
  get(id: string): DurableObjectStandIn;
}

export type PayloadBindingName =
  | GatewayWorkerPlainTextBindingName
  | 'CLOUDFLARE_ZONE_ID' | 'CLOUDFLARE_ZONE_NAME' | 'ZERO_TRUST_READY'
  | 'ANKKA_BOOTSTRAP_NONCE' | 'ANKKA_GATEWAY_OWNERSHIP_WRAP_KEY' | 'ANKKA_MANAGEMENT_TOKEN';
export type PayloadEnvironment = Partial<Record<PayloadBindingName, string>> & { ADMIN_STATE?: DurableNamespaceStandIn };

/** A saved source as the payload's draft and action routes see it; extra fields ride along untouched. */
export interface ManagedSourceLike { readonly url: string; readonly [field: string]: BoundaryValue }

/** The members of the hand-authored gateway payload this runner calls. */
export interface PayloadModule {
  readonly AdminState: new (state: { readonly storage: DurableStorageStandIn }, env: PayloadEnvironment) => DurableObjectStandIn;
  processBootstrap(request: Request, env: PayloadEnvironment, storage: DurableStorageStandIn): Promise<Response>;
  publishBootstrapCompletion(
    claim: BoundaryValue, ready: BoundaryValue, env: PayloadEnvironment, nowMs: number,
    adminState: (request: Request) => Promise<Response>,
  ): Promise<boolean>;
  verifyBootstrapReceiptProviderStateWithReason(
    claim: PreparedCustomerBootstrapClaim & { readonly cloudflareAccessToken: string },
    env: PayloadEnvironment, storage: DurableStorageStandIn, nowMs: number,
  ): Promise<{ readonly verified: boolean; readonly reason: string | null }>;
  parseSourceSave(value: BoundaryValue): BoundaryValue | null;
  verifyManagedSource(source: ManagedSourceLike): Promise<BoundaryValue>;
  managedSourceHash(source: ManagedSourceLike): Promise<string>;
  inspectMcpSource(url: string): Promise<{
    readonly endpoint: string; readonly protocolVersion: string; readonly authMode: string;
    readonly tools: readonly BoundaryValue[]; readonly connectionBlock?: string;
  }>;
}

const payloadModuleSchema = v.looseObject({
  AdminState: v.function(), processBootstrap: v.function(), publishBootstrapCompletion: v.function(),
  verifyBootstrapReceiptProviderStateWithReason: v.function(), parseSourceSave: v.function(),
  verifyManagedSource: v.function(), inspectMcpSource: v.function(), managedSourceHash: v.function(),
});

export async function importPayloadModule(url: string): Promise<PayloadModule> {
  const loaded = await import(url);
  if (!v.safeParse(payloadModuleSchema, loaded).success) throw new LifecycleStageError('payload_module_invalid');
  // The dynamic import is untyped; the schema proved every member this runner calls is a function, and the module is the exact release payload.
  return loaded;
}

/**
 * One in-process namespace: each named object is the release payload's own
 * `AdminState` over its record-backed storage, so what the gateway's objects
 * would have written lands in the runner's durable record instead.
 */
export function inProcessNamespace(payload: PayloadModule, record: LifecycleRecord, environment: () => PayloadEnvironment): DurableNamespaceStandIn {
  return {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: (request) => new payload.AdminState({ storage: record.storage(`object:${id}`) }, environment()).fetch(request),
    }),
  };
}

/** Composes a payload environment whose `ADMIN_STATE` re-enters the same in-process namespace. */
export function payloadEnvironment(
  payload: PayloadModule, record: LifecycleRecord, bindings: Partial<Record<PayloadBindingName, string>>,
): PayloadEnvironment {
  const environment: PayloadEnvironment = { ...bindings };
  environment.ADMIN_STATE = inProcessNamespace(payload, record, () => environment);
  return environment;
}

export function recordJournalPort(record: LifecycleRecord): CustomerStage2JournalPort {
  const storage = record.storage('stage2-journal');
  return {
    async read(): Promise<CustomerStage2Journal | null> {
      const value = await storage.get('journal');
      if (value === undefined) return null;
      const journal = parseCustomerStage2Journal(value);
      if (journal === null) throw new LifecycleStageError('journal_invalid');
      return journal;
    },
    async compareAndSet(expectedRevision, state): Promise<boolean> {
      const current = await storage.get('journal');
      const revision = current === undefined ? null : parseCustomerStage2Journal(current)?.revision ?? null;
      if (revision !== expectedRevision) return false;
      await storage.put('journal', JSON.parse(JSON.stringify(state)));
      return true;
    },
  };
}

export function recordTeardownJobPort(record: LifecycleRecord): GatewayTeardownJobPort {
  const storage = record.storage('teardown-job');
  return {
    async read(): Promise<GatewayTeardownJob | null> {
      const value = await storage.get('job');
      return value === undefined ? null : parseGatewayTeardownJob(value);
    },
    async compareAndSet(expectedRevision, job): Promise<boolean> {
      const current = await storage.get('job');
      const revision = current === undefined ? null : parseGatewayTeardownJob(current).revision;
      if (revision !== expectedRevision) return false;
      await storage.put('job', JSON.parse(JSON.stringify(parseGatewayTeardownJob(job))));
      return true;
    },
  };
}

export function readRecordValue<Schema extends v.GenericSchema>(value: BoundaryValue | undefined, schema: Schema, code: string): v.InferOutput<Schema> {
  const parsed = v.safeParse(schema, value);
  if (!parsed.success) throw new LifecycleStageError(code);
  return parsed.output;
}

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}
