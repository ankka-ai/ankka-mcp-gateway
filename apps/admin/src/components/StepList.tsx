import type { PropsWithChildren, ReactNode } from 'react'
import { stepListStyles } from '../../../installer/src/step-list'

export function StepList({ label, children }: PropsWithChildren<{ label: string }>) {
  return <><style>{stepListStyles}</style><ol className="ankka-steps" aria-label={label} role="list">{children}</ol></>
}

export function ProgressStep({ label, state = 'pending', status, children }: PropsWithChildren<{
  label: string
  state?: 'pending' | 'current' | 'active' | 'done' | 'stopped'
  status?: ReactNode
}>) {
  return <li data-state={state} aria-current={state === 'active' || state === 'current' ? 'step' : undefined}>
    <div className="ankka-step-heading"><span className="ankka-step-label">{label}</span>{status ? <span className="ankka-step-status">{status}</span> : null}</div>
    {children}
  </li>
}
