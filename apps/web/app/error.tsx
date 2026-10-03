'use client'

import Link from 'next/link'
import { useEffect } from 'react'

/** Shown when a page fails to render. It says what happened in plain words and offers a way forward; no stack or internals. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[page error]', error.name, error.digest ?? '') }, [error])
  return (
    <main className="app-main space-y-6">
      <section className="qs-panel" role="alert" aria-labelledby="page-error-title">
        <h1 id="page-error-title" className="qs-page-heading">This page could not load</h1>
        <p>Something went wrong while showing this page. Your work was not changed.</p>
        <p className="flex flex-wrap gap-2">
          <button type="button" className="qs-action-primary" onClick={reset}>Try again</button>
          <Link className="qs-action-secondary" href="/">Go to the overview</Link>
        </p>
        {error.digest && <p className="text-sm">If you report this, quote reference {error.digest}.</p>}
      </section>
    </main>
  )
}
