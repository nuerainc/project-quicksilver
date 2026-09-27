/**
 * The one place the web app creates Sanity clients (threat model A-7).
 *
 * - `getSanityClient('read')`: pages and routes that only read (the decision
 *   log). Uses `SANITY_READ_TOKEN`, a Viewer token that cannot write.
 * - `getSanityClient('write')`: routes that create or patch documents (plan,
 *   the decision routes, evaluation records). Uses `SANITY_WRITE_TOKEN`, an
 *   Editor token.
 *
 * Either falls back to the legacy combined `SANITY_AUTH_TOKEN` with a warning
 * printed once per server process, and a read uses no token at all when the
 * founder has marked the dataset public (`SANITY_DATASET_PUBLIC=on`). The
 * choice itself is `resolveSanityToken` in @quicksilver/kernel/sanity-tokens,
 * shared with the host. The legacy challenge project stays refused
 * (`getDedicatedSanityProjectId`). Server-only: never import this from a
 * client component.
 */
import { createClient, type SanityClient } from '@sanity/client'
import { createOnceWarner, resolveSanityToken, type SanityAccess } from '@quicksilver/kernel/sanity-tokens'
import { getDedicatedSanityProjectId } from './sanity-config'

const warnOnce = createOnceWarner((message) => console.warn(`[sanity] ${message}`))

export function getSanityClient(access: SanityAccess): SanityClient {
  const projectId = getDedicatedSanityProjectId()
  const choice = warnOnce(resolveSanityToken(access, process.env))
  return createClient({
    projectId,
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production',
    apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? '2024-10-01',
    useCdn: false,
    ...(choice.token ? { token: choice.token } : {}),
  })
}
