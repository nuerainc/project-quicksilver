/** Onboard connectors and back-testing (M4). */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { backtestRevenue, BlockedSourceError, createIntent, monthlyTotals, observeInto, parseCsv, readCsvLedger, validateIntentGraph } from './index.ts'

const NOW = new Date('2026-09-26T12:00:00Z')

/** 24 months of a feed store with a seasonal pattern and steady costs. */
function ledgerCsv(noise = 0.05): string {
  const lines = ['Date,Description,Category,Amount']
  for (let i = 0; i < 24; i++) {
    const y = 2024 + Math.floor(i / 12), m = (i % 12) + 1
    const season = 1 + 0.3 * Math.sin(((m - 3) / 12) * 2 * Math.PI)
    const wobble = 1 + noise * (((i * 7) % 5) - 2) / 2
    const revenue = Math.round(20000 * season * wobble)
    lines.push(`${m}/5/${y},"Feed sales, week 1",Sales,"$${revenue.toLocaleString('en-US')}.00"`)
    lines.push(`${y}-${String(m).padStart(2, '0')}-10,Wholesale feed,Cost of goods,(${Math.round(revenue * 0.6)})`)
    lines.push(`${y}-${String(m).padStart(2, '0')}-15,Wages,Payroll,-4000`)
    lines.push(`${y}-${String(m).padStart(2, '0')}-20,Truck fuel,Fuel,-650.50`)
  }
  return lines.join('\r\n')
}

test('CSV parsing handles quotes, commas in fields, and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']])
})

test('the CSV ledger connector reads common exports into transactions and observations', () => {
  const r = readCsvLedger(ledgerCsv(), { source: 'feed-store-ledger.csv' })
  assert.equal(r.transactions.length, 96)
  assert.equal(r.transactions[0]!.date, '2024-01-05')
  assert.equal(r.transactions.find((t) => t.category === 'Cost of goods')!.amount < 0, true, 'parentheses mean negative')
  const obs = Object.fromEntries(r.observations.map((o) => [o.variableId, o.value]))
  assert.equal(obs['observed.history_months'], 24)
  assert.ok((obs['observed.monthly_revenue'] as number) > 10000)
  assert.ok((obs['observed.net_margin'] as number) > 0 && (obs['observed.net_margin'] as number) < 0.4)
  assert.match(String(obs['observed.top_expenses']), /Cost of goods/)
  assert.deepEqual(r.warnings, [])
})

test('debit/credit exports work too, and unreadable rows are reported, not guessed', () => {
  const r = readCsvLedger('Posted Date,Memo,Debit,Credit\n2026-01-03,Sale,,1200\n2026-01-04,Rent,900,\nnot a date,x,1,\n', { source: 'bank.csv' })
  assert.deepEqual(r.transactions.map((t) => t.amount), [1200, -900])
  assert.match(r.warnings.join(' '), /1 row/)
  assert.match(readCsvLedger('foo,bar\n1,2\n', { source: 'x.csv' }).warnings[0]!, /Could not find/)
})

test('AMP boundary: patent-looking sources are refused', () => {
  for (const s of ['AMP-ledger.csv', 'patent costs.csv', 'PPA Rev 4.2 budget.csv', 'provisional-filing.csv']) {
    assert.throws(() => readCsvLedger('Date,Amount\n2026-01-01,1\n', { source: s }), BlockedSourceError, s)
  }
  assert.doesNotThrow(() => readCsvLedger('Date,Amount\n2026-01-01,1\n', { source: 'sample.csv' }))
})

test('observations enter the graph as OBSERVED, through the governed updater, without touching stated values', async () => {
  const { graph } = await createIntent('We run a feed store. Help us understand our margins.', { requestedBy: 'entity-founder', now: NOW, id: 'intent-feed' })
  const reading = readCsvLedger(ledgerCsv(), { source: 'feed-store-ledger.csv' })
  const r = observeInto(graph, reading, NOW)
  assert.ok(r.applied.includes('observed.monthly_revenue') && r.applied.includes('data_sources'))
  assert.deepEqual(r.refused, [])
  const rev = r.graph.variables.find((v) => v.id === 'observed.monthly_revenue')!
  assert.equal(rev.provenance, 'OBSERVED')
  assert.equal(rev.sources[0]!.type, 'observation')
  assert.equal(rev.updatedBy, 'svc:connector:csv-ledger')
  assert.deepEqual(validateIntentGraph(r.graph), [])
  assert.equal(r.graph.variables.find((v) => v.id === 'objective')!.provenance, 'HUMAN_SPECIFIED')
  assert.ok(r.graph.history.length >= r.applied.length)
})

test('back-test: a stable seasonal business passes; forecasts only use earlier months', () => {
  const months = monthlyTotals(readCsvLedger(ledgerCsv(0.05), { source: 'x.csv' }).transactions)
  const report = backtestRevenue(months)
  assert.equal(report.months, 24)
  assert.equal(report.folds.length, 18)
  assert.equal(report.folds[0]!.method, 'mean-3')
  assert.equal(report.folds.at(-1)!.method, 'seasonal-naive')
  assert.equal(report.passed, true, report.reasons.join(' '))
  assert.ok(report.mape! < 0.3)
  assert.match(report.summary, /Passed/)
})

test('back-test: erratic revenue fails with reasons; too little history is not a pass', () => {
  const erratic = Array.from({ length: 20 }, (_, i) => ({ month: `2025-${String((i % 12) + 1).padStart(2, '0')}`, revenue: i % 2 ? 2000 : 12000 }))
  const bad = backtestRevenue(erratic)
  assert.equal(bad.passed, false)
  assert.match(bad.reasons.join(' '), /above the 30% limit/)
  const short = backtestRevenue(erratic.slice(0, 9))
  assert.equal(short.passed, false)
  assert.match(short.reasons.join(' '), /at least 6/)
})
