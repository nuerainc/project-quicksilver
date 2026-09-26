/** Shadow mode tests (M4). */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judge, recommend, recordOutcome, shadowFacts, shadowReport, type ShadowLog } from './shadow.ts'

const owner = { id: 'entity-founder', kind: 'human' as const }
const bot = { id: 'agent:x', kind: 'agent' as const }
const at = new Date('2026-12-01T12:00:00Z')

function build(dept: string, n: number, verdicts: Array<'accepted' | 'modified' | 'rejected'>): ShadowLog {
  let log: ShadowLog = { recommendations: [] }
  for (let i = 0; i < n; i++) {
    const r = recommend(log, { id: `${dept}-${i}`, department: dept, description: `Do thing ${i}`, proposedAt: at.toISOString(), kernel: { recommendation: i % 4 ? 'execute-autonomously' : 'request-approval', riskLevel: 1 } })
    assert.ok(r.ok)
    log = r.log
    if (verdicts[i]) { const j = judge(log, `${dept}-${i}`, owner, verdicts[i]!, at); assert.ok(j.ok); log = j.log }
  }
  return log
}

test('nothing in shadow mode executes, and only a human judges', () => {
  const log = build('collections', 1, [])
  assert.equal(log.recommendations[0]!.executed, false)
  assert.equal(judge(log, 'collections-0', bot, 'accepted', at).ok, false)
  const j = judge(log, 'collections-0', owner, 'accepted', at, 'Good call')
  assert.ok(j.ok)
  assert.equal(judge(j.log, 'collections-0', owner, 'rejected', at).ok, false, 'verdicts are not rewritten')
  assert.equal(recordOutcome(log, 'collections-0', owner, 'good', at).ok, false, 'outcome needs a verdict first')
})

test('a department with enough agreement and no bad outcomes is ready for hand-over; others say why not', () => {
  let log = build('collections', 22, Array(20).fill('accepted').concat(['modified', 'rejected']))
  const lead = build('lead-follow-up', 25, Array(25).fill(null).map((_, i) => (i % 3 ? 'accepted' : 'rejected')))
  log = { recommendations: [...log.recommendations, ...lead.recommendations] }
  const report = Object.fromEntries(shadowReport(log).map((d) => [d.department, d]))
  assert.equal(report['collections']!.readyForHandOver, true)
  assert.equal(report['collections']!.agreement, Math.round((20.5 / 22) * 1000) / 1000)
  assert.equal(report['lead-follow-up']!.readyForHandOver, false)
  assert.match(report['lead-follow-up']!.reasons.join(' '), /below 80%/)

  const o = recordOutcome(log, 'collections-3', owner, 'bad', at, 'Customer complained')
  assert.ok(o.ok)
  const after = shadowReport(o.log).find((d) => d.department === 'collections')!
  assert.equal(after.readyForHandOver, false)
  assert.match(after.reasons.join(' '), /bad outcome/)
})

test('shadow facts feed the Onboard playbook transition', () => {
  const log = build('collections', 21, Array(21).fill('accepted'))
  assert.deepEqual(shadowFacts(log), { 'shadow.recommendations': 21, 'shadow.agreement': 1 })
})
