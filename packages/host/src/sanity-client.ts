/**
 * The Sanity client the host's durable stores write through.
 *
 * Stores depend on the small SanityStoreClient interface, not on
 * @sanity/client, so tests use in-memory fakes and never reach the network.
 * Every path to a client goes through assertAllowedSanityProject: the legacy
 * challenge project stays refused, here and in the stores themselves.
 */
import { createHash } from 'node:crypto'

export const LEGACY_CHALLENGE_PROJECT_ID = 'd280bqjc'

export class LegacySanityProjectError extends Error {
  constructor() {
    super('The legacy challenge Sanity project is blocked. Configure the dedicated Nuera Quicksilver project.')
    this.name = 'LegacySanityProjectError'
  }
}

/** Throws for the legacy challenge project. */
export function assertAllowedSanityProject(projectId: string | undefined): void {
  if (projectId?.trim() === LEGACY_CHALLENGE_PROJECT_ID) throw new LegacySanityProjectError()
}

export interface SanityEnvConfig {
  projectId: string
  dataset: string
  apiVersion: string
  token: string
}

/**
 * Project, dataset and write token from the environment (the same variables
 * the evaluation sink uses). Returns undefined when Sanity is not configured;
 * throws for the legacy project. Never logs or returns anything but the config.
 */
export function sanityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SanityEnvConfig | undefined {
  const projectId = env.NEXT_PUBLIC_SANITY_PROJECT_ID?.trim()
  assertAllowedSanityProject(projectId)
  const token = env.SANITY_AUTH_TOKEN
  if (!projectId || !token) return undefined
  return {
    projectId,
    dataset: env.NEXT_PUBLIC_SANITY_DATASET ?? 'production',
    apiVersion: env.NEXT_PUBLIC_SANITY_API_VERSION ?? '2024-10-01',
    token,
  }
}

export type SanityDoc = { _id: string; _type: string; _rev?: string } & Record<string, unknown>

export type SanityMutation =
  | { create: SanityDoc }
  | { createIfNotExists: SanityDoc }
  | { patch: { id: string; ifRevisionID?: string; set?: Record<string, unknown> } }

/** The part of @sanity/client the host's stores need. `mutate` commits all mutations as one transaction. */
export interface SanityStoreClient {
  /** The project the client writes to, when known; stores refuse the legacy project. */
  readonly projectId?: string
  fetch<T>(query: string, params: Record<string, unknown>): Promise<T>
  getDocument<T extends { _id: string; _type: string; _rev?: string }>(id: string): Promise<T | undefined>
  createIfNotExists<T extends { _id: string; _type: string }>(doc: T): Promise<T>
  mutate(mutations: SanityMutation[]): Promise<void>
}

/**
 * One segment of a document id. Sanity ids take letters, digits, "_" and "-"
 * per segment; anything else is replaced and a short hash keeps the result
 * unique, so the id stays deterministic.
 */
export function idSegment(value: string): string {
  if (!value) throw new Error('An id segment cannot be empty.')
  if (/^[a-zA-Z0-9_-]{1,128}$/.test(value)) return value
  return `${value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}-${createHash('sha256').update(value).digest('hex').slice(0, 10)}`
}

/** A 409 from Sanity: a create found the id taken, or ifRevisionID did not match. */
export function isSanityConflict(error: unknown): boolean {
  const e = error as { statusCode?: number; response?: { statusCode?: number } } | null
  return e?.statusCode === 409 || e?.response?.statusCode === 409
}

/** Build a store client from the environment (undefined when Sanity is not configured). */
export async function createSanityStoreClient(env: NodeJS.ProcessEnv = process.env): Promise<SanityStoreClient | undefined> {
  const config = sanityConfigFromEnv(env)
  if (!config) return undefined
  const { createClient } = await import('@sanity/client')
  const client = createClient({ ...config, useCdn: false, perspective: 'raw' })
  return {
    projectId: config.projectId,
    fetch: <T>(query: string, params: Record<string, unknown>) => client.fetch<T>(query, params),
    getDocument: async <T extends { _id: string; _type: string; _rev?: string }>(id: string) => (await client.getDocument(id)) as T | undefined,
    createIfNotExists: <T extends { _id: string; _type: string }>(doc: T) => client.createIfNotExists(doc) as unknown as Promise<T>,
    mutate: async (mutations) => {
      await client.mutate(mutations as never, { visibility: 'sync' })
    },
  }
}
