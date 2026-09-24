import {
  evaluateNqcRequest,
  type EvaluationTaskType,
  type EvaluatorToolCall,
  type ImpactLevel,
  type NqcEvaluationResponse,
  type RoutingRequest,
} from '@quicksilver/kernel'
import { assertAgentDispatch } from './governance.ts'

/** Shared input contract for model-backed Nuera Quicksilver Agents. */
export interface NueraAgentRequest<Input = unknown> {
  agentId: string
  taskType: EvaluationTaskType
  input: Input
  context?: string[]
  impactLevel?: ImpactLevel
  routing?: RoutingRequest
  signal?: AbortSignal
}

/** Structured payload returned by a worker before NQC governance is applied. */
export interface NueraAgentResult<Output = unknown> {
  output: Output
  modelId: string
  toolCalls?: EvaluatorToolCall[]
  /** Evidence/context used for grounding checks; never private chain-of-thought. */
  evaluationContext?: string[]
}

/** A versioned worker contract. Agent authority is always bounded by the NQC manifest. */
export interface NueraQuicksilverAgent<Input = unknown, Output = unknown> {
  id: string
  version: number
  tasks: readonly EvaluationTaskType[]
  execute(request: NueraAgentRequest<Input>): Promise<NueraAgentResult<Output>>
}

export interface GovernedNueraAgentResult<Output = unknown> extends NueraAgentResult<Output> {
  agentId: string
  agentVersion: number
  evaluation: NqcEvaluationResponse
  /** Only ALLOW is eligible for automatic continuation; ESCALATE is not approval. */
  mayContinueAutomatically: boolean
}

/** Run a worker under the registered NQC identity, then evaluate its result. */
export async function executeGovernedAgent<Input, Output>(
  agent: NueraQuicksilverAgent<Input, Output>,
  request: NueraAgentRequest<Input>,
): Promise<GovernedNueraAgentResult<Output>> {
  if (!agent || typeof agent !== 'object' || !/^nuera-quicksilver:[a-z][a-z0-9-]{0,62}$/.test(agent.id)) {
    throw new Error('Agent implementation must have a valid Nuera Quicksilver identity.')
  }
  if (request.agentId !== agent.id) throw new Error('Request agentId does not match the worker identity.')
  if (!Number.isInteger(agent.version) || agent.version < 1) throw new Error('Agent implementation version must be a positive integer.')
  if (!Array.isArray(agent.tasks) || !agent.tasks.includes(request.taskType)) {
    throw new Error(`Agent "${agent.id}" does not implement task "${request.taskType}".`)
  }

  assertAgentDispatch(agent.id, request.taskType, request.impactLevel ?? 'low')
  const result = await agent.execute(request)
  if (!result || typeof result.modelId !== 'string' || !result.modelId.trim() || !('output' in result)) {
    throw new Error(`Agent "${agent.id}" returned an invalid structured result.`)
  }
  let agentOutput: string
  try {
    agentOutput = JSON.stringify(result.output) ?? String(result.output)
  } catch {
    throw new Error(`Agent "${agent.id}" returned output that cannot be evaluated as JSON.`)
  }

  const evaluation = evaluateNqcRequest({
    agentId: agent.id,
    taskType: request.taskType,
    modelId: result.modelId,
    agentOutput,
    context: result.evaluationContext ?? request.context,
    toolCalls: result.toolCalls,
    impactLevel: request.impactLevel ?? 'low',
    routing: request.routing,
  })

  return {
    ...result,
    agentId: agent.id,
    agentVersion: agent.version,
    evaluation,
    mayContinueAutomatically: evaluation.safetyDecision === 'ALLOW',
  }
}
