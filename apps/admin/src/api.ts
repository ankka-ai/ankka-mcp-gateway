import * as v from 'valibot'

const sourceAuthModeSchema = v.picklist(['none', 'oauth'])
const sourceStatusSchema = v.picklist(['installed', 'draft'])
const runtimeOperationSchema = v.picklist(['update', 'rollback'])
const actionStatusSchema = v.picklist([
  'authorization_required',
  'applying',
  'succeeded',
  'failed',
  'recovery_required',
])
const runtimeVersionSchema = v.strictObject({
  release: v.string(),
  artifactSha256: v.string(),
})
const preparedActionSchema = v.strictObject({
  schemaVersion: v.literal(1),
  actionId: v.string(),
  status: v.literal('authorization_required'),
  expiresAt: v.string(),
  handoffUrl: v.string(),
})
const sourceApplyResultSchema = v.union([
  preparedActionSchema,
  v.strictObject({ schemaVersion: v.literal(1), actionId: v.string(),
    status: v.literal('succeeded'), expiresAt: v.string() }),
])
const controlPlaneOriginSchema = v.pipe(
  v.string(),
  v.check(validControlPlaneOrigin),
)
const gatewayStatusSchema = v.strictObject({
  schemaVersion: v.literal(1),
  status: v.literal('ready'),
  controlPlaneOrigin: controlPlaneOriginSchema,
  release: v.string(),
  gateway: v.strictObject({
    name: v.string(),
    hostname: v.string(),
    mcpUrl: v.string(),
    capabilityMode: v.literal('read_only'),
    codeMode: v.literal('default_on'),
  }),
  source: v.nullable(v.strictObject({
    label: v.string(),
    endpoint: v.string(),
    enabledTools: v.array(v.string()),
  })),
  access: v.strictObject({
    administratorCount: v.number(),
    memberCount: v.number(),
  }),
  // The one machine identity the gateway admits; null on every gateway the hosted installer deploys.
  serviceIdentity: v.optional(v.nullable(v.strictObject({ clientId: v.string() }))),
  updatedAt: v.string(),
})
const managedSourceSchema = v.strictObject({
  id: v.string(),
  label: v.string(),
  url: v.string(),
  authMode: sourceAuthModeSchema,
  onBehalfOfUser: v.boolean(),
  enabledTools: v.array(v.string()),
  status: sourceStatusSchema,
})
const managedSourcesSchema = v.strictObject({
  schemaVersion: v.literal(1),
  revision: v.number(),
  applyMode: v.picklist(['oauth_per_action', 'account_token']),
  installationEnabled: v.optional(v.boolean(), false),
  // The release a rollback can still restore today and no longer could once a source installation starts;
  // null or absent whenever installing decides nothing about rollback. The gateway decides, never this page.
  installEndsRollbackTo: v.optional(v.nullable(v.string())),
  sources: v.array(managedSourceSchema),
})
const discoveredToolSchema = v.strictObject({
  name: v.string(),
  title: v.nullish(v.string()),
  description: v.nullish(v.string()),
  readOnlyHint: v.nullish(v.boolean()),
  destructiveHint: v.nullish(v.boolean()),
  openWorldHint: v.nullish(v.boolean()),
  defaultSelected: v.optional(v.boolean()),
})
const sourceDiscoverySchema = v.strictObject({
  schemaVersion: v.literal(1),
  status: v.picklist(['discovered', 'authorization_required']),
  endpoint: v.string(),
  protocolVersion: v.nullable(v.string()),
  authentication: sourceAuthModeSchema,
  tools: v.array(discoveredToolSchema),
  connectionBlock: v.optional(v.literal('source_google_shared_oauth_unsupported')),
})
const bigQuerySetupsSchema = v.strictObject({
  schemaVersion: v.literal(1), available: v.boolean(), setups: v.array(v.strictObject({
    sourceId: v.string(), actionId: v.string(), ready: v.boolean(), credentialRequired: v.boolean(), recoveryRequired: v.boolean(),
    pendingResource: v.optional(v.nullable(v.picklist(['application', 'worker', 'domain']))),
    failure: v.optional(v.nullable(v.strictObject({ stage: v.picklist(['application', 'worker', 'domain']),
      httpStatus: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(100), v.maxValue(599))),
    }))),
  })),
})
const bigQueryPreparedSchema = v.strictObject({
  schemaVersion: v.literal(1), actionId: v.string(), sourceId: v.string(), expiresAt: v.string(), handoffUrl: v.string(),
})
export type BigQuerySetups = v.InferOutput<typeof bigQuerySetupsSchema>
export type BigQueryPrepared = v.InferOutput<typeof bigQueryPreparedSchema>
export interface BigQuerySetupInput {
  revision: number
  label: string
  configuration: { queryProjectId: string; allowedDatasets: { projectId: string; datasetId: string }[] }
  readOnlyConfirmed: true
}

const BIGQUERY_PREFLIGHT_FAILURE = /^bigquery_(?:google_key_invalid|google_auth_(?:unavailable|response_invalid|http_[1-5][0-9]{2})|google_query_(?:unavailable|rejected|http_[1-5][0-9]{2})|google_response_invalid|runtime_unavailable|setup_failed)$/u
export function isBigQueryPreflightFailure(code: string | null): code is string {
  return code !== null && BIGQUERY_PREFLIGHT_FAILURE.test(code)
}

const sourceActionFailureCodes = new Set([
  'source_action_denied', 'source_action_recovery_required', 'source_action_state_unavailable',
  'source_action_conflict', 'source_action_drift', 'source_discovery_failed', 'source_action_invalid',
  'source_action_authorization_failed', 'source_resource_collision', 'source_action_legacy_policy',
  'source_connection_required', 'source_sync_required', 'source_tools_mismatch', 'bigquery_setup_required',
  // A sign-in source waits with nothing enabled: for its tools to be chosen, then for the chosen tools to be attached.
  'source_tools_required', 'source_tools_chosen',
])
/** Who prepared an action: an administrator, or the gateway's one configured service identity. */
const actorKindSchema = v.optional(v.picklist(['human', 'service']))
const sourceActionSchema = v.strictObject({
  schemaVersion: v.literal(1),
  actionId: v.string(),
  sourceId: v.string(),
  actorKind: actorKindSchema,
  status: actionStatusSchema,
  expiresAt: v.string(),
  failureCode: v.nullable(v.pipe(v.string(), v.transform((code) => sourceActionFailureCodes.has(code) || isBigQueryPreflightFailure(code) ? code : 'source_action_failed'))),
})
const sourceActionStateSchema = v.picklist([
  'authorization_required', 'authorization_expired', 'applying', 'succeeded', 'failed', 'recovery_required',
])
const sourceActionPointerSchema = v.strictObject({
  kind: v.picklist(['source', 'runtime', 'teardown', 'team', 'management_credential']),
  actionId: v.pipe(v.string(), v.regex(/^action_[A-Za-z0-9_-]{32}$/u)),
  sourceId: v.optional(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,31}$/u))),
})
const sourceActionSummarySchema = v.strictObject({
  ...sourceActionSchema.entries,
  actionId: sourceActionPointerSchema.entries.actionId,
  sourceId: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,31}$/u)),
  issuedAt: v.string(),
  state: sourceActionStateSchema,
  canCancel: v.boolean(),
  canRenew: v.optional(v.boolean()),
  connectionUrl: v.optional(v.pipe(v.string(), v.regex(/^https:\/\/dash\.cloudflare\.com\/[a-f0-9]{32}\/one\/access-controls\/ai-controls\/mcp-server\/edit\/[a-z0-9_-]+$/u))),
})
const sourceActionsSchema = v.strictObject({
  schemaVersion: v.literal(1),
  actions: v.array(sourceActionSummarySchema),
  blockingAction: v.nullable(sourceActionPointerSchema),
  // From the installation's durable record: removal has begun deleting. The removal journal alone forgets an
  // interrupted attempt once a later authorization replaces it. Absent when the gateway could not read the record.
  removalStarted: v.optional(v.boolean()),
})
/**
 * The real tools of a paused sign-in installation, from Cloudflare's synced list. Cloudflare types a synced tool as an
 * untyped map, so the gateway passes on a title, a description or a hint only when the record carries it; `tools` is
 * empty unless `state` is `ready`.
 */
const sourceActionToolsSchema = v.strictObject({
  schemaVersion: v.literal(1),
  actionId: sourceActionPointerSchema.entries.actionId,
  sourceId: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,31}$/u)),
  state: v.picklist(['connection_required', 'sync_required', 'unsupported', 'ready']),
  tools: v.pipe(v.array(discoveredToolSchema), v.maxLength(500)),
})
/** A saved tool choice: the draft revision the paused installation is now bound to, and its exact allowlist. */
const sourceToolChoiceSchema = v.strictObject({
  schemaVersion: v.literal(1),
  actionId: sourceActionPointerSchema.entries.actionId,
  sourceId: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,31}$/u)),
  revision: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  enabledTools: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))), v.minLength(1), v.maxLength(500)),
})
const sourceActionConflictReasonSchema = v.picklist([
  'draft_changed', 'source_pending', 'lifecycle_pending', 'recovery_required',
])
const sourceActionConflictSchema = v.strictObject({
  reason: v.optional(sourceActionConflictReasonSchema),
  action: v.optional(sourceActionPointerSchema),
})
const runtimeUpdateSchema = v.strictObject({
  schemaVersion: v.literal(1),
  channel: v.picklist(['canary', 'stable']),
  status: v.picklist(['available', 'up_to_date', 'newer_than_channel', 'unavailable']),
  current: v.nullable(runtimeVersionSchema),
  available: v.nullable(v.strictObject({
    release: v.string(),
    artifactSha256: v.string(),
    sourceCommit: v.string(),
    classification: v.strictObject({
      kind: v.literal('normal'),
      updaterProtocol: v.literal(2),
      changes: v.array(v.string()),
      excludes: v.array(v.string()),
    }),
    notes: v.array(v.string()),
  })),
  rollback: v.union([
    v.strictObject({ available: v.literal(false) }),
    // A previous release is recorded, but the gateway's saved state no longer allows restoring it.
    v.strictObject({ available: v.literal(false), reason: v.literal('minimum_runtime_release'), release: v.string() }),
    v.strictObject({
      available: v.literal(true),
      release: v.string(),
      artifactSha256: v.string(),
      dataRollback: v.literal(false),
    }),
  ]),
})
const runtimeActionSchema = v.strictObject({
  schemaVersion: v.literal(1),
  actionId: v.string(),
  operation: runtimeOperationSchema,
  status: actionStatusSchema,
  stage: v.nullable(v.string()),
  from: runtimeVersionSchema,
  to: runtimeVersionSchema,
  expiresAt: v.string(),
  failureCode: v.nullable(v.string()),
})
// The removal journal never records `succeeded`: once the connected resources are gone the action reads `gateway_removed`.
const teardownActionStatusSchema = v.picklist([
  'authorization_required',
  'applying',
  'gateway_removed',
  'failed',
  'recovery_required',
])
const teardownActionSchema = v.strictObject({
  schemaVersion: v.literal(1),
  actionId: v.string(),
  status: teardownActionStatusSchema,
  expiresAt: v.string(),
  failureCode: v.nullable(v.string()),
})
const teamActionSchema = v.strictObject({
  ...teardownActionSchema.entries,
  status: actionStatusSchema,
  action: v.optional(v.literal('access')),
  actorKind: actorKindSchema,
  canCancel: v.optional(v.boolean(), false),
})
const teamActionResultSchema = v.strictObject({
  schemaVersion: v.literal(1),
  action: v.strictObject({
    ...teamActionSchema.entries,
    status: v.picklist(['applying', 'succeeded', 'failed', 'recovery_required']),
  }),
})
const TEAM_MAX_SOURCES = 32
const teamEmailSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(254))
const teamSourceIdSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,31}$/u))
const teamMemberSchema = v.strictObject({
  email: teamEmailSchema,
  sourceIds: v.pipe(v.array(teamSourceIdSchema), v.maxLength(TEAM_MAX_SOURCES)),
})
const teamMembersSchema = v.array(teamMemberSchema)
const teamSchema = v.strictObject({
  schemaVersion: v.literal(1),
  revision: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER - 1)),
  editingEnabled: v.boolean(),
  editingDisabledReason: v.nullable(v.picklist([
    'managed_in_cloudflare', 'release_review_required', 'lifecycle_action_pending', 'management_credential_missing',
  ])),
  managementCredentialConfigured: v.boolean(),
  // What setup recorded at its token step, as a fixed word: null for a gateway that was never asked. Never the token.
  managementCredentialChoice: v.optional(v.nullable(v.picklist(['provided', 'skipped']))),
  observedAt: v.optional(v.nullable(v.string())),
  members: teamMembersSchema,
  adminEmails: v.pipe(v.array(teamEmailSchema), v.minLength(1)),
  sources: v.pipe(v.array(v.strictObject({
    id: teamSourceIdSchema,
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
    enabledTools: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))), v.maxLength(500)),
    status: sourceStatusSchema,
  })), v.maxLength(TEAM_MAX_SOURCES)),
  pendingAction: v.nullable(teamActionSchema),
  proposedMembers: v.nullable(teamMembersSchema),
})
const managementPermissionSchema = v.picklist(['verified', 'permission_missing', 'drift', 'unconfirmed', 'not_checked'])
/**
 * What the installed management token can do, as fixed words. `portals` stands for MCP Portals Edit and
 * `accessPolicies` for Access: Apps and Policies Edit; each is proven by writing the gateway's own resource back unchanged.
 */
const managementVerificationSchema = v.strictObject({
  schemaVersion: v.literal(1),
  status: v.picklist(['verified', 'missing', 'rejected', 'permission_missing', 'drift', 'busy', 'unconfirmed']),
  token: v.picklist(['active', 'missing', 'rejected', 'unconfirmed', 'not_checked']),
  portals: managementPermissionSchema,
  accessPolicies: managementPermissionSchema,
})
const runtimePreparedActionSchema = v.strictObject({
  schemaVersion: v.literal(1),
  actionId: v.string(),
  status: v.literal('authorization_required'),
  expiresAt: v.string(),
  handoffUrl: v.string(),
  operation: runtimeOperationSchema,
})
const errorResponseSchema = v.object({ error: v.string() })

export type SourceAuthMode = v.InferOutput<typeof sourceAuthModeSchema>
export type SourceStatus = v.InferOutput<typeof sourceStatusSchema>
export type RuntimeOperation = v.InferOutput<typeof runtimeOperationSchema>
export type ActionStatus = v.InferOutput<typeof actionStatusSchema>
export type GatewayStatus = v.InferOutput<typeof gatewayStatusSchema>
export type ManagedSource = v.InferOutput<typeof managedSourceSchema>
export type ManagedSources = v.InferOutput<typeof managedSourcesSchema>
export type DiscoveredTool = v.InferOutput<typeof discoveredToolSchema>
export type SourceDiscovery = v.InferOutput<typeof sourceDiscoverySchema>

export interface SourceDraftInput {
  label: string
  url: string
  authMode: SourceAuthMode
  enabledTools: string[]
}

export type SourceApplyResult = v.InferOutput<typeof sourceApplyResultSchema>
export type PreparedAction = v.InferOutput<typeof preparedActionSchema>
export type SourceAction = v.InferOutput<typeof sourceActionSchema>
export type SourceActionState = v.InferOutput<typeof sourceActionStateSchema>
export type SourceActionSummary = v.InferOutput<typeof sourceActionSummarySchema>
export type SourceActionPointer = v.InferOutput<typeof sourceActionPointerSchema>
export type SourceActionTools = v.InferOutput<typeof sourceActionToolsSchema>
export type SourceToolChoice = v.InferOutput<typeof sourceToolChoiceSchema>
export type SourceActions = v.InferOutput<typeof sourceActionsSchema>
export type SourceActionConflictReason = v.InferOutput<typeof sourceActionConflictReasonSchema>
export type RuntimeVersion = v.InferOutput<typeof runtimeVersionSchema>
export type RuntimeUpdate = v.InferOutput<typeof runtimeUpdateSchema>
export type RuntimeAction = v.InferOutput<typeof runtimeActionSchema>
export type TeardownAction = v.InferOutput<typeof teardownActionSchema>
export type TeamMember = v.InferOutput<typeof teamMemberSchema>
export type Team = v.InferOutput<typeof teamSchema>
export type TeamAction = v.InferOutput<typeof teamActionSchema>
export type TeamActionResult = v.InferOutput<typeof teamActionResultSchema>
export type ManagementVerification = v.InferOutput<typeof managementVerificationSchema>
export type ManagementCredentialChoice = NonNullable<Team['managementCredentialChoice']>

export interface GatewayAdminApi {
  getStatus(): Promise<GatewayStatus>
  getBigQuerySetups(): Promise<BigQuerySetups>
  prepareBigQuery(input: BigQuerySetupInput): Promise<BigQueryPrepared>
  resumeBigQuery(actionId: string): Promise<BigQueryPrepared>
  getSources(): Promise<ManagedSources>
  getTeam(): Promise<Team>
  prepareTeamAction(expectedRevision: number, members: TeamMember[]): Promise<TeamActionResult>
  getTeamAction(actionId: string): Promise<TeamAction>
  cancelTeamAction(actionId: string): Promise<TeamAction>
  getUpdate(): Promise<RuntimeUpdate>
  discoverSource(url: string): Promise<SourceDiscovery>
  saveSourceDraft(revision: number, source: SourceDraftInput): Promise<ManagedSources>
  removeSourceDraft(revision: number, sourceId: string): Promise<ManagedSources>
  prepareSourceAction(revision: number, sourceId: string, renewActionId?: string): Promise<SourceApplyResult>
  getSourceActions(): Promise<SourceActions>
  getSourceAction(actionId: string): Promise<SourceAction>
  cancelSourceAction(actionId: string): Promise<SourceAction>
  /** The real tools of a paused sign-in installation, once Cloudflare has synced them. */
  getSourceActionTools(actionId: string): Promise<SourceActionTools>
  /** Saves the tool choice as its own revision-bound step; the recorded installation is resumed separately. */
  chooseSourceActionTools(actionId: string, revision: number, sourceId: string, enabledTools: string[]): Promise<SourceToolChoice>
  prepareRuntimeAction(operation: RuntimeOperation, expectedTarget?: RuntimeVersion): Promise<PreparedAction & { operation: RuntimeOperation }>
  getRuntimeAction(actionId: string): Promise<RuntimeAction>
  prepareTeardownAction(): Promise<PreparedAction>
  getTeardownAction(actionId: string): Promise<TeardownAction>
  /** Prepares the one approval that lets the gateway save its own management token; the token is pasted into the gateway afterwards. */
  prepareManagementCredentialAction(): Promise<PreparedAction>
  /** Proves both permissions of the installed token by writing the gateway's own Portal and Access policy back unchanged. */
  verifyManagementAccess(): Promise<ManagementVerification>
}

export const SOURCE_ADDITION_PAUSED_MESSAGE = 'New-source installation is temporarily unavailable in this release. Existing sources and team permissions remain available.'
/** Shown beside a control that starts or resumes a source installation, only while the gateway reports that it ends a rollback. */
export function rollbackEndsMessage(release: string): string {
  return `After this you can no longer roll back to ${release}.`
}
export const GOOGLE_SHARED_OAUTH_BLOCK_MESSAGE = 'BigQuery requires a manually registered Google OAuth client. Cloudflare currently documents manual OAuth without an admin credential flow, so one operator connection for your team is not supported. No credentials have been requested. Keep Require user auth off; see the BigQuery setup guide.'

const ERROR_MESSAGES = new Map([
  ['source_not_found', 'This source has already been removed. Refresh Sources.'],
  ['source_removal_requires_cleanup', 'This source has started provisioning. Check its installation status; its resources must be cleaned up before it can be removed.'],
  ['bigquery_setup_invalid', 'Review the query project and dataset names before continuing.'],
  ['preview_only', 'This is a local preview. Open your deployed gateway to connect BigQuery.'],
  ['bigquery_setup_conflict', 'Check the existing BigQuery setup before starting another attempt.'],
  ['bigquery_setup_required', 'Your BigQuery bridge setup needs to resume before its source can connect.'],
  ['bigquery_setup_failed', 'BigQuery setup could not be confirmed. Check its recorded status before trying again.'],
  ['bigquery_google_connection_failed', 'The Google identity could not run the connection check. Review its key and project permissions, then retry setup.'],
  ['bigquery_resource_collision', 'A Cloudflare resource already uses the bridge address or name. Review it before continuing.'],
  ['bigquery_resource_uncertain', 'Cloudflare did not confirm a resource creation. Keep this setup record and review the resource in Cloudflare before recovery.'],
  ['webmcp_input_invalid', 'The tool arguments do not match the declared schema. Review the tool inputs before retrying.'],
  ['webmcp_call_cancelled', 'The call was canceled before the operation started.'],
  ['webmcp_handoff_invalid', 'The authorization handoff could not be verified. Check the recorded action before retrying.'],
  ['access_required', 'Your Cloudflare Access session is no longer active. Sign in again and refresh.'],
  ['origin_required', 'Reload this management page before making changes.'],
  ['management_credential_required', 'Add a valid management token in Settings before installing sources.'],
  ['management_credential_action_conflict', 'Your gateway has an unfinished source installation, update, removal, Team change or management token change. Finish it, or wait for its approval to expire (ten minutes at most), then try again.'],
  ['management_credential_unavailable', 'Your gateway could not reach its management state. Try again in a moment.'],
  ['team_conflict', 'Team access changed in another tab. Refresh before preparing another change.'],
  ['team_invalid', 'Review the email addresses and installed source selections before trying again.'],
  ['team_action_conflict', 'A team access change is already in progress. Refresh to review or resume it.'],
  ['team_action_invalid', 'The team access action could not be verified. Refresh before trying again.'],
  ['team_recovery_required', 'Some access policies may already have changed. Resume the recorded change before editing access again.'],
  ['team_access_revision_conflict', 'Team access changed in another tab. Refresh before preparing another change.'],
  ['team_access_invalid_request', 'Review the email addresses and installed source selections before trying again.'],
  ['team_access_admin_required', 'Gateway administrators must remain in your team. Their roles cannot be changed here.'],
  ['team_access_invalid_state', 'The saved access configuration could not be verified. Refresh before making changes.'],
  ['team_access_invalid_target', 'The owned access policies could not be verified. No new change can be prepared.'],
  ['team_action_recovery_required', 'Some access policies may already have changed. Resume the recorded change before editing access again.'],
  ['team_policy_drift', 'Cloudflare access policies no longer match the saved configuration. Review the Cloudflare policies before trying again. This page will not reset them automatically.'],
  ['team_release_review_required', 'Team access editing is not available in this gateway release.'],
  ['team_editing_managed_in_cloudflare', 'Team access is managed directly in Cloudflare for this release. No gateway management credential is accepted.'],
  ['team_management_credential_missing', 'Add your management token in Settings, then retry.'],
  ['team_management_credential_invalid', 'Cloudflare rejected the management token. Verify management access in Settings to see what is missing, or replace the token there.'],
  ['team_prepare_failed', 'The team access request could not be confirmed. Refresh to check whether a change was recorded before trying again.'],
  ['team_cancel_failed', 'Cancellation could not be confirmed. Refresh to check the recorded change before trying again.'],
  ['team_teardown_requires_compatible_release', 'Automatic removal is unavailable after source provisioning or team policy changes begin. A compatible removal release is required; do not discard the ownership or recovery records.'],
  ['source_action_conflict', 'This source action cannot proceed. Check the recorded status before trying again.'],
  ['source_action_state_unavailable', 'The saved source action state could not be verified. Check status before starting another installation.'],
  ['source_actions_unavailable', 'The saved source action state could not be verified. Check status before starting another installation.'],
  ['response_invalid', 'The gateway response could not be verified. Check status before trying again.'],
  ['source_action_not_found', 'The recorded source action was not found. Check status to review the saved actions.'],
  ['source_action_recovery_required', 'Source provisioning may have started. Keep the recorded action and review its status before attempting recovery.'],
  ['source_action_failed', 'The source action failed. Check its recorded status before trying again.'],
  ['source_action_legacy_policy', 'This source authorization uses an older permission policy. Cancel it only if provisioning never started; otherwise retain its journal for reconciliation.'],
  ['source_action_invalid', 'The source action no longer matches the saved draft.'],
  ['source_addition_paused', SOURCE_ADDITION_PAUSED_MESSAGE],
  ['source_authentication_changed', 'The endpoint authentication mode changed. Inspect it again before saving.'],
  ['source_authentication_unsupported', 'The endpoint did not return the standard MCP OAuth discovery challenge.'],
  ['source_google_shared_oauth_unsupported', GOOGLE_SHARED_OAUTH_BLOCK_MESSAGE],
  ['source_capacity_exceeded', 'This source would exceed the gateway source-state capacity. Reduce its tool selection or remove another draft.'],
  ['source_conflict', 'The source list changed in another tab. Refresh and try again.'],
  ['source_invalid', 'The source draft was rejected. Review its endpoint and exact tool selection.'],
  ['source_protocol_unsupported', 'The endpoint did not accept a supported MCP discovery protocol.'],
  ['source_response_invalid', 'The endpoint returned an invalid or oversized MCP response.'],
  ['source_tool_list_invalid', 'The endpoint returned an invalid or duplicate tool catalogue.'],
  ['source_tools_changed', 'The tool catalogue changed. Inspect it again before saving.'],
  // An installation that waits for the operator is not a failed request: say what it waits for.
  ['source_connection_required', 'The source is installed with nothing enabled and nobody assigned. Connect it in Cloudflare, then continue below.'],
  ['source_sync_required', 'Cloudflare has not finished syncing the tools of this source. Sync its capabilities in Cloudflare, then continue below.'],
  ['source_tools_required', 'The source is connected and nothing is enabled yet. Choose its tools below to finish installation.'],
  ['source_tools_mismatch', 'A selected tool is not in the list Cloudflare synced from this source. Review the selection below.'],
  ['source_tools_unavailable', 'This installation is not waiting for a tool choice. Check its recorded status.'],
  ['source_tools_invalid', 'Select between 1 and 500 tools from the list, then try again.'],
  ['source_tools_unsupported', 'Cloudflare’s synced list for this source cannot be offered here. Nothing was enabled.'],
  ['source_catalogue_unavailable', 'Cloudflare did not return this source’s server record. Try again in a moment.'],
  ['source_unreachable', 'The MCP endpoint could not be reached within the discovery deadline.'],
  ['source_url_invalid', 'Enter a public HTTPS MCP endpoint without credentials, query parameters, or a custom port.'],
  ['runtime_action_conflict', 'Another runtime action is active or the installed version changed.'],
  ['runtime_action_invalid', 'The runtime action is no longer valid.'],
  ['runtime_update_not_available', 'The installed runtime already matches its release channel.'],
  ['teardown_action_conflict', 'Finish or cancel any unfinished source installation, update or Team change, or wait for an open removal authorization to expire, then try again; if nothing is unfinished, the installation record could not be verified.'],
  ['teardown_action_invalid', 'The teardown request was rejected. Reload the management page before trying again.'],
  ['teardown_actions_unavailable', 'Receipt-authorized teardown is not available from this gateway release.'],
  ['update_channel_unavailable', 'The signed release channel is temporarily unavailable.'],
])

export class GatewayApiError extends Error {
  readonly status: number
  readonly code: string
  readonly reason: SourceActionConflictReason | undefined
  readonly action: SourceActionPointer | undefined

  constructor(status: number, code: string, details?: v.InferOutput<typeof sourceActionConflictSchema>) {
    const parsed = v.safeParse(sourceActionConflictSchema, details ?? {})
    const conflict = code === 'source_action_conflict' && parsed.success ? parsed.output : {}
    super(sourceActionConflictMessage(conflict.reason) ?? ERROR_MESSAGES.get(code) ?? 'The gateway request failed. Refresh and try again.')
    this.name = 'GatewayApiError'
    this.status = status
    this.code = code
    this.reason = conflict.reason
    this.action = conflict.action
  }
}

function sourceActionConflictMessage(reason: SourceActionConflictReason | undefined): string | undefined {
  switch (reason) {
    case 'draft_changed': return 'The saved source draft changed. Refresh and review its current tool selection before applying.'
    case 'source_pending': return 'A source installation is already pending. Check its recorded status before starting another installation.'
    case 'lifecycle_pending': return 'Another gateway action is pending. Review that action before starting a source installation.'
    case 'recovery_required': return 'Source provisioning may have started. Keep the recorded action and review its recovery status; starting again is blocked.'
    default: return undefined
  }
}

export function safeGatewayErrorCode(code: string): string {
  return ERROR_MESSAGES.has(code) ? code : 'request_failed'
}

function validControlPlaneOrigin(value: string): boolean {
  if (value.length === 0 || value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password &&
      !url.port && url.pathname === '/' && url.search === '' && url.hash === ''
  } catch {
    return false
  }
}

/** The gateway's own page that turns one prepared action into one Cloudflare consent. */
export const OPERATION_HANDOFF_PATH = '/__ankka/operation'

function validPageOrigin(value: string): boolean {
  if (value.length === 0 || value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.origin === value && !url.username && !url.password
  } catch {
    return false
  }
}

/** A handoff is only ever this gateway's operation page with a fragment; nothing else is navigated to. */
export function validHandoffUrl(value: string, expectedOrigin: string): string | null {
  if (!validPageOrigin(expectedOrigin)) return null
  try {
    const url = new URL(value)
    return url.origin === expectedOrigin && !url.username && !url.password &&
      [OPERATION_HANDOFF_PATH, `${OPERATION_HANDOFF_PATH}/teardown`].includes(url.pathname) &&
      url.search === '' && /^#[A-Za-z0-9_-]{40,8192}$/u.test(url.hash) ? url.href : null
  } catch {
    return null
  }
}

/** Typed same-origin boundary for the gateway management Worker. */
export class HttpGatewayAdminApi implements GatewayAdminApi {
  getStatus(): Promise<GatewayStatus> { return this.#request('/api/status', gatewayStatusSchema) }
  async getBigQuerySetups(): Promise<BigQuerySetups> {
    try { return await this.#request('/api/bigquery', bigQuerySetupsSchema) }
    catch (error) {
      if (error instanceof GatewayApiError && error.status === 404) return { schemaVersion: 1, available: false, setups: [] }
      throw error
    }
  }
  prepareBigQuery(input: BigQuerySetupInput): Promise<BigQueryPrepared> {
    return this.#request('/api/bigquery', bigQueryPreparedSchema, { method: 'POST', body: JSON.stringify({ schemaVersion: 1, ...input }) })
  }
  resumeBigQuery(actionId: string): Promise<BigQueryPrepared> {
    return this.#request('/api/bigquery/resume', bigQueryPreparedSchema, { method: 'POST', body: JSON.stringify({ schemaVersion: 1, actionId }) })
  }
  getSources(): Promise<ManagedSources> { return this.#request('/api/sources', managedSourcesSchema) }
  getTeam(): Promise<Team> { return this.#request('/api/team', teamSchema) }

  prepareTeamAction(expectedRevision: number, members: TeamMember[]): Promise<TeamActionResult> {
    return this.#request('/api/team-actions', teamActionResultSchema, {
      method: 'POST',
      body: JSON.stringify({ schemaVersion: 1, expectedRevision, members }),
    })
  }

  getTeamAction(actionId: string): Promise<TeamAction> {
    return this.#request(`/api/team-actions/${encodeURIComponent(actionId)}`, teamActionSchema)
  }

  cancelTeamAction(actionId: string): Promise<TeamAction> {
    return this.#request(`/api/team-actions/${encodeURIComponent(actionId)}`, teamActionSchema, {
      method: 'DELETE', body: '{}',
    })
  }
  getUpdate(): Promise<RuntimeUpdate> { return this.#request('/api/update', runtimeUpdateSchema) }

  discoverSource(url: string): Promise<SourceDiscovery> {
    return this.#request('/api/sources/discover', sourceDiscoverySchema, {
      method: 'POST', body: JSON.stringify({ url }),
    })
  }

  saveSourceDraft(revision: number, source: SourceDraftInput): Promise<ManagedSources> {
    return this.#request('/api/sources', managedSourcesSchema, {
      method: 'PUT',
      body: JSON.stringify({
        schemaVersion: 1,
        revision,
        source: { ...source, enabledTools: [...new Set(source.enabledTools)].sort() },
      }),
    })
  }

  removeSourceDraft(revision: number, sourceId: string): Promise<ManagedSources> {
    return this.#request('/api/sources', managedSourcesSchema, {
      method: 'DELETE', body: JSON.stringify({ schemaVersion: 1, revision, sourceId }),
    })
  }

  prepareSourceAction(revision: number, sourceId: string, renewActionId?: string): Promise<SourceApplyResult> {
    const path = renewActionId === undefined ? '/api/source-actions' : `/api/source-actions/${encodeURIComponent(renewActionId)}/renew`
    return this.#request(path, sourceApplyResultSchema, {
      method: 'POST', body: JSON.stringify({ schemaVersion: 1, revision, sourceId }),
    })
  }

  getSourceActions(): Promise<SourceActions> {
    return this.#request('/api/source-actions', sourceActionsSchema)
  }

  getSourceAction(actionId: string): Promise<SourceAction> {
    return this.#request(`/api/source-actions/${encodeURIComponent(actionId)}`, sourceActionSchema)
  }

  cancelSourceAction(actionId: string): Promise<SourceAction> {
    return this.#request(`/api/source-actions/${encodeURIComponent(actionId)}`, sourceActionSchema, {
      method: 'DELETE', body: '{}',
    })
  }

  getSourceActionTools(actionId: string): Promise<SourceActionTools> {
    return this.#request(`/api/source-actions/${encodeURIComponent(actionId)}/tools`, sourceActionToolsSchema)
  }

  chooseSourceActionTools(actionId: string, revision: number, sourceId: string, enabledTools: string[]): Promise<SourceToolChoice> {
    return this.#request(`/api/source-actions/${encodeURIComponent(actionId)}/tools`, sourceToolChoiceSchema, {
      method: 'POST',
      // The gateway accepts only a sorted list without repeats, the form it hashes.
      body: JSON.stringify({ schemaVersion: 1, revision, sourceId, enabledTools: [...new Set(enabledTools)].sort() }),
    })
  }

  prepareRuntimeAction(operation: RuntimeOperation, expectedTarget?: RuntimeVersion): Promise<PreparedAction & { operation: RuntimeOperation }> {
    return this.#request('/api/update-actions', runtimePreparedActionSchema, {
      method: 'POST', body: JSON.stringify({ schemaVersion: 1, operation, expectedTarget }),
    })
  }

  getRuntimeAction(actionId: string): Promise<RuntimeAction> {
    return this.#request(`/api/update-actions/${encodeURIComponent(actionId)}`, runtimeActionSchema)
  }

  prepareTeardownAction(): Promise<PreparedAction> {
    return this.#request('/api/teardown-actions', preparedActionSchema, {
      method: 'POST', body: JSON.stringify({ schemaVersion: 1 }),
    })
  }

  getTeardownAction(actionId: string): Promise<TeardownAction> {
    return this.#request(`/api/teardown-actions/${encodeURIComponent(actionId)}`, teardownActionSchema)
  }

  prepareManagementCredentialAction(): Promise<PreparedAction> {
    return this.#request('/api/management-credential/actions', preparedActionSchema, {
      method: 'POST', body: JSON.stringify({ schemaVersion: 1 }),
    })
  }

  verifyManagementAccess(): Promise<ManagementVerification> {
    return this.#request('/api/management-credential/verify', managementVerificationSchema, {
      method: 'POST', body: JSON.stringify({ schemaVersion: 1 }),
    })
  }

  async #request<TSchema extends v.GenericSchema>(
    path: string,
    schema: TSchema,
    init: RequestInit = {},
  ): Promise<v.InferOutput<TSchema>> {
    const requestInit: RequestInit = {
      ...init,
      credentials: 'same-origin',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...init.headers,
      },
    }
    if (init.body !== undefined) {
      requestInit.headers = { ...requestInit.headers, 'content-type': 'application/json' }
    }
    const response = await fetch(path, requestInit)
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const parsed = v.safeParse(errorResponseSchema, payload)
      const code = parsed.success ? safeGatewayErrorCode(parsed.output.error) : 'request_failed'
      const details = v.safeParse(sourceActionConflictSchema, {
        reason: payload?.reason,
        action: payload?.action,
      })
      throw new GatewayApiError(response.status, code, details.success ? details.output : undefined)
    }
    const parsed = v.safeParse(schema, payload)
    if (!parsed.success) throw new GatewayApiError(502, 'response_invalid')
    return parsed.output
  }
}
