import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const page = readFileSync(new URL('../app/monitoring/traces/page.tsx', import.meta.url), 'utf8')
const route = readFileSync(new URL('../app/api/monitoring/traces/route.ts', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../../studio/schemas/telemetry-trace-span.ts', import.meta.url), 'utf8')
const docs = readFileSync(new URL('../../../docs/platform/observability.md', import.meta.url), 'utf8')

test('trace dashboard is discoverable, filterable, refreshable, and responsive', () => {
  assert.match(page, /aria-label="Trace summary"/)
  assert.match(page, /aria-labelledby="telemetry-alerts-title"/)
  assert.match(page, /aria-labelledby="trace-history-title"/)
  assert.match(page, /Filter span kind/)
  assert.match(page, /Search trace metadata/)
  assert.ok(page.includes('onClick={() => void refresh()}'))
  assert.match(page, /grid-cols-2[^\n]*sm:grid-cols-3[^\n]*xl:grid-cols-6/)
  assert.match(page, /alert\.severity === 'critical'/)
  assert.match(page, /Estimated cost/)
})

test('trace API is authenticated, tenant-scoped, bounded, and excludes payload data', () => {
  assert.match(route, /guardWebRoute\(request, 'monitoring\/traces'\)/)
  assert.match(route, /listRecentTraceSpans\(parsed\.data\)/)
  assert.match(route, /z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)/)
  assert.match(route, /cache-control': 'no-store'/)
  assert.doesNotMatch(route, /request\.json|toolArguments|agentOutput/)
  assert.doesNotMatch(schema, /defineField\(\{\s*name:\s*['"](?:prompt|agentOutput|toolArguments|secret|reasoningTrace)['"]/i)
  assert.match(docs, /It is not provider billing/)
})
