import { useEffect, useState } from 'react'
import { Button } from './Button'
import type { SourceConnection } from '../api'

export type ConnectionCheck = SourceConnection | { state: 'waiting' | 'checking'; checkedAt: null; reason: null }

// The gateway's own limit, so a connector shows Checking… only once its request is sent.
const CHECK_CONCURRENCY = 8
// Just above the gateway's 20-second deadline for one check.
export const CONNECTION_CHECK_TIMEOUT_MS = 25_000

const pending = (state: 'waiting' | 'checking'): ConnectionCheck => ({ state, checkedAt: null, reason: null })

export function useSourceConnections(sourceIds: string, check?: (sourceId: string, signal: AbortSignal) => Promise<SourceConnection>, revision = 0) {
  const [refresh, setRefresh] = useState(0)
  const [results, setResults] = useState<Record<string, ConnectionCheck>>({})
  useEffect(() => {
    if (!check) { setResults({}); return }
    const checkConnection = check
    const ids = sourceIds ? sourceIds.split(',') : []
    const stopped = new AbortController()
    setResults(Object.fromEntries(ids.map(id => [id, pending('waiting')])))
    const show = (sourceId: string, result: ConnectionCheck) => {
      if (!stopped.signal.aborted) setResults(current => ({ ...current, [sourceId]: result }))
    }
    // Each check has its own deadline, even if the request ignores its signal.
    async function checkOne(sourceId: string): Promise<SourceConnection> {
      const controller = new AbortController()
      const abort = () => controller.abort()
      const timer = setTimeout(abort, CONNECTION_CHECK_TIMEOUT_MS)
      stopped.signal.addEventListener('abort', abort)
      try {
        const result = await Promise.race([checkConnection(sourceId, controller.signal), new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('connection_check_timeout')))
        })])
        if (result.sourceId !== sourceId) throw new Error('connection_check_mismatch')
        return result
      } catch {
        // A failed or timed-out check never keeps an earlier result.
        return { schemaVersion: 1, sourceId, state: 'unknown', reason: 'check_failed', checkedAt: null }
      } finally {
        clearTimeout(timer)
        stopped.signal.removeEventListener('abort', abort)
      }
    }
    // Each result appears as it arrives; a slow connector holds up only its own.
    async function run() {
      for (let sourceId = ids.shift(); sourceId && !stopped.signal.aborted; sourceId = ids.shift()) {
        show(sourceId, pending('checking'))
        show(sourceId, await checkOne(sourceId))
      }
    }
    void Promise.all(Array.from({ length: CHECK_CONCURRENCY }, run))
    return () => stopped.abort()
  }, [sourceIds, check, revision, refresh])
  const checking = Object.values(results).some(result => result.state === 'waiting' || result.state === 'checking')
  return { results, recheck: () => setRefresh(value => value + 1), checking }
}

export function connectionLabel(result?: ConnectionCheck) {
  switch (result?.state) {
    case 'waiting': return 'Waiting'
    case 'checking': return 'Checking…'
    case 'connected': return 'Connected'
    case 'authorization_required': return 'Reconnect required'
    case 'forbidden': return 'Access denied'
    case 'unavailable': return 'Connection failed'
    case 'user_managed': return 'Individual sign-in'
    default: return result?.reason === 'lifecycle_pending' ? 'Check paused' : 'Not verified'
  }
}

export function ConnectionStatus({ result, label, onReconnect, disabled }: { result: ConnectionCheck | undefined; label: string; onReconnect?: (() => void) | undefined; disabled?: boolean }) {
  const color = result?.state === 'connected' ? 'bg-success/10 text-success-strong'
    : ['authorization_required', 'forbidden', 'unavailable'].includes(result?.state ?? '') ? 'bg-warning/10 text-warning-strong'
      : 'bg-kumo-tint text-kumo-subtle'
  return <div className="flex flex-wrap items-center gap-2">
    <span role="status" className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${color}`}>{connectionLabel(result)}</span>
    {result?.state === 'authorization_required' && onReconnect ? <Button variant="primary" disabled={disabled} onClick={onReconnect} aria-label={`Reconnect ${label}`}>Reconnect</Button> : null}
    {result?.state === 'authorization_required' && result.reconnectUrl ? <a
      className="text-xs text-kumo-subtle underline underline-offset-4"
      href={result.reconnectUrl} target="_blank" rel="noopener noreferrer"
      aria-label={`Open ${label} in Cloudflare (opens a new tab)`}
    >Open in Cloudflare</a> : null}
  </div>
}

export function ConnectionDetails({ result }: { result: ConnectionCheck | undefined }) {
  const message = result?.state === 'connected' ? 'Cloudflare successfully connected to this server. Individual tool calls can still require additional permissions.'
    : result?.state === 'authorization_required' ? result.reconnectUrl
      ? 'Choose Reconnect to sign in again. If authorization does not work here, use Open in Cloudflare for manual setup, then return and check the connection. Keep Require user auth off for this shared connection.'
      : 'The connector needs authorization. Reconnect it in Cloudflare → MCP Portals → MCP servers, then check again.'
      : result?.state === 'forbidden' ? 'The server denied access. Review the connected account’s permissions in Cloudflare and the provider.'
        : result?.state === 'unavailable' ? 'Cloudflare could not connect to this server. Check the provider and try again.'
          : result?.state === 'user_managed' ? 'Each user connects with their own login in the MCP client. This page cannot verify their individual sessions.'
            : result?.state === 'checking' ? 'Testing the connection through Cloudflare…'
              : result?.state === 'waiting' ? 'Waiting for other connection checks to finish before testing this one.'
                : result?.reason === 'management_credential_required' ? 'Configure or renew your gateway’s management token in Settings to check connections.'
                  : result?.reason === 'configuration_changed' ? 'The Cloudflare configuration differs from this gateway’s saved configuration. The connection was not tested.'
                    : result?.reason === 'lifecycle_pending' ? 'Connection checking is paused while a gateway change is unfinished. Finish or resolve that change, then check again.'
                      : result?.reason === 'check_pending' ? 'Cloudflare has not finished checking this connection. Check again shortly.'
                        : 'The connection could not be verified. Check again to get its current status.'
  return <div className="mt-3 text-xs leading-5 text-kumo-subtle">
    <p>{message}</p>
    {result?.checkedAt ? <p>Checked <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString()}</time></p> : null}
  </div>
}
