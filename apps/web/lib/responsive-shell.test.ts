import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { APP_NAVIGATION_GROUPS, APP_NAVIGATION_DESTINATIONS, activeNavigationRoute } from './app-navigation.ts'

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../components/app-navigation.tsx', import.meta.url), 'utf8')
const consolePage = readFileSync(new URL('../app/planning/page.tsx', import.meta.url), 'utf8')

test('primary destinations are grouped by user task and have unique reachable routes', () => {
  assert.deepEqual(APP_NAVIGATION_GROUPS.map(({ label }) => label), ['Operate', 'Govern'])
  assert.deepEqual(APP_NAVIGATION_DESTINATIONS.map(({ href }) => href), ['/', '/decisions', '/planning', '/workflows', '/monitoring', '/monitoring/traces', '/entities', '/agents'])
  assert.equal(new Set(APP_NAVIGATION_DESTINATIONS.map(({ href }) => href)).size, APP_NAVIGATION_DESTINATIONS.length)
  assert.equal(activeNavigationRoute('/workflows/review', '/workflows'), true)
  assert.equal(activeNavigationRoute('/agents', '/workflows'), false)
})

test('shared shell provides grouped desktop navigation and accessible mobile disclosure', () => {
  assert.match(shell, /<nav aria-label="Primary navigation" className="app-primary-nav app-primary-nav--desktop">/)
  assert.match(shell, /<NavigationGroups pathname=\{pathname\} collapsed=\{sidebarCollapsed\} \/>/)
  for (const label of ['Operate', 'Build', 'Govern', 'Observe']) assert.ok(shell.includes(`'${label}'`), `missing task group ${label}`)
  assert.match(shell, /<details ref=\{mobileMenuRef\} className="app-mobile-menu">/)
  assert.match(shell, /aria-label=\{`Open navigation\. Current page: \$\{currentLabel\}`\}/)
  assert.match(shell, /<nav aria-label="Mobile navigation"/)
  assert.match(shell, /aria-current=\{active \? 'page' : undefined\}/)
  assert.match(css, /\.app-mobile-menu__panel\s*\{[^}]*width:\s*min\(25rem,\s*calc\(100vw\s*-\s*2rem\)\)/s)
  assert.match(css, /\.app-topbar\s*\{[^}]*position:\s*fixed/s)
  assert.match(css, /body:has\(\.app-topbar\)\s*>\s*#main-content\s*\{[^}]*margin-inline-start:\s*16\.5rem/s)
  assert.match(css, /@media\s*\(max-width:\s*70rem\)/)
  assert.match(css, /@media\s*\(max-width:\s*58rem\)/)
  assert.match(css, /@media\s*\(max-width:\s*38rem\)/)
  assert.match(css, /@media\s*\(max-width:\s*22rem\)/)
  assert.match(css, /@media\s*\(min-width:\s*58\.01rem\)\s*and\s*\(max-height:\s*36rem\)/)
  assert.match(css, /@media\s*\(max-width:\s*58rem\)\s*and\s*\(max-height:\s*30rem\)/)
  assert.match(css, /\.app-main\s*\{[^}]*padding-block:\s*clamp\(/s)
  assert.match(css, /\.app-topbar\s*\{[^}]*position:\s*sticky/s)
  assert.match(css, /overflow-x:\s*clip/)
  assert.match(css, /:where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible/)
  assert.match(css, /min-height:\s*2\.8rem/)
  assert.match(css, /prefers-reduced-motion/)
  assert.match(css, /font-family:\s*var\(--font-sans\)/)
  assert.doesNotMatch(css, /\.app-brand__name\s*\{[^}]*font-family:\s*ui-monospace/s)
  assert.match(css, /\.app-nav-group__title/)
  assert.match(css, /\.app-nav-link\[aria-current='page'\]/)
  assert.match(layout, /width:\s*'device-width'/)
  assert.match(layout, /viewportFit:\s*'cover'/)
  assert.match(layout, /Skip to main content/)
})

test('shared presentation primitives cover headings, workspaces, forms and statuses', () => {
  for (const selector of ['.qs-page-heading', '.qs-eyebrow', '.qs-panel', '.qs-field', '.qs-action-primary', '.qs-action-secondary', '.qs-helper', '.qs-workspace-grid', '.qs-stat-grid', '.qs-data-card', '.qs-section-heading', '.qs-status-pill', '.qs-status-pill--success', '.qs-status-pill--warning', '.qs-status-pill--danger', '.qs-status-pill--neutral']) {
    assert.ok(css.includes(selector), `missing shared primitive ${selector}`)
  }
  assert.match(css, /\.qs-workspace-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s)
  assert.match(css, /@media\s*\(max-width:\s*38rem\)[\s\S]*?\.qs-workspace-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
})

test('quick navigation supports keyboard access and only renders current destinations', () => {
  assert.match(shell, /event\.key\.toLowerCase\(\) === 'k'/)
  assert.match(shell, /event\.key === 'Escape'/)
  assert.match(shell, /role="dialog" aria-modal="true"/)
  assert.match(shell, /aria-label="Quick navigation results"/)
  assert.match(shell, /APP_DESTINATIONS\.filter/)
  assert.match(shell, /APP_NAVIGATION_GROUPS\.flatMap/)
  assert.match(shell, /No available workspace matches that search/)
  assert.match(shell, /function keepLauncherFocus/)
})

test('the shell adds a collapsible desktop dock and a thumb-friendly mobile quick bar', () => {
  assert.match(shell, /data-collapsed=\{sidebarCollapsed \? 'true' : 'false'\}/)
  assert.match(shell, /nuera-quicksilver-sidebar-collapsed/)
  assert.match(shell, /className="app-sidebar-collapse"/)
  assert.match(shell, /aria-label="Mobile quick navigation"/)
  assert.match(shell, /quicksilver:open-chat/)
  assert.match(css, /\.app-topbar\[data-collapsed='true'\]/)
  assert.match(css, /body:has\(\.app-bottom-nav\) > #main-content/)
  assert.match(css, /\.app-bottom-nav\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s)
  assert.match(css, /@media\s*\(max-width:\s*48rem\)/)
  assert.match(css, /env\(safe-area-inset-bottom\)/)
})

test('dense decision review details stay collapsed until needed, while approval basis is inspectable', () => {
  assert.match(consolePage, /<details className="mb-4 rounded border border-quicksilver-border px-3 py-2 text-sm">\s*<summary[^>]*>\s*Approval basis/s)
  assert.match(consolePage, /Action fingerprint/)
  assert.match(consolePage, /break-all[^>]*>\{d\.approvalFingerprint/)
  assert.match(consolePage, /onAct\(docId, 'approve', undefined, d\.approvalFingerprint\)/)
  assert.match(consolePage, /expectedActionFingerprint\s*\?\s*\{\s*expectedActionFingerprint\s*\}/)
})
