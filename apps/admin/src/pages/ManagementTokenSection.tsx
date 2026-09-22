import { Disclosure } from '../components/Disclosure'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ManagementCredentialStatus, ManagementVerification } from '../api'
import { useGateway } from '../GatewayContext'
import { Button } from '../components/Button'
import { LoadingIndicator } from '../components/LoadingIndicator'
import {
  MANAGEMENT_ACCESS_PURPOSE,
  MANAGEMENT_ACCESS_REACH,
  ManagementTokenCard,
  ManagementTokenCreateLink,
  useManagementTokenStart,
} from '../components/ManagementTokenCard'
import { managementTokenName } from '../managementTokenLink'

const ACTION_ID = /^action_[A-Za-z0-9_-]{32}$/u
const REASON = /^[a-z][a-z0-9_]{0,120}$/u
const RESULTS = ['applied', 'revocation_unconfirmed', 'failed', 'denied', 'cancelled'] as const
type ReturnResult = typeof RESULTS[number]
/** A new Worker version carries the token; Cloudflare starts serving it within about a minute. */
const ARRIVAL_POLL_MS = 3_000
const ARRIVAL_POLL_LIMIT = 40

interface FlowReturn { result: ReturnResult; reason: string | null }

const RETURN_PARAMETERS = ['managementCredentialAction', 'managementCredentialActionResult', 'managementCredentialActionReason'] as const

/** The end of a token change, as the gateway's own page handed it back in the address. Reading changes nothing. */
function readFlowReturn(): FlowReturn | null {
  const url = new URL(window.location.href)
  const actionId = url.searchParams.get('managementCredentialAction')
  const result = RESULTS.find((value) => value === url.searchParams.get('managementCredentialActionResult'))
  const rawReason = url.searchParams.get('managementCredentialActionReason')
  if (actionId === null || !ACTION_ID.test(actionId) || result === undefined) return null
  return { result, reason: rawReason !== null && REASON.test(rawReason) ? rawReason : null }
}

/** The answer is kept in this page's state, so the address gives it up: a reload starts clean. */
function forgetFlowReturn() {
  const url = new URL(window.location.href)
  if (!RETURN_PARAMETERS.some((name) => url.searchParams.has(name))) return
  for (const name of RETURN_PARAMETERS) url.searchParams.delete(name)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

/** True when Cloudflare may have saved the token: the dashboard then watches for it by itself. */
function mayHaveArrived(flow: FlowReturn): boolean {
  return flow.result === 'applied' || flow.result === 'revocation_unconfirmed' ||
    (flow.result === 'failed' && flow.reason === 'secret_write_unconfirmed')
}

function flowMessage(flow: FlowReturn, arrival: 'waiting' | 'arrived' | 'late' | 'unreadable' | null): string {
  if (flow.result === 'denied') return 'You declined the approval in Cloudflare. Nothing was changed.'
  if (flow.result === 'cancelled') return 'You stopped before pasting a token. Nothing was changed.'
  if (flow.result === 'failed' && flow.reason === 'approval_expired') {
    return 'Cloudflare’s approval ran out before the token arrived, so nothing was saved. Approvals last only a few minutes. Start again when you are ready to create and paste the token.'
  }
  if (flow.result === 'failed' && flow.reason === 'paste_page_closed') {
    return 'The page that takes the token was reloaded before the token was pasted, so its approval could not be used any more. Nothing was saved. Start again.'
  }
  if (flow.result === 'failed' && flow.reason !== 'secret_write_unconfirmed') {
    return `Your gateway could not save the token${flow.reason === null ? '' : ` (${flow.reason})`}. Nothing else was changed. Start again.`
  }
  const lead = flow.result === 'failed'
    ? 'Cloudflare did not confirm that it saved the token.'
    : flow.result === 'revocation_unconfirmed'
      ? 'Cloudflare accepted the token, but the temporary approval could not be confirmed revoked. Review active OAuth grants in your Cloudflare profile.'
      : 'Cloudflare accepted the token.'
  if (arrival === 'arrived') return `${lead} Your gateway now runs with it. Verify management access to prove that it can do its work.`
  if (arrival === 'unreadable') return `${lead} Your gateway could not confirm whether the token has arrived. Reload this page to check again.`
  if (arrival === 'late') return `${lead} Your gateway does not run with it yet. Cloudflare can take a few minutes; if it still has not arrived then, start again.`
  return `${lead} Waiting for your gateway to start with it; this usually takes less than a minute…`
}

const PERMISSIONS = [
  ['portals', 'MCP Portals Edit', 'MCP Portal'],
  ['accessPolicies', 'Access: Apps and Policies Edit', 'Portal Access policy'],
] as const

function verificationLines(result: ManagementVerification): string[] {
  if (result.status === 'missing') return ['Your gateway has no management token.']
  if (result.status === 'busy') {
    return ['A connector installation, update, removal, Team change or token change is unfinished, so nothing was checked. Verify again when it has finished.']
  }
  if (result.token === 'rejected') return ['Cloudflare rejected the token: it was revoked, has expired, or belongs to another account. Replace it.']
  if (result.token !== 'active') return ['Cloudflare did not answer the token check, so nothing is proven yet. Try again in a moment.']
  if (result.status === 'verified') {
    return ['Verified. The token is active with MCP Portals Edit and Access: Apps and Policies Edit permissions.']
  }
  const lines = PERMISSIONS.map(([key, permission, resource]) => {
    const word = result[key]
    if (word === 'verified') return `${permission}: proven. Your gateway wrote its own ${resource} back unchanged.`
    if (word === 'permission_missing') return `${permission}: missing. Cloudflare refused the token for your gateway’s own ${resource}.`
    if (word === 'drift') return `${permission}: not proven. Your gateway’s own ${resource} no longer matches what your gateway recorded, so nothing was written to it. Review it in Cloudflare; this page does not reset it.`
    return `${permission}: not confirmed. Cloudflare gave no clear answer for your gateway’s own ${resource}, or your gateway’s records could not be read.`
  })
  if (result.status === 'permission_missing') {
    lines.push('Create a new token from the link, which fills in both permissions, and replace this one.')
  }
  return ['The token is active.', ...lines]
}

/** Settings → Cloudflare management: the one way to add, replace and verify the gateway's own token. */
export function ManagementTokenSection() {
  const { getManagementCredentialStatus, refreshSources, verifyManagementAccess } = useGateway()
  const { start, starting } = useManagementTokenStart()
  const [tokenStatus, setTokenStatus] = useState<ManagementCredentialStatus | null>(null)
  const [tokenState, setTokenState] = useState<'loading' | 'read' | 'unreadable'>('loading')
  const [flow] = useState<FlowReturn | null>(readFlowReturn)
  const [arrival, setArrival] = useState<'waiting' | 'arrived' | 'late' | 'unreadable' | null>(
    () => flow !== null && mayHaveArrived(flow) ? 'waiting' : null)
  const [verification, setVerification] = useState<ManagementVerification | 'failed' | null>(null)
  const [verifying, setVerifying] = useState(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(forgetFlowReturn, [])

  const readTokenStatus = useCallback(async (): Promise<ManagementCredentialStatus | null> => {
    try {
      const next = await getManagementCredentialStatus()
      if (!active.current) return null
      setTokenStatus(next)
      setTokenState('read')
      return next
    } catch {
      if (active.current) setTokenState('unreadable')
      return null
    }
  }, [getManagementCredentialStatus])

  const watchArrival = useRef(arrival === 'waiting')
  useEffect(() => {
    if (!watchArrival.current) { void readTokenStatus(); return }
    // After a token change the dashboard watches for the token by itself: no reload is needed.
    let stopped = false
    let timer: number | undefined
    let attempts = 0
    const check = async () => {
      const next = await readTokenStatus()
      if (stopped || !active.current) return
      attempts += 1
      if (next?.managementCredentialConfigured === true) {
        setArrival('arrived')
        // Sources were loaded while the token was missing; without this they would stay disabled until a reload.
        void refreshSources().catch(() => {})
        return
      }
      if (next === null) { setArrival('unreadable'); return }
      if (attempts >= ARRIVAL_POLL_LIMIT) { setArrival('late'); return }
      timer = window.setTimeout(() => { void check() }, ARRIVAL_POLL_MS)
    }
    void check()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [readTokenStatus, refreshSources])

  const verify = async () => {
    if (verifying) return
    setVerifying(true)
    setVerification(null)
    try {
      const result = await verifyManagementAccess()
      if (active.current) setVerification(result)
    } catch {
      if (active.current) setVerification('failed')
    } finally {
      if (active.current) setVerifying(false)
    }
  }

  const missing = tokenState === 'read' && tokenStatus?.managementCredentialConfigured === false && arrival !== 'waiting'
  const nameInCloudflare = managementTokenName(window.location.hostname)
  const status = tokenState === 'loading' ? 'Checking your management token…'
    : tokenState === 'unreadable'
      ? 'Your gateway could not read its management token status. Reload this page or verify management access.'
      : tokenStatus?.managementCredentialConfigured !== true ? 'No management token configured.'
        : 'Management token configured.'

  return (
    <section className="mt-8" aria-labelledby="management-title">
      <h2 id="management-title" className="text-lg font-semibold text-subheading">Cloudflare management</h2>
      {flow ? (
        <p role="status" className={`notice-banner mt-5 notice-${arrival === 'arrived' ? 'success' : flow.result === 'failed' && arrival === null ? 'error' : 'neutral'}`}>
          {arrival === 'waiting' ? <LoadingIndicator inline /> : null} {flowMessage(flow, arrival)}
        </p>
      ) : null}
      {missing ? <ManagementTokenCard choice={tokenStatus?.managementCredentialChoice} className="mt-5" /> : (
        <div className="surface-card mt-5 space-y-4 p-5 text-sm leading-6 sm:p-6">
          <p role="status">{status}</p>
          <p>{MANAGEMENT_ACCESS_PURPOSE}</p>
          <p>{MANAGEMENT_ACCESS_REACH}</p>
          {arrival === 'waiting' || tokenState === 'loading' ? null : (
            <>
              <p className="text-kumo-subtle">To replace it, create a new token first. Delete the old token in Cloudflare afterwards.</p>
              <ManagementTokenCreateLink />
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" loading={verifying} onClick={() => void verify()}>Verify management access</Button>
                <Button variant="secondary" loading={starting} disabled={verifying} onClick={() => void start()}>Replace management token</Button>
              </div>
              <Disclosure className="text-kumo-subtle" label="Token details">
                <p className="mt-3">Verification re-saves your gateway’s MCP Portal and Access policy unchanged to check both permissions.</p>
                <p className="mt-2">Manage tokens in Cloudflare under Manage Account → Account API Tokens. Look for <strong>{nameInCloudflare}</strong>; the older creation date identifies the previous token. Replacing the token or removing your gateway does not delete it.</p>
              </Disclosure>
            </>
          )}
          {verification === 'failed' ? <p role="alert" className="notice-banner notice-error">The check could not be run. Reload this page and try again.</p> : null}
          {verification !== null && verification !== 'failed' ? (
            <div role="status" className={`notice-banner notice-${verification.status === 'verified' ? 'success' : verification.status === 'busy' ? 'neutral' : 'warning'}`}>
              <ul className="space-y-1">{verificationLines(verification).map((line) => <li key={line}>{line}</li>)}</ul>
            </div>
          ) : null}
          <a className="underline underline-offset-4" href="https://github.com/ankka-ai/ankka-mcp-gateway/blob/main/docs/MANAGEMENT_TOKEN.md" target="_blank" rel="noreferrer">Management token guide</a>
        </div>
      )}
    </section>
  )
}
