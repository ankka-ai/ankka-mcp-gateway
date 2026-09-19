import { useEffect, useState } from 'react'
import { GatewayApiError } from '../api'
import { useGateway } from '../GatewayContext'
import { Button } from './Button'

export function SourceAuthorization({ actionId, sourceId, revision, disabled }: {
  actionId: string; sourceId: string; revision: number; disabled: boolean
}) {
  const { api } = useGateway()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function authorize() {
    setPending(true)
    setError(null)
    try {
      const result = await api.authorizeSource(actionId, revision, sourceId)
      window.location.assign(result.authorizationUrl)
    } catch (failure) {
      setError(failure instanceof GatewayApiError ? failure.message : 'Authorization could not start. Try again.')
      setPending(false)
    }
  }
  return <div className="mt-3">
    <Button variant="primary" className="pressable" disabled={disabled || pending} onClick={() => void authorize()}>
      {pending ? 'Opening authorization…' : 'Authorize source'}
    </Button>
    <p className="mt-2 text-xs leading-5 text-kumo-subtle">Sign in with your provider to connect this source for your team. Credentials stay in your Cloudflare account. Providers that need manual OAuth setup can be connected using the Cloudflare link.</p>
    {error ? <p role="alert" className="mt-2 text-sm text-kumo-danger">{error}</p> : null}
  </div>
}

const RESULTS = new Map([
  ['connected', 'Source authorized. Check its tools below, then choose which to allow.'],
  ['sync_pending', 'Source authorized. Cloudflare is still syncing its tools. Use Check again below; if syncing does not complete, open the source in Cloudflare.'],
  ['cancelled', 'Source authorization was cancelled. You can try again when you are ready.'],
  ['failed', 'Source authorization could not be completed. Start again from your source, or use the Cloudflare link for manual setup.'],
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
