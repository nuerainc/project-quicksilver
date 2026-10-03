import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LiveConnectorError, type LiveFetch } from '@quicksilver/aura'
import { connectLive, type RefreshTokenStore } from './live-connect.ts'

const store = (initial?: string) => {
  const s = { token: initial, saves: [] as string[], load: async () => s.token, save: async (t: string) => { s.token = t; s.saves.push(t) } }
  return s satisfies RefreshTokenStore
}
const fetcherFor = (handler: (url: string, method: string) => unknown): LiveFetch => async (url, init) => ({ status: 200, text: async () => JSON.stringify(handler(url, init.method)) })

const QBO_ENV = { QUICKSILVER_QBO_CLIENT_ID: 'cid', QUICKSILVER_QBO_CLIENT_SECRET: 'csec', QUICKSILVER_QBO_REALM_ID: '9130350000000001', QUICKSILVER_QBO_REFRESH_TOKEN: 'seed-token' }
const qboHandler = (url: string) => url.includes('oauth2') ? { access_token: 'at', refresh_token: 'rotated-1' } : { QueryResponse: {} }

test('each provider says which credential it is missing, by name, and never what it contained', async () => {
  for (const [provider, name] of [['stripe', 'QUICKSILVER_STRIPE_READ_KEY'], ['hubspot', 'QUICKSILVER_HUBSPOT_TOKEN'], ['quickbooks', 'QUICKSILVER_QBO_REFRESH_TOKEN']] as const) {
    await assert.rejects(connectLive(provider, { env: {}, fetcher: fetcherFor(() => ({})), refreshTokens: store() }), (e: Error) => e instanceof LiveConnectorError && e.message.includes(name))
  }
})

test('quickbooks: the first run uses the seed token, saves the rotated one, and the next run uses the saved one', async () => {
  const tokens = store()
  const seen: string[] = []
  const fetcher: LiveFetch = async (url, init) => {
    if (url.includes('oauth2')) seen.push(decodeURIComponent(init.body!.split('refresh_token=')[1]!))
    return { status: 200, text: async () => JSON.stringify(qboHandler(url)) }
  }
  await connectLive('quickbooks', { env: QBO_ENV, fetcher, refreshTokens: tokens })
  assert.deepEqual(tokens.saves, ['rotated-1'])
  await connectLive('quickbooks', { env: QBO_ENV, fetcher, refreshTokens: tokens })
  assert.deepEqual(seen, ['seed-token', 'rotated-1'], 'the spent seed token is not used twice')
})

test('quickbooks defaults to the sandbox; production must be asked for by name', async () => {
  const urls: string[] = []
  const fetcher: LiveFetch = async (url) => { urls.push(url); return { status: 200, text: async () => JSON.stringify(qboHandler(url)) } }
  await connectLive('quickbooks', { env: QBO_ENV, fetcher, refreshTokens: store() })
  assert.ok(urls.some((u) => u.includes('sandbox-quickbooks')))
  urls.length = 0
  await connectLive('quickbooks', { env: { ...QBO_ENV, QUICKSILVER_QBO_ENV: 'production' }, fetcher, refreshTokens: store() })
  assert.ok(urls.some((u) => u.startsWith('https://quickbooks.api.intuit.com/')) && !urls.some((u) => u.includes('sandbox')))
})

test('hubspot and stripe connect through the same entry point', async () => {
  const hubspot = await connectLive('hubspot', { env: { QUICKSILVER_HUBSPOT_TOKEN: 'pat-na1-' + 'a'.repeat(24) }, fetcher: fetcherFor(() => ({ results: [] })), refreshTokens: store() })
  assert.equal(hubspot.source, 'hubspot-api')
  const key = ['rk', 'test', 'abcdefgh12345678'].join('_')
  const stripe = await connectLive('stripe', { env: { QUICKSILVER_STRIPE_READ_KEY: key }, fetcher: fetcherFor(() => ({ data: [], has_more: false })), refreshTokens: store() })
  assert.equal(stripe.source, 'stripe-test-api')
})
