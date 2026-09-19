import { useState } from 'react'
import type { ManagedSource } from '../api'
import { Button } from './Button'

export function SourceRemoval({ source, pending, disabled, credentialConfigured, managedBigQuery, rollbackNote, onRemove, onRefresh }: {
  source: ManagedSource
  pending: boolean
  disabled: boolean
  credentialConfigured: boolean
  managedBigQuery: boolean
  rollbackNote: string | null
  onRemove(sourceId: string): Promise<void>
  onRefresh(): Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setRemoving(true)
    setError(null)
    try { await onRemove(source.id) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Removal could not be confirmed. Check status before continuing.') }
    finally { setRemoving(false) }
  }
  if (managedBigQuery) return <p className="mt-5 text-sm text-kumo-subtle">Individual removal of managed BigQuery bridges is not available yet. Their Worker and stored key need separate Cloudflare authorization. You can revoke access in <a className="underline" href="/team">Team</a>; full gateway removal cleans up the bridge too.</p>
  if (!credentialConfigured) return <p className="mt-5 text-sm text-kumo-subtle">Add a management token in <a className="underline" href="/settings">Settings</a> to remove this source.</p>
  return <div className="mt-5 border-t border-kumo-line pt-4">
    {confirming || pending ? <>
      <p className="text-sm font-medium text-kumo-strong">{pending ? `Continue removing ${source.label}` : `Remove “${source.label}” from your gateway?`}</p>
      <p className="mt-1 text-sm text-kumo-subtle">{pending
        ? 'Removal has started. Continue to check saved progress and finish cleaning up this source.'
        : 'Your team will lose access through this gateway. Its MCP server registration and source access policies will be deleted from Cloudflare. Your upstream service and its data stay unchanged. You can add the source again later.'}</p>
      {rollbackNote && !pending ? <p className="mt-2 text-sm text-kumo-subtle">{rollbackNote}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="destructive" disabled={disabled} loading={removing} onClick={() => void remove()}>
          {removing ? 'Removing…' : pending ? 'Continue removal' : 'Remove source'}
        </Button>
        {!pending ? <Button disabled={removing} onClick={() => { setConfirming(false); setError(null) }}>Cancel</Button> : null}
        {pending || error ? <Button disabled={removing} onClick={() => { void onRefresh().catch(() => setError('Status could not be read. Try again.')) }}>Check status</Button> : null}
      </div>
    </> : <Button variant="destructive" disabled={disabled} onClick={() => setConfirming(true)}>Remove source</Button>}
    {error ? <p role="alert" className="mt-3 text-sm text-kumo-subtle">{error}</p> : null}
  </div>
}
