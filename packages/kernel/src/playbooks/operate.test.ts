/** Operate (M6): autonomy, period totals, reinvestment, bounded experiments, and the playbook. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nextAutomaticTransition } from '../process.ts'
import { appendMoney, applyEvaluation, draftExperiment, evaluateExperiment, moneyTotals, recordMeasurement, type Experiment, type ExperimentDefinition, type MoneyLedger } from './economics.ts'
import { decideSpend, genesisWaesFacts } from './genesis.ts'
import {
  approvePlan,
  AUTONOMY_DEPTHS,
  decideOperateSpend,
  departmentAutonomy,
  experimentSpendConfig,
  operateBlockers,
  operateFacts,
  operatePeriod,
  periodTotals,
  poolLedger,
  reinvestmentPlan,
  startOperateExperiment,
  validateOperateConfig,
  type ApprovedPlan,
  type OperateConfig,
} from './operate.ts'
import { validatePlaybook, type PlaybookDefinition } from './playbook.ts'
import { DEFAULT_HAND_OVER, shadowReport, type DepartmentReport, type ShadowLog } from './shadow.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const config = JSON.parse(readFileSync(join(root, 'deploy', 'operate', 'operate-nuera.json'), 'utf8')) as OperateConfig
const founder = { id: 'entity-founder', kind: 'human' as const }
const agent = { id: 'agent-ops', kind: 'agent' as const }
const T0 = new Date('2026-10-01T12:00:00Z')
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000)

const report = (department: string, ready: boolean): DepartmentReport => ({
  department, recommendations: 25, judged: ready ? 25 : 5, accepted: 5, modified: 0, rejected: 0,
  agreement: 1, badOutcomesOnAccepted: 0, kernelEscalations: 0, readyForHandOver: ready,
  reasons: ready ? [] : ['5 of 20 judged recommendations needed.'],
})

function ledgerWith(entries: Array<[kind: 'spend' | 'compute' | 'revenue' | 'refund', amount: number, at: Date, experimentId?: string, category?: string]>): MoneyLedger {
  let l: MoneyLedger = { runId: config.runId, budgetUsd: 0, entries: [] }
  for (const [kind, amountUsd, at, experimentId, category] of entries) {
    const r = appendMoney(l, { kind, amountUsd, category: category ?? (kind === 'revenue' ? 'sales' : 'software'), description: `${kind} ${amountUsd}`, source: { type: 'bank', ref: `stmt-${l.entries.length}` }, occurredAt: at.toISOString(), ...(experimentId ? { experimentId } : {}) }, founder, at)
    assert.ok(r.ok, r.ok ? '' : r.reasons.join(' '))
    l = r.ledger
  }
  return l
}

const def = (id: string, budgetUsd: number): ExperimentDefinition => ({
  id,
  hypothesis: 'If we add a pricing page, trial sign-ups reach 20 a month within 30 days.',
  playbookId: 'operate',
  metric: { id: 'signups', label: 'Trial sign-ups per month', direction: 'higher-is-better', kill: 5, hold: 10, scale: 20 },
  budgetUsd,
  durationDays: 30,
  customerFacing: true,
  proposedBy: 'agent-ops',
})
const draft = (id: string, budgetUsd: number): Experiment => { const d = draftExperiment(def(id, budgetUsd)); assert.ok(d.ok); return (d as { experiment: Experiment }).experiment }
const approved = (pool: number, at = T0, seq = 1): ApprovedPlan => ({
  seq, approvedAt: at.toISOString(), approvedBy: 'entity-founder', period: { from: day(-30).toISOString(), to: at.toISOString() }, cashOnHandUsd: 5000,
  plan: { surplusUsd: 0, toReserveUsd: 0, reinvestUsd: 0, experimentPoolUsd: pool, keptUsd: 0, needsFounder: true, notes: [] },
})

test('the Nuera config and the Operate playbook validate', () => {
  assert.deepEqual(validateOperateConfig(config), [])
  assert.equal(config.reserveFloorUsd, 1000)
  assert.equal(config.maxExperimentUsd, 250)
  assert.equal(config.prerequisites.entityApproved, false)
  const pb = JSON.parse(readFileSync(join(root, 'deploy', 'playbooks', 'operate.json'), 'utf8')) as PlaybookDefinition
  assert.deepEqual(validatePlaybook(pb).errors, [])
  assert.deepEqual(pb.modes, ['operate'])
  const t = (id: string) => pb.process.transitions.find((x) => x.id === id)!
  assert.equal(t('kill').automatic, true, 'kill is automatic')
  assert.equal(t('approve-plan').requiresHumanApproval, true, 'the founder approves the plan')
  assert.equal(t('start-experiment').requiresHumanApproval, true, 'the founder starts experiments')
  for (const s of pb.process.states.filter((x) => !x.terminal)) {
    assert.ok(pb.process.transitions.some((x) => x.from === s.id && x.to === 'stopped' && x.requiresHumanApproval), `the founder can stop from ${s.id}`)
  }
  // Every agent step names its capability (validatePlaybook enforces it; spot-check).
  assert.equal(pb.stepCapabilities['act/work'], 'capability-propose-department-actions')
  // The cycle: observe → review → act → measure → reinvest, then back to observe with no surplus.
  const done = { 'stage.status': 'completed' }
  assert.equal(nextAutomaticTransition(pb.process, 'observe', done)?.to, 'review')
  assert.equal(nextAutomaticTransition(pb.process, 'review', done)?.to, 'act')
  assert.equal(nextAutomaticTransition(pb.process, 'act', done)?.to, 'measure')
  assert.equal(nextAutomaticTransition(pb.process, 'measure', done)?.to, 'reinvest')
  assert.equal(nextAutomaticTransition(pb.process, 'reinvest', { 'period.surplusUsd': 0 })?.to, 'observe')
  assert.equal(nextAutomaticTransition(pb.process, 'experiment', { 'experiment.verdict': 'kill' })?.to, 'observe')
})

test('config validation and blockers', () => {
  assert.ok(validateOperateConfig({ ...config, reinvestShare: 1.2 }).some((e) => /reinvestShare/.test(e)))
  assert.ok(validateOperateConfig({ ...config, experimentShare: -0.1 }).some((e) => /experimentShare/.test(e)))
  assert.ok(validateOperateConfig({ ...config, playbookId: 'genesis' as 'operate' }).some((e) => /playbookId/.test(e)))
  assert.ok(validateOperateConfig({ ...config, waesRequired: false as true }).some((e) => /waesRequired/.test(e)))
  assert.ok(validateOperateConfig({ ...config, spend: { ...config.spend, autoMaxUsd: 50 } }).some((e) => /autoMaxUsd/.test(e)))
  assert.ok(validateOperateConfig({ ...config, allowedCategories: ['hosting'], prohibitedCategories: ['hosting'] }).some((e) => /both allowed and prohibited/.test(e)))
  const blockers = operateBlockers(config, [])
  assert.ok(blockers.some((b) => /legal entity/.test(b)))
  assert.ok(blockers.some((b) => /"operate-card" is not in the vault/.test(b)))
  assert.deepEqual(operateBlockers({ ...config, prerequisites: { ...config.prerequisites, entityApproved: true } }, config.prerequisites.paymentAccounts), [])
})

test('autonomy: depths match Aura, nothing granted means advise', () => {
  assert.deepEqual([...AUTONOMY_DEPTHS], ['advise', 'propose', 'act-with-approval', 'act-within-limits'])
  const a = departmentAutonomy(report('collections', true), undefined)
  assert.equal(a.effective, 'advise')
  assert.equal(a.granted, null)
  assert.ok(a.reasons.length)
  assert.equal(departmentAutonomy(undefined, undefined, 'sales').department, 'sales')
})

test('autonomy: shadow evidence caps act-within-limits at act-with-approval', () => {
  const capped = departmentAutonomy(report('collections', false), 'act-within-limits')
  assert.equal(capped.effective, 'act-with-approval')
  assert.ok(capped.reasons.some((r) => /not ready/.test(r)))
  assert.ok(capped.reasons.some((r) => /5 of 20/.test(r)), 'the shadow report says why')
  const none = departmentAutonomy(undefined, 'act-within-limits', 'marketing')
  assert.equal(none.effective, 'act-with-approval')
  assert.ok(none.reasons.some((r) => /No shadow recommendations/.test(r)))
  assert.equal(departmentAutonomy(report('collections', true), 'act-within-limits').effective, 'act-within-limits')
  // From a real shadow log: 20 judged at full agreement is ready.
  const log: ShadowLog = { recommendations: Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, department: 'collections', description: 'Send reminder', proposedAt: T0.toISOString(), kernel: { recommendation: 'execute-autonomously' as const, riskLevel: 1 }, executed: false as const, verdict: { value: 'accepted' as const, by: 'entity-founder', at: T0.toISOString() } })) }
  assert.equal(departmentAutonomy(shadowReport(log, DEFAULT_HAND_OVER)[0], 'act-within-limits').effective, 'act-within-limits')
})

test('autonomy: the grant is the ceiling; evidence never raises it', () => {
  for (const g of ['advise', 'propose', 'act-with-approval'] as const) {
    const a = departmentAutonomy(report('collections', true), g)
    assert.equal(a.effective, g)
    assert.deepEqual(a.reasons, [])
  }
  assert.equal(departmentAutonomy(report('collections', false), 'propose').effective, 'propose')
})

test('periodTotals counts only entries in [from, to)', () => {
  const l = ledgerWith([['revenue', 100, day(-40)], ['revenue', 500, day(-10)], ['spend', 80, day(-5)], ['compute', 20, day(-1)], ['refund', 10, day(-1)], ['revenue', 999, T0]])
  const t = periodTotals(l, day(-30), T0)
  assert.equal(t.revenueUsd, 500)
  assert.equal(t.capitalUsedUsd, 90)
  assert.equal(t.netUsd, 410)
  const p = operatePeriod(config, undefined, T0)
  assert.equal(p.from, day(-30).toISOString())
  assert.equal(operatePeriod(config, day(-3).toISOString(), T0).from, day(-3).toISOString())
})

test('reinvestment: no surplus means nothing to reinvest', () => {
  const l = ledgerWith([['revenue', 100, day(-2)], ['spend', 150, day(-1)]])
  const p = reinvestmentPlan(config, moneyTotals(l), 5000)
  assert.deepEqual([p.surplusUsd, p.toReserveUsd, p.reinvestUsd, p.experimentPoolUsd, p.keptUsd], [0, 0, 0, 0, 0])
  assert.equal(p.needsFounder, true)
  assert.ok(p.notes.some((n) => /No surplus/.test(n)))
})

test('reinvestment: surplus is revenue minus spend and compute, net of refunds; reserve is topped up first', () => {
  // Revenue 2,000; spend 300 + compute 100 − refund 50 = 350 capital used → surplus 1,650.
  const l = ledgerWith([['revenue', 2000, day(-3)], ['spend', 300, day(-2)], ['compute', 100, day(-2)], ['refund', 50, day(-1)]])
  const p = reinvestmentPlan(config, moneyTotals(l), 600)
  assert.equal(p.surplusUsd, 1650)
  assert.equal(p.toReserveUsd, 400, 'floor 1,000 − cash 600')
  assert.equal(p.reinvestUsd, 625, '(1,650 − 400) × 0.5')
  assert.equal(p.experimentPoolUsd, 187.5, '625 × 0.3')
  assert.equal(p.keptUsd, 625)
  assert.equal(p.needsFounder, true)
  // Surplus smaller than the gap: all of it goes to the reserve.
  const small = reinvestmentPlan(config, moneyTotals(ledgerWith([['revenue', 100, day(-1)]])), 0)
  assert.deepEqual([small.toReserveUsd, small.reinvestUsd, small.experimentPoolUsd, small.keptUsd], [100, 0, 0, 0])
  assert.throws(() => reinvestmentPlan(config, moneyTotals(l), -1))
})

test('reinvestment: the experiment pool is capped by maxExperimentUsd; amounts are in cents', () => {
  const l = ledgerWith([['revenue', 10_000.01, day(-1)]])
  const p = reinvestmentPlan(config, moneyTotals(l), 5000)
  assert.equal(p.reinvestUsd, 5000.01)
  assert.equal(p.experimentPoolUsd, 250, '1,500 would be over the 250 cap')
  assert.ok(p.notes.some((n) => /capped/.test(n)))
  const odd = reinvestmentPlan({ ...config, reinvestShare: 1 / 3, experimentShare: 1 / 3 }, moneyTotals(ledgerWith([['revenue', 100, day(-1)]])), 5000)
  assert.equal(odd.reinvestUsd, 33.33)
  assert.equal(odd.experimentPoolUsd, 11.11)
  assert.equal(odd.keptUsd, 66.67)
})

test('approving a plan is the founder\'s, and periods never overlap', () => {
  const plan = reinvestmentPlan(config, moneyTotals(ledgerWith([['revenue', 2000, day(-1)]])), 5000)
  const period = operatePeriod(config, undefined, T0)
  assert.equal(approvePlan(config, [], plan, period, 5000, agent, T0).ok, false)
  assert.equal(approvePlan(config, [], plan, period, 5000, { id: 'someone-else', kind: 'human' }, T0).ok, false)
  const r = approvePlan(config, [], plan, period, 5000, founder, T0, 'ok')
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.record.seq, 1)
  assert.equal(approvePlan(config, [r.record], plan, period, 5000, founder, day(1)).ok, false, 'overlapping period')
  const next = approvePlan(config, [r.record], plan, operatePeriod(config, r.record.period.to, day(30)), 5000, founder, day(30))
  assert.ok(next.ok && next.record.seq === 2)
})

test('experiments: bounded by the approved pool and by maxExperimentUsd', () => {
  assert.equal(startOperateExperiment(config, draft('exp-a', 50), founder, T0, [], []).ok, false, 'no approved plan')
  const plans = [approved(100)]
  const over = startOperateExperiment(config, draft('exp-big', 150), founder, day(1), plans, [])
  assert.ok(!over.ok && over.reasons.some((r) => /approved pool/.test(r)))
  const overCap = startOperateExperiment(config, draft('exp-huge', 300), founder, day(1), [approved(1000)], [])
  assert.ok(!overCap.ok && overCap.reasons.some((r) => /cap for one experiment/.test(r)))
  assert.equal(startOperateExperiment(config, draft('exp-a', 60), agent, day(1), plans, []).ok, false, 'only a human starts it')
  const a = startOperateExperiment(config, draft('exp-a', 60), founder, day(1), plans, [])
  assert.ok(a.ok)
  if (!a.ok) return
  const b = startOperateExperiment(config, draft('exp-b', 50), founder, day(1), plans, [a.experiment])
  assert.ok(!b.ok && b.reasons.some((r) => /\$40/.test(r)), 'only 40 of the pool is left')
  assert.ok(startOperateExperiment(config, draft('exp-b', 40), founder, day(1), plans, [a.experiment]).ok)
})

test('experimentSpendConfig: not digital-only, budget is the pool, and decideSpend enforces the same rules', () => {
  const sc = experimentSpendConfig(config, 187.5, T0.toISOString())
  assert.equal(sc.digitalOnly, false)
  assert.equal(sc.budgetUsd, 187.5)
  assert.equal(sc.playbookId, 'operate')
  assert.equal(experimentSpendConfig(config, 1000).budgetUsd, 250, 'never more than maxExperimentUsd')
  const empty: MoneyLedger = { runId: config.runId, budgetUsd: sc.budgetUsd, entries: [] }
  assert.equal(decideSpend(sc, empty, { amountUsd: 5, category: 'inventory', description: 'stock' }, T0).recommendation, 'reject')
  assert.equal(genesisWaesFacts(sc, undefined, 'hello', 'agent-ops')['waes.review'] !== undefined, true)
})

test('spend: experiment spend is refused over the pool; business spend always needs the founder', () => {
  const plans = [approved(100)]
  const s = startOperateExperiment(config, draft('exp-a', 100), founder, day(1), plans, [])
  assert.ok(s.ok)
  if (!s.ok) return
  const exps = [s.experiment]
  let l = ledgerWith([['revenue', 5000, day(-5)], ['spend', 2000, day(-4), undefined, 'hosting']])
  // Business spend outside experiments does not use the pool.
  assert.equal(poolLedger(l, plans[0]!, plans, exps).entries.length, 0)
  const small = decideOperateSpend(config, l, plans, exps, { amountUsd: 8, category: 'advertising', description: 'ad', experimentId: 'exp-a' }, day(2), s.experiment)
  assert.equal(small.recommendation, 'request-approval', '8 of 100 left is risk 3, above autoMaxRisk 2')
  const tiny = decideOperateSpend(config, l, plans, exps, { amountUsd: 2, category: 'advertising', description: 'ad', experimentId: 'exp-a' }, day(2), s.experiment)
  assert.equal(tiny.recommendation, 'execute-autonomously')
  const r = appendMoney(l, { kind: 'spend', amountUsd: 45, category: 'advertising', description: 'ads', experimentId: 'exp-a', source: { type: 'receipt', ref: 'r1' }, occurredAt: day(2).toISOString() }, founder, day(2))
  assert.ok(r.ok)
  if (!r.ok) return
  l = r.ledger
  const overPool = decideOperateSpend(config, l, plans, exps, { amountUsd: 60, category: 'advertising', description: 'more ads', experimentId: 'exp-a' }, day(3), s.experiment)
  assert.equal(overPool.recommendation, 'reject')
  assert.ok(overPool.reasons.some((x) => /budget is left|exceed/.test(x)))
  const overCap = decideOperateSpend(config, l, plans, exps, { amountUsd: 10, category: 'advertising', description: 'same day', experimentId: 'exp-a' }, day(2), s.experiment)
  assert.ok(overCap.reasons.some((x) => /Today's cap/.test(x)), 'daily cap counts experiment spend')
  const business = decideOperateSpend(config, l, plans, exps, { amountUsd: 5, category: 'hosting', description: 'server' }, day(3))
  assert.equal(business.recommendation, 'request-approval')
  assert.equal(decideOperateSpend(config, l, plans, exps, { amountUsd: 5, category: 'hiring', description: 'contractor' }, day(3)).recommendation, 'reject')
  const unfunded = { ...s.experiment, startedAt: day(-100).toISOString() }
  assert.equal(decideOperateSpend(config, l, plans, exps, { amountUsd: 1, category: 'advertising', description: 'x', experimentId: 'exp-a' }, day(3), unfunded).recommendation, 'reject')
})

test('operateFacts: departments, period, reinvestment and experiment facts; kill stays automatic', () => {
  const l = ledgerWith([['revenue', 2000, day(-3)], ['spend', 400, day(-2), undefined, 'hosting']])
  const departments = [departmentAutonomy(report('collections', true), 'act-within-limits'), departmentAutonomy(report('sales', false), 'act-within-limits'), departmentAutonomy(undefined, undefined, 'hr')]
  const base = { config, departments, period: periodTotals(l, day(-30), T0), ledger: l, now: T0 }
  const none = operateFacts({ ...base, plans: [], experiments: [draft('exp-a', 50)] })
  assert.equal(none['departments.count'], 3)
  assert.equal(none['departments.handedOver'], 1)
  assert.equal(none['departments.capped'], 1)
  assert.equal(none['period.surplusUsd'], 1600)
  assert.equal(none['reinvestment.approved'], false)
  assert.equal(none['experiment.drafted'], true)
  assert.equal(none['experiment.poolUsd'], 0)

  const plans = [approved(100, T0)]
  const s = startOperateExperiment(config, draft('exp-a', 60), founder, day(1), plans, [])
  assert.ok(s.ok)
  if (!s.ok) return
  const running = operateFacts({ ...base, plans, experiments: [s.experiment], now: day(2) })
  assert.equal(running['reinvestment.approved'], true)
  assert.equal(running['experiment.running'], true)
  assert.equal(running['experiment.poolRemainingUsd'], 40)
  assert.equal(operateFacts({ ...base, plans, experiments: [s.experiment], now: day(40) })['reinvestment.approved'], false, 'approval covers one period')

  // Kill applies on its own (the kernel acts), and the playbook moves on.
  const m = recordMeasurement(s.experiment, 2, agent, 'analytics:export', day(5))
  assert.ok(m.ok)
  if (!m.ok) return
  const k = applyEvaluation(m.experiment, evaluateExperiment(m.experiment, 0, day(5)), { id: 'kernel', kind: 'service' }, day(5))
  assert.ok(k.ok && k.experiment.status === 'killed')
  if (!k.ok) return
  assert.equal(operateFacts({ ...base, plans, experiments: [k.experiment], now: day(5) })['experiment.verdict'], 'kill')
})
