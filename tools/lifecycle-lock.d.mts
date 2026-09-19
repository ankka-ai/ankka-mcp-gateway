export interface RunLockIdentity { readonly pid: number; readonly startedAt: number; readonly host: string }
export interface RunLockState {
  readonly schemaVersion: 1; readonly token: string; readonly acquiredAt: number; readonly owner: RunLockIdentity;
  readonly child: (RunLockIdentity & { readonly stage: string }) | null;
}
export interface RunLock {
  readonly directory: string;
  assertOwner(): Promise<RunLockState>;
  clearChild(): Promise<void>;
  release(): Promise<boolean>;
}
export class LifecycleLockError extends Error { readonly code: string; readonly detail: string | null; constructor(code: string, detail?: string | null) }
export function processIdentity(): RunLockIdentity;
export function processAlive(identity: RunLockIdentity): Promise<boolean>;
export function acquireRunLock(directory: string): Promise<RunLock>;
export function registerRunLockChild(directory: string, stage: string): Promise<void>;
