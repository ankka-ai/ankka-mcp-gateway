import { useState } from 'react'
import { Button } from './Button'
import { GatewayApiError, type CredentialTarget, type ManagedSource, type ServiceTokenSwitch, type ServiceTokenSwitchOperation } from '../api'

/**
 * The one write a service-token connector needs from you: its Access service token, written straight into its
 * Cloudflare server record from your own shell. The gateway shows where; it never asks for, receives or stores the token.
 */
export function serviceTokenCommand(target: CredentialTarget): string {
  return `jq -n '{auth_credentials: ({headers: {"cf-access-client-id": env.CF_ACCESS_CLIENT_ID, "cf-access-client-secret": env.CF_ACCESS_CLIENT_SECRET}} | tojson)}' | curl -sS -X PUT -H @<(printf 'Authorization: Bearer %s\\nContent-Type: application/json\\n' "$CLOUDFLARE_API_TOKEN") "https://api.cloudflare.com/client/v4/accounts/${target.accountId}/access/ai-controls/mcp/servers/${target.serverId}" --data @- | jq '{success, status: .result.status, auth_type: .result.auth_type}'`
}

export function ServiceTokenInstructions({ target }: { target: CredentialTarget }) {
  return <div className="mt-3 max-w-[80ch] text-xs leading-5 text-kumo-subtle" aria-label="Write the service token">
    <ol className="list-decimal space-y-1.5 pl-5">
      <li>In Zero Trust, create a service token for this connector under <strong>Access controls → Service credentials</strong>. Store its client ID and secret in your password manager; Cloudflare shows the secret once.</li>
      <li>On the self-hosted Access application in front of this endpoint, add a policy with the action <strong>Service Auth</strong> that includes exactly that token. Add it to that application only.</li>
      <li>From your own shell, with <code>CF_ACCESS_CLIENT_ID</code>, <code>CF_ACCESS_CLIENT_SECRET</code> and your own <code>CLOUDFLARE_API_TOKEN</code> (with MCP Portals Write) set, write the token into server record <code className="break-all">{target.serverId}</code>. The request sends nothing but the token; your gateway never sees it.</li>
    </ol>
    <code className="mt-2 block select-all whitespace-pre-wrap break-all rounded-md bg-kumo-tint/70 p-3 text-kumo-default">{serviceTokenCommand(target)}</code>
    <p className="mt-2">Cloudflare never returns the token once written. Your gateway checks that the record still has its own settings and that Cloudflare reports it Ready with its tools.</p>
  </div>
}

const SWITCH_STATUS = {
  create_armed: 'Creating the new server record.',
  credential: 'The new server record is waiting for its service token. Your team keeps using the shared sign-in meanwhile.',
  moving: 'Moving the Portal and Team access to the new server record.',
  returning: 'Returning the Portal and Team access to the sign-in record.',
  retiring: 'Deleting the server record this connector no longer uses.',
} satisfies Record<ServiceTokenSwitch['phase'], string>

/**
 * Moves an installed connector that uses your shared sign-in to an Access service token. Allowed tools and Team
 * assignments stay; the connector's tool names in your Portal get the new server record's prefix once.
 */
export function ServiceTokenSwitchPanel({ source, tokenSwitch, disabled, onSwitch }: {
  source: ManagedSource
  tokenSwitch: ServiceTokenSwitch | null
  disabled: boolean
  onSwitch(sourceId: string, operation: ServiceTokenSwitchOperation): Promise<void>
}) {
  const [pending, setPending] = useState<ServiceTokenSwitchOperation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const own = tokenSwitch?.sourceId === source.id ? tokenSwitch : null
  async function run(operation: ServiceTokenSwitchOperation) {
    setPending(operation)
    setError(null)
    try { await onSwitch(source.id, operation) }
    catch (failure) { setError(failure instanceof GatewayApiError ? failure.message : 'The switch could not be confirmed. Continue to resume from the saved progress.') }
    finally { setPending(null) }
  }
  const busy = disabled || pending !== null
  return <section className="mt-4 border-t border-kumo-line pt-4" aria-label={`Service token for ${source.label}`}>
    <h3 className="text-sm font-medium text-kumo-default">Service token</h3>
    {own ? <>
      <p role="status" className="mt-1 text-sm leading-6 text-kumo-subtle">{SWITCH_STATUS[own.phase]}</p>
      {own.phase === 'credential' ? <ServiceTokenInstructions target={own.credentialTarget} /> : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" className="pressable" disabled={busy} loading={pending === 'continue'} onClick={() => void run('continue')}>Continue</Button>
        {own.canRollback ? <Button variant="secondary" className="pressable" disabled={busy} loading={pending === 'rollback'} onClick={() => void run('rollback')}>
          {own.phase === 'credential' || own.phase === 'create_armed' ? 'Cancel switch' : 'Roll back'}</Button> : null}
      </div>
    </> : <>
      <p className="mt-1 max-w-[80ch] text-sm leading-6 text-kumo-subtle">If this endpoint is behind a self-hosted Cloudflare Access application in your account, it can use an Access service token instead of a shared sign-in that expires. Allowed tools and Team assignments stay the same. Its tool names in your Portal change once, because they start with the new server record’s ID.</p>
      <Button variant="secondary" className="pressable mt-2" disabled={busy || tokenSwitch !== null} loading={pending === 'start'} onClick={() => void run('start')}>Switch to service token</Button>
    </>}
    {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
  </section>
}
