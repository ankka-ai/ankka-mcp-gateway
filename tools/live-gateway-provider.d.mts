import type { BoundaryValue } from '../apps/installer/src/boundary';

export interface LiveGatewayProvision { readonly installId: string; readonly workerName: string; readonly bootstrapOrigin: string }
export interface LiveGatewayInventory {
  readonly schemaVersion: 1; readonly accountId: string; readonly zoneId: string;
  readonly provision: LiveGatewayProvision;
  readonly resources: readonly { readonly path: string; readonly dependency: boolean }[];
}
export interface LiveGatewayProviderConfig {
  readonly accountId: string; readonly zoneId: string;
  readonly basics: { readonly zoneName: string; readonly managementHostname: string; readonly portalHostname: string };
  readonly source?: { readonly url: string };
  /** Present when the deployment opted into a service identity: the inventory then expects its Service Auth policy. */
  readonly serviceAccess?: { readonly tokenId: string };
}
export interface LiveGatewayProvider {
  metrics(provision: LiveGatewayProvision): Promise<BoundaryValue | null>;
  assertFresh(): Promise<void>;
  assertWorker(provision: LiveGatewayProvision): Promise<void>;
  capture(provision: LiveGatewayProvision): Promise<LiveGatewayInventory>;
  assertDependenciesAbsent(inventory: LiveGatewayInventory): Promise<void>;
  assertAllAbsent(inventory: LiveGatewayInventory): Promise<void>;
}
export function createLiveGatewayProvider(input: {
  readonly config: LiveGatewayProviderConfig; readonly token: string;
  readonly transport?: (input: string, init: RequestInit) => Promise<Response>;
}): LiveGatewayProvider;
