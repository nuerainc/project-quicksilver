/** Manual founder reviews of Genesis customer-facing text (M5). Run with `npm run host:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { authorize } from '@quicksilver/kernel/approval'
import type { GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'
import type { CapabilityRef, EntityRef, ProposedAction } from '@quicksilver/kernel/types'
import { MANUAL_REVIEW_COMPONENT, waesContentDigest } from '@quicksilver/kernel/waes'

import {
  checkReviewAppend,
  ContentReviewConflictError,
  ContentReviewRecordError,
  contentReviewProblems,
  contentStatus,
  createManualReview,
  parseContentReviewInput,
  readContentArg,
  reviewSummary,
  type ContentReviewRecord,
} from './genesis-reviews.ts'

const T0 = new Date('2026-11-01T12:00:00Z')
const founder = { id: 'entity-founder', kind: 'human' }
const text = 'Get a margin report for your feed store in 48 hours.'
const config = (allow?: boolean): GenesisRunConfig => ({
  schemaVersion: 1, runId: 'genesis-test', playbookId: 'genesis', budgetUsd: 500, durationDays: 30, digitalOnly: true,
  allowedCategories: ['advertising'], prohibitedCategories: [], spend: { autoMaxUsd: 10, autoMaxRisk: 2, dailyCapUsd: 50 },
  waesRequired: true, ...(allow === undefined ? {} : { waesManualReviewAllowed: allow }),
  prerequisites: { entityApproved: true, paymentAccounts: [] }, owner: 'entity-founder',
})

function review(verdict: 'pass' | 'revise' | 'block' = 'pass', at = T0, body = text): ContentReviewRecord {
  const r = createManualReview({ text: body, channel: 'landing-page', verdict }, founder, at)
  assert.ok(r.ok)
  return r.review
}

test('a manual review is bound to the exact text, marked manual, and made only by a human', () => {
  const r = review()
  assert.equal(r.kind, 'manual')
  assert.equal(r.reviewerKind, 'human')
  assert.deepEqual(r.components, [MANUAL_REVIEW_COMPONENT])
  assert.equal(r.contentDigest, waesContentDigest(text))
  assert.equal(r.text, text)
  assert.deepEqual(contentReviewProblems(r), [])
  assert.notEqual(review().reviewId, r.reviewId, 'every decision gets its own id')
  const byAgent = createManualReview({ text, channel: 'email', verdict: 'pass' }, { id: 'agent-genesis', kind: 'agent' }, T0)
  assert.equal(byAgent.ok, false)
  // A tampered record is refused.
  assert.ok(contentReviewProblems({ ...r, text: `${text}!` }).includes('contentDigest does not match the text.'))
  assert.ok(contentReviewProblems({ ...r, reviewerKind: 'service' }).length)
  assert.ok(contentReviewProblems({ ...r, kind: 'waes' }).length, 'a WAES review may not carry the manual marker')
})

test('the gate: a manual pass unlocks the exact text only when the run allows it, and never for the reviewer as proposer', () => {
  const records = [review('pass')]
  const ok = contentStatus(config(true), records, text, 'agent-genesis')
  assert.equal(ok.passes, true)
  assert.equal(ok.manual, true)
  assert.equal(ok.facts['waes.reviewKind'], 'manual')

  const actor: EntityRef = { id: 'agent-genesis', name: 'Genesis', entityType: 'agent', capabilityIds: ['cap-send'] }
  const capabilities: CapabilityRef[] = [{ id: 'cap-send', name: 'Publish', baseRiskLevel: 1, authorizedEntityIds: ['agent-genesis'] }]
  const action: ProposedAction = { description: 'Publish the landing page', actorId: 'agent-genesis', capabilityId: 'cap-send', applicablePolicyIds: [], evidenceIds: ['ev'], reversible: true, operationalImpact: 1, uncertainty: 1, customerFacing: true }
  const run = (facts: Record<string, string | number | boolean>) => authorize({ action, actor, capabilities, policies: [], evidence: [{ id: 'ev', title: 'signal', confidence: 0.9 }], facts }).recommendation
  assert.equal(run(ok.facts as Record<string, string>), 'execute-autonomously')

  const off = contentStatus(config(), records, text, 'agent-genesis')
  assert.equal(off.facts['waes.review'], 'manual-not-allowed')
  assert.equal(run(off.facts as Record<string, string>), 'reject')
  assert.match(off.reason ?? '', /manual founder review/)

  assert.equal(contentStatus(config(true), records, text, 'entity-founder').facts['waes.review'], 'self-reviewed')
  const changed = contentStatus(config(true), records, `${text} Now 50% off!`, 'agent-genesis')
  assert.equal(changed.facts['waes.review'], 'missing', 'changed text has no review of its own')
  assert.equal(changed.review, null)
  assert.equal(contentStatus(config(true), records, text.replace(/\n/g, '\r\n') + '\n', 'agent-genesis').passes, true, 'line endings and outer whitespace do not matter')
})

test('the latest decision on the same text decides', () => {
  const records = [review('pass', T0), review('block', new Date(T0.getTime() + 60_000))]
  const st = contentStatus(config(true), records, text, 'agent-genesis')
  assert.equal(st.facts['waes.review'], 'block')
  assert.equal(st.reviewsOfThisText, 2)
  assert.equal(contentStatus(config(true), [...records, review('pass', new Date(T0.getTime() + 120_000))], text, 'agent-genesis').passes, true)
  assert.deepEqual(reviewSummary(records), { waes: { total: 0, pass: 0, revise: 0, block: 0 }, manual: { total: 2, pass: 1, revise: 0, block: 1 } })
})

test('append-only: a taken reviewId with different content is a conflict; an identical record is a no-op', () => {
  const r = review()
  assert.equal(checkReviewAppend('run', [], r), true)
  assert.equal(checkReviewAppend('run', [r], structuredClone(r)), false)
  assert.throws(() => checkReviewAppend('run', [r], { ...r, verdict: 'block' }), ContentReviewConflictError)
  assert.throws(() => checkReviewAppend('run', [], { ...r, reviewerKind: 'service' }), ContentReviewRecordError)
})

test('input parsing and the CLI text argument (a file when it exists, else the text itself)', async () => {
  assert.equal(parseContentReviewInput({ text, channel: 'ad', verdict: 'pass' }).ok, true)
  assert.equal(parseContentReviewInput({ text, channel: 'ad', verdict: 'maybe' }).ok, false)
  assert.equal(parseContentReviewInput({ text, verdict: 'pass' }).ok, false)
  const p = parseContentReviewInput({ text, channel: 'ad', verdict: 'pass', note: '  ' })
  assert.ok(p.ok && p.input.note === undefined, 'a blank note is dropped')

  const dir = await mkdtemp(join(tmpdir(), 'genesis-review-arg-'))
  try {
    await writeFile(join(dir, 'offer.txt'), `${text}\n`)
    const f = await readContentArg('offer.txt', dir)
    assert.equal(f.from, 'file')
    assert.equal(waesContentDigest(f.text), waesContentDigest(text))
    const a = await readContentArg('Hello there', dir)
    assert.deepEqual(a, { text: 'Hello there', from: 'argument' })
    assert.equal((await readContentArg('.', dir)).from, 'argument', 'a directory is not a file')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
