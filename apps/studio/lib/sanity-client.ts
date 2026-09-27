/**
 * The one place the Studio scripts create Sanity clients (threat model A-7).
 *
 * - `'read'` (smoke test, dataset export): `SANITY_READ_TOKEN`, a Viewer token.
 * - `'write'` (seed, process seed, history reset, live end-to-end test):
 *   `SANITY_WRITE_TOKEN`, an Editor token.
 *
 * Either falls back to the legacy combined `SANITY_AUTH_TOKEN` with a
 * one-time warning; the choice is the kernel's `resolveSanityToken`, shared
 * with the web app and the host. The legacy challenge project is refused.
 * Schema deploys use `SANITY_DEPLOY_TOKEN` or a `sanity login` session
 * (scripts/deploy-schema.ts), not these.
 */
import { createClient, type SanityClient } from '@sanity/client'
import { createOnceWarner, resolveSanityToken, type SanityAccess } from '../../../packages/kernel/src/sanity-tokens.ts'

export const LEGACY_CHALLENGE_PROJECT_ID = 'd280bqjc'

const warnOnce = createOnceWarner((message) => console.warn(`⚠ ${message}`))

export interface StudioSanityConfig {
  projectId: string
  dataset: string
  token?: string
}

/** Project, dataset and the token for `access`, or the reason it cannot run. Never prints the token. */
export function studioSanityConfig(access: SanityAccess, env: NodeJS.ProcessEnv = process.env): { ok: true; config: StudioSanityConfig } | { ok: false; error: string } {
  const projectId = env.NEXT_PUBLIC_SANITY_PROJECT_ID?.trim()
  if (!projectId || projectId === LEGACY_CHALLENGE_PROJECT_ID) {
    return { ok: false, error: 'Set NEXT_PUBLIC_SANITY_PROJECT_ID to the dedicated Nuera Quicksilver Sanity project; the legacy challenge project is blocked.' }
  }
  const choice = resolveSanityToken(access, env)
  if (access === 'write' && !choice.token) {
    return { ok: false, error: 'SANITY_WRITE_TOKEN is required (an Editor token from sanity.io/manage → API → Tokens). The legacy SANITY_AUTH_TOKEN still works until it is removed.' }
  }
  if (access === 'read' && choice.source === 'none') {
    return { ok: false, error: 'SANITY_READ_TOKEN is required (a Viewer token from sanity.io/manage → API → Tokens), or set SANITY_DATASET_PUBLIC=on for a public dataset.' }
  }
  warnOnce(choice)
  return { ok: true, config: { projectId, dataset: env.NEXT_PUBLIC_SANITY_DATASET || 'production', ...(choice.token ? { token: choice.token } : {}) } }
}

/** A client for `access`, or print why not and exit (these are command-line scripts). */
export function requireStudioSanityClient(access: SanityAccess, options: { perspective?: 'raw' | 'published' } = {}): { client: SanityClient; config: StudioSanityConfig } {
  const r = studioSanityConfig(access)
  if (!r.ok) {
    console.error(r.error)
    process.exit(1)
  }
  const client = createClient({ ...r.config, apiVersion: '2024-10-01', useCdn: false, ...(options.perspective ? { perspective: options.perspective } : {}) })
  return { client, config: r.config }
}
