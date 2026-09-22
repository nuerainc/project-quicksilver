/**
 * MCP bindings.
 *
 * The agent reads from Sanity via the Context MCP server (hosted, read-only).
 * The agent writes via direct Sanity HTTP API calls (Context MCP cannot write).
 *
 * Day-6 work: wire `@ai-sdk/mcp` to the Sanity Context endpoint.
 *
 * Both endpoints are wired in:
 *   - GROQ-mode endpoint (live dataset, schema-aware structured queries)
 *   - KB-mode endpoint (compiled Knowledge Base index, cited + contradiction-checked)
 *
 * Note: ONE endpoint serves ONE mode. An endpoint with both dataset and
 * knowledge-base sources ignores the KB sources, so both live as separate
 * endpoints in the Sanity dashboard (SANITY_CONTEXT_MCP_URL for GROQ-mode,
 * SANITY_CONTEXT_KB_MCP_URL for KB-mode) and their tools are merged for the
 * planner/query agents — see readEnvMcpConfigs / mergeClientTools below.
 */

import { createMCPClient } from '@ai-sdk/mcp'

export interface SanityMCPConfig {
  endpointUrl: string
  token: string
}

/** A config plus a short label used to disambiguate tool names that collide
 *  across endpoints (both GROQ-mode and KB-mode expose `initial_context`). */
export interface NamedMcpConfig extends SanityMCPConfig {
  label: string
}

export async function createSanityContextClient(config: SanityMCPConfig) {
  return createMCPClient({
    transport: {
      type: 'http',
      url: config.endpointUrl,
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
    },
  })
}

type SanityMcpClient = Awaited<ReturnType<typeof createSanityContextClient>>

export interface NamedMcpClient {
  label: string
  client: SanityMcpClient
}

/** Single-endpoint config, kept for callers that only ever talk GROQ-mode. */
export function readEnvMcpConfig(): SanityMCPConfig {
  const url = process.env.SANITY_CONTEXT_MCP_URL
  const token = process.env.SANITY_CONTEXT_TOKEN
  if (!url || !token) {
    throw new Error(
      'SANITY_CONTEXT_MCP_URL and SANITY_CONTEXT_TOKEN must be set. See .env.example.',
    )
  }
  return { endpointUrl: url, token }
}

/**
 * Reads every configured Context MCP endpoint. GROQ-mode
 * (SANITY_CONTEXT_MCP_URL) is required; KB-mode (SANITY_CONTEXT_KB_MCP_URL)
 * is optional and, when present, is wired in alongside it. Context Viewer is
 * an org-level grant, so the GROQ token authorizes the KB endpoint too unless
 * SANITY_CONTEXT_KB_TOKEN overrides it.
 */
export function readEnvMcpConfigs(): NamedMcpConfig[] {
  const groq = readEnvMcpConfig()
  const configs: NamedMcpConfig[] = [{ ...groq, label: 'groq' }]

  const kbUrl = process.env.SANITY_CONTEXT_KB_MCP_URL
  if (kbUrl) {
    const kbToken = process.env.SANITY_CONTEXT_KB_TOKEN || groq.token
    configs.push({ endpointUrl: kbUrl, token: kbToken, label: 'kb' })
  }

  return configs
}

export async function createSanityContextClients(
  configs: NamedMcpConfig[],
): Promise<NamedMcpClient[]> {
  return Promise.all(
    configs.map(async (config) => ({
      label: config.label,
      client: await createSanityContextClient(config),
    })),
  )
}

export async function closeAll(clients: NamedMcpClient[]): Promise<void> {
  await Promise.all(clients.map(({ client }) => client.close()))
}

/**
 * Merges tool sets from every connected endpoint into one object suitable for
 * `generateText({ tools })`. GROQ-mode and KB-mode both expose `initial_context`
 * under the same name — the first registration wins the bare name (GROQ is
 * always first from readEnvMcpConfigs) and later collisions are exposed under
 * a `<label>_<name>` alias so both stay reachable rather than one silently
 * shadowing the other.
 */
export async function mergeClientTools(
  clients: NamedMcpClient[],
): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {}
  for (const { label, client } of clients) {
    const tools = (await client.tools()) as Record<string, unknown>
    for (const [name, tool] of Object.entries(tools)) {
      const key = name in merged ? `${label}_${name}` : name
      merged[key] = tool
    }
  }
  return merged
}