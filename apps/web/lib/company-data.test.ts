import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { APP_NAVIGATION_DESTINATIONS } from './app-navigation.ts'
import { mayCarryConsoleToken } from './console-auth.ts'

const route = readFileSync(new URL('../app/api/entities/route.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/entities/page.tsx', import.meta.url), 'utf8')

test('company directory is discoverable, read-only, and exposes relationships', () => {
  assert.ok(APP_NAVIGATION_DESTINATIONS.some(({ href, label }) => href === '/entities' && label === 'Company data'))
  for (const field of ['"department": department->name', '"reportsTo": reportsTo->', '"capabilities": capabilities[]->', 'availability', 'riskProfile', 'costProfile']) {
    assert.ok(route.includes(field), `directory should include ${field}`)
  }
  assert.match(route, /getSanityClient\('read'\)/)
  assert.doesNotMatch(route, /getSanityClient\('write'\)|\.create\(|\.patch\(/)
  assert.match(page, /href="\/studio"/)
  assert.match(page, /intent=edit&id=/)
})

test('company directory console token is limited to its exact same-origin API path', () => {
  assert.equal(mayCarryConsoleToken('/api/entities'), true)
  assert.equal(mayCarryConsoleToken('/api/entities?all=true'), false)
  assert.equal(mayCarryConsoleToken('https://example.com/api/entities'), false)
})
