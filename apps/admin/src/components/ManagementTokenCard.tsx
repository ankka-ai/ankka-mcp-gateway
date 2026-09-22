import { useState } from 'react'
import type { ManagementCredentialChoice } from '../api'
import { useGateway } from '../GatewayContext'
import { managementTokenCreateLink } from '../managementTokenLink'
import { Button } from './Button'
import { StepList } from './StepList'

/** What a gateway without the token is told, by what setup recorded at its token step. */
export function managementTokenChoiceSentence(choice: ManagementCredentialChoice | null | undefined): string {
  if (choice === 'skipped') return 'You skipped the token during setup.'
  if (choice === 'provided') return 'Your setup token was not saved. Add it again.'
  return 'No management token was added during setup.'
}

export const MANAGEMENT_ACCESS_PURPOSE = 'Add connectors and manage team access with a Cloudflare API token.'
export const MANAGEMENT_ACCESS_REACH = 'This token can edit all Access policies in your Cloudflare account. It stays in your gateway and never passes through Ankka.'
export const MANAGEMENT_ACCESS_STEPS = 'Create the token first as a Cloudflare account Administrator or Super Administrator. The next approval expires after a few minutes.'

/** Step one of the flow, before any approval is spent: the link that creates the token with both permissions and its name. */
export function ManagementTokenCreateLink() {
  const hostname = window.location.hostname
  return (
    <p>
      <a className="underline underline-offset-4" href={managementTokenCreateLink(hostname)} target="_blank" rel="noopener noreferrer">Create the token in Cloudflare ↗</a>
      {' '}Permissions and name are prefilled. Create and copy the token.
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
      <StepList label="Management token setup steps">
        <li><ManagementTokenCreateLink /></li>
        <li>
          <p>Approve in Cloudflare, then paste the token into your gateway.</p>
          <div className="mt-2"><Button variant="primary" loading={starting} onClick={() => void start()}>Add management token</Button></div>
        </li>
      </StepList>
    </section>
  )
}
