import { useEffect, useState } from 'react'
import type { SourceConnection } from '../api'

export type ConnectionCheck = SourceConnection | { state: 'checking'; checkedAt: null; reason: null }

export function useSourceConnections(sourceIds: string, check?: (sourceId: string) => Promise<SourceConnection>, revision = 0) {
  const [refresh, setRefresh] = useState(0)
  const [results, setResults] = useState<Record<string, ConnectionCheck>>({})
  useEffect(() => {
    let cancelled = false
    const ids = sourceIds ? sourceIds.split(',') : []
    setResults(Object.fromEntries(ids.map(id => [id, { state: 'checking', checkedAt: null, reason: null }])))
    if (!check) { setResults({}); return }
    const checkConnection = check
    // Bound browser concurrency; each result appears as it arrives.
    async function run() {
      while (!cancelled) {
        const sourceId = ids.shift()
        if (!sourceId) return
        let result: SourceConnection
        try {
          result = await checkConnection(sourceId)
          if (result.sourceId !== sourceId) throw new Error('connection_check_mismatch')
        } catch {
          result = { schemaVersion: 1, sourceId, state: 'unknown', reason: 'check_failed', checkedAt: null }
        }
        if (!cancelled) setResults(current => ({ ...current, [sourceId]: result }))
      }
    }
    void Promise.all([run(), run(), run()])
    return () => { cancelled = true }
  }, [sourceIds, check, revision, refresh])
  return { results, recheck: () => setRefresh(value => value + 1), checking: Object.values(results).some(result => result.state === 'checking') }
}

export function connectionLabel(result?: ConnectionCheck) {
  switch (result?.state) {
    case 'checking': return 'Checking…'
    case 'connected': return 'Connected'
    case 'authorization_required': return 'Reconnect required'
    case 'forbidden': return 'Access denied'
    case 'unavailable': return 'Connection failed'
    case 'user_managed': return 'Individual sign-in'
    default: return 'Not verified'
  }
}

export function ConnectionStatus({ result, label }: { result: ConnectionCheck | undefined; label: string }) {
  const color = result?.state === 'connected' ? 'bg-success/10 text-success-strong'
    : ['authorization_required', 'forbidden', 'unavailable'].includes(result?.state ?? '') ? 'bg-warning/10 text-warning-strong'
      : 'bg-kumo-tint text-kumo-subtle'
  return <div className="flex flex-wrap items-center gap-2">
    <span role="status" className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${color}`}>{connectionLabel(result)}</span>
    {result?.state === 'authorization_required' && result.reconnectUrl ? <a
      className="gateway-button pressable inline-flex min-h-9 items-center rounded-md px-3 py-1.5 text-xs font-medium"
      data-gateway-variant="secondary"
      href={result.reconnectUrl} target="_blank" rel="noopener noreferrer"
      aria-label={`Reconnect ${label} in Cloudflare (opens a new tab)`}
    >Reconnect in Cloudflare</a> : null}
  </div>
}

export function ConnectionDetails({ result }: { result: ConnectionCheck | undefined }) {
  const message = result?.state === 'connected' ? 'Cloudflare successfully connected to this server. Individual tool calls can still require additional permissions.'
    : result?.state === 'authorization_required' ? result.reconnectUrl
      ? 'Reconnect in Cloudflare opens this connector’s server page in a new tab. Complete its authorization there, then return here and select Check connections. Keep Require user auth off for this shared connection.'
      : 'The connector needs authorization. Reconnect it in Cloudflare → MCP Portals → MCP servers, then check again.'
      : result?.state === 'forbidden' ? 'The server denied access. Review the connected account’s permissions in Cloudflare and the provider.'
        : result?.state === 'unavailable' ? 'Cloudflare could not connect to this server. Check the provider and try again.'
          : result?.state === 'user_managed' ? 'Each user connects with their own login in the MCP client. This page cannot verify their individual sessions.'
            : result?.state === 'checking' ? 'Testing the connection through Cloudflare…'
              : result?.reason === 'management_credential_required' ? 'Configure or renew your gateway’s management token in Settings to check connections.'
                : result?.reason === 'configuration_changed' ? 'The Cloudflare configuration differs from this gateway’s saved configuration. The connection was not tested.'
                  : result?.reason === 'lifecycle_pending' ? 'Finish the current gateway change, then check the connection again.'
                    : result?.reason === 'check_pending' ? 'Cloudflare has not finished checking this connection. Check again shortly.'
                      : 'The connection could not be verified. Check again to get its current status.'
  return <div className="mt-3 text-xs leading-5 text-kumo-subtle">
    <p>{message}</p>
    {result?.checkedAt ? <p>Checked <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString()}</time></p> : null}
  </div>
}
