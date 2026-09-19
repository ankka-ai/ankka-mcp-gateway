import { Input } from '@cloudflare/kumo'
import { Button } from '../components/Button'
import { ArrowRight, Database, GlobeSimple, MagnifyingGlass, Plus, X } from '@phosphor-icons/react'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { GatewayApiError, GOOGLE_SHARED_OAUTH_BLOCK_MESSAGE, SOURCE_ADDITION_PAUSED_MESSAGE, type ManagementCredentialChoice, type SourceActionSummary, type SourceActionTools, type SourceDiscovery, type BigQuerySetups, isBigQueryPreflightFailure, rollbackEndsMessage, validHandoffUrl } from '../api'
import { SOURCE_CATALOG, type SourceCatalog, type SourceCatalogSource } from '../catalog'
import { useGateway } from '../GatewayContext'
import { GatewayEndpoint } from '../components/GatewayEndpoint'
import { ManagementTokenCard } from '../components/ManagementTokenCard'
import { PageHeader } from '../components/PageHeader'
import { NativeConnectorGuides } from '../components/NativeConnectorGuides'
import { StatusPill } from '../components/StatusPill'
import { BigQuerySetupForm } from '../components/BigQuerySetupForm'
import { SourceList } from '../components/SourceList'
import { SourceToolChoice } from '../components/SourceToolChoice'
import { SourceAuthorization, SourceAuthorizationResult } from '../components/SourceAuthorization'
import { ToolChecklist } from '../components/ToolChecklist'
import { bigQueryPreflightGuidance } from '../bigQueryFailure'

const bigQueryResourceNames = { application: 'Access application', worker: 'BigQuery Worker', domain: 'custom domain' }

function BigQueryFailure({ setup }: { setup: BigQuerySetups['setups'][number] | undefined }) {
  if (!setup || (!setup.recoveryRequired && !setup.failure)) return null
  return <div role="status" className="mt-3 text-sm text-kumo-subtle">
    {setup.recoveryRequired ? <p>{setup.pendingResource
      ? `Cloudflare did not confirm creation of the ${bigQueryResourceNames[setup.pendingResource]}.`
      : 'A Cloudflare write has an uncertain result.'} Keep this setup’s receipt and review the resource in Cloudflare before making another attempt.</p> : null}
    {setup.failure ? <p className="mt-1">{bigQueryResourceNames[setup.failure.stage]} request failed{setup.failure.httpStatus === null
      ? ' before a response was confirmed.' : ` (HTTP ${setup.failure.httpStatus}).`}</p> : null}
  </div>
}

// The fixed reasons an installation waits, before the Portal, for its operator: to connect the source, for Cloudflare's
// sync, or for the tools to be chosen. They are an expected outcome of installing, not a failed request.
const CONNECTION_PAUSES = new Set([
  'source_connection_required', 'source_sync_required', 'source_tools_mismatch', 'source_tools_required', 'source_tools_chosen',
])
const NO_RECOMMENDED_TOOLS: readonly string[] = []
// The pause reason each live list state stands for. A list that cannot be offered keeps the recorded reason.
const LIVE_PAUSE = {
  connection_required: 'source_connection_required', sync_required: 'source_sync_required', ready: 'source_tools_required',
} satisfies Partial<Record<SourceActionTools['state'], string>>

const actionLabels = {
  authorization_required: 'Waiting for Cloudflare',
  authorization_expired: 'Authorization expired before work began',
  applying: 'Applying and verifying',
  succeeded: 'Installation completed',
  failed: 'Authorization closed',
  recovery_required: 'Recovery required',
} satisfies Record<SourceActionSummary['state'], string>

function sourceDraftLabel(action: SourceActionSummary | undefined): string {
  return action && (action.state !== 'failed' || isBigQueryPreflightFailure(action.failureCode)) ? actionLabel(action) : 'Saved draft'
}

function actionLabel(action: SourceActionSummary): string {
  if (action.failureCode === 'source_removal_required') return action.state === 'applying' ? 'Removing source' : 'Finish removing source'
  if (action.state === 'failed' && isBigQueryPreflightFailure(action.failureCode)) return 'BigQuery setup failed'
  if (action.state === 'recovery_required') {
    if (action.failureCode === 'source_connection_required') return 'Connect your source'
    if (action.failureCode === 'bigquery_setup_required') return 'Resume BigQuery setup'
    if (action.failureCode === 'source_sync_required') return 'Sync source tools'
    if (action.failureCode === 'source_tools_mismatch') return 'Review source tools'
    if (action.failureCode === 'source_tools_required') return 'Choose tools'
    if (action.failureCode === 'source_tools_chosen') return 'Finish installation'
  }
  return actionLabels[action.state]
}

/** A sign-in source installed with nothing enabled: what it waits for, in the order the operator meets it. */
function unchosenToolsGuidance(action: SourceActionSummary): string | null {
  if (action.failureCode === 'source_connection_required') {
    return 'This source is installed with nothing enabled: it is not attached to your Portal and nobody has been assigned access. Authorize the source, then choose which tools to allow from its real list below. If you use Cloudflare for manual setup, keep Require user auth off.'
  }
  if (action.failureCode === 'source_sync_required') {
    return 'This source is installed with nothing enabled. Open it in Cloudflare and sync its capabilities, resolving any connection error. When its status is Ready, come back: this page lists its real tools so you can choose which to allow.'
  }
  if (action.failureCode === 'source_tools_required') {
    return 'This source is connected and nothing is enabled yet. Choose the tools to allow from its real list below; the gateway then attaches it with exactly those. Nobody has been assigned access.'
  }
  return null
}

function actionGuidance(action: SourceActionSummary, pollingPaused: boolean, accountToken: boolean, toolsChosen = true, bridgeSetup = false): string {
  if (action.failureCode === 'source_removal_required') return action.state === 'applying'
    ? 'Your gateway is removing the saved BigQuery bridge and checking that its resources are gone.'
    : 'Finish removing this BigQuery bridge with a fresh Cloudflare approval. Your gateway retains its cleanup records until removal is verified.'
  if (action.state === 'failed' && isBigQueryPreflightFailure(action.failureCode)) {
    return `${bigQueryPreflightGuidance(action.failureCode)} The bridge was not deployed. Continue BigQuery setup after correcting the issue; it needs fresh Cloudflare approval and another key upload.`
  }
  if (bridgeSetup && action.state === 'authorization_required') return 'BigQuery bridge setup needs its own Cloudflare approval and Google key upload. Complete those steps, or use Continue BigQuery setup if you returned before they finished.'
  if (bridgeSetup && action.state === 'authorization_expired') return 'This BigQuery attempt expired before deployment began. Continue BigQuery setup for fresh Cloudflare approval and another key upload.'
  if (bridgeSetup && action.state === 'recovery_required' && action.canRenew === true) return 'Resume BigQuery setup with fresh Cloudflare approval. Your gateway checks the saved resources before continuing; it asks for the Google key again only if the bridge Worker was not deployed.'
  const unchosen = !toolsChosen && action.state === 'recovery_required' ? unchosenToolsGuidance(action) : null
  if (unchosen !== null) return unchosen
  if (accountToken && action.state === 'authorization_required') return 'This installation is prepared in your gateway. Check its status before taking another action. No new Cloudflare consent is needed.'
  if (accountToken && action.state === 'authorization_expired') return 'This attempt expired before provisioning began. Cancel it, then install the saved draft again.'
  switch (action.state) {
    case 'authorization_required':
      return pollingPaused
        ? 'Complete the existing consent in the Cloudflare tab, then use Check status. Another authorization is blocked.'
        : 'Complete the existing consent in the Cloudflare tab. This page checks status automatically; another authorization is blocked.'
    case 'authorization_expired':
      return 'The gateway did not start this attempt. Cancel this authorization, then authorize the saved draft again.'
    case 'applying':
      return 'The gateway is applying the source and verifying Cloudflare resources. Wait for a confirmed result before taking another action.'
    case 'succeeded':
      return 'The source installation was verified. Grant access in Team before sharing it with approved members.'
    case 'failed':
      return action.failureCode === 'source_action_denied'
        ? 'This authorization was cancelled. You can authorize the saved draft again.'
        : 'This attempt is closed. Review the saved draft before starting another authorization.'
    case 'recovery_required':
      if (action.failureCode === 'source_connection_required') {
        return 'Authorize the source to connect it, then review its tools and finish installation. If you use Cloudflare for manual setup, keep Require user auth off. Nobody has been assigned access.'
      }
      if (action.failureCode === 'source_sync_required') {
        return 'Open the server in Cloudflare and sync its capabilities. Resolve any connection error, then return when its status is Ready to resume and finish installation.'
      }
      if (action.failureCode === 'source_tools_mismatch') {
        return 'The synced source is missing one or more tools from your saved selection. Review its catalogue in Cloudflare and restore the selected tools before resuming. The gateway will keep your exact selection.'
      }
      if (action.failureCode === 'source_tools_chosen') {
        return 'Your tool selection is saved. Resume to attach the source with exactly those tools and finish installation. Nobody has been assigned access.'
      }
      return action.canRenew === true
        ? 'Resume this recorded installation using the gateway management credential. The gateway checks the retained resources before continuing.'
        : 'Provisioning may be incomplete or still finishing. Check status after the previous approval expires. The journal is retained; uncertain resource ownership requires review in Cloudflare.'
  }
}

function actionTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

interface SourcesPageProps {
  catalog?: SourceCatalog
}

export function SourcesPage({ catalog = SOURCE_CATALOG }: SourcesPageProps) {
  const {
    api,
    externalChangeVersion,
    clearError,
    clearSourceNotice,
    cancelSourceApply,
    discoverSource,
    getTeam,
    isBusy,
    isCheckingSourceActions,
    prepareSourceApply,
    refreshSourceActions,
    refreshSources,
    saveSourceDraft,
    removeSourceDraft,
    sourceActions,
    sourceActionsError,
    sourceActionsPollingPaused,
    sourceNotice,
    sources,
  } = useGateway()
  const [showForm, setShowForm] = useState(false)
  const [showBigQuery, setShowBigQuery] = useState(false)
  const [bigQuery, setBigQuery] = useState<BigQuerySetups | null>(null)
  const [bigQueryError, setBigQueryError] = useState<string | null>(null)
  const [resumingBigQuery, setResumingBigQuery] = useState(false)
  useEffect(() => {
    let active = true
    void api.getBigQuerySetups().then((value) => { if (active) setBigQuery(value) }).catch(() => { if (active) setBigQuery(null) })
    return () => { active = false }
  }, [api, externalChangeVersion, sourceActions])
  // Installation is off either because this release pauses it or because the gateway has no management token. Only
  // the gateway knows which, and while the token is missing its answer costs no Cloudflare call.
  const tokenInQuestion = sources !== null && sources.installationEnabled !== true && sources.applyMode === 'account_token'
  const [missingToken, setMissingToken] = useState<{ choice: ManagementCredentialChoice | null } | 'configured' | 'unreadable' | null>(null)
  useEffect(() => {
    if (!tokenInQuestion) { setMissingToken(null); return }
    let active = true
    void getTeam().then(async (team) => {
      if (!active) return
      if (team.managementCredentialConfigured === false) { setMissingToken({ choice: team.managementCredentialChoice ?? null }); return }
      // The token arrived after this dashboard loaded its sources: read them again before saying anything is paused.
      await refreshSources().catch(() => {})
      if (active) setMissingToken('configured')
    }).catch(() => { if (active) setMissingToken('unreadable') })
    return () => { active = false }
  }, [getTeam, refreshSources, tokenInQuestion])
  const [sourceMode, setSourceMode] = useState<'catalog' | 'custom'>(catalog.sources.length > 0 ? 'catalog' : 'custom')
  const [catalogSourceId, setCatalogSourceId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [discovery, setDiscovery] = useState<SourceDiscovery | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  // What Cloudflare says about a paused sign-in source right now, by action. The journal records a reason only when
  // the executor runs, so the live list can be ahead of it.
  const [toolLists, setToolLists] = useState<Record<string, SourceActionTools['state']>>({})
  const reportToolList = useCallback((actionId: string, state: SourceActionTools['state']) => {
    setToolLists((current) => current[actionId] === state ? current : { ...current, [actionId]: state })
  }, [])
  const catalogSource = useMemo(
    () => catalog.sources.find((source) => source.sourceId === catalogSourceId) ?? null,
    [catalog.sources, catalogSourceId],
  )

  // A source that needs sign-in answers discovery with a challenge instead of a list: its tools are chosen after the
  // operator has connected it, from the list Cloudflare syncs, so its draft is saved without any.
  const signIn = discovery?.authentication === 'oauth' && discovery.tools.length === 0 && !discovery.connectionBlock
  const enabledTools = useMemo(() => signIn ? [] : [...selected].sort(), [selected, signIn])
  const missingRecommendedTools = useMemo(() => {
    if (!catalogSource || !discovery || discovery.tools.length === 0) return []
    const discoveredNames = new Set(discovery.tools.map((tool) => tool.name))
    return catalogSource.implementation.recommendedTools.filter((tool) => !discoveredNames.has(tool))
  }, [catalogSource, discovery])

  const resumeBigQuery = async (actionId: string) => {
    if (resumingBigQuery || isBusy) return
    setResumingBigQuery(true)
    setBigQueryError(null)
    try {
      const prepared = await api.resumeBigQuery(actionId)
      const destination = validHandoffUrl(prepared.handoffUrl, window.location.origin)
      if (destination === null) throw new Error('The gateway returned an invalid authorization link.')
      window.location.assign(destination)
    } catch (error) {
      setBigQueryError(error instanceof Error ? error.message : 'BigQuery setup could not resume.')
      await refreshSourceActions().catch(() => {})
      setResumingBigQuery(false)
    }
  }
  if (!sources) return null
  const installationEnabled = sources.installationEnabled === true
  // The gateway decides whether installing ends a rollback; this page only says so beside the control that commits to it.
  const rollbackNote = installationEnabled && sources.installEndsRollbackTo ? rollbackEndsMessage(sources.installEndsRollbackTo) : null
  const applyBlocked = isBusy || isCheckingSourceActions || sourceActions === null || sourceActionsError !== null || sourceActions.blockingAction !== null
  // The gateway itself said it has no management token: the page leads to the one way of adding it.
  const tokenIsMissing = !installationEnabled && missingToken !== null && missingToken !== 'configured' && missingToken !== 'unreadable'
  const latestActions = new Map<string, SourceActionSummary>()
  for (const action of sourceActions?.actions ?? []) {
    const previous = latestActions.get(action.sourceId)
    if (!previous || Date.parse(action.issuedAt) >= Date.parse(previous.issuedAt)) latestActions.set(action.sourceId, action)
  }
  const blocker = sourceActions?.blockingAction
  const needsBridgeCleanup = (sourceId: string) => {
    const action = latestActions.get(sourceId)
    const setup = bigQuery?.setups.find((item) => item.sourceId === sourceId)
    return Boolean(action && setup && !setup.recoveryRequired &&
      (action.canRenew || action.failureCode === 'source_removal_required') &&
      action.state !== 'applying' && (!blocker || (blocker.kind === 'source' && blocker.sourceId === sourceId)))
  }
  const canRemoveDraft = (sourceId: string) => sourceActions !== null && sourceActionsError === null &&
    (!blocker || blocker.kind === 'source') &&
    sources.sources.some((source) => source.id === sourceId && source.status === 'draft') &&
    (sourceActions.actions.filter((action) => action.sourceId === sourceId)
      .every((action) => action.state === 'failed' || action.canCancel) || needsBridgeCleanup(sourceId))
  const removeSource = async (sourceId: string) => {
    if (!needsBridgeCleanup(sourceId)) return removeSourceDraft(sourceId)
    setResumingBigQuery(true)
    setBigQueryError(null)
    try {
      const prepared = await api.prepareBigQueryRemoval(sources.revision, sourceId)
      const destination = validHandoffUrl(prepared.handoffUrl, window.location.origin)
      if (destination === null) throw new Error('The gateway returned an invalid authorization link.')
      window.location.assign(destination)
    } catch (error) {
      setBigQueryError(error instanceof Error ? error.message : 'BigQuery removal could not start.')
      await refreshSourceActions().catch(() => {})
      setResumingBigQuery(false)
    }
  }
  const showActionStatus = sources.sources.some((source) => source.status === 'draft') || latestActions.size > 0 || Boolean(blocker) || sourceActionsError !== null

  const clearDraftForm = () => {
    setCatalogSourceId(null)
    setLabel('')
    setUrl('')
    setDiscovery(null)
    setSelected([])
    setFormError(null)
  }

  const chooseCatalogSource = (source: SourceCatalogSource) => {
    clearDraftForm()
    setSourceMode('catalog')
    setCatalogSourceId(source.sourceId)
    setLabel(source.displayName)
    setUrl(source.implementation.deployment.url)
  }

  const chooseSourceMode = (mode: 'catalog' | 'custom') => {
    if (sourceMode === mode) return
    clearDraftForm()
    setSourceMode(mode)
  }

  const inspect = async () => {
    if (!installationEnabled) return
    setFormError(null)
    setDiscovery(null)
    setSelected([])
    try {
      const next = await discoverSource(url.trim())
      if (catalogSource && next.endpoint !== catalogSource.implementation.deployment.url) {
        setDiscovery(null)
        setFormError('The inspected endpoint no longer matches this reviewed catalog entry. Choose a different source or use the custom URL flow.')
        return
      }
      if (catalogSource && next.authentication !== catalogSource.implementation.connection.authMode) {
        setDiscovery(null)
        setFormError('The endpoint authentication no longer matches this reviewed catalog entry. The preset cannot be used until it is reviewed again.')
        return
      }
      const recommendedNames = new Set(catalogSource?.implementation.recommendedTools ?? [])
      setDiscovery(next)
      setSelected(next.tools
        .filter((tool) => !next.connectionBlock && (catalogSource ? recommendedNames.has(tool.name) : tool.defaultSelected === true))
        .map((tool) => tool.name))
      setUrl(next.endpoint)
    } catch (error) { setFormError(error instanceof Error ? error.message : 'Tool discovery failed.') }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!installationEnabled) return
    if (discovery?.connectionBlock) {
      setFormError(GOOGLE_SHARED_OAUTH_BLOCK_MESSAGE)
      return
    }
    if (!discovery || label.trim().length < 2 || (!signIn && enabledTools.length === 0)) {
      setFormError(signIn ? 'Give the source a name of at least two characters.' : 'Give the source a name and select at least one exact tool.')
      return
    }
    setFormError(null)
    try {
      await saveSourceDraft({
        label: label.trim(),
        url: discovery.endpoint,
        authMode: discovery.authentication,
        enabledTools,
      })
      clearDraftForm()
      setSourceMode(catalog.sources.length > 0 ? 'catalog' : 'custom')
      setShowForm(false)
    } catch (error) { setFormError(error instanceof Error ? error.message : 'The source draft could not be saved.') }
  }

  const authorize = async (sourceId: string, renewActionId?: string) => {
    const setup = bigQuery?.setups.find((item) => item.sourceId === sourceId && !item.ready)
    if (setup) { await resumeBigQuery(setup.actionId); return }
    if (!installationEnabled || isBusy || isCheckingSourceActions || sourceActionsError !== null ||
        (renewActionId === undefined && applyBlocked)) return
    try {
      const prepared = renewActionId === undefined
        ? await prepareSourceApply(sourceId)
        : await prepareSourceApply(sourceId, renewActionId)
      if (prepared.status === 'authorization_required') window.location.assign(prepared.handoffUrl)
    } catch (cause) {
      // An installation that waits for its operator is the expected outcome for a sign-in source, and its status
      // card says what it waits for. Every other refusal stays visible as the provider's safe error.
      if (cause instanceof GatewayApiError && CONNECTION_PAUSES.has(cause.code)) clearError()
    }
  }

  return (
    <div>
      <PageHeader
        title="Sources"
        action={
          <div className="flex gap-2">
          {bigQuery?.available ? <Button variant="secondary" className="pressable" disabled={!installationEnabled || applyBlocked} onClick={() => { setShowBigQuery((visible) => !visible); setShowForm(false) }}>{showBigQuery ? 'Close BigQuery' : 'Add BigQuery'}</Button> : null}
          <Button variant="primary" className="pressable" disabled={!installationEnabled} onClick={() => { setShowForm((visible) => !visible); setShowBigQuery(false) }}>
            {showForm ? <X size={16} /> : <Plus size={16} weight="bold" />}
            {showForm ? 'Close' : 'Add source'}
          </Button>
          </div>
        }
      />

      <GatewayEndpoint />
      <SourceAuthorizationResult />
      {bigQueryError ? <p role="alert" className="notice-banner notice-error mt-6">{bigQueryError}</p> : null}
      {showBigQuery && installationEnabled ? <BigQuerySetupForm disabled={applyBlocked || resumingBigQuery} /> : null}

      {tokenIsMissing ? (
        <>
          <ManagementTokenCard choice={missingToken.choice} />
          <p role="status" className="mt-4 text-sm leading-6 text-kumo-subtle">Saved drafts are retained. They can be installed once your gateway has the token.</p>
        </>
      ) : null}
      {!installationEnabled && (sources.applyMode !== 'account_token' || missingToken === 'configured' || missingToken === 'unreadable') ? <p role="status" className="notice-banner notice-warning mt-6">{missingToken === 'unreadable' ? <>Source installation needs a working management token. Check it in <a href="/settings" className="underline">Settings</a>.</> : SOURCE_ADDITION_PAUSED_MESSAGE} Saved drafts are retained but cannot be applied.</p> : null}

      {sourceNotice ? (
        <div role="status" className={`notice-banner mt-6 notice-${sourceNotice.tone}`}>
          <p>{sourceNotice.message}</p>
          <button type="button" className="pressable" aria-label="Dismiss source notice" onClick={clearSourceNotice}><X size={14} /></button>
        </div>
      ) : null}

      {showActionStatus ? (
        <section className="surface-card mt-6 p-5 sm:p-6" aria-labelledby="source-actions-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="source-actions-title" className="text-sm font-semibold text-kumo-strong">Source installation status</h2>
            <Button variant="secondary" className="pressable" disabled={isBusy || isCheckingSourceActions} onClick={() => void refreshSourceActions().catch(() => {})}>
              {isCheckingSourceActions ? 'Checking status…' : 'Check status'}
            </Button>
          </div>
          {sourceActionsError ? <p role="alert" className="mt-3 text-sm text-danger">{sourceActionsError} Applying sources is disabled until status can be checked.</p> : null}
          {!sourceActions && !sourceActionsError ? <p role="status" className="mt-3 text-sm text-kumo-subtle">Checking for existing gateway actions…</p> : null}
          {sourceActionsPollingPaused ? <p role="status" className="mt-3 text-sm text-kumo-subtle">Automatic checks have paused. Use Check status for the latest result; this does not cancel the action.</p> : null}
          {blocker && blocker.kind !== 'source' ? (
            <p role="status" className="mt-3 text-sm leading-6 text-kumo-subtle">
              A gateway {blocker.kind === 'runtime' ? 'update or rollback' : blocker.kind === 'teardown' ? 'removal' : blocker.kind === 'management_credential' ? 'management token' : 'Team access'} action is blocking source installation. Review that action before applying a source.
              <span className="mt-1 block break-all font-mono text-xs">Action: {blocker.actionId}</span>
            </p>
          ) : null}
          {sourceActions && !blocker && latestActions.size === 0 ? <p className="mt-3 text-sm text-kumo-subtle">No source installation is pending.</p> : null}
          <div aria-live="polite">
            {[...latestActions.values()].map((action) => {
              const actionSource = sources.sources.find((source) => source.id === action.sourceId)
              const setup = bigQuery?.setups.find((item) => item.actionId === action.actionId)
              const preflightFailed = action.state === 'failed' && isBigQueryPreflightFailure(action.failureCode)
              // A sign-in source paused before the Portal: its tools are chosen here, from its real list. A BigQuery
              // bridge has a fixed allowlist and its own setup flow.
              const signInPause = actionSource !== undefined && actionSource.status === 'draft' && actionSource.authMode === 'oauth' &&
                action.state === 'recovery_required' && action.failureCode !== null && CONNECTION_PAUSES.has(action.failureCode) &&
                setup === undefined
              const toolsChosen = !signInPause || actionSource.enabledTools.length > 0
              // While nothing is chosen, the card says what the source waits for now, not what it waited for last.
              const live = toolLists[action.actionId]
              const shown = toolsChosen || live === undefined || live === 'unsupported' ? action : { ...action, failureCode: LIVE_PAUSE[live] }
              return (
              <article key={action.actionId} className="mt-4 border-t border-kumo-line pt-4" aria-label={`Installation of ${actionSource?.label ?? action.sourceId}`}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h3 className="text-sm font-semibold text-kumo-strong">{actionSource?.label ?? action.sourceId}</h3>
                  <StatusPill tone={action.state === 'succeeded' ? 'ready' : preflightFailed || action.state === 'recovery_required' || action.state === 'authorization_expired' ? 'attention' : 'waiting'}>{actionLabel(shown)}</StatusPill>
                </div>
                <p className="mt-2 max-w-[80ch] text-sm leading-6 text-kumo-subtle">{actionGuidance(shown, sourceActionsPollingPaused, sources.applyMode === 'account_token' && bigQuery !== null, toolsChosen, setup !== undefined && !setup.ready)}</p>
                {preflightFailed ? <p className="mt-1 break-all font-mono text-xs text-kumo-subtle">Error code: {action.failureCode}</p> : null}
                <p className="mt-2 text-xs leading-5 text-kumo-subtle">
                  Started <time dateTime={action.issuedAt}>{actionTime(action.issuedAt)}</time> · Authorization expires <time dateTime={action.expiresAt}>{actionTime(action.expiresAt)}</time>
                </p>
                <p className="mt-1 break-all font-mono text-xs text-kumo-subtle">Action: {action.actionId}</p>
                {signInPause && action.canRenew === true && sources.applyMode === 'account_token' && shown.failureCode === 'source_connection_required' ? (
                  <SourceAuthorization actionId={action.actionId} sourceId={actionSource.id} revision={sources.revision} disabled={!installationEnabled || isBusy || isCheckingSourceActions} />
                ) : null}
                {action.connectionUrl && action.state === 'recovery_required' ? (
                  <a className="mt-3 inline-flex text-sm underline underline-offset-4" href={action.connectionUrl} target="_blank" rel="noopener noreferrer">Open source in Cloudflare</a>
                ) : null}
                {setup && !setup.ready && !setup.recoveryRequired && (action.canCancel || preflightFailed) ? (
                  <>
                    <Button variant="secondary" className="pressable mt-3" disabled={isBusy || resumingBigQuery || isCheckingSourceActions} onClick={() => void resumeBigQuery(action.actionId)}>Continue BigQuery setup</Button>
                    {rollbackNote ? <p className="mt-2 text-xs leading-5 text-kumo-subtle">{rollbackNote}</p> : null}
                  </>
                ) : null}
                <BigQueryFailure setup={setup} />
                {canRemoveDraft(action.sourceId) ? (
                  <Button variant="secondary-destructive" className="pressable mt-3"
                    disabled={isBusy || resumingBigQuery || isCheckingSourceActions}
                    onClick={() => void removeSource(action.sourceId).catch(() => {})}>{action.failureCode === 'source_removal_required' ? 'Continue removal' : 'Remove source'}</Button>
                ) : null}
                {canRemoveDraft(action.sourceId) && needsBridgeCleanup(action.sourceId) ? (
                  <p className="mt-2 text-xs leading-5 text-kumo-subtle">Removes this source’s bridge from your Cloudflare account. Requires one Cloudflare approval; no Google key upload is needed.</p>
                ) : null}
                {signInPause && action.canRenew === true ? (
                  <SourceToolChoice
                    action={action}
                    source={actionSource}
                    revision={sources.revision}
                    recommendedTools={catalog.sources.find((entry) => entry.implementation.deployment.url === actionSource.url)?.implementation.recommendedTools ?? NO_RECOMMENDED_TOOLS}
                    disabled={!installationEnabled || isBusy}
                    onState={reportToolList}
                  />
                ) : null}
                {signInPause && action.canRenew !== true ? (
                  <p className="mt-3 text-xs leading-5 text-kumo-subtle">Only the administrator who started this installation can choose its tools and finish it.</p>
                ) : null}
                {/* With nothing chosen there is nothing a resume could attach: the choice comes first. */}
                {toolsChosen && action.canRenew === true && action.state === 'recovery_required' && !bigQuery?.setups.some((setup) => setup.actionId === action.actionId && setup.recoveryRequired) ? (
                  <div className="mt-3">
                    <Button variant="secondary" className="pressable" disabled={!installationEnabled || isBusy || isCheckingSourceActions || sourceActionsError !== null} onClick={() => void authorize(action.sourceId, action.actionId)}>Resume installation</Button>
                    {rollbackNote ? <p className="mt-2 text-xs leading-5 text-kumo-subtle">{rollbackNote}</p> : null}
                  </div>
                ) : null}
                {action.canCancel ? (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button variant="secondary" className="pressable" disabled={isBusy || isCheckingSourceActions || sourceActionsError !== null} onClick={() => void cancelSourceApply(action.actionId).catch(() => {})}>Cancel installation</Button>
                    <p className="max-w-[65ch] text-xs leading-5 text-kumo-subtle">The existing consent link will stop working. You can then authorize the saved draft again.</p>
                  </div>
                ) : action.state === 'authorization_required' || action.state === 'authorization_expired' ? (
                  <p className="mt-3 text-xs leading-5 text-kumo-subtle">Only the administrator who started this authorization can cancel it, and only before provisioning starts.</p>
                ) : null}
              </article>
              )
            })}
          </div>
        </section>
      ) : null}

      {showForm && installationEnabled ? (
        <section className="surface-card mt-7 p-5 sm:p-6" aria-labelledby="add-source-title">
          <div className="flex flex-col justify-between gap-4 border-b border-kumo-line pb-5 sm:flex-row sm:items-start">
            <div>
              <h2 id="add-source-title" className="text-base font-semibold text-subheading">Add an MCP source</h2>
              <p className="mt-1 max-w-[65ch] text-sm leading-6 text-kumo-subtle">Choose allowed tools. New sources start with nobody assigned; grant access in Team. Do not enter credentials here.</p>
            </div>
            <StatusPill tone="attention">Exact tools only</StatusPill>
          </div>

          <NativeConnectorGuides />

          <form className="mt-6" onSubmit={save}>
            <fieldset>
              <legend className="text-sm font-medium text-kumo-default">Start with</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="source-mode-button pressable"
                  aria-pressed={sourceMode === 'catalog'}
                  disabled={isBusy || catalog.sources.length === 0}
                  onClick={() => chooseSourceMode('catalog')}
                >
                  Reviewed catalog
                  {catalog.sources.length > 0 ? <span>{catalog.sources.length}</span> : null}
                </button>
                <button
                  type="button"
                  className="source-mode-button pressable"
                  aria-pressed={sourceMode === 'custom'}
                  disabled={isBusy}
                  onClick={() => chooseSourceMode('custom')}
                >
                  <GlobeSimple size={15} /> Custom MCP URL
                </button>
              </div>
              {catalog.sources.length === 0 ? (
                <p className="mt-2 text-xs leading-5 text-kumo-subtle">No reviewed presets ship in this release. Add a compatible remote MCP endpoint directly.</p>
              ) : null}
            </fieldset>

            {sourceMode === 'catalog' && catalogSource === null ? (
              <div className="mt-5 grid gap-3 sm:grid-cols-2" aria-label="Reviewed source catalog">
                {catalog.sources.map((source) => (
                  <article key={source.sourceId} className="catalog-source-card">
                    <div className="flex flex-wrap gap-2">
                      <StatusPill tone="waiting">{source.implementation.connection.authMode === 'oauth' ? 'OAuth' : 'Public'}</StatusPill>
                    </div>
                    <h3 className="mt-4 text-sm font-semibold text-kumo-strong">{source.displayName}</h3>
                    <p className="mt-1 text-xs leading-5 text-kumo-subtle">{source.description}</p>
                    <p className="mt-3 text-[0.6875rem] text-kumo-inactive">
                      {source.implementation.recommendedTools.length} recommended exact tool{source.implementation.recommendedTools.length === 1 ? '' : 's'}
                    </p>
                    <Button type="button" variant="secondary" className="pressable mt-4" disabled={isBusy} onClick={() => chooseCatalogSource(source)}>
                      Select {source.displayName} <ArrowRight size={15} />
                    </Button>
                  </article>
                ))}
              </div>
            ) : null}

            {catalogSource ? (
              <div className="mt-5 rounded-xl border border-kumo-line bg-kumo-tint/55 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-kumo-strong">{catalogSource.displayName}</h3>
                    <p className="mt-1 text-xs leading-5 text-kumo-subtle">
                      Expected {catalogSource.implementation.connection.authMode === 'oauth' ? 'operator-connected OAuth' : 'public access'}. Live inspection must confirm it before you can save.
                    </p>
                  </div>
                  <Button type="button" variant="secondary" className="pressable" disabled={isBusy} onClick={clearDraftForm}>Change source</Button>
                </div>
                <div className="mt-4 flex flex-wrap gap-2" aria-label="Catalog-recommended tools">
                  {catalogSource.implementation.recommendedTools.map((tool) => <code key={tool} className="tool-chip">{tool}</code>)}
                </div>
                <p className="mt-2 text-[0.6875rem] leading-5 text-kumo-inactive">{catalogSource.implementation.connection.authMode === 'oauth'
                  ? 'This source needs sign-in: recommendations are preselected when you choose its tools, after you have connected it. Review every exact name then.'
                  : 'Recommendations are preselected only after inspection. Review every exact name before saving.'}</p>
              </div>
            ) : null}

            {sourceMode === 'custom' || catalogSource ? (
              <>
                <div className="mt-5 grid gap-5 sm:grid-cols-2">
                  <Input className="w-full" label="Source name" placeholder="Company knowledge" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
                  <Input
                    className="w-full"
                    label="MCP URL"
                    type="url"
                    inputMode="url"
                    placeholder="https://knowledge.example.com/mcp"
                    value={url}
                    readOnly={catalogSource !== null}
                    onChange={(event) => { setUrl(event.target.value); setDiscovery(null) }}
                  />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button type="button" variant="secondary" className="pressable" loading={isBusy} onClick={() => void inspect()}>
                    <MagnifyingGlass size={16} /> Inspect source
                  </Button>
                  <p className="text-xs leading-5 text-kumo-subtle">Source-authored names, descriptions, and safety hints are untrusted review aids.</p>
                </div>
              </>
            ) : null}

            {formError ? <p className="field-error" role="alert">{formError}</p> : null}

            {discovery ? (
              <section className="mt-6 border-t border-kumo-line pt-6" aria-labelledby="catalogue-title">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 id="catalogue-title" className="text-sm font-semibold text-subheading">Tool allowlist</h3>
                    <p className="mt-1 text-xs leading-5 text-kumo-subtle">
                      {discovery.authentication === 'oauth' && discovery.tools.length === 0
                        ? 'This source needs sign-in, so its tools can only be listed after you connect it.'
                        : `${discovery.tools.length} tools discovered with MCP ${discovery.protocolVersion ?? 'compatible protocol'}.${catalogSource ? ' Catalog recommendations that still exist are preselected for review.' : ''}`}
                    </p>
                  </div>
                  <StatusPill tone="waiting">{discovery.authentication === 'oauth' ? 'OAuth protected' : 'Public endpoint'}</StatusPill>
                </div>

                {discovery.connectionBlock ? (
                  <p className="mt-5 rounded-xl border border-warning/30 bg-warning-soft p-4 text-xs leading-5 text-warning-strong" role="alert">
                    <strong className="block text-sm">Google connection blocked</strong>
                    {GOOGLE_SHARED_OAUTH_BLOCK_MESSAGE}{' '}
                    <a className="underline" href="https://github.com/ValentinOtt/ankka-mcp-gateway/blob/main/docs/BIGQUERY_GOOGLE_AUTH.md" target="_blank" rel="noreferrer">BigQuery setup guide</a>
                  </p>
                ) : null}

                {discovery.authentication === 'oauth' && discovery.tools.length === 0 ? (
                  signIn ? (
                    <div className="mt-5 max-w-[80ch] text-xs leading-5 text-kumo-subtle" aria-label="What happens next">
                      <p className="text-sm font-medium text-kumo-default">Nothing to choose yet. What happens next:</p>
                      <ol className="mt-2 list-decimal space-y-1.5 pl-5">
                        <li>Save this draft and install it. The gateway creates the source with nothing enabled and nobody assigned, and does not attach it to your Portal.</li>
                        <li>Connect the source once in Cloudflare, as a gateway operator. The connection is shared with the team members you later give access; its credential stays in your Cloudflare account.</li>
                        <li>Come back to this page. It lists the source’s real tools and you choose which to allow. Only those are attached.</li>
                      </ol>
                      {catalogSource ? (
                        <p className="mt-3">The catalog recommends {catalogSource.implementation.recommendedTools.length} tool{catalogSource.implementation.recommendedTools.length === 1 ? '' : 's'} for this source. Those that exist in its real list are preselected when you choose.</p>
                      ) : null}
                    </div>
                  ) : null
                ) : (
                  <div className="mt-5">
                    {missingRecommendedTools.length > 0 ? (
                      <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-tint/55 p-4 text-xs leading-5 text-kumo-subtle" role="status">
                        <strong className="block text-sm text-kumo-strong">Catalog recommendation changed</strong>
                        {missingRecommendedTools.length} recommended exact tool{missingRecommendedTools.length === 1 ? ' is' : 's are'} absent from the current endpoint. Review the live catalogue before saving.
                        <div className="mt-2 flex flex-wrap gap-2">
                          {missingRecommendedTools.map((tool) => <code key={tool} className="tool-chip">{tool}</code>)}
                        </div>
                      </div>
                    ) : null}
                    <ToolChecklist
                      tools={discovery.tools}
                      selected={selected}
                      onChange={setSelected}
                      listLabel="Discovered tools"
                      missingDescription="No description supplied by this MCP server."
                    />
                  </div>
                )}

                <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-kumo-line pt-5">
                  <Button type="submit" variant="primary" className="pressable" loading={isBusy} aria-describedby={signIn && rollbackNote ? 'save-draft-rollback-note' : undefined} disabled={(!signIn && enabledTools.length === 0) || Boolean(discovery.connectionBlock)}>Save draft</Button>
                  <span className="text-xs text-kumo-subtle">{signIn ? 'This draft is saved with no tools. You choose them after connecting the source.' : `${enabledTools.length} exact tool${enabledTools.length === 1 ? '' : 's'} selected`}</span>
                  {/* Older releases cannot read a source saved without tools, so for this one draft the save is what ends a rollback. */}
                  {signIn && rollbackNote ? (
                    <p id="save-draft-rollback-note" className="basis-full text-xs leading-5 text-kumo-subtle">{rollbackNote} Older releases cannot read a source saved without tools.</p>
                  ) : null}
                </div>
              </section>
            ) : null}
          </form>
        </section>
      ) : null}

      <section className="mt-7" aria-label="MCP sources">
        {sources.sources.length === 0 ? (
          <div className="empty-card">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-kumo-tint text-kumo-subtle"><Database size={23} /></div>
            <h2 className="mt-4 text-base font-semibold text-kumo-strong">No sources yet</h2>
            <p className="mt-1.5 max-w-[48ch] text-pretty text-sm leading-6 text-kumo-subtle">{installationEnabled ? 'Add an MCP source and verify that each allowed tool is read-only.' : tokenIsMissing ? 'Your gateway needs its management token before it can install a source.' : 'Source installation is unavailable right now.'}</p>
            <Button variant="secondary" className="pressable mt-5" disabled={!installationEnabled} onClick={() => setShowForm(true)}><Plus size={16} weight="bold" /> Add your first source</Button>
          </div>
        ) : (
          <SourceList
            sources={sources.sources}
            installationEnabled={installationEnabled}
            authorizeDisabled={applyBlocked}
            isBusy={isBusy}
            draftLabel={(sourceId) => sourceDraftLabel(latestActions.get(sourceId))}
            installNote={blocker ? null : rollbackNote}
            onAuthorize={(sourceId) => void authorize(sourceId)}
            canRemove={canRemoveDraft}
            removeDisabled={isCheckingSourceActions || resumingBigQuery}
            onRemove={(sourceId) => void removeSource(sourceId).catch(() => {})}
          />
        )}
      </section>
    </div>
  )
}
