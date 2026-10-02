import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const matrix = await readFile(new URL('../docs/platform/parity-tests.md', import.meta.url), 'utf8')
const coverage = await readFile(new URL('../docs/NUERA-QUICKSILVER-SPEC-COVERAGE.md', import.meta.url), 'utf8')
const scope = await readFile(new URL('../docs/V1-SCOPE.md', import.meta.url), 'utf8')

function requirementRows(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\|\s*(P-\d{3})\s*\|.*\|\s*(covered|partial|missing|needs operational evidence)\s*\|/.exec(line)
    return match ? [{ id: match[1], status: match[2] }] : []
  })
}

function statusCounts(rows) {
  return Object.fromEntries(['covered', 'partial', 'missing', 'needs operational evidence'].map((status) => [
    status,
    rows.filter((row) => row.status === status).length,
  ]))
}

test('v1 parity matrix contains every P-001 through P-123 requirement exactly once', () => {
  const rows = requirementRows(matrix)
  assert.equal(rows.length, 123)
  assert.deepEqual(rows.map(({ id }) => id), Array.from({ length: 123 }, (_, index) => `P-${String(index + 1).padStart(3, '0')}`))
})

test('parity matrix status totals agree with the published status table and coverage summary', () => {
  const rows = requirementRows(matrix)
  const counts = statusCounts(rows)
  const summaryStart = matrix.indexOf('### Counts by status')
  const summaryEnd = matrix.indexOf('As of 2026-10-01', summaryStart)
  assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, 'parity-tests.md has a dated status count table')
  const summary = matrix.slice(summaryStart, summaryEnd)
  for (const [status, count] of Object.entries(counts)) {
    assert.match(summary, new RegExp(`^\\|\\s*${status.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|\\s*${count}\\s*\\|$`, 'm'))
    const coverageLabel = status === 'needs operational evidence' ? 'needing operational evidence' : status
    assert.ok(coverage.includes(`${count} ${coverageLabel}`), `spec coverage summary includes ${count} ${coverageLabel}`)
  }
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 123)
})

test('scope decision includes the complete P-001 through P-123 baseline', () => {
  assert.match(scope, /P-001–P-123 are required for v1\.0\.0/)
  assert.match(scope, /Every P-001–P-123 row/)
})
