import { Button } from '../components/Button'
import {
  Trash,
  Warning,
  X,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useGateway } from '../GatewayContext'
import { PageHeader } from '../components/PageHeader'
import { LoadingIndicator } from '../components/LoadingIndicator'
import { customerPageStyles } from '../../../installer/src/customer-page-theme'

export function SettingsPage() {
  const {
    clearUpdateNotice,
    getTeam,
    isBusy,
    prepareRuntimeAction,
    prepareTeardownAction,
    refreshUpdate,
    update,
    updateNotice,
  } = useGateway()
  const [pendingRuntimeOperation, setPendingRuntimeOperation] = useState<'update' | 'rollback' | null>(null)
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
  // Installing a source can end a rollback, so an answer loaded before this page opened is read again.
  const updateLoadedEarlier = useRef(update !== null)
  useEffect(() => { if (updateLoadedEarlier.current) void refreshUpdate() }, [refreshUpdate])
  const dangerZone = useRef<HTMLElement>(null)
  const teardownRequested = new URLSearchParams(window.location.search).get('teardown') === 'review'

  useEffect(() => {
    if (!teardownRequested) return
    dangerZone.current?.focus({ preventScroll: true })
    dangerZone.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [teardownRequested])

  if (!update) return null

  const authorize = async (operation: 'update' | 'rollback') => {
    setPendingRuntimeOperation(operation)
    try {
      const prepared = await prepareRuntimeAction(operation)
      window.location.assign(prepared.handoffUrl)
    } catch { /* The provider keeps the safe error visible. */ }
    finally { setPendingRuntimeOperation(null) }
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
  // A recorded release the gateway can no longer restore: say why instead of offering it.
  const rollbackEnded = !update.rollback.available && 'release' in update.rollback ? update.rollback.release : null

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

      <style>{customerPageStyles}</style>
      <section className="ankka-setup update-panel mt-8" aria-labelledby="software-updates-title">
        <div className="update-heading">
          <h2 id="software-updates-title">Software updates</h2>
          <span className="update-label">{statusLabel}</span>
        </div>

        {updateNotice ? (
          <div role="status" className="update-status" data-tone={updateNotice.tone}>
            {updateNotice.tone === 'neutral' ? <LoadingIndicator /> : null}
            <p>{updateNotice.message}</p>
            <button type="button" className="secondary update-dismiss" aria-label="Dismiss update notice" onClick={clearUpdateNotice}><X size={14} /></button>
          </div>
        ) : null}

        <dl className="release-summary">
          <div><dt>Installed</dt><dd>{update.current?.release ?? 'Unavailable'}</dd></div>
          <div><dt>{availableRelease ? 'Available version' : 'Release channel'}</dt><dd>{availableRelease ?? channelLabel}</dd></div>
        </dl>
        <p className="update-label">{channelLabel} release channel · {update.available?.classification.kind === 'normal' ? 'Normal update' : update.status === 'unavailable' ? 'Unverified' : 'No change'}</p>
        {update.status === 'unavailable' ? (
          <p>The signed channel could not be verified. Gateway management and an already available rollback remain usable.</p>
        ) : update.available?.notes?.length ? (
          <ul className="release-notes">{update.available.notes.map(note => <li key={note}>{note}</li>)}</ul>
        ) : (
          <p>The installed runtime matches the {update.channel} channel.</p>
        )}
        <div className="actions">
          {update.status === 'available' ? (
            <button type="button" disabled={isBusy} aria-busy={pendingRuntimeOperation === 'update'} onClick={() => void authorize('update')}>
              {pendingRuntimeOperation === 'update' ? <LoadingIndicator inline /> : null} Update
            </button>
          ) : null}
          {update.rollback.available ? (
            <button type="button" className="secondary" disabled={isBusy} aria-busy={pendingRuntimeOperation === 'rollback'} onClick={() => void authorize('rollback')}>
              {pendingRuntimeOperation === 'rollback' ? <LoadingIndicator inline /> : null} Rollback
            </button>
          ) : rollbackEnded ? (
            <p>You can no longer roll back to {rollbackEnded}. A source was installed or Team access was changed after the update, and the older version cannot work with those changes.</p>
          ) : null}
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
