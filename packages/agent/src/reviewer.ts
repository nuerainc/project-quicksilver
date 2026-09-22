/**
 * Reviewer — an independent second opinion on a proposed action.
 *
 * Wired into /api/plan (apps/web) alongside the kernel's own authorize()
 * call. The reviewer NEVER authorizes or blocks anything — only the kernel
 * does that (packages/kernel). It flags concerns for a human approver to
 * see alongside the kernel's risk/policy computation, and its notes are
 * persisted on the `decision` document (field: `reviewerNotes`) for
 * auditability.
 *
 * Previously REVIEWER_SYSTEM_PROMPT existed but was only exercised by the
 * standalone verify-llm.ts health check, never in the live request path.
 * This file is what actually calls it for real.
 */

import { generateText, Output } from 'ai'
import { z } from 'zod'

import { REVIEWER_SYSTEM_PROMPT } from './prompts.ts'
import { modelForRole } from './models.ts'
import type { ProposedAction } from '@quicksilver/kernel'

// NOTE: no `.default([])` on these array fields. A Zod default marks the field
// optional in the generated JSON Schema, which fails Azure/OpenAI's strict
// response_format validation ("'required' ... must include every key in
// properties") -- the same bug class as the financialExposure fix in
// planner.ts. Every field must be required; the model just returns an empty
// array when it has nothing to report.
export const ReviewResultSchema = z.object({
  valid: z.boolean(),
  policyConflicts: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  riskConcerns: z.array(z.string()),
  suggestions: z.array(z.string()),
})

export type ReviewResult = z.infer<typeof ReviewResultSchema>

export interface ReviewInput {
  action: ProposedAction
  actor: { id: string; name: string; entityType: string }
  capability: { id: string; name: string; riskLevel: number }
  policies: Array<{ id: string; name: string; scope: string; priority: number }>
  evidence: Array<{ id: string; title: string; confidence: number }>
}

/** A neutral, clearly-labeled fallback when the reviewer call itself fails or
 *  returns no structured output — the kernel is still authoritative either
 *  way, so a reviewer hiccup must never block the plan response. */
function unreviewed(reason: string): ReviewResult {
  return {
    valid: true,
    policyConflicts: [],
    missingEvidence: [],
    riskConcerns: [`Reviewer unavailable: ${reason}`],
    suggestions: [],
  }
}

export async function reviewProposedAction(input: ReviewInput): Promise<ReviewResult> {
  const { action, actor, capability, policies, evidence } = input

  const policyList = policies.length
    ? policies.map((p) => `- ${p.name} (scope: ${p.scope}, priority: ${p.priority}, id: ${p.id})`).join('\n')
    : '(none resolved)'
  const evidenceList = evidence.length
    ? evidence.map((e) => `- ${e.title} (confidence: ${e.confidence}, id: ${e.id})`).join('\n')
    : '(none resolved)'

  try {
    const result = await generateText({
      model: modelForRole('reviewer'),
      system: REVIEWER_SYSTEM_PROMPT,
      prompt: `Proposed action: ${action.description}

Actor: ${actor.name} (${actor.entityType}, id ${actor.id})
Capability: ${capability.name} (base risk ${capability.riskLevel}/5, id ${capability.id})

Applicable policies:
${policyList}

Supporting evidence:
${evidenceList}

Financial exposure: $${action.financialExposure}
Reversible: ${action.reversible}
Operational impact: ${action.operationalImpact}/5
Uncertainty: ${action.uncertainty}/5

Review this proposed action independently. Flag any policy conflicts, missing evidence, or risk concerns you see. Do not simply restate the kernel's own computation -- add what an independent reviewer would actually catch.`,
      experimental_output: Output.object({ schema: ReviewResultSchema }),
      maxRetries: 1,
    } as Parameters<typeof generateText>[0])

    const parsed = (result as unknown as { experimental_output?: ReviewResult }).experimental_output
    return parsed ?? unreviewed('model did not return structured output')
  } catch (err) {
    return unreviewed((err as Error).message)
  }
}
