import type { BoundaryValue } from '../apps/installer/src/boundary';

export interface LiveManagementRequestOptions { readonly method?: 'GET' | 'POST' | 'PUT'; readonly body?: BoundaryValue }
export type LiveManagementRequest = (path: string, options?: LiveManagementRequestOptions) => Promise<BoundaryValue>;
export type LiveManagementCheckpoint = (event: { readonly stage: string; readonly status: string; readonly sourceId?: string; readonly actionId?: string }) => Promise<void>;
export class LiveManagementQualificationError extends Error { readonly code: string; constructor(code: string) }
export function qualifyLiveGatewayManagement(input: {
  readonly request: LiveManagementRequest;
  readonly source: { readonly url: string; readonly tool: string };
  readonly checkpoint: LiveManagementCheckpoint;
  /** Sleeps until a stopped action's consent window has elapsed; without it such an action stops the exercise. */
  readonly wait?: ((milliseconds: number) => Promise<void>) | null;
}): Promise<{ readonly sourceId: string; readonly sourceActionId: string; readonly baselineMembers: readonly BoundaryValue[] }>;
