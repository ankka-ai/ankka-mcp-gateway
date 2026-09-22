import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import type { ManagementCredentialStatus, ManagementVerification } from '../api'
import { useGateway } from '../GatewayContext'
import { Button } from '../components/Button'
import { LoadingIndicator } from '../components/LoadingIndicator'
import {
  managementTokenChoiceSentence,
  useManagementTokenStart,
} from '../components/ManagementTokenCard'
import { managementTokenCreateLink, managementTokenName } from '../managementTokenLink'

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
  if (result.status === 'missing') return ['No management token found. Reload this page to add one.']
  if (result.status === 'busy') {
    return ['Another gateway change is in progress. Verify again when it finishes.']
  }
  if (result.token === 'rejected') return ['Cloudflare rejected this token. Replace it to restore management access.']
  if (result.token !== 'active') return ['Could not confirm the token with Cloudflare. Try again.']
  const lines = PERMISSIONS.flatMap(([key, permission, resource]) => {
    const word = result[key]
    if (word === 'verified') return []
    if (word === 'permission_missing') return [`Missing permission: ${permission}.`]
    if (word === 'drift') return [`Your ${resource} has changed. Review it in Cloudflare before verifying again; nothing was overwritten.`]
    return [`Could not confirm ${permission}. Try again.`]
  })
  if (result.status === 'permission_missing') {
    lines.push('Replace the token using the prefilled Cloudflare link.')
  }
  return lines
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
  const [editingToken, setEditingToken] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)
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
  const tokenVerified = verification !== null && verification !== 'failed' && verification.status === 'verified'
  const nameInCloudflare = managementTokenName(window.location.hostname)
  const status = tokenVerified ? 'Management token active'
    : verifying ? 'Checking access…'
    : tokenState === 'loading' ? 'Checking token…'
    : tokenState === 'unreadable'
      ? 'Token status unavailable. Reload or verify access.'
      : arrival === 'waiting' ? 'Waiting for your token…'
        : missing ? 'No management token' : 'Management token added'

  return (
    <section className="mt-8" aria-labelledby="management-title">
      <h2 id="management-title" className="text-lg font-semibold text-subheading">Cloudflare management</h2>
      {flow ? (
        <p role="status" className={`notice-banner mt-5 notice-${arrival === 'arrived' ? 'success' : flow.result === 'failed' && arrival === null ? 'error' : 'neutral'}`}>
          {arrival === 'waiting' ? <LoadingIndicator inline /> : null} {flowMessage(flow, arrival)}
        </p>
      ) : null}
      <div className="surface-card mt-5 space-y-4 p-5 text-sm leading-6 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p role="status" className={`flex items-center gap-2 font-medium ${tokenVerified ? 'text-success-strong' : 'text-subheading'}`}>
              {tokenVerified ? <CheckCircle size={20} weight="fill" aria-hidden="true" className="shrink-0" /> : null}
              {status}
            </p>
            {missing ? <p className="mt-1 text-kumo-subtle">Add a token to manage sources and team access.</p> : null}
          </div>
          {arrival === 'waiting' || tokenState === 'loading' ? null : (
            <div className="flex flex-wrap gap-3">
              {!missing ? <Button variant="secondary" loading={verifying} disabled={starting} onClick={() => void verify()}>Verify access</Button> : null}
              <Button ref={editButton} variant={missing ? 'primary' : 'secondary'} disabled={verifying || starting} aria-expanded={editingToken} aria-controls="management-token-setup" onClick={() => setEditingToken((open) => !open)}>{missing ? 'Add token' : 'Replace token'}</Button>
            </div>
          )}
        </div>
        <p className="text-kumo-subtle">This token can edit all MCP Portals and Access policies in your Cloudflare account.</p>
        {editingToken ? (
          <div id="management-token-setup" className="space-y-4 rounded-lg border border-kumo-line p-4">
            <h3 className="font-medium text-subheading">{missing ? 'Add a management token' : 'Replace your management token'}</h3>
            <ol className="list-decimal space-y-2 pl-5">
              <li><a className="underline underline-offset-4" href={managementTokenCreateLink(window.location.hostname)} target="_blank" rel="noopener noreferrer">Create a token in Cloudflare ↗</a> and copy it. The name and permissions are prefilled.</li>
              <li>Continue to approve in Cloudflare, then paste the token into your gateway.</li>
            </ol>
            {!missing ? <p className="text-kumo-subtle">After replacing, delete the older <strong>{nameInCloudflare}</strong> token in Cloudflare under Manage Account → Account API Tokens.</p> : null}
            <div className="flex flex-wrap gap-3">
              <Button variant="primary" loading={starting} disabled={verifying} onClick={() => void start()}>I’ve copied the token</Button>
              <Button variant="secondary" disabled={starting} onClick={() => { setEditingToken(false); editButton.current?.focus() }}>Cancel</Button>
            </div>
          </div>
        ) : null}
        {verification === 'failed' ? <p role="alert" className="notice-banner notice-error">The check could not be run. Reload this page and try again.</p> : null}
        {verification !== null && verification !== 'failed' && !tokenVerified ? (
          <div role="status" className={`notice-banner notice-${verification.status === 'busy' ? 'neutral' : 'warning'}`}>
            <ul className="space-y-1">{verificationLines(verification).map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
        ) : null}
        <details className="border-t border-kumo-line pt-4 text-kumo-subtle">
          <summary className="w-fit cursor-pointer font-medium text-subheading">Token details</summary>
          <div className="mt-3 space-y-3">
            <p>Your gateway uses this token to manage sources and team access. It stays in your Cloudflare account and never passes through Ankka.</p>
            {missing ? <p>{managementTokenChoiceSentence(tokenStatus?.managementCredentialChoice)}</p> : null}
            <p>Creating a token requires a Cloudflare account Administrator or Super Administrator. Create it before continuing: the approval expires after a few minutes.</p>
            <p>Verification re-saves your gateway’s own MCP Portal and Access policy unchanged to check both edit permissions.</p>
            <p>Removing your gateway does not delete its token. Delete unused tokens in Cloudflare under Manage Account → Account API Tokens.</p>
            <a className="inline-block underline underline-offset-4" href="https://github.com/ankka-ai/ankka-mcp-gateway/blob/main/docs/MANAGEMENT_TOKEN.md" target="_blank" rel="noreferrer">Read the token documentation ↗</a>
          </div>
        </details>
      </div>
    </section>
  )
}
