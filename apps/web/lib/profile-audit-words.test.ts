import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { GLOSSARY } from './glossary.ts'
import { groupPermissions, PERMISSION_WORDS } from './permission-words.ts'
import { riskLabel, riskTone, riskWord } from './risk-words.ts'
import { mayCarryConsoleToken } from './console-auth.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('risk is a word as well as a number, and unknown values say so', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(riskWord), ['None', 'Very low', 'Low', 'Moderate', 'High', 'Severe'])
  assert.equal(riskLabel(3), '3 of 5 · Moderate')
  assert.equal(riskLabel(null), 'Not rated')
  assert.equal(riskLabel(7), 'Not rated')
  assert.equal(riskLabel(2.5), 'Not rated')
  assert.deepEqual([0, 1, 2, 3, 4, 5, null].map(riskTone), ['low', 'low', 'mid', 'mid', 'high', 'high', 'unknown'])
})

test('the glossary explains the four terms the app cannot avoid, in plain words', () => {
  assert.deepEqual(Object.keys(GLOSSARY).sort(), ['NQC', 'WAES', 'fingerprint', 'policy snapshot'])
  for (const text of Object.values(GLOSSARY)) assert.ok(text.length > 60 && !/\bTODO\b/.test(text))
})

test('a term is a button with expanded state, not a hover tip, and risk is shown with its word on every surface', () => {
  const term = read('../components/term.tsx')
  assert.match(term, /<button type="button"[^>]*aria-expanded=\{open\}/)
  assert.match(term, /role="note"/)
  assert.match(read('../components/decision-detail.tsx'), /<Term term="fingerprint">/)
  assert.match(read('../app/decisions/page.tsx'), /riskLabel\(row\.riskLevel\)/)
  assert.match(read('../components/attention-list.tsx'), /riskLabel\(item\.covers\.riskLevel\)/)
  assert.match(read('../app/globals.css'), /\.qs-risk\[data-tone="high"\]/)
})

test('permissions are grouped by area with a description; unknown ones are shown, not hidden', () => {
  const groups = groupPermissions(['decision:approve', 'audit:read', 'decision:read', 'something:new'])
  assert.deepEqual(groups.map((g) => g.area), ['Audit', 'Decisions', 'Other'])
  assert.equal(groups[1]!.items.length, 2)
  assert.match(groups[2]!.items[0]!.can, /No description/)
  for (const key of Object.keys(PERMISSION_WORDS)) assert.match(key, /^[a-z]+:[a-z]+$/)
})

test('the profile page shows who you are and what you can do, and signs out the way you signed in', () => {
  const page = read('../app/profile/page.tsx')
  assert.match(page, /resolveConsoleAccess\(undefined, undefined, \{ withWhoami: true \}\)/)
  assert.match(page, /groupPermissions\(who\.permissions\)/)
  assert.match(page, /shared supervisor token is not tied to one person/)
  assert.match(page, /action="\/api\/auth\/logout"/)
  assert.match(page, /clearConsoleToken\(\)/)
  assert.match(read('../components/app-navigation.tsx'), /href="\/profile"/)
})

test('the audit download is disabled with a reason without audit:read, and the token may reach the export route', () => {
  const detail = read('../components/decision-detail.tsx')
  assert.match(detail, /includes\('audit:read'\)/)
  assert.match(detail, /disabled=\{!canExport\}/)
  assert.match(detail, /Needs the audit:read permission/)
  assert.equal(mayCarryConsoleToken('/api/decisions/d-1/audit'), true)
  assert.equal(mayCarryConsoleToken('/api/decisions/d-1/audit/extra'), false)
})
