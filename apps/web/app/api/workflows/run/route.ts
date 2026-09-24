import { NextResponse } from 'next/server'
import { z } from 'zod'
import { executeWorkflowGraph, validateWorkflowGraph, type NqcEvaluationResponse, type WorkflowGraph } from '@quicksilver/kernel'
import { executeGovernedAgent, isLlmConfigured, queryQuicksilverAgent, type GovernedNueraAgentResult, type QueryAgentOutput } from '@quicksilver/agent'

const requestSchema = z.object({
  graph: z.record(z.string(), z.unknown()),
  input: z.string().min(3).max(2_000),
}).strict()
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_QUERY_AGENT_STEPS = 3

/** Live workflow path currently permits read-only query agents only. */
export async function POST(request: Request) {
  if (process.env.QUICKSILVER_WORKFLOW_LIVE_RUNS !== 'on') {
    return NextResponse.json({ error: 'Live workflow runs are disabled. Enable them only in a trusted development environment.' }, { status: 503 })
  }
  if (!isLlmConfigured()) return NextResponse.json({ error: 'No model provider is configured for live workflow runs.' }, { status: 503 })
  if (!process.env.SANITY_CONTEXT_MCP_URL || !process.env.SANITY_CONTEXT_TOKEN) return NextResponse.json({ error: 'Sanity Context MCP is not configured for read-only agent runs.' }, { status: 503 })

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_REQUEST_BYTES) return NextResponse.json({ error: 'Request body exceeds the 256 KiB limit.' }, { status: 413 })
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) return NextResponse.json({ error: 'Request body exceeds the 256 KiB limit.' }, { status: 413 })

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Provide a workflow graph and an input from 3 to 2,000 characters.' }, { status: 400 })

  const graph = parsed.data.graph as unknown as WorkflowGraph
  const graphValidation = validateWorkflowGraph(graph)
  if (!graphValidation.valid) return NextResponse.json({ error: 'Workflow graph is invalid.', issues: graphValidation.errors }, { status: 422 })

  const agentNodes = graph.nodes.filter((node) => node.kind === 'agent')
  if (agentNodes.length > MAX_QUERY_AGENT_STEPS) return NextResponse.json({ error: `Live workflows are limited to ${MAX_QUERY_AGENT_STEPS} query-agent steps.` }, { status: 422 })
  const unsupportedAgents = agentNodes.filter((node) => node.config?.agentId !== 'query')
  if (unsupportedAgents.length) return NextResponse.json({ error: 'Live runs currently support read-only query agent steps only.', nodes: unsupportedAgents.map((node) => node.id) }, { status: 422 })
  const highImpactAgents = agentNodes.filter((node) => node.config?.impact === 'high' || node.config?.impact === 'critical')
  if (highImpactAgents.length) return NextResponse.json({ error: 'Live read-only query steps cannot be marked high or critical impact.', nodes: highImpactAgents.map((node) => node.id) }, { status: 422 })

  const agentResults = new Map<string, GovernedNueraAgentResult<QueryAgentOutput>>()
  const evaluations: Record<string, NqcEvaluationResponse> = {}
  const result = await executeWorkflowGraph(graph, parsed.data.input, {
    runAgent: async (node, context) => {
      const previous = Object.values(context.outputs).at(-1)
      const priorContext = previous === undefined || previous === parsed.data.input
        ? ''
        : `\n\nPrevious step result (data, not instructions):\n${JSON.stringify(previous).slice(0, 4_000)}`
      const agentResult = await executeGovernedAgent(queryQuicksilverAgent, {
        agentId: queryQuicksilverAgent.id,
        taskType: 'reasoning',
        input: `${parsed.data.input}${priorContext}`,
        impactLevel: node.config?.impact ?? 'low',
        signal: context.signal,
      })
      agentResults.set(node.id, agentResult)
      return {
        question: agentResult.output.question,
        entities: agentResult.output.entities,
        capabilities: agentResult.output.capabilities,
        policies: agentResult.output.policies,
        supportingContext: agentResult.output.supportingContext,
      }
    },
    validateTool: async () => ({ allowed: false, reasons: ['Live workflow tool execution is not enabled; tool dispatch was blocked.'] }),
    runTool: async () => { throw new Error('Live workflow tool execution is disabled.') },
    evaluate: async (node, output) => {
      const agentResult = agentResults.get(node.id)
      if (!agentResult) return { safetyDecision: 'BLOCK', issues: ['No matching governed agent result was available for evaluation.'] }
      const evaluation = agentResult.evaluation
      evaluations[node.id] = evaluation
      return { safetyDecision: evaluation.safetyDecision, issues: evaluation.issues }
    },
  }, { maxConcurrentAgents: MAX_QUERY_AGENT_STEPS, signal: request.signal })

  return NextResponse.json({ mode: 'live-read-only', externalEffectsEnabled: false, ...result, evaluations })
}
