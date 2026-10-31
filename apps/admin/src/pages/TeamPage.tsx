import { Button } from '../components/Button'
import { AddUserDialog } from '../components/AddUserDialog'
import { MemberAccessDialog } from '../components/MemberAccessDialog'
import { TeamGrantDialog } from '../components/TeamGrantDialog'
import { AgentDialog } from '../components/AgentDialog'
import { AgentEntrancePanel } from '../components/AgentEntrancePanel'
import { AgentToolsDialog } from '../components/AgentToolsDialog'
import { Checkbox } from '../components/Checkbox'
import { Trash, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GatewayApiError, SOURCE_ADDITION_PAUSED_MESSAGE, type AgentGrant, type Team, type TeamAction, type TeamGrant, type TeamMember } from '../api'
import { ManagementTokenCard } from '../components/ManagementTokenCard'
import { PageHeader } from '../components/PageHeader'
import { StatusPill } from '../components/StatusPill'
import { DashboardSkeleton } from '../components/DashboardSkeleton'
import { useGateway } from '../GatewayContext'
import { isGatewayUiPreview } from '../preview-api'

const ACTION_ID = /^action_[A-Za-z0-9_-]{32}$/u
const AGENT_OUTCOME_WORDS = {
  ok: 'Answered', tool_error: 'Tool error', rpc_error: 'Refused by the Portal', refused: 'Not on its tool list',
  portal_denied: 'Denied by Cloudflare', portal_error: 'Portal error', failed: 'Failed', too_large: 'Answer too large', cancelled: 'Cancelled',
} satisfies Record<Team['agentCalls'][number]['outcome'], string>

function canonicalTeams(teams: TeamGrant[]): TeamGrant[] {
  return teams.map((team) => {
    const normalized: TeamGrant = {
      id: team.id,
      name: team.name.trim(),
      memberEmails: [...new Set(team.memberEmails.map(email => email.trim().toLowerCase()))].sort(),
      sourceIds: [...new Set(team.sourceIds)].sort(),
    }
    if (team.allSources) normalized.allSources = true
    return normalized
  }).sort((left, right) => left.id.localeCompare(right.id))
}

function canonicalAgents(agents: AgentGrant[]): AgentGrant[] {
  return agents.map((agent) => {
    const normalized: AgentGrant = { id: agent.id, name: agent.name.trim(), clientId: agent.clientId, tokenId: agent.tokenId, enabled: agent.enabled }
    if (agent.teamId !== undefined) normalized.teamId = agent.teamId
    else normalized.sourceIds = [...new Set(agent.sourceIds ?? [])].sort()
    if (agent.tools !== undefined) normalized.tools = [...agent.tools]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.name.localeCompare(right.name))
    return normalized
  }).sort((left, right) => left.id.localeCompare(right.id))
}

/** The connectors an agent reaches once saved: its list, or its team's, limited to connectors that admit agents. */
function agentReach(agent: AgentGrant, teams: TeamGrant[], sources: Team['sources']): string[] {
  const available = new Set(sources.filter(source => source.agentAccess === 'available').map(source => source.id))
  const listed = agent.teamId !== undefined ? teams.find(team => team.id === agent.teamId)?.sourceIds ?? [] : agent.sourceIds ?? []
  return listed.filter(id => available.has(id)).sort()
}

/** Where an agent policy drifted, and the one way to clear it: no secret, no provider text. */
function agentDriftMessage(team: Team): string {
  const drift = team.agentDrift
  if (!drift) return ''
  const where = drift.policyKind === 'portal_agents' ? 'the Portal'
    : `${team.sources.find(source => source.id === drift.sourceId)?.label ?? 'a connector'}`
  return drift.reason === 'team_agent_policy_missing'
    ? `The agent policy on ${where} was deleted in Cloudflare. Switch off or remove the agents that used it and save; switch them on again afterwards to recreate it. Other Team changes wait until then.`
    : `The agent policy on ${where} was changed in Cloudflare, or another policy uses its name. Restore it exactly as saved, or delete the copy, then refresh. Team changes wait until then; this page will not reset it.`
}

function membersForTeams(members: TeamMember[], teams: TeamGrant[]): TeamMember[] {
  const groupedEmails = new Set(teams.flatMap(team => team.memberEmails))
  return canonicalMembers(members.map(member => groupedEmails.has(member.email) ? { ...member, sourceIds: [], allSources: false } : member))
}

function canonicalMembers(members: TeamMember[]): TeamMember[] {
  return members.map((member) => {
    const normalized: TeamMember = { email: member.email.trim().toLowerCase(), sourceIds: [...new Set(member.sourceIds)].sort() }
    if (member.dashboardAccess !== undefined) normalized.dashboardAccess = member.dashboardAccess
    if (member.allSources) normalized.allSources = true
    return normalized
  }).sort((a, b) => a.email.localeCompare(b.email))
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
  const { api, getTeam, getTeamAction, prepareTeamAction, cancelTeamAction, setAgentEntrance, removeAgentEntrance, isBusy, sources, externalChangeVersion } = useGateway()
  const [team, setTeam] = useState<Team | null>(null)
  const [draft, setDraft] = useState<TeamMember[]>([])
  const [teamDraft, setTeamDraft] = useState<TeamGrant[]>([])
  const [agentDraft, setAgentDraft] = useState<AgentGrant[]>([])
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
    setAgentDraft(canonicalAgents(next.agents ?? []))
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
  const effectiveAgents = useMemo(() => canonicalAgents(team?.agents ?? []), [team])
  const recorded = isRecordedChange(action)
  const displayedMembers = recorded ? team?.proposedMembers ?? [] : draft
  const displayedTeams = recorded ? canonicalTeams(team?.proposedTeams ?? effectiveTeams) : teamDraft
  const displayedAgents = recorded ? canonicalAgents(team?.proposedAgents ?? effectiveAgents) : agentDraft
  const membersChanged = JSON.stringify(canonicalMembers(draft)) !== JSON.stringify(effectiveMembers)
  const teamsChanged = JSON.stringify(canonicalTeams(teamDraft)) !== JSON.stringify(effectiveTeams)
  const agentsChanged = JSON.stringify(canonicalAgents(agentDraft)) !== JSON.stringify(effectiveAgents)
  const changed = membersChanged || teamsChanged || agentsChanged
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
    const members = recorded ? team.proposedMembers : membersForTeams(draft, teamDraft)
    const teams = recorded ? canonicalTeams(team.proposedTeams ?? team.teams ?? []) : canonicalTeams(teamDraft)
    // Agents are sent only when they change, or exactly as a recorded change carries them.
    const agents = recorded ? team.proposedAgents ?? undefined : agentsChanged ? canonicalAgents(agentDraft) : undefined
    if (!members) return
    if (!recorded && agents?.some(agent => agent.teamId !== undefined && !teams.some(grant => grant.id === agent.teamId))) {
      setError(new GatewayApiError(400, 'team_agent_team_missing').message)
      return
    }
    actionInFlight.current = true
    setSaving(true)
    setSuccessActionId(null)
    setError(null)
    try {
      const { action: pendingAction } = await prepareTeamAction(team.revision, members, teams, agents)
      if (!ACTION_ID.test(pendingAction.actionId) || (recorded && pendingAction.actionId !== action?.actionId)) {
        throw new GatewayApiError(502, 'team_action_invalid')
      }
      observedActionId.current = pendingAction.actionId
      setAction(pendingAction)
      setTeam((current) => current ? { ...current, pendingAction, proposedMembers: members, proposedTeams: teams, proposedAgents: agents ?? null } : current)
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

  const updateMember = (member: TeamMember) => {
    setDraft(current => membersForTeams([...current.filter(person => person.email !== member.email), member], teamDraft))
  }
  const updateTeams = (next: TeamGrant[]) => {
    setTeamDraft(canonicalTeams(next))
    const knownEmails = new Set([...teamDraft, ...next].flatMap(grant => grant.memberEmails))
    setDraft(current => membersForTeams([
      ...current,
      ...[...knownEmails].filter(email => !current.some(member => member.email === email)).map(email => ({ email, sourceIds: [] })),
    ], next))
  }
  const groupedEmails = new Set(displayedTeams.flatMap(grant => grant.memberEmails))
  const defaultMembers = displayedMembers.filter(member => !groupedEmails.has(member.email))
  const membersByEmail = new Map(displayedMembers.map(member => [member.email, member]))
  for (const email of groupedEmails) {
    if (!membersByEmail.has(email)) membersByEmail.set(email, { email, sourceIds: [] })
  }
  const renderMember = (member: TeamMember, grant?: TeamGrant) => (
    <div key={member.email} role="group" aria-label={member.email} className="flex min-w-0 items-center justify-between gap-4 border-b border-kumo-line/70 py-4">
      <div className="min-w-0">
        <p className="break-all text-sm font-medium text-kumo-strong">{member.email}</p>
        <p className="mt-1 text-xs text-kumo-subtle">{administrators.has(member.email) ? 'Deployment administrator' : member.dashboardAccess ? 'Dashboard administrator' : 'Team member'}</p>
        {!grant ? <p className="mt-1 text-xs text-kumo-subtle">{member.allSources ? 'All MCPs, including future additions' : member.sourceIds.length === 0 ? 'No connectors selected.' : `${member.sourceIds.length} ${member.sourceIds.length === 1 ? 'connector' : 'connectors'} selected`}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <MemberAccessDialog dashboardAccessAvailable={team?.dashboardAccessAvailable === true} connectorAccessFromTeam={!!grant}
          onAllSourcesChange={allSources => {
            if (!disabled && !grant) updateMember({ ...member, allSources, sourceIds: allSources ? installed.map(source => source.id) : member.sourceIds })
          }}
          deploymentAdministrator={administrators.has(member.email)}
          onDashboardAccessChange={dashboardAccess => {
            if (!disabled) updateMember({ ...member, dashboardAccess })
          }} member={member} sources={installed} disabled={disabled} onChange={sourceIds => {
          if (!disabled && !grant) updateMember({ ...member, sourceIds })
        }} />
        {(grant || !administrators.has(member.email)) && !recorded ? <Button type="button" variant="secondary" disabled={disabled} className="size-9 justify-center p-0" aria-label={grant ? `Remove ${member.email} from ${grant.name}` : `Remove ${member.email}`} onClick={() => {
          if (grant) updateTeams(teamDraft.map(item => item.id === grant.id ? { ...item, memberEmails: item.memberEmails.filter(email => email !== member.email) } : item))
          else setDraft(current => current.filter(person => person.email !== member.email))
        }}><Trash size={16} aria-hidden="true" /></Button> : null}
      </div>
    </div>
  )

  const updateAgent = (agent: AgentGrant) => setAgentDraft(current => canonicalAgents([...current.filter(entry => entry.id !== agent.id), agent]))
  const renderAgent = (agent: AgentGrant) => {
    const followed = agent.teamId !== undefined ? displayedTeams.find(grant => grant.id === agent.teamId) : undefined
    const reach = agentReach(agent, displayedTeams, team?.sources ?? [])
    const saved = team?.agents.find(entry => entry.id === agent.id)
    // A followed team can gain connectors after a save: Cloudflare has what was last applied until the next save.
    const pendingReach = !recorded && !changed && saved !== undefined && saved.enabled &&
      JSON.stringify(agentReach(saved, effectiveTeams, team?.sources ?? [])) !== JSON.stringify(saved.appliedSourceIds)
    const summary = agent.teamId !== undefined
      ? `Follows ${followed?.name ?? 'a team that no longer exists'}: ${reach.length} ${reach.length === 1 ? 'connector' : 'connectors'}`
      : `${reach.length} ${reach.length === 1 ? 'connector' : 'connectors'} selected`
    return <div key={agent.id} role="group" aria-label={agent.name} className="flex min-w-0 items-center justify-between gap-4 border-b border-kumo-line/70 py-4">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium text-kumo-strong">{agent.name}</p>
        <p className="mt-1 break-all font-mono text-xs text-kumo-subtle">{agent.clientId}</p>
        <p className="mt-1 text-xs text-kumo-subtle">{summary}</p>
        {pendingReach ? <p className="mt-1 text-xs text-kumo-subtle">Its team changed since the last save. Save to apply its connectors in Cloudflare.</p> : null}
        <p className="mt-1 text-xs text-kumo-subtle">{saved?.lastUsedAt ? `Last used ${new Date(saved.lastUsedAt).toLocaleString()}` : 'Not used yet'}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-kumo-strong">
          <Checkbox checked={agent.enabled} disabled={disabled} aria-label={`Allow ${agent.name} to connect`} onChange={(event) => {
            if (!disabled) updateAgent({ ...agent, enabled: event.target.checked })
          }} />
          {agent.enabled ? 'On' : 'Off'}
        </label>
        {!recorded ? <AgentToolsDialog agent={agent} reach={reach} sources={team?.sources ?? []} disabled={disabled}
          loadTools={(sourceId) => api.getInstalledSourceTools(sourceId)} onSave={(tools) => {
            if (!disabled) updateAgent({ ...agent, tools })
          }} /> : null}
        {!recorded ? <AgentDialog agent={agent} agents={agentDraft} sources={team?.sources ?? []} teams={teamDraft} disabled={disabled} onSave={(next) => {
          if (!disabled) updateAgent(next)
        }} /> : null}
        {!recorded ? <Button type="button" variant="secondary" disabled={disabled} className="size-9 justify-center p-0" aria-label={`Remove ${agent.name}`} onClick={() => setAgentDraft(current => current.filter(entry => entry.id !== agent.id))}><Trash size={16} aria-hidden="true" /></Button> : null}
      </div>
    </div>
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
          {team.agentDrift ? <p role="alert" className="notice-banner notice-warning mt-6">{agentDriftMessage(team)}</p> : null}
          {needsRefresh ? <p role="status" className="notice-banner notice-warning mt-6">Editing is paused until the recorded state can be checked. Trying again reloads the saved configuration and discards unsaved selections; it does not resubmit a change.</p> : null}
          <section className="mt-7" aria-label="Team members">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                {recorded ? <h2 className="text-base font-semibold text-subheading">Recorded change</h2> : null}
                {recorded || changed ? <StatusPill tone="attention">{recorded ? 'Not fully verified' : 'Unsaved changes'}</StatusPill> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!recorded ? <>
                  <TeamGrantDialog team={null} sources={team.sources} disabled={disabled} onSave={(next) => {
                    if (!disabled) updateTeams([...teamDraft.filter(item => item.id !== next.id), next])
                  }} />
                  <AddUserDialog members={[...membersByEmail.values()]} disabled={disabled} onAdd={(email) => {
                    if (!disabled) setDraft(current => canonicalMembers([...current, { email, sourceIds: [] }]))
                  }} />
                </> : null}
              </div>
            </div>

            {recorded ? <p className="notice-banner notice-warning mt-4">{canCancel ? 'Save this exact recorded change, or cancel it before any policy is changed.' : 'This recorded change must be completed exactly before another change can be made.'}</p> : null}
            {recorded && team.proposedMembers === null ? <p role="alert" className="field-error">The recorded proposal is unavailable. Refresh to retrieve it; a different change cannot be submitted.</p> : null}

            <section className="mt-6" aria-labelledby="default-team-title">
              <h2 id="default-team-title" className="text-base font-semibold text-subheading">Default ({defaultMembers.length})</h2>
              <p className="mt-1 text-xs text-kumo-subtle">Members without a team.</p>
              <div className="mt-4 border-t border-kumo-line">
                {defaultMembers.map(member => renderMember(member))}
                {defaultMembers.length === 0 ? <p className="py-4 text-sm text-kumo-subtle">No members without a team.</p> : null}
              </div>
            </section>

            {displayedTeams.map(grant => {
              const members = grant.memberEmails.map(email => membersByEmail.get(email) ?? { email, sourceIds: [] })
              return <section key={grant.id} role="group" aria-label={grant.name} className="mt-7">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="break-words text-base font-semibold text-subheading">{grant.name} ({members.length})</h2>
                  <div className="flex flex-wrap items-center gap-2">
                    {!recorded ? <TeamGrantDialog team={grant} sources={team.sources} disabled={disabled} onSave={(next) => {
                      if (!disabled) updateTeams(teamDraft.map(item => item.id === grant.id ? next : item))
                    }} /> : null}
                    {!recorded ? <Button type="button" variant="secondary" disabled={disabled} className="size-9 justify-center p-0" aria-label={`Remove ${grant.name}`} onClick={() => updateTeams(teamDraft.filter(item => item.id !== grant.id))}><Trash size={16} aria-hidden="true" /></Button> : null}
                  </div>
                </div>
                <div className="mt-4 border-t border-kumo-line">
                  {members.map(member => renderMember(member, grant))}
                  {members.length === 0 ? <p className="py-4 text-sm text-kumo-subtle">No members yet.</p> : null}
                </div>
              </section>
            })}

            <section className="mt-9" aria-labelledby="agents-title">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 id="agents-title" className="text-base font-semibold text-subheading">Agents ({displayedAgents.length})</h2>
                  <p className="mt-1 text-xs leading-5 text-kumo-subtle">Hosted agents that connect with their own Cloudflare Access service token instead of a person’s sign-in. They never reach Gateway Management or this dashboard.</p>
                </div>
                {!recorded ? <AgentDialog agent={null} agents={agentDraft} sources={team.sources} teams={teamDraft} disabled={disabled} onSave={(next) => {
                  if (!disabled) updateAgent(next)
                }} /> : null}
              </div>
              <AgentEntrancePanel entrance={team.agentEntrance} disabled={!team.editingEnabled || isBusy || saving}
                onTurnOn={(hostname) => setAgentEntrance(hostname)} onTurnOff={() => removeAgentEntrance()} />
              <div className="mt-4 border-t border-kumo-line">
                {displayedAgents.map(agent => renderAgent(agent))}
                {displayedAgents.length === 0 ? <p className="py-4 text-sm text-kumo-subtle">No agents.</p> : null}
              </div>
              {team.agentCalls.length > 0 ? <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium text-kumo-strong">Recent agent calls ({team.agentCalls.length})</summary>
                <p className="mt-2 text-xs text-kumo-subtle">One line per tool call through the agent entrance, newest first. No arguments or results are kept.</p>
                <ul className="mt-2 divide-y divide-kumo-line/70 text-xs">
                  {team.agentCalls.map((call, index) => <li key={`${call.at}-${index}`} className="flex flex-wrap gap-x-3 gap-y-1 py-2 text-kumo-subtle">
                    <span>{new Date(call.at).toLocaleString()}</span>
                    <span className="text-kumo-strong">{team.agents.find(entry => entry.id === call.agentId)?.name ?? 'Removed agent'}</span>
                    <span className="break-all font-mono">{call.tool}</span>
                    <span>{AGENT_OUTCOME_WORDS[call.outcome]}</span>
                    <span>{call.durationMs} ms</span>
                    <span>{call.responseBytes} bytes</span>
                  </li>)}
                </ul>
              </details> : null}
            </section>

            {installed.length === 0 ? <p className="mt-3 text-sm text-kumo-subtle">{sources?.installationEnabled === true ? 'Install a connector before granting connector access.' : 'No installed connectors are available to assign. New-connector installation is paused.'}</p> : null}

            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-kumo-line pt-5">
              <Button variant="primary" className="pressable inline-flex items-center gap-2" loading={isBusy || saving} disabled={!team.editingEnabled || loading || saving || isBusy || needsRefresh || callbackId !== null || action?.status === 'applying' || (recorded ? team.proposedMembers === null : !changed)} onClick={() => void save()}>
                {action?.status === 'recovery_required' ? 'Resume recorded change' : recorded ? 'Save recorded change' : 'Save'}
              </Button>
              {canCancel ? <Button variant="secondary" className="pressable inline-flex items-center gap-2" disabled={isBusy || saving || loading || needsRefresh || callbackId !== null} onClick={() => void cancelRecordedChange()}><X size={16} /> Cancel recorded change</Button> : null}
              {!recorded && changed ? <Button variant="secondary" className="pressable inline-flex items-center gap-2" disabled={isBusy || saving} onClick={() => { setDraft(effectiveMembers); setTeamDraft(effectiveTeams); setAgentDraft(effectiveAgents) }}>Discard unsaved changes</Button> : null}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
