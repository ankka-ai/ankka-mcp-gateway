import { PageHeader } from './PageHeader'

type DashboardPage = 'sources' | 'team' | 'settings'
const titles = { sources: 'Sources', team: 'Team', settings: 'Settings' }

function Placeholder({ className = '' }: { className?: string }) {
  return <div className={`dashboard-skeleton-block rounded-md ${className}`} />
}

export function DashboardSkeleton({ page, showHeader = true }: { page: DashboardPage; showHeader?: boolean }) {
  return <div>
    <p role="status" className="sr-only">Loading {titles[page]}…</p>
    {showHeader ? <PageHeader title={titles[page]} action={page !== 'settings' ? <div aria-hidden="true"><Placeholder className="h-9 w-32" /></div> : undefined} /> : null}
    <div aria-hidden="true" className="mt-7 space-y-6">
      {page === 'sources' ? <>
        <div className="surface-card flex items-center gap-4 p-5 sm:p-6">
          <Placeholder className="size-11 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-3"><Placeholder className="h-4 w-28" /><Placeholder className="h-5 w-3/4 max-w-80" /></div>
          <Placeholder className="hidden h-10 w-28 sm:block" />
        </div>
        <div className="flex justify-between gap-4"><Placeholder className="h-9 w-44" /><Placeholder className="h-9 w-52 max-w-[45%]" /></div>
      </> : null}
      {page === 'settings' ? <>
        {[0, 1, 2].map(index => <div key={index} className="space-y-4">
          <Placeholder className="h-5 w-44" />
          <div className="surface-card space-y-4 p-5 sm:p-6">
            <Placeholder className="h-4 w-40" /><Placeholder className="h-4 w-full max-w-xl" /><Placeholder className="h-4 w-3/4 max-w-md" />
            <div className="flex gap-3 pt-2"><Placeholder className="h-10 w-36" /><Placeholder className="h-10 w-36" /></div>
          </div>
        </div>)}
      </> : <div className="surface-card divide-y divide-kumo-line px-5 sm:px-6">
        {[0, 1, 2].map(index => <div key={index} className="flex items-center justify-between gap-5 py-6">
          <div className="min-w-0 flex-1 space-y-3"><Placeholder className={`h-4 ${index === 1 ? 'w-1/2' : 'w-2/3'} max-w-64`} /><Placeholder className="h-3 w-1/3 max-w-36" /></div>
          <Placeholder className={page === 'team' ? 'size-5' : 'h-6 w-20'} />
        </div>)}
      </div>}
    </div>
  </div>
}
