import { readCrmConnector, readCsvLedger, readPaymentsConnector, type ConnectorReading, type CrmDealRecord, type PaymentRecord } from './connectors.ts'

/**
 * Live Onboard connectors (P-088): Stripe, HubSpot and QuickBooks Online, read only.
 *
 * These pull records from the provider's API and hand them to the same readers the file
 * connectors use, so the graph gets the same OBSERVED variables with the same governance.
 *
 *   - Reads only. Data requests are GET; the one POST is QuickBooks' token refresh.
 *   - Each connector may only call its provider's hosts. Nothing follows a redirect to another host.
 *   - Pages, response size and time are bounded. Secrets are never put in an error message.
 *   - Stripe takes a restricted key (rk_...) only; an unrestricted secret key (sk_...) is refused.
 *   - The network is a parameter (`fetcher`), so tests never leave the process.
 */

export type LiveFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect: 'error' }) => Promise<{ status: number; text(): Promise<string> }>

export class LiveConnectorError extends Error {
  constructor(message: string) { super(message); this.name = 'LiveConnectorError' }
}

const MAX_PAGES = 50
const MAX_BODY_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 20_000

interface Http {
  hosts: readonly string[]
  fetcher: LiveFetch
}

async function request(http: Http, label: string, url: string, init: { method?: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<unknown> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !http.hosts.includes(parsed.hostname)) throw new LiveConnectorError(`${label}: refused to call ${parsed.hostname}.`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await http.fetcher(url, { method: init.method ?? 'GET', headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), signal: controller.signal, redirect: 'error' })
    if (res.status === 401 || res.status === 403) throw new LiveConnectorError(`${label}: the provider refused the credential (HTTP ${res.status}). Check its scopes and expiry.`)
    if (res.status === 429) throw new LiveConnectorError(`${label}: the provider is rate limiting; try again later.`)
    if (res.status < 200 || res.status >= 300) throw new LiveConnectorError(`${label}: the provider answered HTTP ${res.status}.`)
    const text = await res.text()
    if (text.length > MAX_BODY_BYTES) throw new LiveConnectorError(`${label}: a response was larger than ${MAX_BODY_BYTES} bytes.`)
    try { return JSON.parse(text) } catch { throw new LiveConnectorError(`${label}: the provider sent something that is not JSON.`) }
  } catch (e) {
    if (e instanceof LiveConnectorError) throw e
    throw new LiveConnectorError(`${label}: the request failed${controller.signal.aborted ? ' (timed out)' : ''}.`)
  } finally { clearTimeout(timer) }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)
const isoDay = (v: unknown): string | undefined => {
  const s = str(v)
  const d = s ? new Date(s) : typeof v === 'number' ? new Date(v * 1000) : undefined
  return d && Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : undefined
}

// ---------------------------------------------------------------------------
// Stripe

export interface StripeLiveOptions {
  /** A restricted key with read access to Charges, Refunds, Subscriptions and Disputes. */
  apiKey: string
  /** Only records created on or after this day (YYYY-MM-DD). Default: 12 months back. */
  since?: string
  now?: Date
  fetcher: LiveFetch
}

export function stripeKeyMode(key: string): 'test' | 'live' {
  if (/^rk_test_[A-Za-z0-9]{8,}$/.test(key)) return 'test'
  if (/^rk_live_[A-Za-z0-9]{8,}$/.test(key)) return 'live'
  if (/^sk_/.test(key)) throw new LiveConnectorError('Stripe: this is an unrestricted secret key. Create a restricted key (rk_...) with read access only.')
  throw new LiveConnectorError('Stripe: the key is not a restricted Stripe key (rk_test_... or rk_live_...).')
}

async function stripePages(http: Http, key: string, path: string, since: number, extra = ''): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://api.stripe.com/v1/${path}?limit=100&created[gte]=${since}${extra}${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`
    const body = obj(await request(http, `Stripe ${path}`, url, { headers: { authorization: `Bearer ${key}` } }))
    const data = arr(body.data).map(obj)
    out.push(...data)
    const last = data.at(-1)
    if (body.has_more !== true || !last || !str(last.id)) return out
    after = str(last.id)
  }
  throw new LiveConnectorError(`Stripe ${path}: more than ${MAX_PAGES} pages; narrow the date range with --since.`)
}

export async function fetchStripePayments(options: StripeLiveOptions): Promise<{ records: PaymentRecord[]; mode: 'test' | 'live'; warnings: string[] }> {
  const mode = stripeKeyMode(options.apiKey)
  const http: Http = { hosts: ['api.stripe.com'], fetcher: options.fetcher }
  const now = options.now ?? new Date()
  const since = Math.floor((options.since ? Date.parse(`${options.since}T00:00:00Z`) : now.getTime() - 365 * 86_400_000) / 1000)
  if (!Number.isFinite(since)) throw new LiveConnectorError('Stripe: --since must be a date like 2026-01-31.')
  const key = options.apiKey
  const records: PaymentRecord[] = []
  const warnings: string[] = []

  for (const c of await stripePages(http, key, 'charges', since)) {
    const date = isoDay(c.created); const cents = num(c.amount)
    if (!date || cents === undefined) continue
    const status = c.status === 'succeeded' ? 'succeeded' : c.status === 'failed' ? 'failed' : 'pending'
    records.push({ date, amount: cents / 100, type: 'charge', status, ...(str(c.customer) ? { customer: str(c.customer) } : {}), ...(str(c.description) ? { description: str(c.description) } : {}) })
  }
  for (const r of await stripePages(http, key, 'refunds', since)) {
    const date = isoDay(r.created); const cents = num(r.amount)
    if (date && cents !== undefined) records.push({ date, amount: cents / 100, type: 'refund', status: r.status === 'failed' ? 'failed' : 'succeeded' })
  }
  for (const d of await stripePages(http, key, 'disputes', since)) {
    const date = isoDay(d.created); const cents = num(d.amount)
    if (date && cents !== undefined) records.push({ date, amount: cents / 100, type: 'dispute', status: 'succeeded' })
  }
  for (const s of await stripePages(http, key, 'subscriptions', since, '&status=all')) {
    const date = isoDay(s.created)
    const items = arr(obj(s.items).data).map(obj)
    const cents = items.reduce((sum, item) => sum + (num(obj(item.price).unit_amount) ?? 0) * (num(item.quantity) ?? 1), 0)
    if (date && cents > 0 && (s.status === 'active' || s.status === 'trialing' || s.status === 'past_due')) {
      records.push({ date, amount: cents / 100, type: 'subscription', status: 'succeeded', ...(str(s.customer) ? { customer: str(s.customer) } : {}) })
    }
  }
  if (mode === 'test') warnings.push('This is a Stripe test-mode key: these figures are test data, not the business.')
  return { records, mode, warnings }
}

export async function readStripeLive(options: StripeLiveOptions): Promise<ConnectorReading> {
  const { records, mode, warnings } = await fetchStripePayments(options)
  const reading = readPaymentsConnector(records, { source: `stripe-${mode}-api` })
  return { ...reading, warnings: [...warnings, ...reading.warnings] }
}

// ---------------------------------------------------------------------------
// HubSpot

export interface HubspotLiveOptions {
  /** A private app access token with the crm.objects.deals.read scope only. */
  accessToken: string
  fetcher: LiveFetch
}

export async function fetchHubspotDeals(options: HubspotLiveOptions): Promise<CrmDealRecord[]> {
  if (!/^[A-Za-z0-9._-]{20,}$/.test(options.accessToken)) throw new LiveConnectorError('HubSpot: the access token looks malformed.')
  const http: Http = { hosts: ['api.hubapi.com'], fetcher: options.fetcher }
  const deals: CrmDealRecord[] = []
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://api.hubapi.com/crm/v3/objects/deals?limit=100&properties=dealname,dealstage,amount,createdate,closedate,hs_is_closed_won,hs_is_closed${after ? `&after=${encodeURIComponent(after)}` : ''}`
    const body = obj(await request(http, 'HubSpot deals', url, { headers: { authorization: `Bearer ${options.accessToken}` } }))
    for (const row of arr(body.results).map(obj)) {
      const p = obj(row.properties)
      const created = isoDay(p.createdate)
      if (!created) continue
      const won = p.hs_is_closed_won === 'true' || p.hs_is_closed_won === true
      const closed = p.hs_is_closed === 'true' || p.hs_is_closed === true
      const closeDate = isoDay(p.closedate)
      deals.push({
        name: str(p.dealname) ?? `deal-${str(row.id) ?? deals.length + 1}`,
        stage: str(p.dealstage) ?? 'unknown',
        amount: num(p.amount) ?? 0,
        status: won ? 'won' : closed ? 'lost' : 'open',
        createdDate: created,
        ...(closeDate && closed ? { closeDate } : {}),
      })
    }
    after = str(obj(obj(body.paging).next).after)
    if (!after) return deals
  }
  throw new LiveConnectorError(`HubSpot deals: more than ${MAX_PAGES} pages.`)
}

export async function readHubspotLive(options: HubspotLiveOptions): Promise<ConnectorReading> {
  return readCrmConnector(await fetchHubspotDeals(options), { source: 'hubspot-api' })
}

// ---------------------------------------------------------------------------
// QuickBooks Online

export interface QuickBooksLiveOptions {
  clientId: string
  clientSecret: string
  /** Intuit rotates this on every refresh; save `refreshToken` from the result for next time. */
  refreshToken: string
  realmId: string
  environment: 'sandbox' | 'production'
  since?: string
  now?: Date
  fetcher: LiveFetch
}

export interface QuickBooksLiveResult { reading: ConnectorReading; refreshToken: string }

const QBO_ENTITIES: Array<{ entity: string; sign: 1 | -1; category: string }> = [
  { entity: 'SalesReceipt', sign: 1, category: 'sales' },
  { entity: 'Payment', sign: 1, category: 'customer payments' },
  { entity: 'Purchase', sign: -1, category: 'purchases' },
  { entity: 'BillPayment', sign: -1, category: 'bill payments' },
]

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export async function readQuickBooksLive(options: QuickBooksLiveOptions): Promise<QuickBooksLiveResult> {
  if (!/^\d{4,20}$/.test(options.realmId)) throw new LiveConnectorError('QuickBooks: the realm (company) id should be digits only.')
  const http: Http = { hosts: ['oauth.platform.intuit.com', options.environment === 'sandbox' ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com'], fetcher: options.fetcher }
  const tokenBody = obj(await request(http, 'QuickBooks sign-in', 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(options.refreshToken)}`,
  }))
  const accessToken = str(tokenBody.access_token)
  if (!accessToken) throw new LiveConnectorError('QuickBooks: sign-in did not return an access token. The refresh token may have expired; authorize again.')
  const refreshToken = str(tokenBody.refresh_token) ?? options.refreshToken

  const base = `https://${options.environment === 'sandbox' ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${options.realmId}/query`
  const since = options.since ?? new Date((options.now ?? new Date()).getTime() - 365 * 86_400_000).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new LiveConnectorError('QuickBooks: --since must be a date like 2026-01-31.')
  const rows: string[] = ['date,amount,category,description']
  let count = 0
  for (const { entity, sign, category } of QBO_ENTITIES) {
    for (let start = 1, pages = 0; ; pages++) {
      if (pages >= MAX_PAGES) throw new LiveConnectorError(`QuickBooks ${entity}: more than ${MAX_PAGES} pages.`)
      const query = `select * from ${entity} where TxnDate >= '${since}' startposition ${start} maxresults 500`
      const body = obj(await request(http, `QuickBooks ${entity}`, `${base}?minorversion=75&query=${encodeURIComponent(query)}`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } }))
      const found = arr(obj(body.QueryResponse)[entity]).map(obj)
      for (const t of found) {
        const date = isoDay(t.TxnDate); const total = num(t.TotalAmt)
        if (!date || total === undefined) continue
        const who = str(obj(t.CustomerRef).name) ?? str(obj(t.EntityRef).name) ?? str(obj(t.VendorRef).name) ?? ''
        rows.push(`${date},${sign * Math.abs(total)},${csvCell(category)},${csvCell(who)}`)
        count++
      }
      if (found.length < 500) break
      start += 500
    }
  }
  const reading = readCsvLedger(rows.join('\n'), { source: `quickbooks-${options.environment}-api` })
  const warnings = [`QuickBooks figures are cash basis: sales receipts and customer payments in, purchases and bill payments out (${count} records since ${since}).`]
  if (options.environment === 'sandbox') warnings.push('This is a QuickBooks sandbox company: these figures are test data, not the business.')
  return { reading: { ...reading, warnings: [...warnings, ...reading.warnings] }, refreshToken }
}
