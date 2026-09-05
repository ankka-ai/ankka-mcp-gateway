import { Button } from '../components/Button'
import {
  ArrowsClockwise,
  CheckCircle,
  ClockCounterClockwise,
  Trash,
  Warning,
  X,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useGateway } from '../GatewayContext'
import { PageHeader } from '../components/PageHeader'
import { StatusPill } from '../components/StatusPill'

export function SettingsPage() {
  const {
    clearUpdateNotice,
    getTeam,
    isBusy,
    prepareRuntimeAction,
    prepareTeardownAction,
    update,
    updateNotice,
  } = useGateway()
  const [managementStatus, setManagementStatus] = useState('Checking management credential…')
  const checkManagement = useCallback(async () => {
    try {
      const team = await getTeam()
      setManagementStatus(!team.managementCredentialConfigured
        ? 'Add a management credential to enable source installation and Team changes.'
        : team.observedAt ? 'Credential verified; current Team policies are readable.'
          : 'Credential configured. Finish the recorded Team change before verifying the complete membership.')
    } catch {
      setManagementStatus('Could not verify management access. Check the token, permissions, and owned policies in Cloudflare.')
    }
  }, [getTeam])
  useEffect(() => { void checkManagement() }, [checkManagement])
  const dangerZone = useRef<HTMLElement>(null)
  const teardownRequested = new URLSearchParams(window.location.search).get('teardown') === 'review'

  useEffect(() => {
    if (!teardownRequested) return
    dangerZone.current?.focus({ preventScroll: true })
    dangerZone.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [teardownRequested])

  if (!update) return null

  const authorize = async (operation: 'update' | 'rollback') => {
    try {
      const prepared = await prepareRuntimeAction(operation)
      window.location.assign(prepared.handoffUrl)
    } catch { /* The provider keeps the safe error visible. */ }
  }

  const reviewTeardown = async () => {
    try {
      const prepared = await prepareTeardownAction()
      window.location.assign(prepared.handoffUrl)
    } catch { /* The provider keeps the safe error visible. */ }
  }

  const statusLabel = update.status === 'available' ? 'Update available'
    : update.status === 'unavailable' ? 'Channel unavailable' : 'Up to date'
  const channelLabel = update.channel === 'stable' ? 'Stable' : 'Canary'
  const availableRelease = update.status === 'available' ? update.available?.release : null

  return (
    <div>
      <PageHeader title="Settings" />

      <section className="mt-8" aria-labelledby="management-title">
        <h2 id="management-title" className="text-lg font-semibold text-subheading">Cloudflare management</h2>
        <div className="surface-card mt-5 space-y-4 p-5 text-sm leading-6 sm:p-6">
          <p role="status">{managementStatus}</p>
          <p>Create an account-owned API token in Cloudflare, then add it as an encrypted secret named <code>ANKKA_MANAGEMENT_TOKEN</code> in your gateway Worker's Settings → Variables and Secrets. Enter the token only in Cloudflare.</p>
          <p>This lets your gateway install sources and save Team access without asking for Cloudflare consent each time. The token can affect Access policies across your account; it must not include Worker deployment, DNS, or token-creation permissions.</p>
          <p>To replace it, update the secret, verify access here, then revoke the old token in Cloudflare. Deleting the secret or removing your gateway does not revoke the token.</p>
          <a className="underline underline-offset-4" href="https://github.com/ankka-ai/ankka-mcp-gateway/blob/main/docs/MANAGEMENT_TOKEN.md" target="_blank" rel="noreferrer">Setup and permissions guide</a>
          <div><Button variant="secondary" onClick={() => void checkManagement()}>Verify management access</Button></div>
        </div>
      </section>

      <section className="mt-8" aria-labelledby="software-updates-title">
        <h2 id="software-updates-title" className="text-lg font-semibold tracking-[-0.02em] text-subheading">Software updates</h2>

        {updateNotice ? (
          <div role="status" className={`notice-banner mt-5 notice-${updateNotice.tone}`}>
            <p>{updateNotice.message}</p>
            <button type="button" className="pressable" aria-label="Dismiss update notice" onClick={clearUpdateNotice}><X size={14} /></button>
          </div>
        ) : null}

        <div className="surface-card mt-5 overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-kumo-line px-5 py-5 sm:px-6">
            <h3 className="text-sm font-medium text-subheading">{channelLabel} release channel</h3>
            <StatusPill tone={update.status === 'available' || update.status === 'unavailable' ? 'attention' : 'ready'}>
              {statusLabel}
            </StatusPill>
          </div>

          <dl className="grid gap-px bg-kumo-line sm:grid-cols-2">
            <div className="bg-kumo-overlay px-5 py-5 sm:px-6">
              <dt className="text-xs font-medium text-kumo-subtle">Installed</dt>
              <dd className="mt-1.5 break-all text-sm text-kumo-strong">{update.current?.release ?? 'Unavailable'}</dd>
            </div>
            {availableRelease ? (
              <div className="bg-brand-soft px-5 py-5 sm:px-6">
                <dt className="text-xs font-medium text-brand-strong">Available version</dt>
                <dd className="mt-1.5 break-all text-lg font-semibold text-brand-strong">{availableRelease}</dd>
              </div>
            ) : (
              <div className="bg-kumo-overlay px-5 py-5 sm:px-6">
                <dt className="text-xs font-medium text-kumo-subtle">Channel</dt>
                <dd className="mt-1.5 text-sm text-kumo-strong">{update.channel}</dd>
              </div>
            )}
          </dl>

          <div className="px-5 py-5 sm:px-6">
            <dl className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <dt className="text-kumo-subtle">Classification</dt>
              <dd className="text-kumo-strong">
                {update.available?.classification.kind === 'normal' ? 'Normal update' : update.status === 'unavailable' ? 'Unverified' : 'No change'}
              </dd>
            </dl>
            {update.status === 'unavailable' ? (
              <p className="text-sm leading-6 text-kumo-subtle">The signed channel could not be verified. Gateway management and an already available rollback remain usable.</p>
            ) : update.available?.notes?.length ? (
              <ul className="space-y-2 text-sm leading-6 text-kumo-subtle">
                {update.available.notes.map((note) => <li key={note} className="flex gap-2"><CheckCircle size={16} className="mt-1 shrink-0 text-success-strong" />{note}</li>)}
              </ul>
            ) : (
              <p className="text-sm leading-6 text-kumo-subtle">The installed runtime matches the {update.channel} channel.</p>
            )}

            <div className="mt-5 flex flex-wrap gap-2 border-t border-kumo-line pt-5">
              {update.status === 'available' ? (
                <Button variant="primary" className="pressable" loading={isBusy} onClick={() => void authorize('update')}>
                  <ArrowsClockwise size={16} /> Update
                </Button>
              ) : null}
              {update.rollback.available ? (
                <Button variant="secondary" className="pressable" disabled={isBusy} onClick={() => void authorize('rollback')}>
                  <ClockCounterClockwise size={16} /> Rollback
                </Button>
              ) : null}
            </div>
          </div>
        </div>

      </section>

      <section
        ref={dangerZone}
        tabIndex={-1}
        className="mt-10 border-t border-danger/20 pt-8 outline-none"
        aria-labelledby="danger-zone-title"
      >
        <div className="flex items-start gap-3">
          <Warning size={20} className="mt-0.5 shrink-0 text-danger" weight="fill" />
          <div>
            <h2 id="danger-zone-title" className="text-lg font-semibold tracking-[-0.02em] text-danger">Danger zone</h2>
            <p className="mt-1 text-sm leading-6 text-kumo-subtle">These actions can make the gateway unavailable to every connected client.</p>
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-danger/20 bg-danger-soft/55 p-5 sm:p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-2xl">
              <div className="flex items-center gap-2 text-danger">
                <Trash size={18} />
                <h3 className="text-base font-semibold">Teardown gateway</h3>
              </div>
              <p className="mt-2 text-sm leading-6 text-kumo-subtle">
                Review what will be removed before authorizing deletion in Cloudflare. Opening the plan does not change your gateway.
              </p>
            </div>
            <Button
              variant="secondary-destructive"
              className="pressable shrink-0"
              loading={isBusy}
              onClick={() => void reviewTeardown()}
            >
              Review teardown plan
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
