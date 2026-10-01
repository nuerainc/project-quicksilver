import { createHash, randomBytes } from 'node:crypto'
import { mapVerifiedOidcIdentity, parseOidcIdentityBindings, verifyOidcIdToken } from './oidc-identities.ts'
import { digestAuthSecret, oidcSessionStore, type OidcSessionStore } from './oidc-session-store.ts'

export const OIDC_SESSION_COOKIE = '__Host-quicksilver-session'
export const OIDC_LOGIN_COOKIE = '__Host-quicksilver-oidc'
const LOGIN_TTL_MS = 10 * 60_000
const SESSION_TTL_MS = 8 * 60 * 60_000
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024

export interface OidcBrowserEnv {
  OIDC_ISSUER?: string
  OIDC_CLIENT_ID?: string
  OIDC_CLIENT_SECRET?: string
  OIDC_REDIRECT_URI?: string
  QUICKSILVER_OIDC_USERS?: string
  QUICKSILVER_TENANT_ID?: string
  NODE_ENV?: string
}

interface OidcProviderMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  response_types_supported?: string[]
  code_challenge_methods_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

export interface OidcAuthDependencies {
  store?: OidcSessionStore
  fetcher?: typeof fetch
  now?: () => Date
  random?: (bytes: number) => Buffer
}

function randomToken(bytes: number, random: (bytes: number) => Buffer): string {
  return random(bytes).toString('base64url')
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url')
}

function httpsUrl(value: string | undefined): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null
    return url
  } catch { return null }
}

function configFrom(env: OidcBrowserEnv): { issuer: string; clientId: string; clientSecret: string; redirectUri: string } | null {
  const issuerUrl = httpsUrl(env.OIDC_ISSUER)
  const redirectUrl = httpsUrl(env.OIDC_REDIRECT_URI)
  if (!issuerUrl || !redirectUrl || !env.OIDC_CLIENT_ID?.trim() || !env.OIDC_CLIENT_SECRET
    || env.OIDC_CLIENT_SECRET.length < 8) return null
  if (issuerUrl.search || redirectUrl.search || redirectUrl.hash) return null
  return {
    issuer: issuerUrl.href.replace(/\/$/, ''),
    clientId: env.OIDC_CLIENT_ID.trim(),
    clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: redirectUrl.href,
  }
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('OIDC provider response exceeded the size limit.')
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('OIDC provider response exceeded the size limit.')
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OIDC provider response was malformed.')
  return value as Record<string, unknown>
}

async function providerMetadata(issuer: string, fetcher: typeof fetch): Promise<OidcProviderMetadata> {
  const discoveryUrl = new URL(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
  const response = await fetcher(discoveryUrl, { redirect: 'error', signal: AbortSignal.timeout(8_000), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error('OIDC provider discovery failed.')
  const body = await boundedJson(response)
  const authorization = typeof body.authorization_endpoint === 'string' ? httpsUrl(body.authorization_endpoint) : null
  const token = typeof body.token_endpoint === 'string' ? httpsUrl(body.token_endpoint) : null
  const jwks = typeof body.jwks_uri === 'string' ? httpsUrl(body.jwks_uri) : null
  if (body.issuer !== issuer || !authorization || !token || !jwks
    || !Array.isArray(body.response_types_supported) || !body.response_types_supported.includes('code')
    || !Array.isArray(body.code_challenge_methods_supported) || !body.code_challenge_methods_supported.includes('S256')) {
    throw new Error('OIDC provider metadata is incomplete or does not match the configured issuer.')
  }
  if (body.token_endpoint_auth_methods_supported !== undefined
    && (!Array.isArray(body.token_endpoint_auth_methods_supported)
      || !body.token_endpoint_auth_methods_supported.some((method) => method === 'client_secret_post' || method === 'client_secret_basic'))) {
    throw new Error('OIDC provider does not support the configured confidential-client authentication method.')
  }
  return {
    issuer,
    authorization_endpoint: authorization.href,
    token_endpoint: token.href,
    jwks_uri: jwks.href,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    ...(Array.isArray(body.token_endpoint_auth_methods_supported) ? { token_endpoint_auth_methods_supported: body.token_endpoint_auth_methods_supported.filter((item): item is string => typeof item === 'string') } : {}),
  }
}

function internalReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  try {
    const url = new URL(value, 'https://quicksilver.invalid')
    if (url.origin !== 'https://quicksilver.invalid' || url.pathname.startsWith('/api/auth/')) return '/'
    const result = `${url.pathname}${url.search}${url.hash}`
    return result.length <= 1024 ? result : '/'
  } catch { return '/' }
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store', pragma: 'no-cache' })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 303, headers })
}

function appFailure(request: Request): Response {
  return redirect(new URL('/?auth=failed', request.url).href, [clearCookie(OIDC_LOGIN_COOKIE)])
}

function cookieValue(request: Request, name: string): string | null {
  for (const item of (request.headers.get('cookie') ?? '').split(';')) {
    const index = item.indexOf('=')
    if (index < 0 || item.slice(0, index).trim() !== name) continue
    const value = item.slice(index + 1).trim()
    return /^[A-Za-z0-9_-]{32,256}$/.test(value) ? value : null
  }
  return null
}

export async function startOidcLogin(request: Request, env: OidcBrowserEnv, deps: OidcAuthDependencies = {}): Promise<Response> {
  const config = configFrom(env)
  if (!config) return appFailure(request)
  const now = deps.now?.() ?? new Date()
  const random = deps.random ?? randomBytes
  const fetcher = deps.fetcher ?? fetch
  try {
    const metadata = await providerMetadata(config.issuer, fetcher)
    const state = randomToken(32, random)
    const nonce = randomToken(32, random)
    const binding = randomToken(32, random)
    const verifier = randomToken(48, random)
    const transaction = {
      stateDigest: digestAuthSecret(state),
      browserBindingDigest: digestAuthSecret(binding),
      nonce,
      codeVerifier: verifier,
      returnTo: internalReturnTo(new URL(request.url).searchParams.get('returnTo')),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LOGIN_TTL_MS).toISOString(),
    }
    await (deps.store ?? await oidcSessionStore()).createLoginTransaction(transaction)
    const authorization = new URL(metadata.authorization_endpoint)
    authorization.searchParams.set('client_id', config.clientId)
    authorization.searchParams.set('redirect_uri', config.redirectUri)
    authorization.searchParams.set('response_type', 'code')
    authorization.searchParams.set('scope', 'openid profile email')
    authorization.searchParams.set('state', state)
    authorization.searchParams.set('nonce', nonce)
    authorization.searchParams.set('code_challenge', sha256Base64Url(verifier))
    authorization.searchParams.set('code_challenge_method', 'S256')
    return redirect(authorization.href, [setCookie(OIDC_LOGIN_COOKIE, binding, LOGIN_TTL_MS / 1000)])
  } catch (error) {
    console.error('[oidc] login start failed', error instanceof Error ? error.name : 'UnknownError')
    return appFailure(request)
  }
}

export async function completeOidcLogin(request: Request, env: OidcBrowserEnv, deps: OidcAuthDependencies = {}): Promise<Response> {
  const config = configFrom(env)
  const url = new URL(request.url)
  const stateValues = url.searchParams.getAll('state')
  const codeValues = url.searchParams.getAll('code')
  const state = stateValues.length === 1 ? stateValues[0] : null
  const code = codeValues.length === 1 ? codeValues[0] : null
  const binding = cookieValue(request, OIDC_LOGIN_COOKIE)
  if (!config || !state || state.length > 256 || !binding) return appFailure(request)

  const now = deps.now?.() ?? new Date()
  let store: OidcSessionStore
  let transaction
  try {
    store = deps.store ?? await oidcSessionStore()
    transaction = await store.consumeLoginTransaction(digestAuthSecret(state), digestAuthSecret(binding), now)
  } catch (error) {
    console.error('[oidc] callback transaction failed', error instanceof Error ? error.name : 'UnknownError')
    return appFailure(request)
  }
  if (!transaction || url.searchParams.has('error') || !code || code.length > 4096) return appFailure(request)

  const fetcher = deps.fetcher ?? fetch
  const random = deps.random ?? randomBytes
  try {
    const metadata = await providerMetadata(config.issuer, fetcher)
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: transaction.codeVerifier,
    })
    const supportsPost = !metadata.token_endpoint_auth_methods_supported
      || metadata.token_endpoint_auth_methods_supported.includes('client_secret_post')
    const tokenHeaders: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }
    if (supportsPost) form.set('client_secret', config.clientSecret)
    else tokenHeaders.authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`
    const response = await fetcher(metadata.token_endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
      headers: tokenHeaders,
      body: form,
    })
    if (!response.ok) throw new Error('OIDC token exchange failed.')
    const tokenResult = await boundedJson(response)
    if (typeof tokenResult.id_token !== 'string') throw new Error('OIDC response did not contain an ID token.')
    const claims = await verifyOidcIdToken(tokenResult.id_token, {
      issuer: config.issuer,
      audience: config.clientId,
      jwksUri: metadata.jwks_uri,
      nonce: transaction.nonce,
    }, { fetcher, now })
    const identity = mapVerifiedOidcIdentity(claims, parseOidcIdentityBindings(env.QUICKSILVER_OIDC_USERS), env.QUICKSILVER_TENANT_ID?.trim() || 'default')
    if (!identity.ok) throw new Error('OIDC identity is not mapped to an authorized tenant principal.')

    const sessionToken = randomToken(32, random)
    await store.createSession({
      tokenDigest: digestAuthSecret(sessionToken),
      identity: { issuer: claims.iss, subject: claims.sub },
      principal: identity.principal,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    })
    const target = new URL(transaction.returnTo, config.redirectUri).href
    return redirect(target, [
      setCookie(OIDC_SESSION_COOKIE, sessionToken, SESSION_TTL_MS / 1000),
      clearCookie(OIDC_LOGIN_COOKIE),
    ])
  } catch (error) {
    console.error('[oidc] callback failed', error instanceof Error ? error.name : 'UnknownError')
    return appFailure(request)
  }
}

export interface BrowserSessionPrincipal {
  id: string
  kind: 'human'
  tenantId: string
  roles: string[]
  displayName?: string
}

export async function readBrowserSession(request: Request, env: OidcBrowserEnv, deps: Pick<OidcAuthDependencies, 'store' | 'now'> = {}): Promise<BrowserSessionPrincipal | null> {
  const token = cookieValue(request, OIDC_SESSION_COOKIE)
  if (!token) return null
  const now = deps.now?.() ?? new Date()
  const session = await (deps.store ?? await oidcSessionStore()).getSession(digestAuthSecret(token), now)
  if (!session || session.revokedAt || Date.parse(session.expiresAt) <= now.getTime()) return null
  const expectedTenant = env.QUICKSILVER_TENANT_ID?.trim() || 'default'
  const identity = mapVerifiedOidcIdentity({ iss: session.identity.issuer, sub: session.identity.subject }, parseOidcIdentityBindings(env.QUICKSILVER_OIDC_USERS), expectedTenant)
  if (!identity.ok || identity.principal.kind !== 'human' || session.principal.id !== identity.principal.id) return null
  return {
    id: identity.principal.id,
    kind: 'human',
    tenantId: identity.principal.tenantId,
    roles: [...identity.principal.roles],
    ...(identity.principal.displayName ? { displayName: identity.principal.displayName } : {}),
  }
}

export async function revokeBrowserSession(request: Request, env: OidcBrowserEnv, deps: Pick<OidcAuthDependencies, 'store' | 'now'> = {}): Promise<boolean> {
  const token = cookieValue(request, OIDC_SESSION_COOKIE)
  if (!token) return true
  return (deps.store ?? await oidcSessionStore()).revokeSession(digestAuthSecret(token), deps.now?.() ?? new Date())
}

export function signedOutResponse(request: Request): Response {
  return redirect(new URL('/', request.url).href, [clearCookie(OIDC_SESSION_COOKIE)])
}
