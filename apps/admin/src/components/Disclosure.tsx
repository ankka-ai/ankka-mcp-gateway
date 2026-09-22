import { CaretRight } from '@phosphor-icons/react'
import type { ComponentProps, ReactNode } from 'react'

function Indicator() {
  return <span className="disclosure-indicator" aria-hidden="true"><CaretRight size={14} weight="bold" /></span>
}

export function DisclosureTrigger({ children, className = '', ...props }: ComponentProps<'button'>) {
  return <button type="button" {...props} className={`disclosure-trigger ${className}`}>
    <span className="flex min-w-0 flex-1 items-center gap-3">{children}</span>
    <Indicator />
  </button>
}

export function Disclosure({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return <details className={`disclosure ${className}`}>
    <summary className="disclosure-trigger">
      <span className="min-w-0 flex-1">{label}</span>
      <Indicator />
    </summary>
    <div className="disclosure-content">{children}</div>
  </details>
}
