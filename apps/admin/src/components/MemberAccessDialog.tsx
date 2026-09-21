import { Dialog } from '@cloudflare/kumo/primitives/dialog'
import { X } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import type { Team, TeamMember } from '../api'
import { Button } from './Button'

interface MemberAccessDialogProps {
  member: TeamMember
  sources: Team['sources']
  disabled: boolean
  onChange(sourceIds: string[]): void
}

export function MemberAccessDialog({ member, sources, disabled, onChange }: MemberAccessDialogProps) {
  const [open, setOpen] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger render={<Button variant="secondary" />} aria-label={`Access for ${member.email}`}>Access</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/65" />
      <Dialog.Popup initialFocus={heading} className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-overlay text-kumo-default shadow-xl">
        <header className="shrink-0 border-b border-kumo-line p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Dialog.Title ref={heading} tabIndex={-1} className="text-lg font-semibold text-kumo-strong outline-none">Member access</Dialog.Title>
              <p className="mt-1 break-all text-sm text-kumo-subtle">{member.email}</p>
            </div>
            <Dialog.Close render={<Button variant="ghost" aria-label="Close member access" />}><X size={20} aria-hidden="true" /></Dialog.Close>
          </div>
          <Dialog.Description className="mt-4 text-sm leading-6 text-kumo-subtle">Select sources to grant access to their tools. Tools are shared per source.</Dialog.Description>
        </header>
        <div className="overflow-y-auto overscroll-contain px-5 sm:px-6">
          {sources.map(source => <div key={source.id} className="border-b border-kumo-line py-4 last:border-0">
            <label className="flex items-center gap-3 text-sm font-medium text-kumo-strong">
              <input type="checkbox" className="size-4 shrink-0 accent-brand" disabled={disabled} checked={member.sourceIds.includes(source.id)} onChange={event => {
                if (!disabled) onChange(event.target.checked ? [...new Set([...member.sourceIds, source.id])] : member.sourceIds.filter(id => id !== source.id))
              }} />
              <span className="break-words">{source.label}</span>
            </label>
            <details className="ml-7 mt-2 text-xs text-kumo-subtle">
              <summary className="cursor-pointer">{source.enabledTools.length} {source.enabledTools.length === 1 ? 'tool' : 'tools'}</summary>
              <ul aria-label={`${source.label} tools`} className="mt-3 flex flex-wrap gap-2">
                {source.enabledTools.map(tool => <li key={tool} className="tool-chip break-all"><code>{tool}</code></li>)}
              </ul>
            </details>
          </div>)}
          {sources.length === 0 ? <p className="py-6 text-sm text-kumo-subtle">No installed sources to assign.</p> : null}
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-kumo-line p-5 sm:px-6">
          <p className="text-xs leading-5 text-kumo-subtle">{disabled ? 'Access is currently read-only.' : 'Save on the Team page to apply your changes.'}</p>
          <Dialog.Close render={<Button variant="primary" />}>Done</Dialog.Close>
        </footer>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
