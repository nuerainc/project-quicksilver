/**
 * Which Sanity token a client uses (threat model A-7, T-59).
 *
 * Read-only paths and write paths get different tokens, so a process that
 * only reads never holds a credential that can write `approvalRecord`,
 * policies or capabilities:
 *
 * - read:  `SANITY_READ_TOKEN` (a Viewer token). Without it, no token when
 *          `SANITY_DATASET_PUBLIC=on` (the founder has made the dataset
 *          public, so unauthenticated reads work); otherwise the legacy
 *          combined `SANITY_AUTH_TOKEN`, with a one-time warning.
 * - write: `SANITY_WRITE_TOKEN` (an Editor token). Without it, the legacy
 *          `SANITY_AUTH_TOKEN`, with a one-time warning.
 *
 * Pure: reads only the `env` it is given and returns the choice plus the
 * warning to print; the per-app helpers (apps/web/lib/sanity-client.ts,
 * packages/host/src/sanity-client.ts, apps/studio/lib/sanity-client.ts)
 * create the clients, print each warning once and keep the legacy challenge
 * project refused. Never returns or logs anything about the token but its
 * variable name.
 */

export type SanityAccess = 'read' | 'write'

export type SanityTokenSource = 'SANITY_READ_TOKEN' | 'SANITY_WRITE_TOKEN' | 'SANITY_AUTH_TOKEN' | 'public-dataset' | 'none'

export interface SanityTokenChoice {
  access: SanityAccess
  /** The token to use; undefined for an unauthenticated (public dataset) read, or when nothing is set. */
  token?: string
  /** Where the token came from (a variable name), never the token. */
  source: SanityTokenSource
  /** Set when the legacy combined token (or nothing) was used; print it once. */
  warning?: string
}

type Env = Readonly<Record<string, string | undefined>>

function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim()
  return v ? v : undefined
}

/** Pick the token for `access` from the environment. */
export function resolveSanityToken(access: SanityAccess, env: Env): SanityTokenChoice {
  const legacy = value(env, 'SANITY_AUTH_TOKEN')
  if (access === 'read') {
    const read = value(env, 'SANITY_READ_TOKEN')
    if (read) return { access, token: read, source: 'SANITY_READ_TOKEN' }
    if ((env.SANITY_DATASET_PUBLIC ?? '').trim().toLowerCase() === 'on') return { access, source: 'public-dataset' }
    if (legacy) {
      return {
        access,
        token: legacy,
        source: 'SANITY_AUTH_TOKEN',
        warning: 'SANITY_READ_TOKEN is not set: read-only Sanity paths are using the combined SANITY_AUTH_TOKEN. Create a Viewer token and set SANITY_READ_TOKEN (threat model A-7).',
      }
    }
    return { access, source: 'none', warning: 'No Sanity read token is set (SANITY_READ_TOKEN): reads are unauthenticated and see only a public dataset.' }
  }
  const write = value(env, 'SANITY_WRITE_TOKEN')
  if (write) return { access, token: write, source: 'SANITY_WRITE_TOKEN' }
  if (legacy) {
    return {
      access,
      token: legacy,
      source: 'SANITY_AUTH_TOKEN',
      warning: 'SANITY_WRITE_TOKEN is not set: Sanity writes are using the combined SANITY_AUTH_TOKEN. Create an Editor token and set SANITY_WRITE_TOKEN (threat model A-7).',
    }
  }
  return { access, source: 'none', warning: 'No Sanity write token is set (SANITY_WRITE_TOKEN): writes will be refused by Sanity.' }
}

/**
 * Print each distinct warning once per process through `print`. Returns the
 * choice unchanged, so a helper can write `onceWarned(resolveSanityToken(...))`.
 */
export function createOnceWarner(print: (message: string) => void): (choice: SanityTokenChoice) => SanityTokenChoice {
  const seen = new Set<string>()
  return (choice) => {
    if (choice.warning && !seen.has(choice.warning)) {
      seen.add(choice.warning)
      print(choice.warning)
    }
    return choice
  }
}
