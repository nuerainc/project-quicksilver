import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchHubspotDeals, fetchStripePayments, LiveConnectorError, readHubspotLive, readQuickBooksLive, readStripeLive, stripeKeyMode, type LiveFetch } from './live-connectors.ts'

// No network: every call goes to a scripted fake that records what it was asked.

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
function fake(routes: Array<[RegExp, (url: URL, call: Call) => { status?: number; body: unknown } | string]>) {
  const calls: Call[] = []
  const fetcher: LiveFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) })
    for (const [pattern, answer] of routes) {
      if (!pattern.test(url)) continue
      const r = answer(new URL(url), calls.at(-1)!)
      const body = typeof r === 'string' ? r : JSON.stringify(r.body)
      return { status: typeof r === 'string' ? 200 : r.status ?? 200, text: async () => body }
    }
    return { status: 404, text: async () => '{}' }
  }
  return { fetcher, calls }
}

const T = Date.parse('2026-10-03T12:00:00Z') / 1000
const KEY = ['rk', 'test', 'abcdefgh12345678'].join('_')
const NOW = new Date('2026-10-03T12:00:00Z')

// ── Stripe ────────────────────────────────────────────────────────────────

test('stripe: only a restricted key is accepted, and the mode comes from the key', () => {
  assert.equal(stripeKeyMode(KEY), 'test')
  assert.equal(stripeKeyMode(['rk', 'live', 'abcdefgh12345678'].join('_')), 'live')
  assert.throws(() => stripeKeyMode(['sk', 'test', 'abcdefgh12345678'].join('_')), /unrestricted secret key/)
  assert.throws(() => stripeKeyMode('whsec_abc'), /not a restricted Stripe key/)
})

test('stripe: reads charges, refunds, disputes and subscriptions with GET only and turns them into observations', async () => {
  const { fetcher, calls } = fake([
    [/\/v1\/charges/, (u) => u.searchParams.get('starting_after') ? { body: { data: [{ id: 'ch_3', created: T, amount: 2000, status: 'succeeded', customer: 'cus_b' }], has_more: false } } : { body: { data: [{ id: 'ch_1', created: T, amount: 10000, status: 'succeeded', customer: 'cus_a' }, { id: 'ch_2', created: T, amount: 5000, status: 'failed' }], has_more: true } }],
    [/\/v1\/refunds/, () => ({ body: { data: [{ id: 're_1', created: T, amount: 1000, status: 'succeeded' }], has_more: false } })],
    [/\/v1\/disputes/, () => ({ body: { data: [{ id: 'dp_1', created: T, amount: 500 }], has_more: false } })],
    [/\/v1\/subscriptions/, () => ({ body: { data: [{ id: 'sub_1', created: T, status: 'active', customer: 'cus_a', items: { data: [{ quantity: 2, price: { unit_amount: 1500 } }] } }, { id: 'sub_2', created: T, status: 'canceled', items: { data: [{ quantity: 1, price: { unit_amount: 9900 } }] } }], has_more: false } })],
  ])
  const reading = await readStripeLive({ apiKey: KEY, fetcher, now: NOW })
  assert.ok(calls.length >= 5)
  assert.ok(calls.every((c) => c.method === 'GET' && c.url.startsWith('https://api.stripe.com/')), 'reads only, only Stripe')
  assert.ok(calls.every((c) => c.headers.authorization === `Bearer ${KEY}`))
  const value = (id: string) => reading.observations.find((o) => o.variableId === id)?.value
  assert.equal(value('observed.charge_volume'), 150, 'two good charges (100 + 20) plus one active subscription (2 x 15 = 30); failed charge and canceled subscription excluded')
  assert.equal(value('observed.active_customers'), 2)
  assert.equal(value('observed.monthly_recurring_revenue'), 30)
  assert.match(reading.warnings.join(' '), /test-mode key/)
  assert.equal(reading.source, 'stripe-test-api')
})

test('stripe: bad dates, runaway paging and provider refusals are named without leaking the key', async () => {
  await assert.rejects(fetchStripePayments({ apiKey: KEY, fetcher: fake([]).fetcher, since: 'yesterday' }), /--since/)
  const endless = fake([[/\/v1\//, () => ({ body: { data: [{ id: 'x', created: T, amount: 1, status: 'succeeded' }], has_more: true } })]])
  await assert.rejects(fetchStripePayments({ apiKey: KEY, fetcher: endless.fetcher }), /more than 50 pages/)
  const refused = fake([[/./, () => ({ status: 403, body: {} })]])
  await assert.rejects(fetchStripePayments({ apiKey: KEY, fetcher: refused.fetcher }), (e: Error) => e instanceof LiveConnectorError && /refused the credential/.test(e.message) && !e.message.includes(KEY))
})

// ── HubSpot ───────────────────────────────────────────────────────────────

const HS_TOKEN = 'pat-na1-' + 'a'.repeat(24)

test('hubspot: reads deals page by page with GET only and derives win rate and deal size', async () => {
  const { fetcher, calls } = fake([[/crm\/v3\/objects\/deals/, (u) => u.searchParams.get('after') === 'p2'
    ? { body: { results: [{ id: '3', properties: { dealname: 'C', dealstage: 'qualified', amount: '500', createdate: '2026-09-20T00:00:00Z', hs_is_closed: 'false' } }] } }
    : { body: { results: [
      { id: '1', properties: { dealname: 'A', dealstage: 'closedwon', amount: '1000', createdate: '2026-08-01T00:00:00Z', closedate: '2026-08-31T00:00:00Z', hs_is_closed: 'true', hs_is_closed_won: 'true' } },
      { id: '2', properties: { dealname: 'B', dealstage: 'closedlost', amount: '800', createdate: '2026-08-05T00:00:00Z', closedate: '2026-09-04T00:00:00Z', hs_is_closed: 'true', hs_is_closed_won: 'false' } },
    ], paging: { next: { after: 'p2' } } } }]])
  const deals = await fetchHubspotDeals({ accessToken: HS_TOKEN, fetcher })
  assert.deepEqual(deals.map((d) => [d.name, d.status]), [['A', 'won'], ['B', 'lost'], ['C', 'open']])
  assert.equal(calls.length, 2)
  assert.ok(calls.every((c) => c.method === 'GET' && c.url.startsWith('https://api.hubapi.com/')))
  const reading = await readHubspotLive({ accessToken: HS_TOKEN, fetcher: fake([[/deals/, () => ({ body: { results: [] } })]]).fetcher })
  assert.equal(reading.source, 'hubspot-api')
  await assert.rejects(fetchHubspotDeals({ accessToken: 'short', fetcher }), /malformed/)
})

// ── QuickBooks ────────────────────────────────────────────────────────────

const qbo = (over: Partial<Parameters<typeof readQuickBooksLive>[0]> = {}, routes: Parameters<typeof fake>[0] = []) => {
  const f = fake([
    [/oauth2\/v1\/tokens\/bearer/, () => ({ body: { access_token: 'at-1', refresh_token: 'rt-2' } })],
    ...routes,
  ])
  return { ...f, run: () => readQuickBooksLive({ clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rt-1', realmId: '9130350000000001', environment: 'sandbox', since: '2026-01-01', now: NOW, fetcher: f.fetcher, ...over }) }
}

test('quickbooks: refreshes the token, reads cash-basis money in and out, and returns the rotated refresh token', async () => {
  const t = qbo({}, [[/\/query\?/, (u) => {
    const q = u.searchParams.get('query')!
    if (q.includes('from SalesReceipt')) return { body: { QueryResponse: { SalesReceipt: [{ TxnDate: '2026-09-02', TotalAmt: 400, CustomerRef: { name: 'Acme' } }] } } }
    if (q.includes('from Payment')) return { body: { QueryResponse: { Payment: [{ TxnDate: '2026-09-10', TotalAmt: 600, CustomerRef: { name: 'Beta, Inc' } }] } } }
    if (q.includes('from Purchase')) return { body: { QueryResponse: { Purchase: [{ TxnDate: '2026-09-05', TotalAmt: 250, EntityRef: { name: 'Hosting Co' } }] } } }
    return { body: { QueryResponse: {} } }
  }]])
  const out = await t.run()
  assert.equal(out.refreshToken, 'rt-2', 'the rotated refresh token is handed back to be saved')
  assert.equal(out.reading.transactions.length, 3)
  assert.deepEqual(out.reading.transactions.map((x) => x.amount).sort((a, b) => a - b), [-250, 400, 600])
  assert.match(out.reading.warnings.join(' '), /cash basis/)
  assert.match(out.reading.warnings.join(' '), /sandbox/)
  const data = t.calls.filter((c) => c.url.includes('/query?'))
  assert.ok(data.length >= 4 && data.every((c) => c.method === 'GET' && c.url.startsWith('https://sandbox-quickbooks.api.intuit.com/v3/company/9130350000000001/')))
  const token = t.calls.find((c) => c.url.includes('oauth2'))!
  assert.equal(token.method, 'POST')
  assert.equal(token.headers.authorization, `Basic ${Buffer.from('cid:csecret').toString('base64')}`)
  assert.equal(t.calls.filter((c) => c.method === 'POST').length, 1, 'the token refresh is the only POST')
})

test('quickbooks: production uses the production host; a failed sign-in, bad realm or bad date is refused clearly', async () => {
  const prod = qbo({ environment: 'production' }, [[/\/query\?/, () => ({ body: { QueryResponse: {} } })]])
  await prod.run()
  assert.ok(prod.calls.filter((c) => c.url.includes('/query?')).every((c) => c.url.startsWith('https://quickbooks.api.intuit.com/')))
  const noToken = fake([[/oauth2/, () => ({ body: { error: 'invalid_grant' } })]])
  await assert.rejects(readQuickBooksLive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', realmId: '9130350000000001', environment: 'sandbox', fetcher: noToken.fetcher }), /did not return an access token/)
  await assert.rejects(qbo({ realmId: '../x' }).run(), /digits only/)
  await assert.rejects(qbo({ since: '01/02/2026' }).run(), /--since/)
})

test('a redirect, a non-JSON answer and a foreign host are all refused', async () => {
  await assert.rejects(fetchHubspotDeals({ accessToken: HS_TOKEN, fetcher: fake([[/./, () => 'not json']]).fetcher }), /not JSON/)
  await assert.rejects(fetchHubspotDeals({ accessToken: HS_TOKEN, fetcher: async () => { throw new Error('redirect') } }), /request failed/)
})
