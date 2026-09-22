import { Check } from '@phosphor-icons/react'
import type { ComponentProps } from 'react'

/** Keeps native form, label and keyboard behavior with the dashboard's shared styling. */
export function Checkbox({ className = '', ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <span className={`gateway-checkbox ${className}`}>
    <input {...props} type="checkbox" className="gateway-checkbox-input" />
    <span className="gateway-checkbox-box" aria-hidden="true"><Check size={14} weight="bold" /></span>
  </span>
}
