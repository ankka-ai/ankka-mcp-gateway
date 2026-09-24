import { useEffect, useState } from 'react'
import { Input } from '@cloudflare/kumo'
import { GatewayApiError } from '../api'
import { useGateway } from '../GatewayContext'
import { Button } from './Button'

export function SourceAuthorization({ actionId, sourceId, sourceUrl, revision, disabled }: {
  actionId: string; sourceId: string; sourceUrl: string; revision: number; disabled: boolean
}) {
  const { api } = useGateway()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [metaAppId, setMetaAppId] = useState('')
  const meta = sourceUrl === 'https://mcp.facebook.com/ads'
  const validMetaAppId = /^[1-9][0-9]{0,31}$/u.test(metaAppId.trim())
  async function authorize() {
    setPending(true)
    setError(null)
    try {
      const result = meta
        ? await api.authorizeSource(actionId, revision, sourceId, metaAppId.trim())
        : await api.authorizeSource(actionId, revision, sourceId)
      window.location.assign(result.authorizationUrl)
    } catch (failure) {
      setError(meta && failure instanceof GatewayApiError && failure.code === 'source_oauth_unavailable'
        ? 'Meta authorization could not start. Check your app’s Ads MCP use case and callback URL, then try again.'
        : failure instanceof GatewayApiError ? failure.message : 'Authorization could not start. Try again.')
      setPending(false)
    }
  }
  return <div className="mt-3">
    {meta ? <div className="mb-4 max-w-xl space-y-3">
      <p className="text-sm leading-6 text-kumo-subtle">Meta requires your own developer app. Add the <strong>Create &amp; manage ads with ads MCP server</strong> use case, then register this callback in Facebook Login for Business:</p>
      <code className="block break-all text-xs">{window.location.origin}/__ankka/source-oauth/callback</code>
      <Input label="Meta App ID" value={metaAppId} maxLength={32} inputMode="numeric" autoComplete="off" disabled={disabled || pending} onChange={(event) => setMetaAppId(event.target.value)} />
      <p className="text-xs leading-5 text-kumo-subtle">Use the public App ID, not an app secret or access token. Your gateway requests reporting permissions only.</p>
      <a className="inline-block text-sm underline underline-offset-4" href="https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started" target="_blank" rel="noreferrer">Meta app setup guide</a>
    </div> : null}
    <Button variant="primary" className="pressable" disabled={disabled || pending || (meta && !validMetaAppId)} onClick={() => void authorize()}>
      {pending ? 'Opening authorization…' : 'Authorize connector'}
    </Button>
    {sourceId === 'source-616e6b6b616d6370' ? <p className="mt-2 text-xs leading-5 text-kumo-subtle">Sign in with your gateway identity to connect Gateway Management. Each person assigned this connector uses their own sign-in.</p> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-kumo-danger">{error}</p> : null}
  </div>
}

const RESULTS = new Map([
  ['connected', 'Connector authorized. Check its tools below, then choose which to allow.'],
  ['sync_pending', 'Connector authorized. Cloudflare is still syncing its tools. Use Check again below; if syncing does not complete, open the connector in Cloudflare.'],
  ['cancelled', 'Connector authorization was cancelled. You can try again when you are ready.'],
  ['failed', 'Connector authorization could not be completed. Start again from your connector, or use the Cloudflare link for manual setup.'],
])

export function SourceAuthorizationResult() {
  const [result] = useState(() => new URL(window.location.href).searchParams.get('source_oauth'))
  useEffect(() => {
    if (result === null) return
    const url = new URL(window.location.href)
    url.searchParams.delete('source_oauth')
    window.history.replaceState(window.history.state, '', url)
  }, [result])
  const message = result === null ? undefined : RESULTS.get(result)
  return message ? <p role="status" className="notice-banner mt-6">{message}</p> : null
}
