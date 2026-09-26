import { applyBeliefUpdate } from './belief.ts'
import type { GraphVariable, IntentGraph } from './types.ts'

/**
 * Onboard connectors (M4): read a business's own records and fill the intent
 * graph with OBSERVED values, so Onboard starts from evidence, not guesses.
 *
 * Rules:
 *   - Connectors only read. They never write back to the source system.
 *   - Every observation names its source (connector, file and rows), and
 *     enters the graph through the governed belief updater as a service
 *     actor, so the memory governor still screens it and a human-stated value
 *     is never overwritten.
 *   - Boundary: sources that look like AMP patent material are refused until
 *     the provisional application is filed (the default pattern list can be
 *     extended, never emptied by a connector).
 */

export interface Observation {
  variableId: string
  label: string
  value: string | number
  unit?: string
  importance: number
  /** e.g. "ledger.csv rows 2–418". */
  sourceRef: string
}

export interface Transaction {
  date: string // YYYY-MM-DD
  amount: number // positive = money in, negative = money out
  category: string
  description: string
}

export interface ConnectorReading {
  connectorId: string
  kind: 'ledger' | 'crm' | 'payments' | 'email'
  source: string
  observations: Observation[]
  transactions: Transaction[]
  warnings: string[]
}

export const BLOCKED_SOURCE_PATTERNS: readonly RegExp[] = Object.freeze([/\bamp\b/i, /patent/i, /\bppa\b/i, /provisional/i])

export class BlockedSourceError extends Error {
  constructor(source: string) {
    super(`Source "${source}" looks like AMP patent material; it stays out of Quicksilver connectors until the provisional application is filed.`)
    this.name = 'BlockedSourceError'
  }
}

export function assertSourceAllowed(source: string, extra: readonly RegExp[] = []): void {
  for (const p of [...BLOCKED_SOURCE_PATTERNS, ...extra]) if (p.test(source)) throw new BlockedSourceError(source)
}

// ---------------------------------------------------------------------------
// CSV ledger connector

export interface CsvLedgerOptions {
  /** A name for the source, e.g. the file name. Checked against the boundary. */
  source: string
  /** Column names in the file (case-insensitive). Defaults cover common exports. */
  columns?: { date?: string; amount?: string; category?: string; description?: string; debit?: string; credit?: string }
  /** Categories counted as revenue; by default any positive amount is revenue. */
  revenueCategories?: string[]
}

/** Parse CSV text (RFC 4180 quoting). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null
  let s = raw.trim()
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  s = s.replace(/[$,\s]/g, '')
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1) }
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  return (negative ? -1 : 1) * Number(s)
}

function parseDate(raw: string | undefined): string | null {
  const s = raw?.trim() ?? ''
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s)
  if (m) { const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!; return `${y}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}` }
  return null
}

const round2 = (x: number) => Math.round(x * 100) / 100

/** Monthly totals of money in (revenue) and out (expenses), oldest first. */
export function monthlyTotals(transactions: Transaction[], revenueCategories?: string[]): Array<{ month: string; revenue: number; expenses: number }> {
  const isRevenue = (t: Transaction) => revenueCategories?.length ? revenueCategories.some((c) => c.toLowerCase() === t.category.toLowerCase()) && t.amount > 0 : t.amount > 0
  const by = new Map<string, { revenue: number; expenses: number }>()
  for (const t of transactions) {
    const month = t.date.slice(0, 7)
    const m = by.get(month) ?? { revenue: 0, expenses: 0 }
    if (isRevenue(t)) m.revenue += t.amount
    else if (t.amount < 0) m.expenses += -t.amount
    by.set(month, m)
  }
  const months = [...by.keys()].sort()
  if (!months.length) return []
  // Fill gaps so a month with no activity counts as zero, not as missing.
  const out: Array<{ month: string; revenue: number; expenses: number }> = []
  let [y, mo] = months[0]!.split('-').map(Number) as [number, number]
  const last = months.at(-1)!
  for (;;) {
    const key = `${y}-${String(mo).padStart(2, '0')}`
    const v = by.get(key) ?? { revenue: 0, expenses: 0 }
    out.push({ month: key, revenue: round2(v.revenue), expenses: round2(v.expenses) })
    if (key === last) break
    mo++
    if (mo > 12) { mo = 1; y++ }
  }
  return out
}

export function readCsvLedger(text: string, options: CsvLedgerOptions): ConnectorReading {
  assertSourceAllowed(options.source)
  const rows = parseCsv(text)
  const warnings: string[] = []
  if (rows.length < 2) return { connectorId: 'csv-ledger', kind: 'ledger', source: options.source, observations: [], transactions: [], warnings: ['The file has no data rows.'] }
  const header = rows[0]!.map((h) => h.trim().toLowerCase())
  const find = (explicit: string | undefined, candidates: string[]) => {
    const names = explicit ? [explicit.toLowerCase()] : candidates
    return header.findIndex((h) => names.includes(h))
  }
  const c = options.columns ?? {}
  const iDate = find(c.date, ['date', 'transaction date', 'posted date', 'txn date'])
  const iAmount = find(c.amount, ['amount', 'total', 'net amount'])
  const iDebit = find(c.debit, ['debit', 'withdrawal', 'money out'])
  const iCredit = find(c.credit, ['credit', 'deposit', 'money in'])
  const iCat = find(c.category, ['category', 'account', 'type', 'class'])
  const iDesc = find(c.description, ['description', 'memo', 'name', 'payee', 'details'])
  if (iDate < 0 || (iAmount < 0 && iDebit < 0 && iCredit < 0)) {
    return { connectorId: 'csv-ledger', kind: 'ledger', source: options.source, observations: [], transactions: [], warnings: [`Could not find a date column and an amount (or debit/credit) column in: ${header.join(', ')}.`] }
  }
  const transactions: Transaction[] = []
  let skipped = 0
  for (const r of rows.slice(1)) {
    const date = parseDate(r[iDate])
    let amount = iAmount >= 0 ? parseAmount(r[iAmount]) : null
    if (amount === null && (iDebit >= 0 || iCredit >= 0)) {
      const credit = iCredit >= 0 ? parseAmount(r[iCredit]) ?? 0 : 0
      const debit = iDebit >= 0 ? parseAmount(r[iDebit]) ?? 0 : 0
      amount = credit - Math.abs(debit)
    }
    if (!date || amount === null) { skipped++; continue }
    transactions.push({ date, amount, category: (iCat >= 0 ? r[iCat] : '')?.trim() || 'uncategorized', description: (iDesc >= 0 ? r[iDesc] : '')?.trim() ?? '' })
  }
  if (skipped) warnings.push(`${skipped} row(s) had no readable date or amount and were skipped.`)
  transactions.sort((a, b) => a.date.localeCompare(b.date))

  const months = monthlyTotals(transactions, options.revenueCategories)
  const ref = `${options.source} (${transactions.length} transactions, ${months[0]?.month ?? '?'} to ${months.at(-1)?.month ?? '?'})`
  const observations: Observation[] = [{ variableId: 'data_sources', label: 'Data sources', value: `Ledger export: ${options.source}`, importance: 0.7, sourceRef: ref }]
  if (months.length) {
    const recent = months.slice(-3)
    const avgRev = round2(recent.reduce((s, m) => s + m.revenue, 0) / recent.length)
    const avgExp = round2(recent.reduce((s, m) => s + m.expenses, 0) / recent.length)
    observations.push(
      { variableId: 'observed.monthly_revenue', label: 'Monthly revenue (last 3 months, average)', value: avgRev, unit: 'USD', importance: 0.8, sourceRef: ref },
      { variableId: 'observed.monthly_expenses', label: 'Monthly expenses (last 3 months, average)', value: avgExp, unit: 'USD', importance: 0.7, sourceRef: ref },
      { variableId: 'observed.history_months', label: 'Months of history', value: months.length, unit: 'months', importance: 0.4, sourceRef: ref },
    )
    if (avgRev > 0) observations.push({ variableId: 'observed.net_margin', label: 'Net margin (last 3 months)', value: Math.round(((avgRev - avgExp) / avgRev) * 1000) / 1000, unit: 'fraction', importance: 0.8, sourceRef: ref })
    const byCat = new Map<string, number>()
    for (const t of transactions.filter((t) => t.amount < 0 && t.date.slice(0, 7) >= recent[0]!.month)) byCat.set(t.category, (byCat.get(t.category) ?? 0) - t.amount)
    const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    if (top.length) observations.push({ variableId: 'observed.top_expenses', label: 'Largest expense categories (last 3 months)', value: top.map(([k, v]) => `${k} $${round2(v / recent.length)}/mo`).join('; '), importance: 0.6, sourceRef: ref })
  }
  return { connectorId: 'csv-ledger', kind: 'ledger', source: options.source, observations, transactions, warnings }
}

// ---------------------------------------------------------------------------
// Into the graph

export interface ObserveResult {
  graph: IntentGraph
  applied: string[]
  refused: Array<{ variableId: string; reasons: string[] }>
}

/**
 * Write observations into the graph as OBSERVED values, through the governed
 * belief updater (actor: the connector's service identity). Variables that
 * do not exist yet are added as open unknowns first, then observed.
 */
export function observeInto(graph: IntentGraph, reading: ConnectorReading, now = new Date()): ObserveResult {
  let g = structuredClone(graph)
  const applied: string[] = []
  const refused: ObserveResult['refused'] = []
  const actor = { id: `svc:connector:${reading.connectorId}`, kind: 'service' as const }
  for (const o of reading.observations) {
    if (!g.variables.some((v) => v.id === o.variableId)) {
      const unknown: GraphVariable = { id: o.variableId, label: o.label, kind: 'unknown', provenance: 'AGENT_INFERRED', confidence: 0, importance: o.importance, sources: [], updatedAt: now.toISOString(), updatedBy: actor.id, ...(o.unit ? { unit: o.unit } : {}) }
      g = { ...g, variables: [...g.variables, unknown], edges: [...g.edges, { from: 'objective', to: o.variableId, relation: 'informs' }] }
    }
    const r = applyBeliefUpdate(g, actor, {
      variableId: o.variableId,
      value: o.value,
      provenance: 'OBSERVED',
      confidence: 0.9,
      sources: [{ type: 'observation', ref: `${reading.connectorId}:${o.sourceRef}` }],
      kind: typeof o.value === 'number' ? 'metric' : 'assumption',
    }, now)
    if (r.accepted) { g = r.graph; applied.push(o.variableId) } else refused.push({ variableId: o.variableId, reasons: r.reasons })
  }
  return { graph: g, applied, refused }
}
