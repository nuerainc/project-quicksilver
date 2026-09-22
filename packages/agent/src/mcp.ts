/**
 * MCP bindings.
 *
 * The agent reads from Sanity via the Context MCP server (hosted, read-only).
 * The agent writes via direct Sanity HTTP API calls (Context MCP cannot write).
 *
 * Day-6 work: wire `@ai-sdk/mcp` to the Sanity Context endpoint.
 *
 * Endpoints in scope:
 *   - GROQ-mode endpoint (live dataset, schema-aware structured queries)
 *   - KB-mode endpoint (compiled index over selected sources, for provenance)
 *
 * Note: ONE endpoint serves ONE mode. An endpoint with both dataset and
 * knowledge-base sources ignores the KB sources. To demo both modes, create
 * two endpoints in the Sanity dashboard and wire both to the agent.
 */

import { createMCPClient } from '@ai-sdk/mcp'

export interface SanityMCPConfig {
  endpointUrl: string
  token: string
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