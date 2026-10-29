import { Checkbox } from './Checkbox'
import { Dialog } from '@cloudflare/kumo/primitives/dialog'
import { X } from '@phosphor-icons/react'
import { type FormEvent, useId, useRef, useState } from 'react'
import type { AgentGrant, Team, TeamGrant } from '../api'
import { Button } from './Button'

const CLIENT_ID = /^[a-f0-9]{32}\.access$/u
const TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const CHOOSE = 'choose'

export function newAgentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `agent-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Why an installed connector cannot take an agent, in the words the connector list uses. */
export function agentAccessNote(source: Team['sources'][number]): string | null {
  if (source.agentAccess === 'management') return 'Gateway Management is never available to agents.'
  if (source.agentAccess === 'individual_sign_in') return 'Individual sign-in: agents can use only connectors your Portal signs in to itself.'
  return null
}

interface AgentDialogProps {
  agent: AgentGrant | null
  agents: AgentGrant[]
  sources: Team['sources']
  teams: TeamGrant[]
  disabled: boolean
  onSave(agent: AgentGrant): void
}

export function AgentDialog({ agent, agents, sources, teams, disabled, onSave }: AgentDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(agent?.name ?? '')
  const [clientId, setClientId] = useState(agent?.clientId ?? '')
  const [tokenId, setTokenId] = useState(agent?.tokenId ?? '')
  const [choice, setChoice] = useState(agent?.teamId ?? CHOOSE)
  const [sourceIds, setSourceIds] = useState<string[]>(agent?.sourceIds ?? [])
  const [error, setError] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const clientIdId = useId()
  const tokenIdId = useId()
  const sourcesId = useId()
  const errorId = useId()
  const installed = sources.filter((source) => source.status === 'installed')
  const followed = teams.find((team) => team.id === choice)

  const reset = (nextOpen: boolean) => {
    setOpen(nextOpen)
    setName(agent?.name ?? '')
    setClientId(agent?.clientId ?? '')
    setTokenId(agent?.tokenId ?? '')
    setChoice(agent?.teamId ?? CHOOSE)
    setSourceIds(agent?.sourceIds ?? [])
    setError(null)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    const trimmed = name.trim()
    const client = clientId.trim().toLowerCase()
    const token = tokenId.trim().toLowerCase()
    if (trimmed.length < 1 || trimmed.length > 80) return setError('Enter an agent name of 1 to 80 characters.')
    if (!CLIENT_ID.test(client)) return setError('Enter the service token’s Client ID: 32 hexadecimal characters followed by .access.')
    if (!TOKEN_ID.test(token)) return setError('Enter the service token’s ID from Zero Trust, not its Client ID or secret.')
    const others = agents.filter((other) => other.id !== agent?.id)
    if (others.some((other) => other.clientId === client || other.tokenId === token)) return setError('Another agent already uses this service token.')
    // A new agent starts allowed; the Team page switches it off and on.
    const next: AgentGrant = { id: agent?.id ?? newAgentId(), name: trimmed, clientId: client, tokenId: token, enabled: agent?.enabled ?? true }
    if (choice === CHOOSE) next.sourceIds = [...new Set(sourceIds)].filter((id) => installed.some((source) => source.id === id && source.agentAccess === 'available')).sort()
    else next.teamId = choice
    onSave(next)
    setOpen(false)
  }

  return <Dialog.Root open={open} onOpenChange={reset}>
    <Dialog.Trigger disabled={disabled} render={<Button variant="secondary" />}>{agent ? 'Edit' : 'Add agent'}</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/65" />
      <Dialog.Popup initialFocus={nameInput} className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-overlay text-kumo-default shadow-xl">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <header className="shrink-0 border-b border-kumo-line p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <Dialog.Title className="text-lg font-semibold text-kumo-strong">{agent ? 'Edit agent' : 'Add agent'}</Dialog.Title>
              <Dialog.Close render={<Button variant="ghost" aria-label="Close agent editor" />}><X size={20} aria-hidden="true" /></Dialog.Close>
            </div>
            <Dialog.Description className="mt-2 text-sm leading-6 text-kumo-subtle">An agent connects with its own Cloudflare Access service token. Create the token in Zero Trust and enter its Client ID and token ID. Your gateway never asks for or stores the secret.</Dialog.Description>
          </header>
          <div className="overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
            <label htmlFor={nameId} className="block text-sm font-medium">Name</label>
            <input ref={nameInput} id={nameId} value={name} maxLength={80} required className="text-input mt-2 w-full" onChange={(event) => { setName(event.target.value); setError(null) }} />
            <label htmlFor={clientIdId} className="mt-5 block text-sm font-medium">Client ID</label>
            <input id={clientIdId} value={clientId} autoComplete="off" spellCheck={false} maxLength={39} placeholder="0123456789abcdef0123456789abcdef.access" className="text-input mt-2 w-full font-mono" aria-describedby={error ? errorId : undefined} onChange={(event) => { setClientId(event.target.value); setError(null) }} />
            <label htmlFor={tokenIdId} className="mt-5 block text-sm font-medium">Token ID</label>
            <input id={tokenIdId} value={tokenId} autoComplete="off" spellCheck={false} maxLength={36} placeholder="00000000-0000-0000-0000-000000000000" className="text-input mt-2 w-full font-mono" aria-describedby={error ? errorId : undefined} onChange={(event) => { setTokenId(event.target.value); setError(null) }} />
            <p className="mt-2 text-xs leading-5 text-kumo-subtle">The token ID is the service token’s own ID in Cloudflare, not its Client ID. The agent access guide shows where to find both.</p>
            <label htmlFor={sourcesId} className="mt-5 block text-sm font-medium">Connectors</label>
            <select id={sourcesId} value={choice} disabled={disabled} className="text-input mt-2 w-full" onChange={(event) => { setChoice(event.target.value); setError(null) }}>
              <option value={CHOOSE}>Choose connectors</option>
              {teams.map((team) => <option key={team.id} value={team.id}>Follow {team.name}</option>)}
            </select>
            {followed ? <p className="mt-2 text-xs leading-5 text-kumo-subtle">This agent gets the connectors {followed.name} has when you save, except those it cannot use. Saving Team again applies later changes to that team.</p> : null}
            {choice === CHOOSE ? <fieldset className="mt-3" aria-label="Agent connectors">
              {installed.map((source) => {
                const note = agentAccessNote(source)
                return <label key={source.id} className={`flex min-h-11 items-center gap-3 text-sm text-kumo-strong ${note ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                  <Checkbox disabled={disabled || note !== null} checked={note === null && sourceIds.includes(source.id)} onChange={(event) => {
                    setSourceIds((current) => event.target.checked ? [...new Set([...current, source.id])] : current.filter((id) => id !== source.id))
                  }} />
                  <span className="min-w-0 break-words">{source.label}{note ? <span className="block text-xs text-kumo-subtle">{note}</span> : null}</span>
                </label>
              })}
              {installed.length === 0 ? <p className="text-sm text-kumo-subtle">Install a connector first.</p> : null}
            </fieldset> : null}
            {error ? <p id={errorId} role="alert" className="field-error">{error}</p> : null}
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-kumo-line p-5 sm:px-6">
            <Dialog.Close render={<Button type="button" variant="secondary" />}>Cancel</Dialog.Close>
            <Button type="submit" variant="primary" disabled={disabled || !name.trim()}>Save agent</Button>
          </footer>
        </form>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
