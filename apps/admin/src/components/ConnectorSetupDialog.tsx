import { Dialog } from '@cloudflare/kumo/primitives/dialog'
import { ArrowLeft, X } from '@phosphor-icons/react'
import { type ReactNode, type RefObject, useRef } from 'react'
import { Button } from './Button'

interface ConnectorSetupDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  title: string
  description: string
  closeLabel: string
  onLibrary(): void
  finalFocus: false | RefObject<HTMLButtonElement | null>
  children: ReactNode
}

export function ConnectorSetupDialog({ open, onOpenChange, title, description, closeLabel, onLibrary, finalFocus, children }: ConnectorSetupDialogProps) {
  const heading = useRef<HTMLHeadingElement>(null)
  return <Dialog.Root open={open} onOpenChange={onOpenChange} disablePointerDismissal>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/65" />
      <Dialog.Popup initialFocus={heading} finalFocus={finalFocus} className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-overlay text-kumo-default shadow-xl">
        <header className="shrink-0 border-b border-kumo-line p-5 sm:px-8 sm:py-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={onLibrary}><ArrowLeft size={16} aria-hidden="true" /> Connector library</Button>
            <Dialog.Close render={<Button variant="ghost" aria-label={closeLabel} />}><X size={20} aria-hidden="true" /></Dialog.Close>
          </div>
          <Dialog.Title ref={heading} tabIndex={-1} className="text-2xl font-medium tracking-tight text-kumo-strong outline-none">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-6 text-kumo-subtle">{description}</Dialog.Description>
        </header>
        <div className="overflow-y-auto overscroll-contain p-5 sm:p-8">{children}</div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
