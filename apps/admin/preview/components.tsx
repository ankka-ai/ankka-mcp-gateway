import { Input, TooltipProvider } from '@cloudflare/kumo'
import { type PropsWithChildren, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GatewayProvider, useGateway } from '../src/GatewayContext'
import type { TeamMember } from '../src/api'
import { createPreviewGatewayAdminApi } from '../src/preview-api'
import { InstallHandoff } from '../src/InstallHandoff'
import { Button } from '../src/components/Button'
import { AddUserDialog } from '../src/components/AddUserDialog'
import { BrandMark } from '../src/components/BrandMark'
import { BigQuerySetupForm } from '../src/components/BigQuerySetupForm'
import { GatewayEndpoint } from '../src/components/GatewayEndpoint'
import { LifecycleScreen } from '../src/components/LifecycleScreen'
import { LoadingIndicator } from '../src/components/LoadingIndicator'
import { NativeConnectorGuides } from '../src/components/NativeConnectorGuides'
import { PageHeader } from '../src/components/PageHeader'
import { SourceList } from '../src/components/SourceList'
import { StatusPill } from '../src/components/StatusPill'
import { customerPageStyles } from '../../installer/src/customer-page-theme'
import '../src/styles.css'
import './components.css'

function Sample({ title, children }: PropsWithChildren<{ title: string }>) {
  return <section className="component-sample"><h2 className="component-label">{title}</h2>{children}</section>
}

function Components() {
  const group = new URLSearchParams(location.search).get('group') ?? 'buttons'
  const { sources } = useGateway()
  const [members, setMembers] = useState<TeamMember[]>([{ email: 'admin@example.com', sourceIds: [] }])
  const [notice, setNotice] = useState('')
  if (group.startsWith('handoff-')) return <><style>{customerPageStyles}</style><InstallHandoff><p>Gateway ready.</p></InstallHandoff></>
  return (
    <main className="component-catalog">
      <style>{customerPageStyles}</style>
      {group === 'buttons' ? <>
        <Sample title="Dashboard · Button"><div className="component-row">
          <Button variant="primary">Primary</Button><Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button><Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button><Button variant="secondary-destructive">Secondary destructive</Button>
          <Button loading>Loading</Button><Button disabled>Disabled</Button>
        </div></Sample>
        <Sample title="Dashboard · Form controls"><div className="component-fields">
          <Input label="Source name" placeholder="Company knowledge" />
          <Input label="Disabled field" placeholder="Unavailable" disabled />
          <label>Text input<input className="text-input" placeholder="Search tools…" /></label>
          <label>Text area<textarea className="text-input" rows={3} placeholder={'search\nfetch_document'} /></label>
          <label><span>Email with validation</span><input className="text-input" defaultValue="invalid" aria-invalid="true" aria-describedby="sample-field-error" /><span id="sample-field-error" className="field-error">Enter a valid email address.</span></label>
        </div></Sample>
        <Sample title="Installer · Buttons and form controls"><div className="ankka-setup component-installer">
          <div className="actions"><button type="button">Continue</button><button type="button" className="secondary">Back</button><button type="button" className="danger">Remove gateway</button><button type="button" disabled>Preparing</button></div>
          <div className="grid"><label>Gateway name<input placeholder="Your team’s gateway" /></label><label>Domain<select defaultValue="example.com"><option>example.com</option></select></label></div>
        </div></Sample>
      </> : null}
      {group === 'feedback' ? <>
        <Sample title="Shared · LoadingIndicator"><div className="component-row"><LoadingIndicator /><span>Loading your gateway…</span><LoadingIndicator inline /><span>Inline loading</span></div></Sample>
        <Sample title="Dashboard · StatusPill"><div className="component-row"><StatusPill tone="ready">Ready</StatusPill><StatusPill tone="waiting">Waiting</StatusPill><StatusPill tone="attention">Attention required</StatusPill></div></Sample>
        <Sample title="Dashboard · Notices"><div className="component-fields">
          <p className="notice-banner notice-neutral">An operation is in progress.</p>
          <p className="notice-banner notice-success">The change has been verified.</p>
          <p className="notice-banner notice-warning">Review this action before continuing.</p>
          <p className="notice-banner notice-error">The operation did not complete. Review the recorded state.</p>
        </div></Sample>
        <Sample title="Dashboard · Empty state"><div className="empty-card"><h3>No sources yet</h3><p>Add your first MCP source to get started.</p><Button variant="primary">Add source</Button></div></Sample>
      </> : null}
      {group === 'brand' ? <>
        <Sample title="BrandMark · Sidebar treatment"><div className="component-wordmark"><BrandMark className="sidebar-wordmark" /></div></Sample>
        <Sample title="PageHeader"><PageHeader title="Sources" description="Manage the sources your team can connect to." action={<Button variant="primary">Add source</Button>} /></Sample>
        <Sample title="LifecycleScreen"><LifecycleScreen title="Finishing your Ankka Gateway" loading><p>Your gateway is finishing setup in your Cloudflare account.</p></LifecycleScreen></Sample>
      </> : null}
      {group === 'dialog' ? <Sample title="AddUserDialog · Interactive"><p className="component-help">Open the dialog to inspect its layout and validation. New entries only affect this sample.</p><AddUserDialog members={members} disabled={false} onAdd={email => setMembers(current => [...current, { email, sourceIds: [] }])} /><ul className="mt-5 space-y-2">{members.map(member => <li key={member.email}>{member.email}</li>)}</ul></Sample> : null}
      {group === 'sources-components' ? <>
        <Sample title="GatewayEndpoint"><GatewayEndpoint /></Sample>
        <Sample title="SourceList · Search, filters, and expansion">{sources ? <SourceList sources={sources.sources} installationEnabled isBusy={false} onAuthorize={() => setNotice('This is a component sample. No installation was started.')} /> : <LoadingIndicator />}{notice ? <p role="status" className="notice-banner mt-5">{notice}</p> : null}</Sample>
      </> : null}
      {group === 'bigquery-components' ? <Sample title="BigQuerySetupForm"><BigQuerySetupForm disabled={false} /></Sample> : null}
      {group === 'provider-guides' ? <Sample title="NativeConnectorGuides"><p className="component-help">Expand the guide and choose a provider to inspect every recipe.</p><NativeConnectorGuides /></Sample> : null}
    </main>
  )
}

const root = document.getElementById('root')
const api = createPreviewGatewayAdminApi()
const handoff = new URLSearchParams(location.search).get('group')
if (api && handoff?.startsWith('handoff-')) {
  const url = new URL(location.href)
  url.searchParams.set('setup', 'finishing')
  history.replaceState(null, '', url)
  // Only this isolated development document replaces the handoff's status request.
  window.fetch = async () => handoff === 'handoff-sign-in' ? new Response(null, { status: 401 })
    : Response.json({ schemaVersion: 1, status: handoff === 'handoff-incomplete' ? 'INCOMPLETE' : 'CONVERGING' })
}
if (root) createRoot(root).render(api
  ? <TooltipProvider><GatewayProvider api={api}><Components /></GatewayProvider></TooltipProvider>
  : <p>Start the local library with <code>npm run dev:ui</code>.</p>)
