import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { auditDigestMatches, buildDecisionAudit, canonicalJson } from './decision-audit.ts'
import { WEB_ROUTE_ACCESS } from './route-guard.ts'

const doc = { _id: 'd1', question: 'Cut costs', status: 'executed', policyIds: ['p1'], processHistory: [{ from: 'proposed', to: 'approved', actorId: 'u2', at: '2026-10-03T10:00:00Z' }], evaluation: { reasoningScore: 80 } }

test('the audit export carries the decision as recorded, who exported it, and a digest of exactly that record', () => {
  const out = buildDecisionAudit(doc, 'auditor-1', '2026-10-03T12:00:00.000Z')
  assert.equal(out.schema, 'quicksilver.decision-audit/1')
  assert.equal(out.exportedBy, 'auditor-1')
  assert.equal(out.exportedAt, '2026-10-03T12:00:00.000Z')
  assert.equal(out.decision._id, 'd1')
  assert.equal('policyIds' in out.decision, false)
  assert.deepEqual(out.decision.processHistory, doc.processHistory)
  assert.match(out.integrity.digest, /^[a-f0-9]{64}$/)
  assert.equal(auditDigestMatches(out), true)
})

test('editing the exported decision breaks the digest, and key order does not change it', () => {
  const out = buildDecisionAudit(doc, 'a', 'x')
  const edited = { ...out, decision: { ...out.decision, status: 'rejected' } }
  assert.equal(auditDigestMatches(edited), false)
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }))
})

test('exporting needs audit:read and the page and the export share one query', () => {
  assert.deepEqual(WEB_ROUTE_ACCESS['decisions/audit'].permissions, ['audit:read'])
  const detail = readFileSync(new URL('../app/api/decisions/[id]/route.ts', import.meta.url), 'utf8')
  const audit = readFileSync(new URL('../app/api/decisions/[id]/audit/route.ts', import.meta.url), 'utf8')
  assert.match(detail, /DECISION_DETAIL_QUERY/)
  assert.match(audit, /DECISION_DETAIL_QUERY/)
  assert.match(audit, /content-disposition/)
  assert.doesNotMatch(audit, /\.(create|createOrReplace|patch|delete)\(/)
})
