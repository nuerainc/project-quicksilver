import { createBuiltInAgentRegistry, type EvaluationTaskType, type ImpactLevel } from '@quicksilver/kernel'

const registry = createBuiltInAgentRegistry()

/** Every model-backed agent call must match a registered manifest and task. */
export function assertAgentDispatch(agentId: string, task: EvaluationTaskType, impact: ImpactLevel = 'low') {
  const decision = registry.authorizeDispatch(agentId, task, impact)
  if (!decision.allowed) throw new Error(`NQC Kernel denied agent dispatch: ${decision.reasons.join(' ')}`)
  return decision
}

export function listAgentManifests() {
  return registry.list()
}
