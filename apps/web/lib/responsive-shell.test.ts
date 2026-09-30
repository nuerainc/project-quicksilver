import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { APP_NAVIGATION_GROUPS, APP_NAVIGATION_DESTINATIONS, activeNavigationRoute } from './app-navigation.ts'

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')
const consolePage = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')

test('primary destinations are grouped by user task and have unique reachable routes', () => {
  assert.deepEqual(APP_NAVIGATION_GROUPS.map(({ label }) => label), ['Operate', 'Govern'])
  assert.deepEqual(APP_NAVIGATION_DESTINATIONS.map(({ href }) => href), ['/decisions', '/workflows', '/monitoring', '/agents'])
  assert.equal(new Set(APP_NAVIGATION_DESTINATIONS.map(({ href }) => href)).size, APP_NAVIGATION_DESTINATIONS.length)
  assert.equal(activeNavigationRoute('/workflows/review', '/workflows'), true)
  assert.equal(activeNavigationRoute('/agents', '/workflows'), false)
})

test('shared shell defines compact mobile disclosure, larger-screen navigation and responsive content width', () => {
  assert.match(css, /\.app-mobile-menu__panel\s*\{[^}]*width:\s*min\(23rem,\s*calc\(100vw\s*-\s*2rem\)\)/s)
  assert.match(css, /@media\s*\(min-width:\s*42rem\)/)
  assert.match(css, /@media\s*\(max-width:\s*34rem\)/)
  assert.match(css, /\.app-main\s*\{[^}]*padding-block:\s*clamp\(/s)
  assert.match(css, /:focus-visible/)
  assert.match(css, /prefers-reduced-motion/)
  assert.match(layout, /width:\s*'device-width'/)
  assert.match(layout, /viewportFit:\s*'cover'/)
  assert.match(layout, /Skip to main content/)
})

test('dense decision review details stay collapsed until needed, while approval basis is inspectable', () => {
  assert.match(consolePage, /<details className="mb-4 rounded border border-quicksilver-border px-3 py-2 text-sm">\s*<summary[^>]*>\s*Approval basis/s)
  assert.match(consolePage, /Action fingerprint/)
  assert.match(consolePage, /break-all[^>]*>\{d\.approvalFingerprint/)
  assert.match(consolePage, /onAct\(docId, 'approve', undefined, d\.approvalFingerprint\)/)
  assert.match(consolePage, /expectedActionFingerprint\s*\?\s*\{\s*expectedActionFingerprint\s*\}/)
})
