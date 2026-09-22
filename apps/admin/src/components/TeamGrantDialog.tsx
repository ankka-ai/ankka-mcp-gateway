import { Checkbox } from './Checkbox'
import { Dialog } from '@cloudflare/kumo/primitives/dialog'
import { X } from '@phosphor-icons/react'
import { type FormEvent, useId, useRef, useState } from 'react'
import type { Team, TeamGrant } from '../api'
import { Button } from './Button'

const EMAIL = /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,190}$/u

export function newTeamId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `team-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

interface TeamGrantDialogProps {
  team: TeamGrant | null
  sources: Team['sources']
  disabled: boolean
  onSave(team: TeamGrant): void
}

export function TeamGrantDialog({ team, sources, disabled, onSave }: TeamGrantDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(team?.name ?? '')
  const [emails, setEmails] = useState<string[]>(team?.memberEmails ?? [])
  const [email, setEmail] = useState('')
  const [sourceIds, setSourceIds] = useState<string[]>(team?.sourceIds ?? [])
  const [error, setError] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const emailId = useId()
  const errorId = useId()
  const installed = sources.filter((source) => source.status === 'installed')
  const allSelected = installed.length > 0 && installed.every((source) => sourceIds.includes(source.id))

  const reset = (nextOpen: boolean) => {
    setOpen(nextOpen)
    setName(team?.name ?? '')
    setEmails(team?.memberEmails ?? [])
    setEmail('')
    setSourceIds(team?.sourceIds ?? [])
    setError(null)
  }

  const addEmail = () => {
    const normalized = email.trim().toLowerCase()
    if (normalized.length > 254 || !EMAIL.test(normalized)) {
      setError('Enter a valid email address, up to 254 characters.')
      return
    }
    if (emails.includes(normalized)) {
      setError('This person is already on this team.')
      return
    }
    setEmails((current) => [...current, normalized].sort())
    setEmail('')
    setError(null)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 80) {
      setError('Enter a team name of 1 to 80 characters.')
      return
    }
    onSave({
      id: team?.id ?? newTeamId(),
      name: trimmed,
      memberEmails: [...emails].sort(),
      sourceIds: [...new Set(sourceIds)].sort(),
    })
    setOpen(false)
  }

  return <Dialog.Root open={open} onOpenChange={reset}>
    <Dialog.Trigger disabled={disabled} render={<Button variant="secondary" />}>{team ? 'Edit' : 'Create team'}</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/65" />
      <Dialog.Popup initialFocus={nameInput} className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-overlay text-kumo-default shadow-xl">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <header className="shrink-0 border-b border-kumo-line p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <Dialog.Title className="text-lg font-semibold text-kumo-strong">{team ? 'Edit team' : 'Create team'}</Dialog.Title>
              <Dialog.Close render={<Button variant="ghost" aria-label="Close team editor" />}><X size={20} aria-hidden="true" /></Dialog.Close>
            </div>
            <Dialog.Description className="mt-2 text-sm leading-6 text-kumo-subtle">A team grants its members the connectors you select. Adding or removing a person updates that team once.</Dialog.Description>
          </header>
          <div className="overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
            <label htmlFor={nameId} className="block text-sm font-medium">Name</label>
            <input ref={nameInput} id={nameId} value={name} maxLength={80} required className="text-input mt-2 w-full" onChange={(event) => { setName(event.target.value); setError(null) }} />
            <div className="mt-5">
              <label htmlFor={emailId} className="block text-sm font-medium">Members</label>
              <div className="mt-2 flex gap-2">
                <input id={emailId} type="email" autoComplete="off" value={email} maxLength={254} className="text-input min-w-0 flex-1" placeholder="teammate@example.com" aria-describedby={error ? errorId : undefined} onChange={(event) => { setEmail(event.target.value); setError(null) }} />
                <Button type="button" variant="secondary" disabled={disabled || !email.trim()} onClick={addEmail}>Add</Button>
              </div>
              <ul className="mt-3 flex flex-wrap gap-2">
                {emails.map((member) => <li key={member}>
                  <button type="button" className="tool-chip break-all" onClick={() => setEmails((current) => current.filter((value) => value !== member))}>Remove {member}</button>
                </li>)}
              </ul>
            </div>
            <fieldset className="mt-5">
              <legend className="text-sm font-medium">Connectors</legend>
              <p className="mt-2 text-xs leading-5 text-kumo-subtle">All installed connectors selects every connector installed now. A connector you add later stays closed until you add it to this team.</p>
              {installed.length > 0 ? <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-kumo-strong">
                <Checkbox checked={allSelected} disabled={disabled} onChange={(event) => {
                  setSourceIds(event.target.checked ? installed.map((source) => source.id) : [])
                }} />
                All installed connectors
              </label> : <p className="mt-3 text-sm text-kumo-subtle">No installed connectors to assign.</p>}
              {installed.map((source) => <label key={source.id} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-kumo-strong">
                <Checkbox disabled={disabled} checked={sourceIds.includes(source.id)} onChange={(event) => {
                  setSourceIds((current) => event.target.checked ? [...new Set([...current, source.id])] : current.filter((id) => id !== source.id))
                }} />
                <span className="break-words">{source.label}</span>
              </label>)}
            </fieldset>
            {error ? <p id={errorId} role="alert" className="field-error">{error}</p> : null}
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-kumo-line p-5 sm:px-6">
            <Dialog.Close render={<Button type="button" variant="secondary" />}>Cancel</Dialog.Close>
            <Button type="submit" variant="primary" disabled={disabled || !name.trim()}>Save team</Button>
          </footer>
        </form>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
