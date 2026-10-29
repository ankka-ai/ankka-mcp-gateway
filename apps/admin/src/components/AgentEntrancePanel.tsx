import { useId, useState } from 'react'
import { GatewayApiError, type AgentEntrance } from '../api'
import { Button } from './Button'
import { StatusPill } from './StatusPill'

interface AgentEntrancePanelProps {
  entrance: AgentEntrance | null
  disabled: boolean
  onTurnOn(hostname: string): Promise<AgentEntrance>
  onTurnOff(): Promise<AgentEntrance>
}

/**
 * The agent entrance: one MCP address, on its own hostname outside Access, for agents that can send only a
 * bearer token. It is the only thing that hostname serves.
 */
export function AgentEntrancePanel({ entrance, disabled, onTurnOn, onTurnOff }: AgentEntrancePanelProps) {
  const [hostname, setHostname] = useState('')
  const [current, setCurrent] = useState<AgentEntrance | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const hostnameId = useId()
  const shown = current ?? entrance
  if (!shown) return null
  const run = async (step: () => Promise<AgentEntrance>) => {
    setWorking(true)
    setError(null)
    try { setCurrent(await step()) }
    catch (cause) { setError(cause instanceof GatewayApiError ? cause.message : 'The agent entrance could not be changed. Try again.') }
    finally { setWorking(false) }
  }
  return <section aria-labelledby={`${hostnameId}-title`} className="mt-4 rounded-xl border border-kumo-line p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 id={`${hostnameId}-title`} className="text-sm font-semibold text-kumo-strong">Agent entrance</h3>
      <StatusPill tone={shown.status === 'on' ? 'ready' : shown.status === 'off' ? 'waiting' : 'attention'}>{shown.status === 'on' ? 'On' : shown.status === 'off' ? 'Off' : 'Unfinished'}</StatusPill>
    </div>
    {shown.status === 'on' && shown.url ? <>
      <p className="mt-2 text-xs leading-5 text-kumo-subtle">Agents that can send only a bearer token connect here. Their bearer is <code>ankka_agent_v1_</code> followed by their service token as base64url of <code>client-id:client-secret</code>; the agent access guide shows how to build it.</p>
      <p className="mt-2 break-all font-mono text-sm text-kumo-strong">{shown.url}</p>
      <Button type="button" variant="secondary" className="mt-3" loading={working} disabled={disabled || working} onClick={() => void run(onTurnOff)}>Turn off</Button>
    </> : shown.status === 'off' ? <>
      <p className="mt-2 text-xs leading-5 text-kumo-subtle">For agents that cannot send Cloudflare’s service-token headers. Your gateway attaches one hostname under your zone to its own Worker; that hostname serves only this MCP address. Agents that send the headers themselves can use the Portal directly.</p>
      <label htmlFor={hostnameId} className="mt-3 block text-sm font-medium">Hostname</label>
      <div className="mt-2 flex flex-wrap gap-2">
        <input id={hostnameId} value={hostname} placeholder={shown.suggestedHostname ?? 'agents.example.com'} autoComplete="off" spellCheck={false} maxLength={253}
          className="text-input min-w-0 flex-1 font-mono" onChange={(event) => { setHostname(event.target.value); setError(null) }} />
        <Button type="button" variant="secondary" loading={working} disabled={disabled || working}
          onClick={() => void run(() => onTurnOn((hostname.trim() || shown.suggestedHostname || '').toLowerCase()))}>Turn on</Button>
      </div>
    </> : <>
      <p className="mt-2 text-xs leading-5 text-kumo-subtle">A change to {shown.hostname} did not finish. {shown.status === 'attaching' ? 'Turn it on again to finish attaching it, or turn it off.' : 'Turn it off again to finish removing it.'}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {shown.status === 'attaching' && shown.hostname ? <Button type="button" variant="secondary" loading={working} disabled={disabled || working} onClick={() => void run(() => onTurnOn(shown.hostname ?? ''))}>Turn on</Button> : null}
        <Button type="button" variant="secondary" loading={working} disabled={disabled || working} onClick={() => void run(onTurnOff)}>Turn off</Button>
      </div>
    </>}
    {error ? <p role="alert" className="field-error">{error}</p> : null}
  </section>
}
