import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const signIn = read('../app/sign-in/page.tsx')
const bell = read('../components/attention-bell.tsx')
const status = read('../app/api/auth/status/route.ts')
const errorPage = read('../app/error.tsx')

test('the sign-in page leads with the organisation account, keeps the token under "Advanced", and goes back only to a page of the app', () => {
  assert.match(signIn, /Continue with your organisation account/)
  assert.match(signIn, /<summary[^>]*>Use an access token instead<\/summary>/)
  assert.match(signIn, /returnToFrom\(window\.location\.search\)/)
  assert.match(signIn, /type="password"/)
  assert.match(signIn, /clearConsoleToken\(\)/)
  assert.match(signIn, /Organisation sign-in is not set up for this site/)
})

test('a failed sign-in says nothing was changed and what to do, without naming the cause', () => {
  assert.match(signIn, /Sign-in did not finish/)
  assert.match(signIn, /Nothing was changed/)
  assert.match(signIn, /ask an administrator to add it/)
})

test('demo accounts appear only in demo mode', () => {
  assert.match(signIn, /const DEMO = process\.env\.NEXT_PUBLIC_QUICKSILVER_DEMO_MODE === 'on'/)
  assert.match(signIn, /\{DEMO && !access\?\.signedIn && \(/)
})

test('the status route is always 200 (a visitor who is not signed in is not a console error) and returns no secret', () => {
  assert.equal(/status: 40[0-9]/.test(status), false)
  assert.equal(/status: 50[0-9]/.test(status), false)
  assert.match(status, /readBrowserSession/)
  assert.equal(/Authorization|authorization|token/i.test(status.replace(/\/\*[\s\S]*?\*\//g, '')), false)
})

test('the bell is an accessible button with a count, hides for a visitor who is not signed in, and marks a count that may be low', () => {
  assert.match(bell, /aria-haspopup="dialog"/)
  assert.match(bell, /aria-expanded=\{open\}/)
  assert.match(bell, /if \(needsSignIn\) return null/)
  assert.match(bell, /some sources could not be checked/)
  assert.match(bell, /incomplete \? '\+' : ''/)
  assert.match(bell, /event\.key === 'Escape'/)
  assert.match(bell, /role="dialog" aria-label="What needs you"/)
  const nav = read('../components/app-navigation.tsx')
  assert.match(nav, /<AttentionBell variant="row"/)
  assert.match(nav, /<AttentionBell className="app-bell app-bell--mobile"/)
})

test('no page sends people to the planning page to sign in any more', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue
      if (/href=["'`{][^>]*console-token/.test(readFileSync(full, 'utf8'))) offenders.push(full.slice(root.length))
    }
  }
  walk(join(root, 'app')); walk(join(root, 'components'))
  assert.deepEqual(offenders, [])
})

test('the app has an error page, a not-found page and a loading state, and the error page shows no internals', () => {
  assert.match(errorPage, /role="alert"/)
  assert.match(errorPage, /Try again/)
  assert.equal(/\{error\.message\}|error\.stack/.test(errorPage), false)
  assert.match(read('../app/not-found.tsx'), /That page does not exist/)
  assert.match(read('../app/loading.tsx'), /role="status"/)
})

test('Overview is a destination in the navigation and the quick-navigate launcher', async () => {
  const { APP_NAVIGATION_DESTINATIONS } = await import('./app-navigation.ts')
  assert.equal(APP_NAVIGATION_DESTINATIONS[0]!.href, '/')
  assert.equal(APP_NAVIGATION_DESTINATIONS[0]!.label, 'Overview')
})
