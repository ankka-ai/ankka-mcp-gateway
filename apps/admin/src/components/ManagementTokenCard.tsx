import { useState } from 'react'
import type { ManagementCredentialChoice } from '../api'
import { useGateway } from '../GatewayContext'
import { Button } from './Button'

/** What a gateway without the token is told, by what setup recorded at its token step. */
export function managementTokenChoiceSentence(choice: ManagementCredentialChoice | null | undefined): string {
  if (choice === 'skipped') return 'You continued without a token during setup, so your gateway has never had one.'
  if (choice === 'provided') return 'You pasted a token during setup, but your gateway lost it before it could be saved. It kept nothing of it, so the token has to be added again.'
  return 'This gateway was set up before setup asked for the token, so it was never given one.'
}

export const MANAGEMENT_ACCESS_PURPOSE = 'Your gateway needs one Cloudflare API token of its own to add sources and change team access, because every approval you give it is temporary.'
export const MANAGEMENT_ACCESS_REACH = 'Cloudflare cannot limit this token to your gateway: it can edit every Access policy in your account, and it never passes through anything Ankka hosts.'
export const MANAGEMENT_ACCESS_STEPS = 'You approve one change in Cloudflare, then create the token from a link and paste it into your own gateway. Creating it needs a Super Administrator or Administrator of your Cloudflare account.'

/**
 * Starts the one way a gateway gets or replaces its management token: prepare the change here, approve it in
 * Cloudflare, paste the token on a page of this gateway. The token is never entered on this dashboard.
 */
export function useManagementTokenStart() {
  const { prepareManagementCredentialAction } = useGateway()
  const [starting, setStarting] = useState(false)
  const start = async () => {
    if (starting) return
    setStarting(true)
    try {
      const prepared = await prepareManagementCredentialAction()
      window.location.assign(prepared.handoffUrl)
    } catch {
      // The provider keeps the safe error visible.
      setStarting(false)
    }
  }
  return { start, starting }
}

/** Shown on Sources, Team and Settings while the gateway reports that it has no management token. */
export function ManagementTokenCard({ choice, className = 'mt-6' }: {
  choice: ManagementCredentialChoice | null | undefined
  className?: string
}) {
  const { start, starting } = useManagementTokenStart()
  return (
    <section className={`surface-card space-y-3 p-5 text-sm leading-6 sm:p-6 ${className}`} aria-labelledby="management-token-card-title">
      <h2 id="management-token-card-title" className="text-base font-semibold text-subheading">Add your management token</h2>
      <p>{MANAGEMENT_ACCESS_PURPOSE}</p>
      <p>{MANAGEMENT_ACCESS_REACH}</p>
      <p className="text-kumo-subtle">{managementTokenChoiceSentence(choice)}</p>
      <p className="text-kumo-subtle">{MANAGEMENT_ACCESS_STEPS}</p>
      <div><Button variant="primary" loading={starting} onClick={() => void start()}>Add management token</Button></div>
    </section>
  )
}
