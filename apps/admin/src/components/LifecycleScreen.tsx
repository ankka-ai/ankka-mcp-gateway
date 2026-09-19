import type { PropsWithChildren } from 'react'
import { customerPageStyles } from '../../../installer/src/customer-page-theme'
import { BrandMark } from './BrandMark'
import { LoadingIndicator } from './LoadingIndicator'

export function LifecycleScreen({ title, loading = false, children }: PropsWithChildren<{ title: string; loading?: boolean }>) {
  return (
    <div className="ankka-setup">
      <style>{customerPageStyles}</style>
      <header className="site-header">
        <div className="brand" role="img" aria-label="Ankka"><BrandMark className="wordmark" /></div>
      </header>
      <main className="page-message">
        <h1>{title}</h1>
        {loading ? <LoadingIndicator /> : null}
        {children}
      </main>
    </div>
  )
}
