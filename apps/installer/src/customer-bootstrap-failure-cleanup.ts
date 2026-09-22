import {
  customerStage2MutationsUnsent,
  type CustomerStage2Journal,
} from './customer-stage2-journal';

/**
 * Whether a terminal setup failure may remove the bootstrap Worker and
 * namespace. A missing journal is a successful read of "nothing was sent".
 * A failed read must not be passed here: the caller treats that as recovery.
 */
export function classifyCustomerBootstrapFailure(input: {
  readonly journal: CustomerStage2Journal | null;
  readonly workerId: string | null;
  readonly namespaceId: string | null;
  readonly versionId: string | null;
}): 'bootstrap_only' | 'recovery_required' {
  if (input.workerId === null || input.namespaceId === null) return 'recovery_required';
  if (input.journal === null) return 'bootstrap_only';
  if (!customerStage2MutationsUnsent(input.journal)) return 'recovery_required';
  if (input.journal.identity.workerId !== input.workerId ||
      input.journal.identity.namespaceId !== input.namespaceId) return 'recovery_required';
  if (input.versionId !== null && input.journal.identity.bootstrapVersionId !== input.versionId) {
    return 'recovery_required';
  }
  return 'bootstrap_only';
}
