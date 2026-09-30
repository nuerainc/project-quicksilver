/**
 * What-if commands (M7 part 3), run on the founder's computer or the host.
 *
 *   npm run whatif -- cash [--run operate|genesis] [--horizon 6] [--runs 2000] [--seed 1] [--cash <usd>] [--scenario <name>]
 *                          [--period-days <n>] [--reserve <usd>] [--block <n>]
 *   npm run whatif -- scenarios [--run operate|genesis]
 *   npm run whatif -- experiment <experimentId> [--run operate|genesis] [--runs 2000] [--seed 1] [--noise <sd>]
 *   npm run whatif -- autonomy [--department <d>]
 *
 * Every result is an ESTIMATE, never a decision. These commands only read:
 * the money ledger and experiments of the Operate run (data/operate/<runId>/)
 * or the Genesis run (data/genesis/<runId>/, or Sanity with
 * QUICKSILVER_GENESIS_STORE=sanity), and the Onboard shadow logs
 * (data/intent/onboard/<intentId>/shadow.json). They write, spend, authorize
 * and change nothing. The same inputs and seed give the same numbers.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { moneyTotals, type Experiment, type MoneyLedger } from '@quicksilver/kernel/playbooks/economics'
import type { GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'
import { periodTotals, type OperateConfig } from '@quicksilver/kernel/playbooks/operate'
import { DEFAULT_HAND_OVER, type HandOverRules } from '@quicksilver/kernel/playbooks/shadow'
import {
  counterfactualAutonomy,
  counterfactualKernel,
  describeShock,
  generateScenarios,
  ledgerPeriods,
  simulateCash,
  simulateExperiment,
  type CounterfactualRow,
  type Scenario,
} from '@quicksilver/kernel/simulation'

import { genesisStoresFromEnv } from './genesis-store.ts'
import { loadShadowLogs, OperateStore } from './operate-store.ts'
import { CLI_VALUE_FLAGS, parseCommandArgs } from './cli-args.ts'

const root = process.env.INIT_CWD ?? process.cwd()
const { command: cmd, args, flag, positional } = parseCommandArgs(process.argv.slice(2), { valueFlags: CLI_VALUE_FLAGS.whatif })

function fail(message: string): never { console.error(message); process.exit(1) }
const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

function intFlag(name: string, fallback: number, min: number, max: number): number {
  const raw = flag(name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be a whole number from ${min} to ${max}.`)
  return n
}
function numFlag(name: string): number | undefined {
  const raw = flag(name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) fail(`${name} must be a number of zero or more.`)
  return n
}

interface RunData {
  kind: 'operate' | 'genesis'
  runId: string
  ledger: MoneyLedger
  experiments: Experiment[]
  periodDays: number
  reserveFloorUsd: number
  /** Cash on hand when --cash is not passed, with how it was worked out. */
  defaultCash: { usd: number; how: string } | { usd: null; how: string }
  handOver?: HandOverRules
}

async function readConfig<T>(path: string): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (e) { fail(`Could not read ${path}: ${(e as Error).message}`) }
}

async function loadRun(kind: string): Promise<RunData> {
  if (kind === 'operate') {
    const config = await readConfig<OperateConfig>(resolve(root, process.env.QUICKSILVER_OPERATE_CONFIG ?? 'deploy/operate/operate-nuera.json'))
    const store = new OperateStore(resolve(root, process.env.QUICKSILVER_OPERATE_DIR ?? 'data/operate'), config.runId)
    const ledger = await store.ledger().catch((e: Error) => fail(e.message))
    const plans = await store.plans()
    const last = plans.at(-1)
    const defaultCash: RunData['defaultCash'] = last
      ? (() => {
          const since = periodTotals(ledger, last.approvedAt, new Date(8.64e15))
          return { usd: last.cashOnHandUsd + since.netUsd, how: `cash on hand at plan #${last.seq} (${usd(last.cashOnHandUsd)}, ${last.approvedAt.slice(0, 10)}) plus the ledger's net since (${usd(since.netUsd)})` }
        })()
      : { usd: null, how: 'no approved plan records cash on hand' }
    return { kind: 'operate', runId: config.runId, ledger, experiments: await store.experiments(), periodDays: config.periodDays ?? 30, reserveFloorUsd: config.reserveFloorUsd ?? 0, defaultCash, handOver: config.handOver }
  }
  if (kind === 'genesis') {
    const config = await readConfig<GenesisRunConfig>(resolve(root, process.env.QUICKSILVER_GENESIS_CONFIG ?? 'deploy/genesis/genesis-500.json'))
    const stores = await genesisStoresFromEnv({ dir: resolve(root, process.env.QUICKSILVER_GENESIS_DIR ?? 'data/genesis'), budgetUsd: config.budgetUsd }).catch((e: Error) => fail(e.message))
    const entries = await stores.ledger.load(config.runId).catch((e: Error) => fail(e.message))
    const ledger: MoneyLedger = { runId: config.runId, budgetUsd: config.budgetUsd, entries }
    const t = moneyTotals(ledger)
    // Genesis runs last weeks, not months: weekly periods by default.
    return { kind: 'genesis', runId: config.runId, ledger, experiments: await stores.experiments.list(config.runId), periodDays: 7, reserveFloorUsd: 0, defaultCash: { usd: config.budgetUsd + t.netUsd, how: `the run budget (${usd(config.budgetUsd)}) plus the ledger's net (${usd(t.netUsd)})` } }
  }
  fail('--run must be operate or genesis.')
}

const scenarioKey = (s: Scenario) => (s.kind === 'experiment-fails' ? `${s.kind}:${String(s.basis.experimentId)}` : s.kind)

function scenariosFor(run: RunData, periodDays: number) {
  return generateScenarios({ ledger: run.ledger, periodDays, experiments: run.experiments })
}

function printRow(r: CounterfactualRow) {
  const met = r.metAt ? `${r.metAt.slice(0, 10)} (${r.judgedWhenMet} judged)` : 'never'
  console.log(`  ${String(r.minJudged).padStart(4)}  ${pct(r.minAgreement).padStart(6)}  ${met.padEnd(24)} ${String(r.wouldRunAlone).padStart(9)} ${String(r.wouldHaveBeenWrong).padStart(6)} (${r.ownerRejected} rejected, ${r.ownerModified} modified) ${String(r.unjudged).padStart(9)} ${String(r.badOutcomes).padStart(4)} ${String(r.unknownOutcomes).padStart(8)}${r.current ? '  ← your rules' : ''}`)
}

switch (cmd) {
  case 'cash': {
    const run = await loadRun(flag('--run') ?? 'operate')
    const horizon = intFlag('--horizon', 6, 1, 120)
    const runs = intFlag('--runs', 2000, 1, 100_000)
    const seed = intFlag('--seed', 1, -2_147_483_648, 2_147_483_647)
    const periodDays = intFlag('--period-days', run.periodDays, 1, 366)
    const blockLength = intFlag('--block', 1, 1, 24)
    const reserve = numFlag('--reserve') ?? run.reserveFloorUsd
    let cash = numFlag('--cash')
    const notes: string[] = []
    if (cash === undefined) {
      if (run.defaultCash.usd === null) fail(`--cash <usd> is required: ${run.defaultCash.how}, and the ledger does not know your bank balance.`)
      cash = run.defaultCash.usd
      notes.push(`Start cash is ${run.defaultCash.how}. Pass --cash <usd> for your real balance.`)
    }
    const scenarioName = flag('--scenario')
    let scenario: Scenario | undefined
    if (scenarioName) {
      const set = scenariosFor(run, periodDays)
      scenario = set.scenarios.find((s) => scenarioKey(s) === scenarioName) ?? (set.scenarios.filter((s) => s.kind === scenarioName).length === 1 ? set.scenarios.find((s) => s.kind === scenarioName) : undefined)
      if (!scenario) {
        const skipped = set.skipped.find((s) => s.kind === scenarioName)
        fail(skipped ? `Scenario ${scenarioName} is not available: ${skipped.reason}` : `No scenario "${scenarioName}". Available: ${set.scenarios.map(scenarioKey).join(', ') || 'none'}.`)
      }
    }
    const r = simulateCash({ ledger: run.ledger, periodDays, startCashUsd: cash, horizonPeriods: horizon, reserveFloorUsd: reserve, runs, seed, blockLength, ...(scenario ? { shocks: scenario.shocks } : {}) })
    console.log(`What-if cash for ${run.kind} run ${run.runId}: an ESTIMATE, not a decision. Seed ${seed}, ${runs} runs, history ${r.ok ? r.history.periods : 0} period(s) of ${periodDays} days (${run.ledger.entries.length} ledger entries).`)
    if (!r.ok) fail(`No estimate: ${r.reasons.join(' ')}`)
    if (scenario) console.log(`Scenario: ${scenario.name}.`)
    console.log(`Basis: ${r.label}.`)
    console.log(`  period ${'p5'.padStart(11)} ${'p25'.padStart(11)} ${'p50'.padStart(11)} ${'p75'.padStart(11)} ${'p95'.padStart(11)}  <reserve  <$0  median revenue  median return`)
    for (const s of r.steps) {
      console.log(`  ${String(s.period).padStart(6)} ${[s.cash.p5, s.cash.p25, s.cash.p50, s.cash.p75, s.cash.p95].map((x) => usd(x).padStart(11)).join(' ')}  ${pct(s.pBelowReserve).padStart(8)} ${pct(s.pOutOfCash).padStart(6)} ${usd(s.medianRevenueUsd).padStart(15)}  ${s.medianReturnOnCapital === null ? '—' : s.medianReturnOnCapital.toFixed(3)}`)
    }
    console.log(`Over ${horizon} period(s): chance cash falls below the ${usd(r.reserveFloorUsd)} reserve floor at some point ${pct(r.pBelowReserve)}; chance of running out of cash ${pct(r.pOutOfCash)}.`)
    if (r.medianRevenueDelayedPastHorizonUsd > 0) console.log(`Median revenue delayed past the horizon: ${usd(r.medianRevenueDelayedPastHorizonUsd)}.`)
    console.log('How to read it: in half the runs cash ended above p50; in 90% of runs it ended between p5 and p95. It is a spread of possibilities from history, not a forecast or a plan.')
    console.log('Assumptions:')
    for (const a of [...notes, ...r.assumptions]) console.log(`  - ${a}`)
    for (const w of r.warnings) console.log(`  ! ${w}`)
    break
  }
  case 'scenarios': {
    const run = await loadRun(flag('--run') ?? 'operate')
    const periodDays = intFlag('--period-days', run.periodDays, 1, 366)
    const set = scenariosFor(run, periodDays)
    const history = ledgerPeriods(run.ledger, { periodDays }).periods.length
    console.log(`Stress scenarios for ${run.kind} run ${run.runId} (use with: npm run whatif -- cash --run ${run.kind} --scenario <name>). Inputs to an estimate, not predictions or decisions. Deterministic (no sampling: seed and runs apply when you run cash). History ${history} period(s) of ${periodDays} days (${run.ledger.entries.length} ledger entries).`)
    for (const s of set.scenarios) console.log(`  ${scenarioKey(s)}: ${s.name} — ${s.shocks.map(describeShock).join('; ')}`)
    for (const s of set.skipped) console.log(`  (skipped) ${s.kind}: ${s.reason}`)
    break
  }
  case 'experiment': {
    const [id] = positional
    if (!id) fail('Usage: experiment <experimentId> [--run operate|genesis] [--runs 2000] [--seed 1] [--noise <sd>]')
    const run = await loadRun(flag('--run') ?? 'operate')
    const exp = run.experiments.find((e) => e.definition.id === id)
    if (!exp) fail(`No experiment "${id}" in ${run.kind} run ${run.runId}.`)
    const runs = intFlag('--runs', 2000, 1, 100_000)
    const seed = intFlag('--seed', 1, -2_147_483_648, 2_147_483_647)
    const noise = numFlag('--noise') ?? 0
    const r = simulateExperiment(exp, { runs, seed, noise, ledger: run.ledger, now: new Date() })
    console.log(`What-if for experiment ${id} (${run.kind} run ${run.runId}): an ESTIMATE, not a decision. Seed ${seed}, ${runs} runs, history ${exp.measurements.length} measurement(s).`)
    if (!r.ok) fail(`No estimate: ${r.reasons.join(' ')}`)
    const m = exp.definition.metric
    console.log(`Now: ${r.current.verdict}. ${r.current.explanation}`)
    console.log(`By the end date (${exp.endsAt?.slice(0, 10)}, ${r.stepsLeft} more measurement(s) expected):`)
    for (const k of ['kill', 'hold', 'continue', 'scale', 'over-budget'] as const) console.log(`  ${k.padEnd(12)} ${pct(r.odds[k]).padStart(6)}`)
    console.log(`Chance ${m.label} reaches the scale threshold (${m.scale}) at some point: ${pct(r.pReachesScale)}. Final ${m.label}: p5 ${r.finalValue.p5}, p50 ${r.finalValue.p50}, p95 ${r.finalValue.p95}.`)
    console.log(`Spend: ${usd(r.spentUsd)} of ${usd(r.budgetUsd)} so far; chance of going over budget at the observed pace: ${pct(r.pOverBudget)}.`)
    console.log('Nothing was applied: kill, hold and scale are still decided by evaluate / decide.')
    console.log('Assumptions:')
    for (const a of r.assumptions) console.log(`  - ${a}`)
    for (const w of r.warnings) console.log(`  ! ${w}`)
    break
  }
  case 'autonomy': {
    const intentDir = resolve(root, process.env.QUICKSILVER_INTENT_DIR ?? 'data/intent')
    let rules: HandOverRules = DEFAULT_HAND_OVER
    try {
      const c = JSON.parse(await readFile(resolve(root, process.env.QUICKSILVER_OPERATE_CONFIG ?? 'deploy/operate/operate-nuera.json'), 'utf8')) as OperateConfig
      if (c.handOver) rules = c.handOver
    } catch { /* default rules */ }
    const log = await loadShadowLogs(intentDir)
    const department = flag('--department')
    const cf = counterfactualAutonomy(log, { rules, ...(department ? { department } : {}) })
    const judged = log.recommendations.filter((r) => r.verdict && (!department || r.department === department)).length
    console.log(`What-if autonomy: an ESTIMATE from recorded shadow history, not a decision; it grants nothing. Deterministic (no sampling: seed and runs do not apply). History ${judged} judged of ${log.recommendations.filter((r) => !department || r.department === department).length} recommendation(s). Your rules: ${rules.minJudged} judged at ${pct(rules.minAgreement)}.`)
    if (!cf.departments.length) console.log(department ? `  No shadow recommendations for ${department}.` : '  No shadow recommendations yet.')
    for (const d of cf.departments) {
      console.log(`\n${d.department}: ${d.judged} judged of ${d.recommendations}. If it had acted alone once the rules were first met:`)
      console.log(`  ${'min'.padStart(4)}  ${'agree'.padStart(6)}  ${'met'.padEnd(24)} ${'run alone'.padStart(9)} ${'wrong'.padStart(6)} ${' '.repeat(24)} ${'unjudged'.padStart(9)} ${'bad'.padStart(4)} ${'unknown'.padStart(8)}`)
      const rows = d.table.some((r) => r.current) ? d.table : [...d.table, d.current]
      for (const r of rows) printRow(r)
      for (const n of d.notes) console.log(`  ! ${n}`)
    }
    const k = counterfactualKernel(department ? { recommendations: log.recommendations.filter((r) => r.department === department) } : log)
    const o = k.overall
    console.log(`\nKernel vs owner (${o.judged} judged): matched ${o.matched}, kernel too loose ${o.tooLoose}, too strict ${o.tooStrict}, sent to a human ${o.escalated}; match rate ${o.matchRate === null ? '— (every case went to a human)' : pct(o.matchRate)}.`)
    for (const [dep, a] of Object.entries(k.byDepartment)) console.log(`  ${dep}: ${a.judged} judged, match rate ${a.matchRate === null ? '—' : pct(a.matchRate)} (${a.tooLoose} too loose, ${a.tooStrict} too strict, ${a.escalated} escalated)`)
    console.log('Assumptions:')
    for (const a of [...cf.assumptions, ...k.assumptions]) console.log(`  - ${a}`)
    break
  }
  default:
    console.log('Commands: cash, scenarios, experiment <id>, autonomy. Every result is an estimate, never a decision. See the header of packages/host/src/whatif-cli.ts.')
}
