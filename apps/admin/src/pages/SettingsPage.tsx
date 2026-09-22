import { Button } from '../components/Button'
import {
  Trash,
  Warning,
  X,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { useGateway } from '../GatewayContext'
import { PageHeader } from '../components/PageHeader'
import { LoadingIndicator } from '../components/LoadingIndicator'
import { ManagementTokenSection } from './ManagementTokenSection'
import { customerPageStyles } from '../../../installer/src/customer-page-theme'

export function SettingsPage() {
  const {
    clearUpdateNotice,
    isBusy,
    prepareRuntimeAction,
    prepareTeardownAction,
    refreshUpdate,
    update,
    updateNotice,
  } = useGateway()
  const [pendingRuntimeOperation, setPendingRuntimeOperation] = useState<'update' | 'rollback' | null>(null)
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

      <ManagementTokenSection />

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
            <p>You can no longer roll back to {rollbackEnded}. A connector was installed or Team access was changed after the update, and the older version cannot work with those changes.</p>
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
