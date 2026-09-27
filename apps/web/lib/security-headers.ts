/**
 * Security headers for the web app (threat model T-67), modelled on the host
 * console's policy (`CONSOLE_HEADERS` in packages/host/src/host.ts).
 *
 * The console keeps a person's bearer token in sessionStorage, so the page
 * must not run script it did not ship:
 *
 * - `script-src`: only scripts carrying this response's nonce, plus what they
 *   load (`'strict-dynamic'`). Next.js reads the nonce from the request's
 *   `Content-Security-Policy` header (set in middleware.ts) and stamps it on
 *   its own inline and bundle scripts. No host allow-list, no wildcard, no
 *   third-party script hosts, and no `'unsafe-eval'` outside `next dev`.
 * - `style-src 'self' 'unsafe-inline'`: Next.js and React emit inline styles
 *   that carry no nonce, so inline styles are allowed; styles cannot run script.
 * - `connect-src 'self'`: every browser call goes to this app's own `/api/*`
 *   routes. Sanity and the model provider are called only server-side.
 * - `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'none'`,
 *   `object-src 'none'`.
 */

export interface CspOptions {
  /** Per-response nonce (base64). */
  nonce: string
  /**
   * `next dev` only: its webpack dev runtime and React's dev tooling use
   * `eval`, so development adds `'unsafe-eval'`. Never set in production.
   */
  development?: boolean
}

export function contentSecurityPolicy({ nonce, development = false }: CspOptions): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) throw new Error('CSP nonce must be at least 16 base64 characters.')
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', [`'nonce-${nonce}'`, "'strict-dynamic'", ...(development ? ["'unsafe-eval'"] : [])]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...(development ? ['ws:'] : [])]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ]
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ')
}

/** Companion headers middleware.ts sends with the CSP on every page and API response. */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = Object.freeze([
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
])

/** A fresh nonce: 16 random bytes, base64. Works in the Edge and Node runtimes. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
