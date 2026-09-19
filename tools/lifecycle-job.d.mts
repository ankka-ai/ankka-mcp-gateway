import type { BoundaryValue } from '../apps/installer/src/boundary';

export type LifecycleStage =
  | 'preflight' | 'bootstrap' | 'converge' | 'verify' | 'manage' | 'update'
  | 'remove-dependencies' | 'remove-root' | 'verify-absent';
export type LifecycleOperation = 'install' | 'manage' | 'update' | 'remove';
export type CredentialReference =
  | { readonly keychain: { readonly service: string; readonly account: string } }
  | { readonly env: string };
export interface LifecycleReleaseReference { readonly publishDirectory: string; readonly pin: string }
export interface LifecycleApproval { readonly approvedBy: string; readonly approvedAt: string; readonly targetDigest: string }
export interface LifecycleJob {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly scope: 'disposable_lifecycle';
  readonly target: {
    readonly accountId: string; readonly zoneId: string; readonly zoneName: string;
    readonly prefix: string; readonly gatewayName: string; readonly adminEmail: string;
  };
  readonly releases: { readonly a: LifecycleReleaseReference; readonly b: LifecycleReleaseReference };
  readonly source: { readonly url: string; readonly tool: string };
  readonly credentials: {
    readonly deployment: CredentialReference;
    readonly management: CredentialReference;
    readonly service?: { readonly secret: CredentialReference; readonly clientId: string; readonly tokenId: string };
  };
  readonly operations: readonly LifecycleOperation[];
  readonly runDirectory: string;
  readonly approval?: LifecycleApproval;
}
export interface ReleasePin {
  readonly schemaVersion: 1; readonly channel: 'canary' | 'stable'; readonly controlPlaneOrigin: string;
  readonly release: string; readonly keyId: string; readonly publicKey: string; readonly artifactSha256: string;
}
export class LifecycleJobError extends Error { readonly code: string; readonly detail: string | null; constructor(code: string, detail?: string | null) }
export const LIFECYCLE_STAGES: readonly LifecycleStage[];
export const LIFECYCLE_OPERATIONS: readonly LifecycleOperation[];
export function canonicalJson(value: BoundaryValue): string;
export function outsideRepository(path: string, code?: string): Promise<string>;
export function lifecycleHostnames(job: LifecycleJob): { readonly management: string; readonly portal: string };
export function stagesForJob(job: LifecycleJob, options?: { readonly stage?: LifecycleStage; readonly from?: LifecycleStage }): readonly LifecycleStage[];
export function credentialReferenceLabel(reference: CredentialReference): string;
export function readReleasePin(path: string): Promise<ReleasePin>;
export function approvalDigest(job: LifecycleJob): Promise<string>;
export function readLifecycleJob(path: string): Promise<LifecycleJob>;
export function assertLifecycleJobApproved(job: LifecycleJob): Promise<string>;
export function writeLifecycleJobApproval(path: string, job: LifecycleJob, approval: LifecycleApproval): Promise<LifecycleJob>;
