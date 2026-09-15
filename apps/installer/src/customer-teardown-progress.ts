import * as v from 'valibot';
import { CUSTOMER_TEARDOWN_RESOURCE_KINDS, customerTeardownKindsSchema } from './customer-teardown-attempt';

const actionId = v.pipe(v.string(), v.regex(/^action_[A-Za-z0-9_-]{32}$/u));
const attemptId = v.pipe(v.string(), v.regex(/^attempt_[A-Za-z0-9_-]{24}$/u));
const installationId = v.pipe(v.string(), v.regex(/^acg-[a-f0-9]{24}$/u));
const hash = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/u));

/** The phases the gateway's bounded apply passes report while removing, in the order they run. */
export const CUSTOMER_TEARDOWN_PHASES = Object.freeze([
  'bridge_preflight', 'sharing_preflight', 'preflight', 'remove', 'sharing_delete', 'delete', 'verify', 'bridges',
] as const);
export type CustomerTeardownPhase = (typeof CUSTOMER_TEARDOWN_PHASES)[number];
export type CustomerTeardownResourceKind = (typeof CUSTOMER_TEARDOWN_RESOURCE_KINDS)[number];

/** A bounded apply pass with more to do: the payload's opaque progress, and the fixed words the removal page shows. */
export const customerTeardownRemovingSchema = v.strictObject({
  schemaVersion: v.literal(1), actionId, status: v.literal('removing'), installationId, progress: hash,
  phase: v.optional(v.picklist(CUSTOMER_TEARDOWN_PHASES)),
  removedKinds: v.optional(v.pipe(v.array(v.picklist(CUSTOMER_TEARDOWN_RESOURCE_KINDS)), v.maxLength(CUSTOMER_TEARDOWN_RESOURCE_KINDS.length))),
});
export const customerTeardownCompletionSchema = v.strictObject({
  schemaVersion: v.literal(1), actionId, status: v.literal('gateway_removed'), installationId,
  removedResourceCount: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  readyReceiptChecksum: hash, dependencyResourcesHash: hash,
});
export type CustomerTeardownCompletion = v.InferOutput<typeof customerTeardownCompletionSchema>;

/** Why a removal attempt stopped, in the page's fixed vocabulary; every word has one message on the removal page. */
export const CUSTOMER_TEARDOWN_REASONS = Object.freeze([
  'authorization', 'account_access', 'removal', 'no_progress', 'expired', 'pass_limit', 'revocation', 'denied', 'interrupted',
] as const);
export type CustomerTeardownReason = (typeof CUSTOMER_TEARDOWN_REASONS)[number];
const reasonSchema = v.picklist(CUSTOMER_TEARDOWN_REASONS);

/**
 * The outcome of one settled attempt, kept without secrets so the removal
 * page can learn it after the callback has long answered: the receipt link
 * to the installer, or the reason word.
 */
export const customerTeardownOutcomeSchema = v.strictObject({
  schemaVersion: v.literal(1), attemptId,
  result: v.picklist(['removed', 'recovery_required']), reason: v.nullable(reasonSchema),
  handoffUrl: v.nullable(v.pipe(v.string(), v.url(), v.maxLength(64 * 1024))),
});
export type CustomerTeardownOutcome = v.InferOutput<typeof customerTeardownOutcomeSchema>;

export interface CustomerTeardownOutcomePort {
  read(): Promise<CustomerTeardownOutcome | null>;
  write(outcome: CustomerTeardownOutcome): Promise<void>;
}

const OUTCOME_KEY = 'ankka-mcp-gateway/customer-teardown-outcome/v1';

/** The latest attempt's outcome in the management object's own storage; it holds no grant and no action key. */
export class DurableCustomerTeardownOutcomePort implements CustomerTeardownOutcomePort {
  constructor(private readonly storage: DurableObjectStorage) {}
  async read(): Promise<CustomerTeardownOutcome | null> {
    const parsed = v.safeParse(customerTeardownOutcomeSchema, await this.storage.get(OUTCOME_KEY));
    return parsed.success ? parsed.output : null;
  }
  async write(outcome: CustomerTeardownOutcome): Promise<void> {
    await this.storage.put(OUTCOME_KEY, v.parse(customerTeardownOutcomeSchema, outcome));
  }
}

const stepSchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z_]{1,32}$/u)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  state: v.picklist(['pending', 'active', 'done']),
});
/** What the removal page polls: fixed labels and words only, never provider text. */
export const customerTeardownProgressSchema = v.strictObject({
  schemaVersion: v.literal(1), attemptId,
  status: v.picklist(['authorizing', 'removing', 'settled']),
  result: v.nullable(v.picklist(['removed', 'recovery_required'])), reason: v.nullable(reasonSchema),
  handoffUrl: v.nullable(v.pipe(v.string(), v.url())),
  steps: v.pipe(v.array(stepSchema), v.maxLength(CUSTOMER_TEARDOWN_RESOURCE_KINDS.length + 2)),
});
export type CustomerTeardownProgress = v.InferOutput<typeof customerTeardownProgressSchema>;
export type CustomerTeardownProgressStep = v.InferOutput<typeof stepSchema>;

const KIND_LABELS = Object.freeze({
  mcp_server: 'MCP servers', mcp_portal: 'MCP Portal', access_application: 'Access applications', access_policy: 'Access policies',
  dns_record: 'DNS records', worker: 'Managed bridge Workers', worker_custom_domain: 'Managed bridge domains',
} satisfies Record<CustomerTeardownResourceKind, string>);

/**
 * The removal page's step list: the Portal sharing check, each receipt resource
 * kind, and the verification, with the state the latest pass reported.
 */
export function customerTeardownProgressSteps(input: {
  readonly kinds: readonly CustomerTeardownResourceKind[];
  readonly phase: CustomerTeardownPhase | null;
  readonly removedKinds: readonly CustomerTeardownResourceKind[];
  readonly result: 'removed' | 'recovery_required' | null;
  readonly removing: boolean;
}): CustomerTeardownProgressStep[] {
  const kinds = v.parse(customerTeardownKindsSchema, input.kinds);
  const done = input.result === 'removed';
  const sharingDone = done || (input.phase !== null && input.phase !== 'bridge_preflight' && input.phase !== 'sharing_preflight');
  const verifying = input.removing && input.phase === 'verify';
  const steps: CustomerTeardownProgressStep[] = [
    { id: 'sharing', label: 'Portal sharing check', state: sharingDone ? 'done' : input.removing ? 'active' : 'pending' },
  ];
  let activeGiven = !sharingDone;
  for (const kind of kinds) {
    const kindDone = done || input.removedKinds.includes(kind);
    let state: CustomerTeardownProgressStep['state'] = kindDone ? 'done' : 'pending';
    if (!kindDone && !activeGiven && input.removing && !verifying) { state = 'active'; activeGiven = true; }
    steps.push({ id: kind, label: KIND_LABELS[kind], state });
  }
  steps.push({ id: 'verification', label: 'Verification', state: done ? 'done' : verifying ? 'active' : 'pending' });
  return steps;
}
