import { readHubspotLive, readQuickBooksLive, readStripeLive, LiveConnectorError, type ConnectorReading, type LiveFetch } from '@quicksilver/aura'

/**
 * `npm run onboard -- connect-live <intentId> stripe|hubspot|quickbooks [--since YYYY-MM-DD]`
 *
 * Credentials come from the environment of the founder's computer and are never written to disk, except
 * QuickBooks' refresh token: Intuit rotates it on every use, so the new one is saved (owner-only file).
 * Everything here reads. Nothing is written back to Stripe, HubSpot or QuickBooks.
 */

export const LIVE_PROVIDERS = ['stripe', 'hubspot', 'quickbooks'] as const
export type LiveProvider = (typeof LIVE_PROVIDERS)[number]

export interface RefreshTokenStore {
  load(): Promise<string | undefined>
  save(token: string): Promise<void>
}

export interface LiveConnectDeps {
  env: Record<string, string | undefined>
  fetcher: LiveFetch
  refreshTokens: RefreshTokenStore
  since?: string
  now?: Date
}

const need = (env: LiveConnectDeps['env'], name: string, why: string): string => {
  const v = env[name]?.trim()
  if (!v) throw new LiveConnectorError(`${name} is not set (${why}).`)
  return v
}

export async function connectLive(provider: LiveProvider, deps: LiveConnectDeps): Promise<ConnectorReading> {
  const { env } = deps
  const common = { fetcher: deps.fetcher, ...(deps.since ? { since: deps.since } : {}), ...(deps.now ? { now: deps.now } : {}) }
  if (provider === 'stripe') {
    return readStripeLive({ ...common, apiKey: need(env, 'QUICKSILVER_STRIPE_READ_KEY', 'a restricted read-only Stripe key, rk_test_... or rk_live_...') })
  }
  if (provider === 'hubspot') {
    return readHubspotLive({ fetcher: deps.fetcher, accessToken: need(env, 'QUICKSILVER_HUBSPOT_TOKEN', 'a HubSpot private app token with deals read access') })
  }
  const environment = env.QUICKSILVER_QBO_ENV === 'production' ? 'production' : 'sandbox'
  const saved = await deps.refreshTokens.load()
  const refreshToken = saved ?? need(env, 'QUICKSILVER_QBO_REFRESH_TOKEN', 'the first refresh token from the Intuit OAuth playground')
  const out = await readQuickBooksLive({
    ...common,
    clientId: need(env, 'QUICKSILVER_QBO_CLIENT_ID', 'the Intuit app client id'),
    clientSecret: need(env, 'QUICKSILVER_QBO_CLIENT_SECRET', 'the Intuit app client secret'),
    realmId: need(env, 'QUICKSILVER_QBO_REALM_ID', 'the QuickBooks company id'),
    refreshToken,
    environment,
  })
  // Save the rotated token before anything else can fail: the old one is now spent.
  await deps.refreshTokens.save(out.refreshToken)
  return out.reading
}
