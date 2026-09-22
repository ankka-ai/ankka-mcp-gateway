import { Button } from '../components/Button'
import { AddUserDialog } from '../components/AddUserDialog'
import { MemberAccessDialog } from '../components/MemberAccessDialog'
import { TeamGrantDialog } from '../components/TeamGrantDialog'
import { Check, Trash, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GatewayApiError, SOURCE_ADDITION_PAUSED_MESSAGE, type Team, type TeamAction, type TeamGrant, type TeamMember } from '../api'
import { ManagementTokenCard } from '../components/ManagementTokenCard'
import { PageHeader } from '../components/PageHeader'
import { StatusPill } from '../components/StatusPill'
import { DashboardSkeleton } from '../components/DashboardSkeleton'
import { useGateway } from '../GatewayContext'
import { isGatewayUiPreview } from '../preview-api'

const ACTION_ID = /^action_[A-Za-z0-9_-]{32}$/u

function canonicalTeams(teams: TeamGrant[]): TeamGrant[] {
  return teams.map((team) => ({
    id: team.id,
    name: team.name.trim(),
    memberEmails: [...new Set(team.memberEmails.map((email) => email.trim().toLowerCase()))].sort(),
    sourceIds: [...new Set(team.sourceIds)].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id))
}

function grants(member: TeamMember, teams: TeamGrant[], sources: Team['sources']): string {
  const labels = new Map(sources.map((source) => [source.id, source.label]))
  const reasons = new Map<string, string[]>()
  for (const sourceId of member.sourceIds) {
    const current = reasons.get(sourceId) ?? []
    current.push('Direct')
    reasons.set(sourceId, current)
  }
  for (const team of teams) {
    if (!team.memberEmails.includes(member.email)) continue
    for (const sourceId of team.sourceIds) {
      const current = reasons.get(sourceId) ?? []
      current.push(team.name)
      reasons.set(sourceId, current)
    }
  }
  return [...reasons].map(([sourceId, via]) => `${labels.get(sourceId) ?? sourceId} (${via.join(', ')})`).join('; ')
}

function effectiveAccessText(member: TeamMember, teams: TeamGrant[], sources: Team['sources']): string {
  const access = grants(member, teams, sources)
  return access ? `Effective access: ${access}` : 'Effective access: none'
}

function moveCoveredDirectGrants(members: TeamMember[], team: TeamGrant): TeamMember[] {
  const people = new Set(team.memberEmails)
  const connectors = new Set(team.sourceIds)
  return canonicalMembers(members.map((member) => people.has(member.email)
    ? { ...member, sourceIds: member.sourceIds.filter((sourceId) => !connectors.has(sourceId)) }
    : member))
}

function canonicalMembers(members: TeamMember[]): TeamMember[] {
  return members.map((member) => ({
    email: member.email.trim().toLowerCase(),
    sourceIds: [...new Set(member.sourceIds)].sort(),
  })).sort((a, b) => a.email.localeCompare(b.email))
}

function withAdministrators(team: Team, members: TeamMember[]): TeamMember[] {
  const emails = new Set(members.map((member) => member.email.toLowerCase()))
  return canonicalMembers([
    ...members,
    ...team.adminEmails.filter((email) => !emails.has(email.toLowerCase())).map((email) => ({ email, sourceIds: [] })),
  ])
}

function isRecordedChange(action: TeamAction | null): boolean {
  return action?.status === 'authorization_required' || action?.status === 'applying' || action?.status === 'recovery_required'
}

function actionMessage(action: TeamAction | null): string | null {
  if (!action || action.status === 'succeeded') return null
  const failure = action.failureCode && ['team_management_credential_missing', 'team_management_credential_invalid', 'team_access_group_permission_missing', 'team_policy_drift'].includes(action.failureCode)
    ? `${new GatewayApiError(409, action.failureCode).message} `
    : ''
  // The gateway offers cancellation only while no write is recorded.
  if (action.status === 'recovery_required') return action.canCancel
    ? `${failure}No access policy was changed. Resume the recorded change${failure ? ' once this is fixed' : ''}, or cancel it.`
    : `${failure}Some access policies may already have changed. Resume the exact recorded change below. Nothing was automatically restored.`
  if (action.status === 'applying') return 'Applying and verifying team access. Some policies may already have changed; the saved configuration below is not a live check.'
  if (action.status === 'failed') return action.failureCode === 'team_action_cancelled'
    ? 'The recorded change was canceled before any access policy was changed.'
    : `${failure}The recorded team access change did not complete. Review the saved configuration before trying again.`
  return 'This proposal is retained in your gateway. Save the exact recorded change here to apply and verify it in your Cloudflare account. Hosted authorization is no longer used.'
}

export function TeamPage() {
  const preview = isGatewayUiPreview()
  const { getTeam, getTeamAction, prepareTeamAction, cancelTeamAction, isBusy, sources, externalChangeVersion } = useGateway()
  const [team, setTeam] = useState<Team | null>(null)
  const [draft, setDraft] = useState<TeamMember[]>([])
  const [teamDraft, setTeamDraft] = useState<TeamGrant[]>([])
  const [action, setAction] = useState<TeamAction | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [successActionId, setSuccessActionId] = useState<string | null>(null)
  const actionInFlight = useRef(false)
  const seenExternalChange = useRef(externalChangeVersion)
  const teamReadGeneration = useRef(0)
  const [callbackId, setCallbackId] = useState(() => {
    const value = new URL(window.location.href).searchParams.get('accessAction')
    return value && ACTION_ID.test(value) ? value : null
  })
  const observedActionId = useRef(callbackId)

  const clearCallback = useCallback(() => {
    setCallbackId(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('accessAction')
    url.searchParams.delete('accessActionResult')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  const acceptTeam = useCallback((next: Team) => {
    // A retained completion is history; only confirm an action observed on this visit.
    if (next.pendingAction?.status === 'succeeded' && next.pendingAction.actionId === observedActionId.current) {
      setSuccessActionId(next.pendingAction.actionId)
    }
    observedActionId.current = isRecordedChange(next.pendingAction) ? next.pendingAction?.actionId ?? null : null
    setTeam(next)
    setAction(next.pendingAction)
    setDraft(withAdministrators(next, next.members))
    setTeamDraft(canonicalTeams(next.teams ?? []))
    setNeedsRefresh(false)
    if (next.pendingAction && !['authorization_required', 'applying'].includes(next.pendingAction.status)) clearCallback()
  }, [clearCallback])

  const readTeam = useCallback(async (showLoading = true) => {
    const generation = ++teamReadGeneration.current
    if (showLoading) setLoading(true)
    try {
      const next = await getTeam()
      if (generation !== teamReadGeneration.current) return false
      acceptTeam(next)
      return true
    } catch (cause) {
      if (generation !== teamReadGeneration.current) return false
      throw cause
    } finally {
      if (generation === teamReadGeneration.current) setLoading(false)
    }
  }, [acceptTeam, getTeam])

  const refresh = useCallback(async () => {
    setError(null)
    try {
      if (await readTeam()) clearCallback()
    }
    catch {
      setNeedsRefresh(true)
      setError('Team access could not be loaded. Try again to check the saved configuration and any recorded change before continuing.')
    }
  }, [clearCallback, readTeam])

  useEffect(() => {
    let active = true
    void readTeam().catch(() => {
      if (active) setError('Team access could not be loaded. Try again.')
    })
    const url = new URL(window.location.href)
    if (url.searchParams.has('accessActionResult')) {
      url.searchParams.delete('accessActionResult')
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
    return () => { active = false; teamReadGeneration.current += 1 }
  }, [readTeam])

  const actionId = action?.actionId ?? callbackId
  const shouldPoll = team !== null && !loading && !saving && !isBusy && !needsRefresh && (action?.status === 'applying' || callbackId !== null)

  useEffect(() => {
    if (!actionId || !shouldPoll) return
    let active = true
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = await getTeamAction(actionId)
        if (!active) return
        if (next.actionId !== actionId) throw new Error('action_mismatch')
        observedActionId.current = actionId
        if (next.status === 'succeeded' || next.status === 'failed' || next.status === 'recovery_required') {
          if (await readTeam(false)) clearCallback()
          return
        }
        setAction(next)
        clearCallback()
        if (next.status === 'authorization_required') return
        timer = window.setTimeout(() => { void poll() }, 1500)
      } catch {
        if (active) {
          setNeedsRefresh(true)
          setError('The team access action status is unavailable. Try again to check it before continuing. The saved configuration is not proof of live access.')
        }
      }
    }
    void poll()
    return () => { active = false; window.clearTimeout(timer) }
  }, [actionId, clearCallback, readTeam, getTeamAction, shouldPoll])

  const administrators = useMemo(() => new Set(team?.adminEmails.map((value) => value.toLowerCase()) ?? []), [team?.adminEmails])
  const effectiveMembers = useMemo(() => team ? withAdministrators(team, team.members) : [], [team])
  const effectiveTeams = useMemo(() => canonicalTeams(team?.teams ?? []), [team])
  const recorded = isRecordedChange(action)
  const displayedMembers = recorded ? team?.proposedMembers ?? [] : draft
  const displayedTeams = recorded ? canonicalTeams(team?.proposedTeams ?? effectiveTeams) : teamDraft
  const membersChanged = JSON.stringify(canonicalMembers(draft)) !== JSON.stringify(effectiveMembers)
  const teamsChanged = JSON.stringify(canonicalTeams(teamDraft)) !== JSON.stringify(effectiveTeams)
  const changed = membersChanged || teamsChanged
  useEffect(() => {
    if (changed || needsRefresh) setSuccessActionId(null)
  }, [changed, needsRefresh])
  useEffect(() => {
    if (!successActionId) return
    const timer = window.setTimeout(() => setSuccessActionId(null), 5000)
    return () => window.clearTimeout(timer)
  }, [successActionId])
  useEffect(() => {
    if (seenExternalChange.current === externalChangeVersion) return
    seenExternalChange.current = externalChangeVersion
    if (changed || actionInFlight.current) {
      setNeedsRefresh(true)
      setError('Gateway state may have changed through another action. Your unsaved selections were preserved. Try again to review the saved team before continuing.')
      return
    }
    void refresh()
  }, [externalChangeVersion, changed, refresh])
  const installed = team?.sources.filter((source) => source.status === 'installed') ?? []
  const showSuccess = action?.status === 'succeeded' && action.actionId === successActionId && !changed && !saving && !needsRefresh
  const message = actionMessage(action) ?? (showSuccess ? 'Team access saved and verified in Cloudflare.' : null)
  const disabled = isBusy || saving || loading || needsRefresh || callbackId !== null || recorded || team?.editingEnabled !== true
  const canCancel = (action?.status === 'authorization_required' || action?.status === 'recovery_required') && action.canCancel === true
  // The gateway says it has no management token: lead to the one way of adding it instead of a disabled page.
  const tokenMissing = team?.managementCredentialConfigured === false &&
    team.editingDisabledReason !== 'managed_in_cloudflare' && team.editingDisabledReason !== 'release_review_required'

  const save = async () => {
    if (!team?.editingEnabled || loading || isBusy || needsRefresh || callbackId !== null || actionInFlight.current || action?.status === 'applying' || (!recorded && !changed)) return
    const members = recorded ? team.proposedMembers : canonicalMembers(draft)
    const teams = recorded ? canonicalTeams(team.proposedTeams ?? team.teams ?? []) : canonicalTeams(teamDraft)
    if (!members) return
    actionInFlight.current = true
    setSaving(true)
    setSuccessActionId(null)
    setError(null)
    try {
      const { action: pendingAction } = await prepareTeamAction(team.revision, members, teams)
      if (!ACTION_ID.test(pendingAction.actionId) || (recorded && pendingAction.actionId !== action?.actionId)) {
        throw new GatewayApiError(502, 'team_action_invalid')
      }
      observedActionId.current = pendingAction.actionId
      setAction(pendingAction)
      setTeam((current) => current ? { ...current, pendingAction, proposedMembers: members, proposedTeams: teams } : current)
      if (await readTeam()) clearCallback()
    } catch (cause) {
      setNeedsRefresh(true)
      setError(cause instanceof GatewayApiError ? cause.message : 'The team access change could not be confirmed. Try again to check the recorded state before making another change.')
    } finally { actionInFlight.current = false; setSaving(false) }
  }

  const cancelRecordedChange = async () => {
    if (!canCancel || !action || loading || isBusy || needsRefresh || callbackId !== null || actionInFlight.current) return
    actionInFlight.current = true
    setError(null)
    try {
      const canceled = await cancelTeamAction(action.actionId)
      if (canceled.actionId !== action.actionId || canceled.status !== 'failed' || canceled.failureCode !== 'team_action_cancelled') {
        throw new GatewayApiError(409, 'team_cancel_failed')
      }
      if (await readTeam()) clearCallback()
    } catch (cause) {
      setNeedsRefresh(true)
      setError(cause instanceof GatewayApiError ? cause.message : 'Cancellation could not be confirmed. Try again to check the recorded change before continuing.')
    } finally { actionInFlight.current = false }
  }

  return (
    <div>
      <PageHeader title="Team" />

      {preview ? <p role="status" className="notice-banner notice-neutral mt-6">Local preview — synthetic users; no Cloudflare changes.</p> : null}
      {error ? (
        <div className="mt-6">
          <p role="alert" className="notice-banner notice-error">{error}</p>
          <Button variant="secondary" className="pressable mt-3" loading={loading} disabled={isBusy || saving || (!needsRefresh && !recorded && changed)} onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : null}
      {message ? (
        <div role="status" className={`notice-banner mt-6 flex items-center justify-between gap-3 notice-${showSuccess ? 'success' : action?.status === 'failed' || action?.status === 'recovery_required' ? 'error' : 'neutral'}`}>
          <p>{message}</p>
          {showSuccess ? <button type="button" className="pressable inline-flex size-6 shrink-0 items-center justify-center rounded-md" aria-label="Dismiss team access confirmation" onClick={() => setSuccessActionId(null)}><X size={16} aria-hidden="true" /></button> : null}
        </div>
      ) : null}
      {!team ? loading ? <DashboardSkeleton page="team" showHeader={false} /> : <p className="mt-8 text-sm text-kumo-subtle">No team access information is available.</p> : (
        <>
          {tokenMissing ? <ManagementTokenCard choice={team.managementCredentialChoice} /> : null}
          {tokenMissing && team.editingDisabledReason === 'management_credential_missing' ? <p role="status" className="mt-4 text-sm leading-6 text-kumo-subtle">Until your gateway has the token, you can still inspect the saved access configuration and shared tools.</p> : null}
          {!team.editingEnabled && team.editingDisabledReason !== 'management_credential_missing' && team.editingDisabledReason !== 'managed_in_cloudflare' ? <p role="status" className="notice-banner notice-warning mt-6">{team.editingDisabledReason === 'lifecycle_action_pending' ? 'Another connector, update, teardown, or management token action is in progress. Finish or safely cancel that action, then refresh.' : 'Team access changes are disabled until this gateway release is reviewed and approved.'} You can still inspect the saved access configuration and shared tools.</p> : null}
          {sources && sources.installationEnabled !== true && sources.applyMode !== 'account_token' ? <p role="status" className="notice-banner notice-warning mt-6">{SOURCE_ADDITION_PAUSED_MESSAGE} {team.editingEnabled ? 'You can grant or revoke access to the installed connectors below.' : 'This restriction does not change saved access.'}</p> : null}
          {needsRefresh ? <p role="status" className="notice-banner notice-warning mt-6">Editing is paused until the recorded state can be checked. Trying again reloads the saved configuration and discards unsaved selections; it does not resubmit a change.</p> : null}
          <section className="mt-7" aria-labelledby="named-teams-title">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="named-teams-title" className="text-base font-semibold text-subheading">Teams ({displayedTeams.length})</h2>
              {!recorded ? <TeamGrantDialog team={null} sources={team.sources} disabled={disabled} onSave={(next) => {
                if (!disabled) setTeamDraft((current) => canonicalTeams([...current.filter((item) => item.id !== next.id), next]))
              }} /> : null}
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-kumo-subtle">A team shares one connector allowlist. Direct grants stay until you move them. Access is the combination of a person's direct grants and every team that includes both that person and the connector.</p>
            <div className="mt-5 border-t border-kumo-line">
              {displayedTeams.map((grant) => {
                const moved = moveCoveredDirectGrants(displayedMembers, grant)
                const canMove = !recorded && JSON.stringify(canonicalMembers(moved)) !== JSON.stringify(canonicalMembers(displayedMembers))
                return <div key={grant.id} role="group" aria-label={grant.name} className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-b border-kumo-line/70 py-4">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-kumo-strong">{grant.name}</p>
                    <p className="mt-1 text-xs text-kumo-subtle">{grant.memberEmails.length === 0 ? 'No members yet. This team is not granted until someone is on it.' : grant.memberEmails.join(', ')}</p>
                    <p className="mt-1 text-xs text-kumo-subtle">{grant.sourceIds.length === 0 ? 'No connectors selected.' : grant.sourceIds.map((sourceId) => team.sources.find((source) => source.id === sourceId)?.label ?? sourceId).join(', ')}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {!recorded ? <TeamGrantDialog team={grant} sources={team.sources} disabled={disabled} onSave={(next) => {
                      if (!disabled) setTeamDraft((current) => canonicalTeams(current.map((item) => item.id === grant.id ? next : item)))
                    }} /> : null}
                    {canMove ? <Button type="button" variant="secondary" disabled={disabled} onClick={() => setDraft(moveCoveredDirectGrants(draft, grant))}>Move covered direct grants into this team</Button> : null}
                    {!recorded ? <Button type="button" variant="secondary" disabled={disabled} className="size-9 justify-center p-0" aria-label={`Remove ${grant.name}`} onClick={() => setTeamDraft((current) => current.filter((item) => item.id !== grant.id))}><Trash size={16} aria-hidden="true" /></Button> : null}
                  </div>
                </div>
              })}
              {displayedTeams.length === 0 ? <p className="py-5 text-sm text-kumo-subtle">No teams yet. Direct grants still control access.</p> : null}
            </div>
          </section>
          <section className="mt-7" aria-labelledby="edit-access-title">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="edit-access-title" className="text-base font-semibold text-subheading">{recorded ? 'Recorded change' : `Team members (${draft.length})`}</h2>
              <div className="flex flex-wrap items-center gap-3">
                {recorded || changed ? <StatusPill tone="attention">{recorded ? 'Not fully verified' : 'Unsaved changes'}</StatusPill> : null}
                {!recorded ? <AddUserDialog members={draft} disabled={disabled} onAdd={(email) => {
                  if (!disabled) setDraft((current) => canonicalMembers([...current, { email, sourceIds: [] }]))
                }} /> : null}
              </div>
            </div>

            {recorded ? <p className="notice-banner notice-warning mt-4">{canCancel ? 'Save this exact recorded change, or cancel it before any policy is changed.' : 'This recorded change must be completed exactly before another change can be made.'}</p> : null}

            {recorded && team.proposedMembers === null ? <p role="alert" className="field-error">The recorded proposal is unavailable. Refresh to retrieve it; a different change cannot be submitted.</p> : null}

            <div className="mt-5 border-t border-kumo-line">
              {displayedMembers.map((member) => (
                <div key={member.email} role="group" aria-label={member.email} className="flex min-w-0 items-center justify-between gap-4 border-b border-kumo-line/70 py-4">
                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium text-kumo-strong">{member.email}</p>
                    <p className="mt-1 text-xs text-kumo-subtle">{administrators.has(member.email) ? 'Administrator' : 'Team member'}</p>
                    <p className="mt-1 text-xs text-kumo-subtle">{member.sourceIds.length === 0 ? 'No connectors selected.' : `${member.sourceIds.length} ${member.sourceIds.length === 1 ? 'connector' : 'connectors'} selected`}</p>
                    {displayedTeams.length > 0 ? <p className="mt-1 text-xs text-kumo-subtle">{effectiveAccessText(member, displayedTeams, team.sources)}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <MemberAccessDialog member={member} sources={installed} disabled={disabled} onChange={sourceIds => {
                      if (!disabled) setDraft(current => current.map(person => person.email === member.email ? { ...person, sourceIds } : person))
                    }} />
                    {!administrators.has(member.email) && !recorded ? <Button type="button" variant="secondary" disabled={disabled} className="size-9 justify-center p-0" aria-label={`Remove ${member.email}`} onClick={() => setDraft((current) => current.filter((person) => person.email !== member.email))}><Trash size={16} aria-hidden="true" /></Button> : null}
                  </div>
                </div>
              ))}
              {displayedMembers.length === 0 && !recorded ? <p className="py-5 text-sm text-kumo-subtle">No users have been configured.</p> : null}
            </div>

            {installed.length === 0 ? <p className="mt-3 text-sm text-kumo-subtle">{sources?.installationEnabled === true ? 'Install a connector before granting connector access.' : 'No installed connectors are available to assign. New-connector installation is paused.'}</p> : null}

            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-kumo-line pt-5">
              <Button variant="primary" className="pressable inline-flex items-center gap-2" loading={isBusy || saving} disabled={!team.editingEnabled || loading || saving || isBusy || needsRefresh || callbackId !== null || action?.status === 'applying' || (recorded ? team.proposedMembers === null : !changed)} onClick={() => void save()}>
                <Check size={16} /> {action?.status === 'recovery_required' ? 'Resume recorded change' : recorded ? 'Save recorded change' : 'Save'}
              </Button>
              {canCancel ? <Button variant="secondary" className="pressable inline-flex items-center gap-2" disabled={isBusy || saving || loading || needsRefresh || callbackId !== null} onClick={() => void cancelRecordedChange()}><X size={16} /> Cancel recorded change</Button> : null}
              {!recorded && changed ? <Button variant="secondary" className="pressable inline-flex items-center gap-2" disabled={isBusy || saving} onClick={() => { setDraft(effectiveMembers); setTeamDraft(effectiveTeams) }}>Discard unsaved changes</Button> : null}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
