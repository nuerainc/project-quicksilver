import { moneyTotals, type Experiment, type MoneyEntry, type MoneyLedger } from '../playbooks/economics.ts'
import type { CashShock, PeriodFlow } from './cash.ts'
import { ledgerPeriods } from './cash.ts'
import { cents } from './random.ts'

/**
 * Named stress scenarios (M7 part 3, the what-if engine).
 *
 * A small, deterministic library. Each scenario is data: a name and the
 * shocks `simulateCash` accepts. A scenario that the inputs can't support is
 * skipped with the reason, never filled in with made-up numbers.
 */

export const SCENARIO_KINDS = ['revenue-10', 'revenue-25', 'revenue-50', 'cost-spike', 'lost-largest-customer', 'delayed-payment', 'experiment-fails'] as const
export type ScenarioKind = (typeof SCENARIO_KINDS)[number]

export interface Scenario {
  name: string
  kind: ScenarioKind
  shocks: CashShock[]
  /** The numbers the shocks were built from. */
  basis: Record<string, number | string>
}

export interface ScenarioBase {
  ledger?: MoneyLedger
  periodHistory?: PeriodFlow[]
  periodDays?: number
  asOf?: Date | string
  /** Experiments that could fail (running or held ones are used). */
  experiments?: Experiment[]
}

export interface ScenarioSet {
  scenarios: Scenario[]
  skipped: Array<{ kind: ScenarioKind; reason: string }>
}

/**
 * The money ledger has no counterparty field. An entry may carry an optional
 * `counterparty` string (ignored by the ledger's rules, covered by its hash);
 * the lost-customer scenario uses it when present and is skipped otherwise.
 */
type WithCounterparty = MoneyEntry & { counterparty?: unknown }

export function generateScenarios(base: ScenarioBase, options: { kinds?: ScenarioKind[] } = {}): ScenarioSet {
  const kinds = options.kinds ?? [...SCENARIO_KINDS]
  const scenarios: Scenario[] = []
  const skipped: ScenarioSet['skipped'] = []
  const periods = base.ledger ? ledgerPeriods(base.ledger, { periodDays: base.periodDays, asOf: base.asOf }).periods : base.periodHistory ?? []
  const n = periods.length
  const meanCost = n ? cents(periods.reduce((s, p) => s + p.costUsd, 0) / n) : 0
  const meanRevenue = n ? cents(periods.reduce((s, p) => s + p.revenueUsd, 0) / n) : 0

  for (const kind of SCENARIO_KINDS) {
    if (!kinds.includes(kind)) continue
    switch (kind) {
      case 'revenue-10':
      case 'revenue-25':
      case 'revenue-50': {
        const pct = Number(kind.slice(8))
        scenarios.push({ name: `revenue −${pct}%`, kind, shocks: [{ kind: 'revenue-scale', factor: cents(1 - pct / 100) }], basis: { revenueChangePct: -pct } })
        break
      }
      case 'cost-spike': {
        if (!n) { skipped.push({ kind, reason: 'No history, so there is no normal cost to spike.' }); break }
        if (!(meanCost > 0)) { skipped.push({ kind, reason: 'History shows no cost, so a proportional spike changes nothing.' }); break }
        scenarios.push({ name: 'cost spike (×1.5 for one period)', kind, shocks: [{ kind: 'cost-scale', factor: 1.5, fromPeriod: 1, toPeriod: 1 }], basis: { meanCostUsd: meanCost, factor: 1.5 } })
        break
      }
      case 'lost-largest-customer': {
        const revenue = (base.ledger?.entries ?? []).filter((e) => e.kind === 'revenue') as WithCounterparty[]
        const named = revenue.filter((e) => typeof e.counterparty === 'string' && e.counterparty.trim())
        if (!base.ledger) { skipped.push({ kind, reason: 'Needs the money ledger to know who pays.' }); break }
        if (!named.length) { skipped.push({ kind, reason: 'The ledger does not name counterparties on revenue entries, so the largest customer is unknown.' }); break }
        const byCustomer = new Map<string, number>()
        for (const e of named) byCustomer.set((e.counterparty as string).trim(), (byCustomer.get((e.counterparty as string).trim()) ?? 0) + e.amountUsd)
        const [customer, total] = [...byCustomer.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!
        const perPeriod = cents(total / Math.max(1, n))
        scenarios.push({ name: `lost largest customer (${customer})`, kind, shocks: [{ kind: 'revenue-drop', amountUsd: perPeriod }], basis: { customer, historicalRevenueUsd: cents(total), perPeriodUsd: perPeriod, periods: n, revenueEntriesNamed: named.length, revenueEntries: revenue.length } })
        break
      }
      case 'delayed-payment': {
        scenarios.push({ name: 'delayed payment (half of period 1 revenue arrives one period late)', kind, shocks: [{ kind: 'revenue-delay', share: 0.5, delayPeriods: 1, fromPeriod: 1, toPeriod: 1 }], basis: { share: 0.5, delayPeriods: 1, meanRevenueUsd: meanRevenue } })
        break
      }
      case 'experiment-fails': {
        const open = (base.experiments ?? []).filter((e) => e.status === 'running' || e.status === 'held')
        if (!open.length) { skipped.push({ kind, reason: 'No running or held experiment to fail.' }); break }
        const totals = base.ledger ? moneyTotals(base.ledger) : undefined
        for (const e of open) {
          const spent = totals?.byExperiment[e.definition.id]?.capitalUsedUsd ?? 0
          const left = cents(Math.max(0, e.definition.budgetUsd - spent))
          // Revenue the ledger attributes to this experiment is in the history; a failed experiment earns none of it.
          const earned = totals?.byExperiment[e.definition.id]?.revenueUsd ?? 0
          const earnedPerPeriod = cents(earned / Math.max(1, n))
          const shocks: CashShock[] = [{ kind: 'cost-add', amountUsd: left, fromPeriod: 1, toPeriod: 1 }]
          if (earnedPerPeriod > 0) shocks.push({ kind: 'revenue-drop', amountUsd: earnedPerPeriod })
          scenarios.push({
            name: `experiment ${e.definition.id} fails at its kill threshold`,
            kind,
            shocks,
            basis: { experimentId: e.definition.id, killThreshold: e.definition.metric.kill, budgetUsd: e.definition.budgetUsd, spentUsd: spent, remainingBudgetSpentUsd: left, historicalRevenueFromExperimentUsd: earned, revenueLostPerPeriodUsd: earnedPerPeriod },
          })
        }
        break
      }
    }
  }
  return { scenarios, skipped }
}
