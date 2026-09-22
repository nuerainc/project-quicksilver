/**
 * Planner — the only Quicksilver agent.
 *
 * Connects to Sanity Context MCP, exposes the structured content as tools to
 * the planner model, and returns a structured plan for the kernel to authorize.
 *
 * Day 6: connectivity verified end-to-end.
 * Day 7: returns candidate actions in ProposedAction shape.
 * Day 9: candidate actions become a full decision artifact via the kernel.
 */

import { generateText, Output, stepCountIs } from 'ai'
import { z } from 'zod'

import { PLANNER_SYSTEM_PROMPT } from './prompts.ts'
import { isLlmConfigured, modelForRole } from './models.ts'
import { createSanityContextClient, readEnvMcpConfig } from './mcp.ts'
import type { ProposedAction } from '@quicksilver/kernel'

export interface PlannerInput {
  objective: string
  /** Optional pre-loaded context to skip MCP round-trips (used for tests). */
  context?: Record<string, unknown>
}

const ProposedActionSchema = z.object({
  description: z.string(),
  actorId: z.string(),
  capabilityId: z.string(),
  applicablePolicyIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  // Required (not `.default(0)`): strict JSON-schema output needs every property in `required`.
  financialExposure: z.number().describe('Estimated financial exposure in USD; use 0 if none'),
  reversible: z.boolean(),
  operationalImpact: z.number().int().min(0).max(5),
  uncertainty: z.number().int().min(0).max(5),
})

export const PlanOutputSchema = z.object({
  decomposition: z.object({
    objective: z.string(),
    constraints: z.array(z.string()),
    successMetrics: z.array(z.string()),
    requiredCapabilities: z.array(z.string()),
    candidateWorkstreams: z.array(z.string()),
  }),
  candidateActions: z.array(ProposedActionSchema).min(1),
  reasoning: z.string(),
})

export type PlannerOutput = z.infer<typeof PlanOutputSchema>

/** Re-exported so callers can gate on it without importing models directly. */
export { isLlmConfigured }

/**
 * Max model steps (one step = one model call, plus any tool calls it makes).
 * `generateText` defaults to a single step, which ends the run right after the
 * first tool call — before the model can emit its structured plan.
 */
const PLANNER_MAX_STEPS = 15

export async function planObjective(input: PlannerInput): Promise<PlannerOutput> {
  if (!isLlmConfigured()) {
    throw new Error(
      'No LLM configured. Set AZURE_API_KEY + AZURE_RESOURCE_NAME (or OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) in .env.',
    )
  }

  const mcpConfig = readEnvMcpConfig()
  const client = await createSanityContextClient(mcpConfig)

  try {
    const tools = (await client.tools()) as Record<string, unknown>

    // Day 8: agentic loop with structured output. The model uses MCP tools
    // to discover entities/capabilities/policies/evidence, then emits a plan
    // matching the ProposedAction shape — which the kernel can authorize
    // directly without further transformation.
    const result = await generateText({
      model: modelForRole('planner'),
      system: PLANNER_SYSTEM_PROMPT,
      prompt: `Decompose this company objective and propose candidate actions:

"""${input.objective}"""

Step 1: Use the available tools (groq_query, schema_explorer, knowledge_base_read) to discover:
  - Which entities have which capabilities
  - Which policies apply to the actions you're considering
  - Which evidence (reports, analyses, vendor bulletins) is relevant

Step 2: Emit a structured plan. The candidateActions array MUST contain at least one action. Each action must reference entities and capabilities by their Sanity document IDs (e.g., "entity-engineering-agent", "cap-process-param"). Do NOT invent IDs — only use IDs you actually retrieved.

The kernel will compute risk and authorization from your candidate actions. Be specific about which policies apply.`,
      tools: tools as unknown as Parameters<typeof generateText>[0]['tools'],
      experimental_output: Output.object({ schema: PlanOutputSchema }),
      stopWhen: stepCountIs(PLANNER_MAX_STEPS),
      maxRetries: 2,
    } as Parameters<typeof generateText>[0])

    const parsed = (result as unknown as { experimental_output?: PlannerOutput }).experimental_output
    if (!parsed || parsed.candidateActions.length === 0) {
      throw new Error('Planner produced no candidate actions.')
    }
    return parsed
  } finally {
    await client.close()
  }
}