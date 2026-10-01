/** Onboard connectors and back-testing (M4). */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  backtestRevenue,
  BlockedSourceError,
  createIntent,
  ingestLiveConnectors,
  monthlyTotals,
  observeInto,
  parseCsv,
  readCrmConnector,
  readCsvLedger,
  readEmailConnector,
  readPaymentsConnector,
  validateIntentGraph,
} from './index.ts'

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

test('patent boundary: patent-looking sources are refused, and a deployment can add patterns', () => {
  for (const s of ['patent costs.csv', 'Patent-ledger.csv', 'provisional-filing.csv']) {
    assert.throws(() => readCsvLedger('Date,Amount\n2026-01-01,1\n', { source: s }), BlockedSourceError, s)
  }
  assert.doesNotThrow(() => readCsvLedger('Date,Amount\n2026-01-01,1\n', { source: 'sample.csv' }))
  const extra = [/\bharbor\b/i]
  assert.throws(() => readCsvLedger('Date,Amount\n2026-01-01,1\n', { source: 'harbor-budget.csv', blockedPatterns: extra }), BlockedSourceError)
  assert.throws(() => readCsvLedger('Date,Amount\n2026-01-01,1\n', { source: 'patent.csv', blockedPatterns: extra }), BlockedSourceError, 'extra patterns never replace the built-ins')
  assert.doesNotThrow(() => readCsvLedger('Date,Amount\n2026-01-01,1\n', { source: 'harbor-budget.csv' }))
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

test('payments connector: reads charges, refunds, subscriptions and disputes into observations', () => {
  const csv = [
    'Date,Type,Amount,Customer,Description',
    '2026-08-01,charge,$150.00,cust-1,Annual plan',
    '2026-08-05,subscription,50.00,cust-2,Monthly sub',
    '2026-08-10,refund,25.00,cust-1,Partial refund',
    '2026-08-15,dispute,50.00,cust-3,Chargeback',
    '2026-09-01,subscription,50.00,cust-2,Monthly sub renewal',
  ].join('\n')

  const r = readPaymentsConnector(csv, { source: 'stripe-test.csv' })
  assert.equal(r.kind, 'payments')
  assert.equal(r.transactions.length, 5)
  const obs = Object.fromEntries(r.observations.map((o) => [o.variableId, o.value]))
  assert.equal(obs['observed.charge_volume'], 250)
  assert.equal(obs['observed.active_customers'], 3)
  assert.ok((obs['observed.refund_rate'] as number) > 0)
  assert.ok((obs['observed.dispute_rate'] as number) > 0)
  assert.ok((obs['observed.monthly_recurring_revenue'] as number) > 0)
  assert.deepEqual(r.warnings, [])

  // Refuses patent source
  assert.throws(() => readPaymentsConnector(csv, { source: 'patent-payments.csv' }), BlockedSourceError)
})

test('CRM connector: parses pipeline, win rate, deal size and sales cycle', () => {
  const deals = [
    { name: 'Acme Renewal', stage: 'Closed Won', amount: 12000, status: 'won' as const, createdDate: '2026-01-01', closeDate: '2026-02-01' },
    { name: 'Beta Trial', stage: 'Closed Won', amount: 8000, status: 'won' as const, createdDate: '2026-02-01', closeDate: '2026-03-03' },
    { name: 'Gamma Demo', stage: 'Closed Lost', amount: 5000, status: 'lost' as const, createdDate: '2026-02-15', closeDate: '2026-03-01' },
    { name: 'Delta Expansion', stage: 'Negotiation', amount: 25000, status: 'open' as const, createdDate: '2026-03-10' },
  ]

  const r = readCrmConnector(deals, { source: 'hubspot-deals' })
  assert.equal(r.kind, 'crm')
  const obs = Object.fromEntries(r.observations.map((o) => [o.variableId, o.value]))
  assert.equal(obs['observed.pipeline_value'], 25000)
  assert.equal(obs['observed.open_deals_count'], 1)
  assert.equal(obs['observed.win_rate'], 0.67) // 2 won / 3 decided = 0.666 -> 0.67
  assert.equal(obs['observed.average_deal_size'], 10000) // (12000 + 8000) / 2
  assert.ok((obs['observed.sales_cycle_days'] as number) >= 30)
  assert.deepEqual(r.warnings, [])

  // Refuses patent source
  assert.throws(() => readCrmConnector(deals, { source: 'provisional-crm.csv' }), BlockedSourceError)
})

test('email connector: parses support volume, resolution time, sentiment and categories', () => {
  const tickets = [
    { id: 'T-1', date: '2026-09-01', status: 'resolved' as const, sentiment: 'positive' as const, resolutionHours: 2.5, category: 'Billing' },
    { id: 'T-2', date: '2026-09-02', status: 'resolved' as const, sentiment: 'neutral' as const, resolutionHours: 5.0, category: 'Technical' },
    { id: 'T-3', date: '2026-09-03', status: 'open' as const, sentiment: 'negative' as const, category: 'Billing' },
  ]

  const r = readEmailConnector(tickets, { source: 'zendesk-tickets' })
  assert.equal(r.kind, 'email')
  const obs = Object.fromEntries(r.observations.map((o) => [o.variableId, o.value]))
  assert.equal(obs['observed.support_inquiry_volume'], 3)
  assert.equal(obs['observed.unresolved_inquiries'], 1)
  assert.equal(obs['observed.average_resolution_hours'], 3.75)
  assert.equal(obs['observed.customer_sentiment_score'], 0.5) // (1.0 + 0.5 + 0.0) / 3 = 0.5
  assert.match(String(obs['observed.top_issue_categories']), /Billing/)

  // Refuses patent source
  assert.throws(() => readEmailConnector(tickets, { source: 'patent-support.csv' }), BlockedSourceError)
})

test('unified live connector pipeline: ingests multiple connector sources into intent graph', async () => {
  const { graph } = await createIntent('Validate our B2B SaaS operations.', { requestedBy: 'entity-founder', now: NOW, id: 'intent-saas' })
  const ledgerReading = readCsvLedger(ledgerCsv(0.05), { source: 'financials.csv' })
  const paymentsReading = readPaymentsConnector([
    { date: '2026-08-01', amount: 2000, type: 'subscription', customer: 'c-1' },
    { date: '2026-09-01', amount: 2000, type: 'subscription', customer: 'c-1' },
  ], { source: 'stripe-live' })
  const crmReading = readCrmConnector([
    { name: 'Enterprise Contract', stage: 'Negotiation', amount: 50000, status: 'open', createdDate: '2026-08-01' },
  ], { source: 'crm-live' })
  const emailReading = readEmailConnector([
    { id: 'T-1', date: '2026-09-01', status: 'resolved', sentiment: 'positive', resolutionHours: 1.0, category: 'Onboarding' },
  ], { source: 'email-live' })

  const result = ingestLiveConnectors(graph, [ledgerReading, paymentsReading, crmReading, emailReading], NOW)
  assert.ok(result.applied.includes('observed.monthly_revenue'))
  assert.ok(result.applied.includes('observed.monthly_recurring_revenue'))
  assert.ok(result.applied.includes('observed.pipeline_value'))
  assert.ok(result.applied.includes('observed.support_inquiry_volume'))
  assert.equal(result.readings.length, 4)
  assert.deepEqual(result.refused, [])
  assert.deepEqual(validateIntentGraph(result.graph), [])

  // All variables have OBSERVED provenance
  const mrr = result.graph.variables.find((v) => v.id === 'observed.monthly_recurring_revenue')!
  assert.equal(mrr.provenance, 'OBSERVED')
  assert.equal(mrr.sources[0]!.type, 'observation')
})
