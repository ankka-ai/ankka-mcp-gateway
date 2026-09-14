export interface CredentialFamilyVerdict { readonly family: string; readonly status: number; readonly outcome: string }
export interface DeploymentCredentialInventory {
  readonly schemaVersion: 1;
  readonly identity: { readonly kind: 'user_owned' | 'account_owned' | 'unknown'; readonly status: string | null; readonly expiresOn: string | null };
  readonly families: readonly CredentialFamilyVerdict[];
}
export class LifecycleCredentialError extends Error { readonly code: string; constructor(code: string) }
export function inventoryDeploymentCredential(input: {
  readonly token: string; readonly accountId: string; readonly zoneId: string;
  readonly transport?: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<DeploymentCredentialInventory>;
