/** Genesis economics (M5): experiments, the money ledger, spend risk, the run config, and the WAES gate. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authorize } from '../approval.ts'
import type { CapabilityRef, EntityRef, ProposedAction } from '../types.ts'
import { MANUAL_REVIEW_COMPONENT, WAES_BLOCK_REASONS, waesContentDigest, waesFacts, type WaesReview } from '../waes.ts'
import {
  appendMoney,
  applyEvaluation,
  draftExperiment,
  evaluateExperiment,
  moneyTotals,
  recordMeasurement,
  spendRiskLevel,
  startExperiment,
  verifyMoneyLedger,
  type ExperimentDefinition,
  type MoneyLedger,
} from './economics.ts'
import { decideSpend, genesisBlockers, genesisFacts, genesisWaesFacts, validateGenesisConfig, type GenesisRunConfig } from './genesis.ts'
import { validatePlaybook, type PlaybookDefinition } from './playbook.ts'
import { nextAutomaticTransition } from '../process.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const founder = { id: 'entity-founder', kind: 'human' as const }
const kernel = { id: 'kernel', kind: 'service' as const }
const T0 = new Date('2026-11-01T12:00:00Z')
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000)

const def: ExperimentDefinition = {
  id: 'exp-landing-1',
  hypothesis: 'A one-page offer for feed-store margin reports gets 3+ paid signups in 10 days.',
  playbookId: 'genesis',
  metric: { id: 'paid-signups', label: 'Paid signups', direction: 'higher-is-better', kill: 0, hold: 2, scale: 3 },
  budgetUsd: 60,
  durationDays: 10,
  customerFacing: true,
  proposedBy: 'agent-planner',
}

const config = JSON.parse(readFileSync(join(root, 'deploy', 'genesis', 'genesis-500.json'), 'utf8')) as GenesisRunConfig

test('the shipped Genesis playbook and $500 run config are valid', () => {
  const pb = JSON.parse(readFileSync(join(root, 'deploy', 'playbooks', 'genesis.json'), 'utf8')) as PlaybookDefinition
  assert.deepEqual(validatePlaybook(pb).errors, [])
  assert.deepEqual(validateGenesisConfig(config), [])
  assert.equal(config.budgetUsd, 500)
  assert.equal(config.durationDays, 30)
  // Kill is automatic; scale and modify are the founder's.
  const t = (id: string) => pb.process.transitions.find((x) => x.id === id)!
  assert.equal(t('kill').automatic, true)
  assert.equal(t('scale').requiresHumanApproval, true)
  assert.equal(t('start-experiment').requiresHumanApproval, true)
  assert.equal(nextAutomaticTransition(pb.process, 'allocate', { 'experiment.verdict': 'kill' })?.to, 'kill')
})

test('the run cannot start without an approved entity and payment accounts in the vault', () => {
  const blockers = genesisBlockers(config, [])
  assert.ok(blockers.some((b) => /legal entity/.test(b)))
  assert.ok(blockers.some((b) => /not in the vault/.test(b)))
  assert.deepEqual(genesisBlockers({ ...config, prerequisites: { ...config.prerequisites, entityApproved: true } }, config.prerequisites.paymentAccounts), [])
})

test('experiments: a human starts them, thresholds are pinned, kill applies on its own, scale needs a human', () => {
  const d = draftExperiment(def)
  assert.ok(d.ok)
  if (!d.ok) return
  assert.equal(startExperiment(d.experiment, kernel, T0, { remainingBudgetUsd: 500 }).ok, false)
  assert.equal(startExperiment(d.experiment, founder, T0, { remainingBudgetUsd: 40 }).ok, false, 'budget above what is left')
  const tampered = { ...d.experiment, definition: { ...def, metric: { ...def.metric, scale: 1 } } }
  assert.equal(startExperiment(tampered, founder, T0, { remainingBudgetUsd: 500 }).ok, false, 'changed thresholds are refused')

  const s = startExperiment(d.experiment, founder, T0, { remainingBudgetUsd: 500 })
  assert.ok(s.ok)
  if (!s.ok) return
  assert.equal(recordMeasurement(s.experiment, 1, kernel, '', day(2)).ok, false, 'measurements need a source')
  const m = recordMeasurement(s.experiment, 3, kernel, 'payments:stripe-export', day(3))
  assert.ok(m.ok)
  if (!m.ok) return
  const ev = evaluateExperiment(m.experiment, 20, day(3))
  assert.equal(ev.verdict, 'scale')
  assert.equal(applyEvaluation(m.experiment, ev, kernel, day(3)).ok, false)
  const scaled = applyEvaluation(m.experiment, ev, founder, day(3))
  assert.ok(scaled.ok && scaled.experiment.status === 'scaled')

  const zero = recordMeasurement(s.experiment, 0, kernel, 'payments:stripe-export', day(4))
  assert.ok(zero.ok)
  if (!zero.ok) return
  const killed = applyEvaluation(zero.experiment, evaluateExperiment(zero.experiment, 10, day(4)), kernel, day(4))
  assert.ok(killed.ok && killed.experiment.status === 'killed')
  assert.equal(evaluateExperiment(zero.experiment, 61, day(4)).verdict, 'over-budget')
  assert.equal(evaluateExperiment({ ...s.experiment, measurements: [{ at: '', value: 2, by: 'k', source: 's' }] }, 5, day(11)).verdict, 'expired')
})

test('the money ledger: compute is capital, entries need sources, tampering is detected', () => {
  let ledger: MoneyLedger = { runId: 'r', budgetUsd: 500, entries: [] }
  const add = (input: Parameters<typeof appendMoney>[1], actor: { id: string; kind: 'human' | 'agent' | 'service' } = founder) => {
    const r = appendMoney(ledger, input, actor, T0)
    assert.ok(r.ok, r.ok ? '' : r.reasons.join(' '))
    if (r.ok) ledger = r.ledger
  }
  add({ kind: 'spend', amountUsd: 12, category: 'domain', description: 'Domain for the offer page', source: { type: 'receipt', ref: 'rcpt-1' } })
  add({ kind: 'compute', amountUsd: 7.5, category: 'compute', description: 'Model usage, week 1', source: { type: 'provider-usage', ref: 'azure-2026-11-w1' } }, kernel)
  add({ kind: 'revenue', amountUsd: 29, category: 'sales', description: 'First paid report', source: { type: 'payment-processor', ref: 'ch_1' }, experimentId: 'exp-landing-1' })
  add({ kind: 'refund', amountUsd: 2, category: 'domain', description: 'Registrar promo credit', source: { type: 'receipt', ref: 'rcpt-2' } })
  const totals = moneyTotals(ledger)
  assert.equal(totals.capitalUsedUsd, 17.5)
  assert.equal(totals.remainingUsd, 482.5)
  assert.equal(totals.netUsd, 11.5)
  assert.equal(totals.computeUsd, 7.5)
  assert.equal(appendMoney(ledger, { kind: 'spend', amountUsd: 5, category: 'software', description: 'x', source: { type: 'receipt', ref: '' } }, founder, T0).ok, false)
  assert.equal(appendMoney(ledger, { kind: 'revenue', amountUsd: 5, category: 'sales', description: 'x', source: { type: 'manual', ref: 'note' } }, kernel, T0).ok, false, 'only a human records revenue by hand')
  assert.ok(verifyMoneyLedger(ledger).valid)
  const forged = { ...ledger, entries: ledger.entries.map((e, i) => (i === 0 ? { ...e, amountUsd: 1 } : e)) }
  assert.equal(verifyMoneyLedger(forged).valid, false)
})

test('spend risk is measured against what is left', () => {
  assert.equal(spendRiskLevel(0, 500), 0)
  assert.equal(spendRiskLevel(10, 500), 1)
  assert.equal(spendRiskLevel(20, 500), 2)
  assert.equal(spendRiskLevel(20, 100), 4)
  assert.equal(spendRiskLevel(20, 15), 5)
})

test('spend decisions: small experiment spend runs, larger spend asks the founder, prohibited or over-cap is refused', () => {
  const d = draftExperiment(def)
  assert.ok(d.ok)
  if (!d.ok) return
  const s = startExperiment(d.experiment, founder, T0, { remainingBudgetUsd: 500 })
  assert.ok(s.ok)
  if (!s.ok) return
  const ledger: MoneyLedger = { runId: 'r', budgetUsd: 500, entries: [] }
  const req = (amountUsd: number, category = 'advertising') => ({ amountUsd, category, description: 'Ad test', experimentId: def.id })
  assert.equal(decideSpend(config, ledger, req(8), T0, s.experiment).recommendation, 'execute-autonomously')
  assert.equal(decideSpend(config, ledger, req(25), T0, s.experiment).recommendation, 'request-approval')
  assert.equal(decideSpend(config, ledger, req(8), T0).recommendation, 'request-approval', 'spend outside an experiment')
  assert.equal(decideSpend(config, ledger, req(8, 'inventory'), T0, s.experiment).recommendation, 'reject')
  assert.equal(decideSpend(config, ledger, req(55), T0, s.experiment).recommendation, 'reject', 'daily cap')
  assert.equal(decideSpend(config, ledger, req(61), T0, s.experiment).recommendation, 'reject', 'experiment budget')
  const facts = genesisFacts(config, ledger, [s.experiment], T0, day(3))
  assert.equal(facts['run.daysLeft'], 27)
  assert.equal(facts['experiment.running'], true)
})

test('WAES gate: customer-facing actions are hard-blocked without a passing review of the exact content', () => {
  const content = 'Get a margin report for your feed store in 48 hours.'
  const actor: EntityRef = { id: 'agent-genesis', name: 'Genesis', entityType: 'agent', capabilityIds: ['cap-send'] }
  const capabilities: CapabilityRef[] = [{ id: 'cap-send', name: 'Send offer', baseRiskLevel: 1, authorizedEntityIds: ['agent-genesis'] }]
  const action: ProposedAction = { description: 'Publish the offer page', actorId: 'agent-genesis', capabilityId: 'cap-send', applicablePolicyIds: [], evidenceIds: ['ev'], reversible: true, operationalImpact: 1, uncertainty: 1, customerFacing: true }
  const run = (facts: Record<string, string | number | boolean>) => authorize({ action, actor, capabilities, policies: [], evidence: [{ id: 'ev', title: 'signal', confidence: 0.9 }], facts })
  const review: WaesReview = { reviewId: 'w1', contentDigest: waesContentDigest(content), verdict: 'pass', components: ['SENTINEL', 'COMPASS'], reviewer: 'waes-service', reviewedAt: T0.toISOString() }

  assert.equal(run(waesFacts(undefined, content, 'agent-genesis')).recommendation, 'reject')
  assert.equal(run(waesFacts(review, content + ' Now 50% off!', 'agent-genesis')).recommendation, 'reject', 'stale review')
  assert.equal(run(waesFacts({ ...review, reviewer: 'agent-genesis' }, content, 'agent-genesis')).recommendation, 'reject', 'self-review')
  assert.equal(run(waesFacts({ ...review, verdict: 'revise' }, content, 'agent-genesis')).recommendation, 'reject')
  assert.equal(run(waesFacts(review, content.replace(/\n/g, '\r\n'), 'agent-genesis')).recommendation, 'execute-autonomously')
  assert.equal(authorize({ action: { ...action, customerFacing: false }, actor, capabilities, policies: [], evidence: [{ id: 'ev', title: 's', confidence: 0.9 }] }).recommendation, 'execute-autonomously')
})

test('WAES gate: a manual founder review unlocks a customer-facing action only when manual reviews are allowed', () => {
  const content = 'Get a margin report for your feed store in 48 hours.'
  const actor: EntityRef = { id: 'agent-genesis', name: 'Genesis', entityType: 'agent', capabilityIds: ['cap-send'] }
  const capabilities: CapabilityRef[] = [{ id: 'cap-send', name: 'Send offer', baseRiskLevel: 1, authorizedEntityIds: ['agent-genesis'] }]
  const action: ProposedAction = { description: 'Publish the offer page', actorId: 'agent-genesis', capabilityId: 'cap-send', applicablePolicyIds: [], evidenceIds: ['ev'], reversible: true, operationalImpact: 1, uncertainty: 1, customerFacing: true }
  const run = (facts: Record<string, string | number | boolean>) => authorize({ action, actor, capabilities, policies: [], evidence: [{ id: 'ev', title: 'signal', confidence: 0.9 }], facts })
  const manual: WaesReview = { reviewId: 'm1', kind: 'manual', contentDigest: waesContentDigest(content), verdict: 'pass', components: [MANUAL_REVIEW_COMPONENT], reviewer: 'entity-founder', reviewerKind: 'human', reviewedAt: T0.toISOString() }

  // Allowed: passes, and the facts say it was manual.
  const allowed = waesFacts(manual, content, 'agent-genesis', { allowManual: true })
  assert.deepEqual(allowed, { 'waes.review': 'pass', 'waes.reviewId': 'm1', 'waes.reviewKind': 'manual' })
  assert.equal(run(allowed).recommendation, 'execute-autonomously')

  // Not allowed (the default): blocked with its own reason.
  const notAllowed = waesFacts(manual, content, 'agent-genesis')
  assert.equal(notAllowed['waes.review'], 'manual-not-allowed')
  const r = run(notAllowed)
  assert.equal(r.recommendation, 'reject')
  assert.ok(r.blockingReasons.includes(WAES_BLOCK_REASONS['manual-not-allowed']))

  // The proposer cannot approve its own text, even manually.
  assert.equal(waesFacts({ ...manual, reviewer: 'agent-genesis' }, content, 'agent-genesis', { allowManual: true })['waes.review'], 'self-reviewed')
  // Different content: stale.
  assert.equal(waesFacts(manual, content + ' Now 50% off!', 'agent-genesis', { allowManual: true })['waes.review'], 'stale')
  assert.equal(run(waesFacts(manual, content + ' Now 50% off!', 'agent-genesis', { allowManual: true })).recommendation, 'reject')
  // A non-human manual reviewer, or a missing reviewer kind, is refused.
  assert.equal(waesFacts({ ...manual, reviewerKind: 'service' }, content, 'agent-genesis', { allowManual: true })['waes.review'], 'manual-invalid')
  assert.equal(waesFacts({ ...manual, reviewerKind: undefined }, content, 'agent-genesis', { allowManual: true })['waes.review'], 'manual-invalid')
  assert.equal(run(waesFacts({ ...manual, reviewerKind: 'service' }, content, 'agent-genesis', { allowManual: true })).recommendation, 'reject')
  // A manual review must name only the marker; a WAES review may not carry it.
  assert.equal(waesFacts({ ...manual, components: ['SENTINEL'] }, content, 'agent-genesis', { allowManual: true })['waes.review'], 'manual-invalid')
  assert.equal(waesFacts({ ...manual, kind: 'waes', components: [MANUAL_REVIEW_COMPONENT] }, content, 'agent-genesis', { allowManual: true })['waes.review'], 'manual-invalid')
  // Manual revise/block still block.
  assert.equal(run(waesFacts({ ...manual, verdict: 'revise' }, content, 'agent-genesis', { allowManual: true })).recommendation, 'reject')
  assert.equal(run(waesFacts({ ...manual, verdict: 'block' }, content, 'agent-genesis', { allowManual: true })).recommendation, 'reject')

  // The run config carries the policy.
  assert.equal(config.waesManualReviewAllowed, true)
  assert.equal(config.waesRequired, true)
  assert.equal(genesisWaesFacts(config, manual, content, 'agent-genesis')['waes.review'], 'pass')
  assert.equal(genesisWaesFacts({ ...config, waesManualReviewAllowed: false }, manual, content, 'agent-genesis')['waes.review'], 'manual-not-allowed')
  const { waesManualReviewAllowed: _omit, ...withoutFlag } = config
  assert.deepEqual(validateGenesisConfig(withoutFlag as GenesisRunConfig), [])
  assert.equal(genesisWaesFacts(withoutFlag as GenesisRunConfig, manual, content, 'agent-genesis')['waes.review'], 'manual-not-allowed', 'default is off')
  assert.deepEqual(validateGenesisConfig({ ...config, waesManualReviewAllowed: 'yes' as unknown as boolean }), ['waesManualReviewAllowed must be true or false.'])
})

test('WAES gate: reviews recorded before `kind` existed still behave as WAES reviews', () => {
  const content = 'Weekly feed price digest, free for 30 days.'
  const legacy: WaesReview = { reviewId: 'w-old', contentDigest: waesContentDigest(content), verdict: 'pass', components: ['SENTINEL', 'COMPASS'], reviewer: 'waes-service', reviewedAt: T0.toISOString() }
  assert.deepEqual(waesFacts(legacy, content, 'agent-genesis'), { 'waes.review': 'pass', 'waes.reviewId': 'w-old', 'waes.reviewKind': 'waes' })
  // allowManual does not matter for a WAES review, and no reviewerKind is needed.
  assert.equal(waesFacts(legacy, content, 'agent-genesis', { allowManual: false })['waes.review'], 'pass')
  assert.equal(waesFacts({ ...legacy, components: [] }, content, 'agent-genesis')['waes.review'], 'missing')
  assert.equal(waesFacts({ ...legacy, kind: 'other' as never }, content, 'agent-genesis')['waes.review'], 'missing')
})
