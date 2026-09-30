import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const page = readFileSync(new URL('../components/business-dashboard.tsx', import.meta.url), 'utf8')
const planningPage = readFileSync(new URL('../app/planning/page.tsx', import.meta.url), 'utf8')
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

test('the objective and planning console is preserved at its own route', () => {
  assert.match(planningPage, /<h1 className="qs-page-heading">Turn intent into governed action\.<\/h1>/)
  assert.match(planningPage, /id="business-objective"/)
  assert.match(planningPage, /Create plan/)
  assert.match(planningPage, /disabled=\{busy \|\| objective\.trim\(\)\.length < 3 \|\| !token\}/)
})

test('business dashboard links to each existing workspace and preserved planning console', () => {
  for (const href of ['/planning', '/decisions', '/workflows', '/monitoring', '/agents']) {
    assert.match(page, new RegExp(`href="${href}"`), `${href} should remain reachable from the dashboard`)
  }
  assert.match(page, /Quick actions/)
})

test('dashboard requires the existing tab-scoped principal and has useful loading/error states', () => {
  assert.match(page, /readConsoleToken\(\)/)
  assert.match(page, /Sign in to load your business data/)
  assert.match(page, /role="alert"/)
  assert.match(page, /Loading current business records/)
})
