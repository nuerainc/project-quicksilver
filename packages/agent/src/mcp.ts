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
import { ToolRegistry, type EvaluatorToolCall } from '@quicksilver/kernel'

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

/**
 * Context MCP endpoints and the knowledge base that belong to the paused
 * Sanity Challenge project. The Nuera instance must never read them: they
 * serve the challenge dataset, while this instance writes decisions and
 * evaluations to its own project. Same rule as the blocked project id.
 */
const LEGACY_CHALLENGE_ENDPOINT_NAMES = ['quicksilver-agent', 'quicksilver-knowledge-base'] as const
const LEGACY_CHALLENGE_KNOWLEDGE_BASE_IDS = ['kbxQPcFbgi6f'] as const

/** Throws when a Context MCP URL points at the challenge project's endpoints or knowledge base. */
export function assertNotLegacyContextEndpoint(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Context MCP URL is not a valid URL.')
  }
  const name = parsed.pathname.replace(/\/+$/, '').split('/').at(-1) ?? ''
  const kbIds = (parsed.searchParams.get('knowledgeBases') ?? '').split(',').map((id) => id.trim())
  if ((LEGACY_CHALLENGE_ENDPOINT_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `Context MCP endpoint "${name}" belongs to the paused Sanity Challenge project and is blocked. ` +
        'Create endpoints in the dedicated Nuera Quicksilver project (see docs/platform/sanity-isolation.md).',
    )
  }
  if (kbIds.some((id) => (LEGACY_CHALLENGE_KNOWLEDGE_BASE_IDS as readonly string[]).includes(id))) {
    throw new Error('The challenge knowledge base is blocked. Build a knowledge base in the dedicated Nuera Quicksilver project.')
  }
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
  assertNotLegacyContextEndpoint(url)
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
    assertNotLegacyContextEndpoint(kbUrl)
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
  callLog: EvaluatorToolCall[] = [],
): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {}
  const registry = new ToolRegistry()
  const completedTools: string[] = []

  for (const { label, client } of clients) {
    const tools = (await client.tools()) as Record<string, unknown>
    for (const [name, rawTool] of Object.entries(tools)) {
      const key = name in merged ? `${label}_${name}` : name
      const tool = rawTool as {
        inputSchema?: { jsonSchema?: unknown }
        execute?: (args: unknown, options: unknown) => Promise<unknown>
        description?: string
        metadata?: { annotations?: Record<string, unknown> }
      }
      if (typeof tool.execute !== 'function') {
        merged[key] = rawTool
        continue
      }

      const annotations = tool.metadata?.annotations ?? {}
      // These endpoints use Context Viewer and are read-only. Treat explicit
      // destructive/write annotations as side effects and fail closed pending
      // a verified supervisor approval path.
      const requiresApproval = annotations.destructiveHint === true || annotations.readOnlyHint === false
      registry.register({
        id: key,
        contractVersion: 1,
        provider: `sanity-context/${label}`,
        description: tool.description,
        inputSchema: tool.inputSchema?.jsonSchema,
        access: requiresApproval ? 'side-effect' : 'read-only',
        requiresApproval,
      })
      const originalExecute = tool.execute
      merged[key] = {
        ...tool,
        execute: async (args: unknown, options: unknown) => {
          const validation = registry.validate({ name: key, arguments: args }, undefined, completedTools)
          if (!validation.allowed) {
            callLog.push({ name: key, succeeded: false })
            throw new Error(`NQC Kernel denied tool call "${key}": ${validation.reasons.join(' ')}`)
          }
          try {
            const result = await originalExecute(args, options)
            completedTools.push(key)
            callLog.push({ name: key, succeeded: true })
            return result
          } catch (error) {
            // Record outcome without persisting provider error text, which can
            // contain user data or credentials.
            callLog.push({ name: key, succeeded: false })
            throw error
          }
        },
      }
    }
  }
  return merged
}
