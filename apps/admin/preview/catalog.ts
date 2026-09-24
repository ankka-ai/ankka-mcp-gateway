export interface PreviewEntry {
  id: string
  group: string
  label: string
  description: string
  url: string
  source: string
}

const installer = 'http://127.0.0.1:5731'
const action = `action_${'a'.repeat(32)}`
const hosted = (id: string, label: string, path: string, description: string): PreviewEntry => ({ id, group: 'Hosted installer', label, description, url: installer + path, source: 'payload/installer/index.html' })
const worker = (id: string, label: string, source: string, description: string): PreviewEntry => ({ id, group: 'Gateway setup', label, description, url: `${installer}/__ui/worker/${id}`, source: `apps/installer/src/${source}.ts` })
const dashboard = (id: string, label: string, path: string, description: string, source: string): PreviewEntry => ({ id, group: 'Management dashboard', label, description, url: path, source: `apps/admin/src/${source}.tsx` })
const components = (id: string, label: string, description: string): PreviewEntry => ({ id, group: 'Components', label, description, url: `/preview/components.html?preview=ready&group=${id}`, source: 'apps/admin/src/components/' })
const sourceScenarios: [string, string][] = [
  ['source-pending', 'Connector · awaiting approval'], ['source-applying', 'Connector · installing'],
  ['source-expired', 'Connector · approval expired'], ['source-recovery', 'Connector · recovery required'],
  ['source-completed', 'Connector · completed'], ['source-lifecycle', 'Connector · another action active'],
]

export const catalog: PreviewEntry[] = [
  hosted('welcome', 'Welcome', '/?preview=start', 'The entry point on deploy.ankka.ai.'),
  hosted('connected', 'Cloudflare connected', '/?preview=connected', 'The installer after the account connection.'),
  hosted('hosted-review', 'Deployment review', '/review?preview=planned', 'Review the planned gateway before approval.'),
  hosted('hosted-approval', 'Approval pending', '/deploy?preview=authorizing', 'Waiting for Cloudflare approval.'),
  hosted('hosted-running', 'Deployment in progress', '/result?preview=running', 'Provisioning and handoff to the gateway.'),
  hosted('hosted-success', 'Deployment handed off', '/result?preview=success', 'The hosted step has finished.'),
  hosted('hosted-failure', 'Deployment failed', '/result?preview=failed', 'A failed Cloudflare approval.'),
  hosted('hosted-removal', 'Cleanup required', '/result?preview=removal', 'An incomplete deployment that needs removal.'),
  worker('setup', 'Gateway details', 'customer-setup-page', 'The installer served from your Worker. Fill the form to review it.'),
  worker('setup-review', 'Gateway review', 'customer-setup-page', 'Gateway addresses, administrators, and resources to create.'),
  worker('setup-loading', 'Checking setup session', 'customer-setup-page', 'The initial setup loading state, held open for inspection.'),
  worker('no-domains', 'No active domain', 'customer-setup-page', 'Domain guidance when the connected account has no active zones.'),
  worker('expired', 'Setup session expired', 'customer-setup-page', 'The recovery state for an expired setup session.'),
  worker('progress', 'Finishing installation', 'customer-install-progress-page', 'The Worker is still converging. This preview stays in progress.'),
  worker('incomplete', 'Installation incomplete', 'customer-install-progress-page', 'Installation stopped before readiness.'),
  worker('denied', 'Approval rejected', 'customer-install-progress-page', 'Cloudflare did not approve the setup attempt.'),
  worker('operation-loading', 'Preparing change approval', 'customer-operation-router', 'The shared connector, update, and rollback authorization page.'),
  worker('update-progress', 'Update · applying release', 'customer-operation-router', 'The Worker-hosted update progress page after Cloudflare approval, showing the real update steps.'),
  worker('operation-error', 'Change approval error', 'customer-operation-router', 'A change authorization link could not be started.'),
  worker('recovery-loading', 'Preparing setup recovery', 'customer-gateway-entrypoint', 'Requesting a fresh setup approval.'),
  worker('recovery-error', 'Setup recovery error', 'customer-gateway-entrypoint', 'The retry state for setup recovery.'),
  worker('bigquery-key', 'BigQuery credential step', 'customer-bigquery-credential-page', 'The current key-upload interface. Use synthetic files only.'),
  worker('management-token', 'Management token step', 'customer-management-credential-page', 'Where an approved token change lands: the create link and the one paste field. Use synthetic values only.'),
  worker('remove-review', 'Removal review', 'customer-teardown-router', 'Review the two removal phases before approval.'),
  worker('remove-error', 'Removal stopped', 'customer-teardown-router', 'An interrupted removal and the return to Settings.'),
  worker('remove-running', 'Removing connected resources', 'customer-teardown-router', 'Live removal steps with completed, active, and waiting resources.'),
  worker('remove-stopped', 'Resource removal stopped', 'customer-teardown-router', 'Saved progress after a removal attempt stops.'),
  worker('remove-final-running', 'Final removal in progress', 'gateway-teardown-router', 'The final removal with the same shared progress treatment.'),
  worker('remove-final', 'Final removal', 'gateway-teardown-router', 'The hosted final-removal review and authorization.'),
  dashboard('sources', 'Sources', '/sources?preview=ready', 'Installed connectors, drafts, endpoint copy, filters, and connector setup. Use Add connector to enter a custom MCP URL or browse the Connector library.', 'pages/SourcesPage'),
  dashboard('empty', 'Connectors · empty', '/sources?preview=empty', 'The gateway before a connector is added.', 'pages/SourcesPage'),
  ...sourceScenarios.map(([id, label]) => dashboard(id, label, `/sources?preview=${id}`, 'A recorded connector action using the current connector management UI.', 'pages/SourcesPage')),
  dashboard('team', 'Team', '/team?preview=ready', 'Saved membership and per-member access dialogs.', 'pages/TeamPage'),
  dashboard('team-editable', 'Team · edit access', '/team?preview=team-editable', 'Assign connectors in the access modal and save synthetic changes.', 'pages/TeamPage'),
  dashboard('team-recovery', 'Team · recovery required', '/team?preview=team-recovery', 'An exact recorded access proposal that needs recovery.', 'pages/TeamPage'),
  dashboard('team-legacy', 'Team · recorded proposal', '/team?preview=team-legacy', 'A retained proposal that can be cancelled before writes.', 'pages/TeamPage'),
  dashboard('team-lifecycle', 'Team · action in progress', '/team?preview=team-lifecycle', 'Editing paused while another lifecycle action is active.', 'pages/TeamPage'),
  dashboard('settings', 'Settings', '/settings?preview=ready', 'Cloudflare management, software updates, and the danger zone.', 'pages/SettingsPage'),
  dashboard('settings-token', 'Management token', '/settings?preview=management-token', 'Token verification, replacement, and collapsed details.', 'pages/ManagementTokenSection'),
  dashboard('update', 'Update available', '/settings?preview=update#software-updates-title', 'Release details, notes, update, and rollback.', 'pages/SettingsPage'),
  dashboard('update-running', 'Update · in progress', `/settings?preview=update-running&runtimeAction=${action}#software-updates-title`, 'The update status notice and shared matrix loader.', 'pages/SettingsPage'),
  dashboard('update-failed', 'Update · recovery required', `/settings?preview=update-failed&runtimeAction=${action}#software-updates-title`, 'A failed update with recovery guidance.', 'pages/SettingsPage'),
  dashboard('update-success', 'Update · completed', `/settings?preview=ready&runtimeAction=${action}#software-updates-title`, 'The successful runtime action notice.', 'pages/SettingsPage'),
  dashboard('dashboard-loading', 'Dashboard loading', '/?preview=loading', 'Connectors skeleton loading state with the dashboard navigation visible.', 'components/AppShell'),
  dashboard('team-loading', 'Team loading', '/team?preview=loading', 'Team skeleton loading state.', 'components/AppShell'),
  dashboard('settings-loading', 'Settings loading', '/settings?preview=loading', 'Settings skeleton loading state.', 'components/AppShell'),
  dashboard('dashboard-error', 'Dashboard unavailable', '/?preview=error', 'The branded error screen and retry action.', 'components/AppShell'),
  dashboard('handoff-loading', 'Handoff · finishing setup', '/preview/components.html?preview=ready&group=handoff-loading', 'The real dashboard installation handoff, waiting for readiness.', 'InstallHandoff'),
  dashboard('handoff-incomplete', 'Handoff · setup incomplete', '/preview/components.html?preview=ready&group=handoff-incomplete', 'The dashboard handoff after an incomplete installation.', 'InstallHandoff'),
  dashboard('handoff-sign-in', 'Handoff · sign in again', '/preview/components.html?preview=ready&group=handoff-sign-in', 'The handoff when Cloudflare Access requires sign-in.', 'InstallHandoff'),
  components('buttons', 'Buttons & inputs', 'Real dashboard buttons, loading and disabled states, form controls, and installer controls.'),
  components('steps', 'Steps & progress', 'Shared step markers, connecting lines, and waiting, current, running, completed, and stopped states.'),
  components('feedback', 'Loaders, notices & badges', 'StatusPill, LoadingIndicator, and the dashboard’s existing notice styles.'),
  components('brand', 'Wordmark & page headers', 'The existing vector wordmark, dashboard header, and lifecycle layout.'),
  components('dialog', 'Add user dialog', 'Open the real dialog, try its validation, and add a synthetic team member.'),
  components('sources-components', 'Endpoint & connector list', 'GatewayEndpoint and SourceList with functional copy, search, filters, and expansion.'),
  components('bigquery-components', 'BigQuery setup form', 'The real BigQuery setup form with validation and synthetic responses.'),
  components('provider-guides', 'Provider connectors', 'Setup requirements and availability for each connector in the library.'),
]
