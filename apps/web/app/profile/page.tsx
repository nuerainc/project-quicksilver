'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { clearConsoleToken, resolveConsoleAccess, type ConsoleAccess } from '@/lib/console-auth'
import { groupPermissions } from '@/lib/permission-words'
import { signInPageHref } from '@/lib/session-control'

export default function ProfilePage() {
  const [access, setAccess] = useState<ConsoleAccess | null>(null)
  useEffect(() => { void resolveConsoleAccess(undefined, undefined, { withWhoami: true }).then(setAccess) }, [])
  const who = access?.whoami ?? null
  const groups = who ? groupPermissions(who.permissions) : []

  return (
    <main className="app-main space-y-6">
      <header className="qs-page-heading">
        <p className="qs-eyebrow">Govern · Your account</p>
        <h1>Your account</h1>
        <p className="qs-page-heading__summary">Who Quicksilver thinks you are, and what that lets you do. A control you cannot use says why before you press it.</p>
      </header>

      {access === null && <p role="status">Checking who you are…</p>}

      {access && !access.signedIn && (
        <section className="qs-panel" aria-labelledby="profile-signin">
          <h2 id="profile-signin" className="text-lg font-semibold">You are not signed in</h2>
          <p><Link className="qs-action-primary" href={signInPageHref('/profile')}>Sign in</Link></p>
        </section>
      )}

      {access?.signedIn && !who && (
        <section className="qs-panel" role="alert">
          <h2 className="text-lg font-semibold">Signed in, but the server could not say who you are</h2>
          <p>Try again in a moment. Your session is still active.</p>
        </section>
      )}

      {who && (
        <>
          <section className="qs-panel" aria-labelledby="profile-who">
            <h2 id="profile-who" className="text-lg font-semibold">{who.displayName ?? who.principalId}</h2>
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              <div><dt className="qs-eyebrow">Identifier</dt><dd className="break-all">{who.principalId}</dd></div>
              <div><dt className="qs-eyebrow">Organisation</dt><dd className="break-all">{who.tenantId}</dd></div>
              <div><dt className="qs-eyebrow">Signed in with</dt><dd>{who.credential === 'shared-supervisor' ? 'The shared supervisor token' : access?.token ? 'A pasted access token' : 'Your organisation account'}</dd></div>
              <div><dt className="qs-eyebrow">Account type</dt><dd>{who.kind}</dd></div>
            </dl>
            {who.credential === 'shared-supervisor' && <p className="qs-helper mt-3">The shared supervisor token is not tied to one person, so the audit trail cannot say who acted.</p>}
          </section>

          <section className="qs-panel" aria-labelledby="profile-can">
            <h2 id="profile-can" className="text-lg font-semibold">What you can do</h2>
            {groups.length === 0 ? <p>Your account has no permissions in this organisation, so most controls will be disabled.</p> : groups.map((group) => (
              <div key={group.area} className="mt-3">
                <h3 className="qs-eyebrow">{group.area}</h3>
                <ul className="mt-1 space-y-1">{group.items.map((item) => <li key={item.permission}>{item.can} <code>{item.permission}</code></li>)}</ul>
              </div>
            ))}
          </section>

          <section className="qs-panel" aria-labelledby="profile-out">
            <h2 id="profile-out" className="text-lg font-semibold">Sign out</h2>
            {access?.token ? (
              <button type="button" className="qs-action-secondary" onClick={() => { clearConsoleToken(); window.location.assign('/sign-in') }}>Forget this access token</button>
            ) : (
              <form method="post" action="/api/auth/logout"><button type="submit" className="qs-action-secondary">Sign out</button></form>
            )}
          </section>
        </>
      )}
    </main>
  )
}
