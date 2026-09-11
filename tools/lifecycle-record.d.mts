import type { BoundaryValue } from '../apps/installer/src/boundary';
import type { RunLock } from './lifecycle-lock.mjs';

export type LifecycleStageStatus = 'passed' | 'verified' | 'failed' | 'blocked' | 'interrupted' | 'not_run';
export interface LifecycleStageResult { readonly status: LifecycleStageStatus; readonly code?: string | null; readonly detail?: BoundaryValue }
export interface LifecycleRecordEvent { readonly stage: string; readonly status: string; readonly at: string }
export interface LifecycleTraceEntry { readonly method: string; readonly family: string; readonly status: number | string; readonly ms: number }
export interface LifecycleRecordState {
  readonly schemaVersion: 1; readonly scope: 'external_runner'; readonly jobId: string; readonly targetDigest: string;
  readonly qualified: false;
  readonly events: readonly LifecycleRecordEvent[];
  readonly stages: { readonly [stage: string]: LifecycleStageResult & { readonly at: string } };
  readonly storage: { readonly [namespace: string]: { readonly [key: string]: BoundaryValue } };
  readonly trace: readonly LifecycleTraceEntry[];
  readonly install: { readonly [key: string]: BoundaryValue };
  readonly inventory: BoundaryValue | null;
  readonly removal: { readonly [key: string]: BoundaryValue };
}
export interface DurableStorageStandIn {
  get(key: string): Promise<BoundaryValue | undefined>;
  list(options?: { readonly prefix?: string; readonly limit?: number; readonly startAfter?: string }): Promise<Map<string, BoundaryValue>>;
  put(key: string, value: BoundaryValue): Promise<void>;
  put(entries: { readonly [key: string]: BoundaryValue }): Promise<void>;
  snapshot(): { readonly [key: string]: BoundaryValue };
}
export interface LifecycleRecord {
  readonly directory: string;
  readonly state: LifecycleRecordState;
  readonly lock: RunLock | null;
  event(stage: string, status: string, detail?: { readonly [key: string]: BoundaryValue }): Promise<void>;
  stage(stage: string, result: LifecycleStageResult): Promise<void>;
  set(section: 'install' | 'removal', key: string, value: BoundaryValue): Promise<void>;
  setInventory(value: BoundaryValue): Promise<void>;
  storage(namespace: string): DurableStorageStandIn;
  trace(entry: LifecycleTraceEntry): Promise<void>;
  cancelRequested(): Promise<boolean>;
  close(): Promise<void>;
}
export class LifecycleRecordError extends Error { readonly code: string; constructor(code: string) }
export function privateRunDirectory(directory: string): Promise<string>;
export function openLifecycleRecord(directory: string, options?: {
  readonly create?: boolean; readonly holdLock?: boolean; readonly jobId?: string; readonly targetDigest?: string;
}): Promise<LifecycleRecord>;
export function summarizeLifecycleRecord(state: LifecycleRecordState): BoundaryValue;
export function requestLifecycleCancel(directory: string): Promise<void>;
export function readInstallationSecrets(directory: string): Promise<BoundaryValue | null>;
export function writeInstallationSecrets(directory: string, value: BoundaryValue): Promise<void>;
