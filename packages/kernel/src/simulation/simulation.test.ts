/** What-if engine tests (M7 part 3). Run with `npm run kernel:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { appendMoney, draftExperiment, evaluateExperiment, recordMeasurement, startExperiment, type Experiment, type MoneyLedger } from '../playbooks/economics.ts'
import type { ShadowLog, ShadowRecommendation } from '../playbooks/shadow.ts'
import { counterfactualAutonomy, counterfactualKernel, generateScenarios, ledgerPeriods, mulberry32, simulateCash, simulateExperiment, type CashSimulation } from './index.ts'

const founder = { id: 'entity-founder', kind: 'human' as const }
const DAY = 86_400_000
const T0 = new Date('2026-01-01T00:00:00Z').getTime()

function ledgerOf(rows: Array<[kind: 'revenue' | 'spend' | 'compute' | 'refund', amountUsd: number, day: number, extra?: Record<string, unknown>]>): MoneyLedger {
  let l: MoneyLedger = { runId: 'sim', budgetUsd: 0, entries: [] }
  for (const [kind, amountUsd, day, extra] of rows) {
    const at = new Date(T0 + day * DAY)
    const r = appendMoney(l, { kind, amountUsd, category: kind === 'revenue' ? 'sales' : 'hosting', description: kind, source: { type: 'bank', ref: `d${day}` }, occurredAt: at.toISOString(), ...(extra ?? {}) }, founder, at)
    assert.ok(r.ok, r.ok ? '' : r.reasons.join(' '))
    if (r.ok) l = r.ledger
  }
  return l
}

const AS_OF = new Date(T0 + 180 * DAY)
/** Six 30-day periods: revenue 1000..1500, cost 600 each. */
const sixPeriods = () => ledgerOf(Array.from({ length: 6 }, (_, i) => [['revenue', 1000 + i * 100, i * 30 + 5], ['spend', 600, i * 30 + 10]] as const).flat() as never)

test('mulberry32 is deterministic and in [0, 1)', () => {
  const a = mulberry32(42), b = mulberry32(42)
  const xs = Array.from({ length: 1000 }, () => a())
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()))
  assert.ok(xs.every((x) => x >= 0 && x < 1))
  assert.notEqual(mulberry32(1)(), mulberry32(2)())
})

test('ledgerPeriods pairs revenue and capital used (spend + compute − refunds) per period', () => {
  const l = ledgerOf([['revenue', 100, 1], ['spend', 40, 2], ['compute', 10, 3], ['refund', 5, 4], ['revenue', 200, 40]])
  const { periods } = ledgerPeriods(l, { periodDays: 30, asOf: new Date(T0 + 60 * DAY) })
  assert.equal(periods.length, 2)
  assert.deepEqual(periods.map((p) => [p.revenueUsd, p.costUsd]), [[100, 45], [200, 0]])
})

test('simulateCash refuses without history unless assumptions are explicit, and labels them', () => {
  const empty: MoneyLedger = { runId: 'x', budgetUsd: 0, entries: [] }
  const r = simulateCash({ ledger: empty, startCashUsd: 1000, horizonPeriods: 3, runs: 100, seed: 1 })
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.reasons.join(' '), /no money history/)
  const a = simulateCash({ ledger: empty, startCashUsd: 1000, horizonPeriods: 3, runs: 200, seed: 1, assumed: { revenue: { meanUsd: 500, sdUsd: 100 }, cost: { meanUsd: 400, sdUsd: 50 } } })
  assert.ok(a.ok)
  if (a.ok) {
    assert.equal(a.basis, 'assumed')
    assert.equal(a.label, 'assumed, not from history')
    assert.match(a.assumptions.join(' '), /ASSUMED, NOT FROM HISTORY/)
  }
})

test('simulateCash is deterministic given a seed, and reports percentiles, reserve and ruin odds per step', () => {
  const opts = { ledger: sixPeriods(), asOf: AS_OF, startCashUsd: 500, horizonPeriods: 6, runs: 2000, seed: 7, reserveFloorUsd: 1000 }
  const a = simulateCash(opts) as CashSimulation
  const b = simulateCash(opts) as CashSimulation
  assert.ok(a.ok)
  assert.deepEqual(a, b)
  assert.notDeepEqual(simulateCash({ ...opts, seed: 8 }), a)
  assert.equal(a.kind, 'estimate')
  assert.equal(a.history.periods, 6)
  assert.equal(a.historyTooShort, false)
  assert.equal(a.steps.length, 6)
  for (const s of a.steps) assert.ok(s.cash.p5 <= s.cash.p25 && s.cash.p25 <= s.cash.p50 && s.cash.p50 <= s.cash.p75 && s.cash.p75 <= s.cash.p95)
  // Every period nets +400..+900, starting below the floor: always below reserve at the start, never out of cash.
  assert.equal(a.pBelowReserve, 1)
  assert.equal(a.pOutOfCash, 0)
  assert.ok(a.steps[5]!.cash.p5 >= 500 + 6 * 400)
  assert.ok(a.steps[0]!.medianReturnOnCapital! > 1)
  assert.ok(a.assumptions.some((x) => /paired/.test(x)))
})

test('planned spends and shocks move the distribution; short history is flagged', () => {
  const base = { ledger: sixPeriods(), asOf: AS_OF, startCashUsd: 500, horizonPeriods: 3, runs: 500, seed: 3 }
  const plain = simulateCash(base) as CashSimulation
  const spend = simulateCash({ ...base, plannedSpendsUsd: [2000] }) as CashSimulation
  assert.equal(spend.steps[0]!.cash.p50, plain.steps[0]!.cash.p50 - 2000)
  assert.ok(spend.pOutOfCash > 0.99)
  const halved = simulateCash({ ...base, shocks: [{ kind: 'revenue-scale', factor: 0.5 }] }) as CashSimulation
  assert.ok(halved.steps[2]!.cash.p50 < plain.steps[2]!.cash.p50)
  const delayed = simulateCash({ ...base, horizonPeriods: 1, shocks: [{ kind: 'revenue-delay', share: 1, delayPeriods: 1 }] }) as CashSimulation
  assert.ok(delayed.medianRevenueDelayedPastHorizonUsd >= 1000)
  assert.equal(delayed.steps[0]!.medianRevenueUsd, 0)
  const bad = simulateCash({ ...base, shocks: [{ kind: 'revenue-scale', factor: -1 }] })
  assert.equal(bad.ok, false)
  const short = simulateCash({ ...base, asOf: undefined, ledger: ledgerOf([['revenue', 100, 1], ['spend', 50, 2]]) }) as CashSimulation
  assert.ok(short.ok && short.historyTooShort)
  assert.match(short.warnings.join(' '), /too short to say much/)
})

test('generateScenarios is data; it skips what the inputs cannot support and says why', () => {
  const l = sixPeriods()
  const set = generateScenarios({ ledger: l, asOf: AS_OF })
  assert.deepEqual(set.scenarios.map((s) => s.kind), ['revenue-10', 'revenue-25', 'revenue-50', 'cost-spike', 'delayed-payment'])
  assert.deepEqual(set.skipped.map((s) => s.kind), ['lost-largest-customer', 'experiment-fails'])
  assert.match(set.skipped[0]!.reason, /counterparties/)
  assert.deepEqual(set.scenarios[1]!.shocks, [{ kind: 'revenue-scale', factor: 0.75 }])
  assert.deepEqual(generateScenarios({ ledger: l, asOf: AS_OF }), set, 'deterministic')
  for (const s of set.scenarios) assert.ok(simulateCash({ ledger: l, startCashUsd: 0, horizonPeriods: 2, runs: 10, seed: 1, shocks: s.shocks }).ok)

  const named = ledgerOf([['revenue', 900, 1, { counterparty: 'Acme' }], ['revenue', 100, 2, { counterparty: 'Beta' }], ['revenue', 300, 35, { counterparty: 'Acme' }], ['spend', 50, 3]])
  const lost = generateScenarios({ ledger: named }, { kinds: ['lost-largest-customer'] })
  assert.equal(lost.scenarios.length, 1)
  assert.equal(lost.scenarios[0]!.basis.customer, 'Acme')
  assert.deepEqual(lost.scenarios[0]!.shocks, [{ kind: 'revenue-drop', amountUsd: 600 }])

  // A running experiment that has spent $30 of $100 and earned $60 over 2 periods fails: the rest of
  // its budget goes in period 1, and the revenue it brought in stops.
  const exp = runningExperiment([22, 24])
  const withExp = ledgerOf([['spend', 30, 1, { experimentId: 'exp-1' }], ['revenue', 60, 2, { experimentId: 'exp-1' }], ['revenue', 500, 40]])
  const fails = generateScenarios({ ledger: withExp, experiments: [exp] }, { kinds: ['experiment-fails'] })
  assert.equal(fails.scenarios.length, 1)
  assert.deepEqual(fails.scenarios[0]!.shocks, [{ kind: 'cost-add', amountUsd: 70, fromPeriod: 1, toPeriod: 1 }, { kind: 'revenue-drop', amountUsd: 30 }])
  assert.equal(generateScenarios({ ledger: withExp, experiments: [] }, { kinds: ['experiment-fails'] }).skipped[0]!.kind, 'experiment-fails')
})

function runningExperiment(values: number[], everyDays = 1): Experiment {
  const d = draftExperiment({ id: 'exp-1', hypothesis: 'If we email, signups rise.', playbookId: 'operate', metric: { id: 'signups', label: 'Signups', direction: 'higher-is-better', kill: 10, hold: 20, scale: 40 }, budgetUsd: 100, durationDays: 30, customerFacing: false, proposedBy: 'entity-founder' })
  assert.ok(d.ok)
  const s = startExperiment((d as { experiment: Experiment }).experiment, founder, new Date(T0), { remainingBudgetUsd: 1000 })
  assert.ok(s.ok)
  let exp = (s as { experiment: Experiment }).experiment
  values.forEach((v, i) => {
    const r = recordMeasurement(exp, v, founder, 'analytics', new Date(T0 + (i + 1) * everyDays * DAY))
    assert.ok(r.ok)
    exp = (r as { experiment: Experiment }).experiment
  })
  return exp
}

test('simulateExperiment: needs 2 measurements, is deterministic, and agrees with evaluateExperiment', () => {
  const one = simulateExperiment(runningExperiment([25]), { runs: 100, seed: 1 })
  assert.equal(one.ok, false)
  assert.match(one.ok ? '' : one.reasons.join(' '), /at least 2/)

  // Steadily rising: +2 a day for 29 more days from 26 → scale is near certain.
  const rising = runningExperiment([22, 24, 26], 1)
  const a = simulateExperiment(rising, { runs: 500, seed: 9, spentUsd: 3 })
  assert.ok(a.ok)
  if (!a.ok) return
  assert.deepEqual(simulateExperiment(rising, { runs: 500, seed: 9, spentUsd: 3 }), a)
  assert.equal(a.odds.scale, 1)
  assert.equal(a.pReachesScale, 1)
  assert.equal(a.current.verdict, evaluateExperiment(rising, 3, new Date(T0 + 3 * DAY)).verdict)
  assert.equal(a.pOverBudget, 0)
  assert.equal(a.historyTooShort, true)

  // Falling below kill: kill ends the run and applies on its own.
  const falling = simulateExperiment(runningExperiment([19, 16, 13, 11]), { runs: 300, seed: 2 })
  assert.ok(falling.ok && falling.odds.kill === 1)
  const sum = falling.ok ? Object.values(falling.odds).reduce((s, x) => s + x, 0) : 0
  assert.ok(Math.abs(sum - 1) < 0.005)

  // Spend pace from the ledger: $10 a day for 3 days, 27 days left, $100 budget → always over.
  const l = ledgerOf([['spend', 10, 0, { experimentId: 'exp-1' }], ['spend', 10, 1, { experimentId: 'exp-1' }], ['spend', 10, 2, { experimentId: 'exp-1' }]])
  const pace = simulateExperiment(rising, { runs: 200, seed: 4, ledger: l })
  assert.ok(pace.ok && pace.spentUsd === 30 && pace.pOverBudget === 1)
})

function rec(id: string, department: string, day: number, kernel: ShadowRecommendation['kernel']['recommendation'], verdict?: 'accepted' | 'modified' | 'rejected', outcome?: 'good' | 'neutral' | 'bad'): ShadowRecommendation {
  const at = new Date(T0 + day * DAY).toISOString()
  return {
    id, department, description: id, proposedAt: at, executed: false,
    kernel: { recommendation: kernel, riskLevel: 1 },
    ...(verdict ? { verdict: { value: verdict, by: 'entity-founder', at } } : {}),
    ...(outcome ? { outcome: { value: outcome, by: 'entity-founder', at } } : {}),
  }
}

test('counterfactualAutonomy replays in time order and never assumes unknown outcomes are good', () => {
  const recs: ShadowRecommendation[] = []
  for (let i = 0; i < 10; i++) recs.push(rec(`c${i}`, 'collections', i, 'execute-autonomously', 'accepted', 'good'))
  // After day 9 the rules (minJudged 10, 0.8) are met; then:
  recs.push(rec('c10', 'collections', 10, 'execute-autonomously', 'rejected'))
  recs.push(rec('c11', 'collections', 11, 'execute-autonomously', 'modified', 'good'))
  recs.push(rec('c12', 'collections', 12, 'execute-autonomously', 'accepted', 'bad'))
  recs.push(rec('c13', 'collections', 13, 'execute-autonomously', 'accepted'))
  recs.push(rec('c14', 'collections', 14, 'execute-autonomously'))
  recs.push(rec('c15', 'collections', 15, 'request-approval', 'accepted'))
  recs.push(rec('s0', 'sales', 0, 'execute-autonomously', 'accepted'))
  const log: ShadowLog = { recommendations: recs.reverse() }
  const r = counterfactualAutonomy(log, { rules: { minJudged: 10, minAgreement: 0.8 } })
  assert.equal(r.kind, 'estimate')
  const c = r.departments.find((d) => d.department === 'collections')!
  assert.equal(c.current.metAt, new Date(T0 + 9 * DAY).toISOString())
  assert.equal(c.current.judgedWhenMet, 10)
  assert.equal(c.current.afterHandOver, 6)
  assert.equal(c.current.wouldRunAlone, 5)
  assert.equal(c.current.ownerRejected, 1)
  assert.equal(c.current.ownerModified, 1)
  assert.equal(c.current.wouldHaveBeenWrong, 2)
  assert.equal(c.current.unjudged, 1)
  assert.equal(c.current.badOutcomes, 1)
  assert.equal(c.current.goodOutcomes, 0, 'the modified action\'s outcome is not the recommendation\'s')
  assert.equal(c.current.unknownOutcomes, 4)
  assert.equal(c.table.length, 9)
  assert.equal(c.table.filter((x) => x.current).length, 1)
  assert.ok(c.table.filter((x) => x.minJudged === 30).every((x) => x.metAt === null && x.wouldRunAlone === 0))
  const sales = r.departments.find((d) => d.department === 'sales')!
  assert.equal(sales.current.metAt, null)
  assert.match(sales.notes.join(' '), /never reached/)
  assert.deepEqual(counterfactualAutonomy(log, { department: 'sales' }).departments.map((d) => d.department), ['sales'])
})

test('a bad outcome recorded before the rules are met delays hand-over', () => {
  const recs = Array.from({ length: 12 }, (_, i) => rec(`x${i}`, 'ops', i, 'execute-autonomously', 'accepted', i === 0 ? 'bad' : undefined))
  const r = counterfactualAutonomy({ recommendations: recs }, { rules: { minJudged: 10, minAgreement: 0.8 } })
  assert.equal(r.departments[0]!.current.metAt, null)
})

test('counterfactualKernel compares the kernel call with the owner verdict', () => {
  const log: ShadowLog = { recommendations: [
    rec('a', 'x', 1, 'execute-autonomously', 'accepted'),
    rec('b', 'x', 2, 'execute-autonomously', 'rejected'),
    rec('c', 'x', 3, 'reject', 'rejected'),
    rec('d', 'y', 4, 'reject', 'accepted'),
    rec('e', 'y', 5, 'request-approval', 'modified'),
    rec('f', 'y', 6, 'execute-autonomously'),
  ] }
  const k = counterfactualKernel(log)
  assert.equal(k.overall.judged, 5)
  assert.equal(k.overall.matched, 2)
  assert.equal(k.overall.tooLoose, 1)
  assert.equal(k.overall.tooStrict, 1)
  assert.equal(k.overall.escalated, 1)
  assert.equal(k.overall.matchRate, 0.5)
  assert.equal(k.overall.matrix['request-approval'].modified, 1)
  assert.equal(k.byDepartment['x']!.matchRate, 0.667)
})
