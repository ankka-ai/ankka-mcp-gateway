/**
 * Cloudflare's template link for the gateway's account API token, and the name it pre-fills. The dashboard offers the
 * link before the approval starts, so the short-lived approval is not spent while the token is still being created.
 *
 * The same two permissions and the same name as `customerManagementCredentialTemplateLink` in the installer, which the
 * setup page and the paste page use; `apps/installer/test/management-token-link.test.ts` holds the two builders equal.
 */
const PERMISSION_GROUP_KEYS = Object.freeze([
  Object.freeze({ key: 'access', type: 'edit' }),
  Object.freeze({ key: 'mcp_portals', type: 'edit' }),
] as const)

export function managementTokenName(managementHostname: string): string {
  return `Ankka gateway ${managementHostname}`
}

export function managementTokenCreateLink(managementHostname: string): string {
  const permissions = encodeURIComponent(JSON.stringify(PERMISSION_GROUP_KEYS))
  const name = encodeURIComponent(managementTokenName(managementHostname))
  return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${permissions}&name=${name}`
}
