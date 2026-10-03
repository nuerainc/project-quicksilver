import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const page = readFileSync(new URL('../components/business-dashboard.tsx', import.meta.url), 'utf8')
const nextConfig = readFileSync(new URL('../next.config.mjs', import.meta.url), 'utf8')
const routeGuard = readFileSync(new URL('./route-guard.ts', import.meta.url), 'utf8')

test('home is an operating dashboard backed by recorded company data', () => {
  assert.match(page, /Business overview/)
  assert.match(page, /Needs your attention/)
  assert.match(page, /Business measures/)
  assert.match(page, /Money ledger/)
  assert.match(page, /Recent decisions/)
  assert.match(page, /does not create activity or estimate missing values/)
  assert.match(page, /Latest recorded metric documents/)
  assert.match(page, /processor and bank reconciliation are not connected/)
  assert.match(page, /dashboard\/finance/)
  assert.match(routeGuard, /'dashboard\/finance': \{ permissions: Object\.freeze<Permission\[]>\(\['finance:read'\]\) \}/)
  assert.match(page, /multi-tenant hosting remains gated/i)
})

test('the old planning route redirects to decisions, because planning now happens in the chat', () => {
  assert.match(nextConfig, /source: '\/planning', destination: '\/decisions'/)
  assert.equal(existsSync(new URL('../app/planning', import.meta.url)), false)
})

test('business dashboard links to each workspace, and planning opens the chat', () => {
  for (const href of ['/decisions', '/workflows', '/monitoring', '/agents']) {
    assert.match(page, new RegExp(`href="${href}"`), `${href} should remain reachable from the dashboard`)
  }
  assert.match(page, /Quick actions/)
  assert.match(page, /quicksilver:open-chat/)
})

test('dashboard requires the existing tab-scoped principal and has useful loading/error states', () => {
  assert.match(page, /resolveConsoleAccess\(\)/)
  assert.match(page, /Sign in to load your business data/)
  assert.match(page, /role="alert"/)
  assert.match(page, /<AttentionList hideHeading \/>/)
})
