import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="app-main space-y-6">
      <section className="qs-panel" aria-labelledby="not-found-title">
        <h1 id="not-found-title" className="qs-page-heading">That page does not exist</h1>
        <p>The link may be out of date. These are the places to go from here.</p>
        <p className="flex flex-wrap gap-2">
          <Link className="qs-action-primary" href="/">Overview</Link>
          <Link className="qs-action-secondary" href="/decisions">Decisions</Link>
          <Link className="qs-action-secondary" href="/workflows">Workflows</Link>
        </p>
      </section>
    </main>
  )
}
