/**
 * Day 7 — simple query agent.
 *
 * Structured Q&A over the company model. Uses AI SDK's `generateObject`
 * with a Zod schema so the response shape is enforced (no prose, no CoT
 * leaking to callers).
 *
 * Example:
 *   "Who can perform process parameter modification?"
 *   → {
 *       question: "...",
 *       entities: [{ id: "entity-engineering-agent", name: "Engineering Agent", ... }, ...],
 *       supportingContext: ["Capability 'Process Parameter Modification' authorizes 3 entities…"],
 *       confidence: 0.95,
 *     }
 */

import { generateText, Output, stepCountIs } from 'ai'
import { z } from 'zod'

import { QUERY_SYSTEM_PROMPT } from './prompts.ts'
import { isLlmConfigured, modelForRole } from './models.ts'
import {
  closeAll,
  createSanityContextClients,
  mergeClientTools,
  readEnvMcpConfigs,
} from './mcp.ts'

export const QueryResultSchema = z.object({
  question: z.string(),
  entities: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      entityType: z.string(),
      role: z.string().optional(),
      reasoning: z.string(),
    }),
  ),
  capabilities: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        riskLevel: z.number().int().min(0).max(5),
      }),
    )
    .default([]),
  policies: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        scope: z.string(),
      }),
    )
    .default([]),
  supportingContext: z.array(z.string()),
  confidence: z.number().min(0).max(1),
})

export type QueryResult = z.infer<typeof QueryResultSchema>

export async function queryCompany(question: string): Promise<QueryResult> {
  if (!isLlmConfigured()) {
    throw new Error(
      'No LLM configured. Set AZURE_API_KEY + AZURE_RESOURCE_NAME (or OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) in .env.',
    )
  }

  const mcpConfigs = readEnvMcpConfigs()
  const clients = await createSanityContextClients(mcpConfigs)

  try {
    const tools = await mergeClientTools(clients)

    // Structured output via `experimental_output` (still supported in AI SDK 6).
    // The tool-call loop runs first — `stopWhen` is required, because the default
    // is a single step, which ends the run right after the first tool call —
    // then the model emits a final JSON message matching the Zod schema.
    const result = await generateText({
      model: modelForRole('planner'),
      system: QUERY_SYSTEM_PROMPT,
      prompt: `Question: ${question}`,
      tools: tools as unknown as Parameters<typeof generateText>[0]['tools'],
      experimental_output: Output.object({
        schema: QueryResultSchema,
      }),
      stopWhen: stepCountIs(12),
      maxRetries: 2,
    } as Parameters<typeof generateText>[0])

    const parsed = (result as unknown as { experimental_output?: QueryResult }).experimental_output
    if (!parsed) {
      throw new Error('Model did not return structured output.')
    }
    return parsed
  } finally {
    await closeAll(clients)
  }
}