import { Button as KumoButton } from '@cloudflare/kumo'
import type { ComponentProps } from 'react'
import { LoadingIndicator } from './LoadingIndicator'

export function Button(props: ComponentProps<typeof KumoButton>) {
  return (
    <KumoButton
      {...props}
      loading={false}
      disabled={props.loading || props.disabled}
      icon={props.loading ? <LoadingIndicator inline /> : props.icon}
      aria-busy={props.loading || props['aria-busy']}
      // Keep Kumo's interaction behavior; our shared styles own the visual variants.
      variant="ghost"
      data-gateway-variant={props.variant ?? 'secondary'}
      className={`gateway-button pressable ${props.className ?? ''}`}
    />
  )
}
