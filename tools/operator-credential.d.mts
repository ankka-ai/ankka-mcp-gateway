import type { CredentialReference } from './lifecycle-job.mjs';
export class OperatorCredentialError extends Error { readonly code: string; readonly detail: string | null; constructor(code: string, detail?: string | null) }
export function resolveOperatorCredential(reference: CredentialReference): Promise<string>;
