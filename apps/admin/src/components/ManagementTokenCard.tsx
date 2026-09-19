import { useState } from 'react'
import type { ManagementCredentialChoice } from '../api'
import { useGateway } from '../GatewayContext'
import { managementTokenCreateLink, managementTokenName } from '../managementTokenLink'
import { Button } from './Button'

/** What a gateway without the token is told, by what setup recorded at its token step. */
export function managementTokenChoiceSentence(choice: ManagementCredentialChoice | null | undefined): string {
  if (choice === 'skipped') return 'You continued without a token during setup, so your gateway has never had one.'
  if (choice === 'provided') return 'You pasted a token during setup, but your gateway lost it before it could be saved. It kept nothing of it, so the token has to be added again.'
  return 'This gateway was set up before setup asked for the token, so it was never given one.'
}

export const MANAGEMENT_ACCESS_PURPOSE = 'Your gateway needs one Cloudflare API token of its own to add sources and change team access, because every approval you give it is temporary.'
export const MANAGEMENT_ACCESS_REACH = 'Cloudflare cannot limit this token to your gateway: it can edit every Access policy in your account, and it never passes through anything Ankka hosts.'
export const MANAGEMENT_ACCESS_STEPS = 'Create the token first: Cloudflare’s approval in the second step lasts only a few minutes. Creating it needs a Super Administrator or Administrator of your Cloudflare account.'

/** Step one of the flow, before any approval is spent: the link that creates the token with both permissions and its name. */
export function ManagementTokenCreateLink() {
  const hostname = window.location.hostname
  return (
    <p>
      <a className="underline underline-offset-4" href={managementTokenCreateLink(hostname)} target="_blank" rel="noopener noreferrer">Create the token in Cloudflare ↗</a>
      {' '}The link fills in both permissions and the name <strong>{managementTokenName(hostname)}</strong>. Create it and copy it.
    </p>
  )
}

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
      <ol className="list-decimal space-y-3 pl-5">
        <li><ManagementTokenCreateLink /></li>
        <li>
          <p>Add it to your gateway: you approve one change in Cloudflare, then paste the token on a page of your own gateway.</p>
          <div className="mt-2"><Button variant="primary" loading={starting} onClick={() => void start()}>Add management token</Button></div>
        </li>
      </ol>
    </section>
  )
}
