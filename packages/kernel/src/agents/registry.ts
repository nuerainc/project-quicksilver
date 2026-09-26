import type { EvaluationTaskType, ImpactLevel } from '../engine/index.ts'

export type AgentAuthority = 'propose' | 'review'

/** Versioned identity and policy contract for a Nuera Quicksilver Agent. */
export interface AgentManifest {
  id: string
  version: number
  authority: AgentAuthority
  tasks: readonly EvaluationTaskType[]
  maximumImpact: ImpactLevel
  requiresEvaluation: boolean
}

export interface AgentDispatchDecision {
  allowed: boolean
  requiresEvaluation: boolean
  reasons: string[]
}

const TASKS: EvaluationTaskType[] = ['reasoning', 'code', 'bulk', 'planning', 'routing', 'tool', 'memory', 'hydraulic', 'evaluation', 'other']
const IMPACTS: ImpactLevel[] = ['low', 'moderate', 'high', 'critical']

/** Per-runtime registry for versioned agent identities and dispatch policy. */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentManifest>()

  register(manifest: AgentManifest): Readonly<AgentManifest> {
    const errors = validateAgentManifest(manifest)
    if (errors.length) throw new Error(`Invalid agent manifest "${manifest?.id ?? 'unknown'}": ${errors.join(' ')}`)
    if (this.agents.has(manifest.id)) throw new Error(`Agent "${manifest.id}" is already registered.`)
    const safe = Object.freeze({ ...manifest, tasks: Object.freeze([...manifest.tasks]) })
    this.agents.set(safe.id, safe)
    return safe
  }

  get(id: string): Readonly<AgentManifest> | undefined {
    return this.agents.get(id)
  }

  list(): Readonly<AgentManifest>[] {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  authorizeDispatch(agentId: string, task: EvaluationTaskType, impact: ImpactLevel = 'low'): AgentDispatchDecision {
    const agent = this.agents.get(agentId)
    if (!agent) return { allowed: false, requiresEvaluation: true, reasons: [`Agent "${agentId}" is not registered.`] }
    const reasons: string[] = []
    if (!TASKS.includes(task)) reasons.push(`Task "${task}" is not a supported NQC task.`)
    if (!IMPACTS.includes(impact)) reasons.push(`Impact "${impact}" is not a supported NQC impact level.`)
    if (!agent.tasks.includes(task)) reasons.push(`Agent "${agentId}" is not approved for the "${task}" task.`)
    if (IMPACTS.includes(impact) && IMPACTS.indexOf(impact) > IMPACTS.indexOf(agent.maximumImpact)) reasons.push(`Impact "${impact}" exceeds agent "${agentId}" maximum "${agent.maximumImpact}".`)
    return { allowed: reasons.length === 0, requiresEvaluation: agent.requiresEvaluation, reasons }
  }
}

function validateAgentManifest(manifest: AgentManifest): string[] {
  if (!manifest || typeof manifest !== 'object') return ['Manifest must be an object.']
  const errors: string[] = []
  if (typeof manifest.id !== 'string' || !/^nuera-quicksilver:[a-z][a-z0-9-]{0,62}$/.test(manifest.id)) errors.push('id must be a namespaced stable identifier.')
  if (!Number.isInteger(manifest.version) || manifest.version < 1) errors.push('version must be a positive integer.')
  if (manifest.authority !== 'propose' && manifest.authority !== 'review') errors.push('authority must be propose or review; agents cannot authorize actions.')
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0 || manifest.tasks.some((task) => !TASKS.includes(task))) errors.push('tasks must include supported evaluation task types.')
  if (Array.isArray(manifest.tasks) && new Set(manifest.tasks).size !== manifest.tasks.length) errors.push('tasks cannot contain duplicates.')
  if (!IMPACTS.includes(manifest.maximumImpact)) errors.push('maximumImpact must be a supported impact level.')
  if (typeof manifest.requiresEvaluation !== 'boolean') errors.push('requiresEvaluation must be boolean.')
  return errors
}

/** Built-in agents present in this repository; the remaining family is future work. */
export const BUILT_IN_AGENT_MANIFESTS: readonly AgentManifest[] = Object.freeze([
  Object.freeze({ id: 'nuera-quicksilver:planner', version: 1, authority: 'propose', tasks: Object.freeze(['planning'] as EvaluationTaskType[]), maximumImpact: 'critical', requiresEvaluation: true }),
  Object.freeze({ id: 'nuera-quicksilver:reviewer', version: 1, authority: 'review', tasks: Object.freeze(['evaluation', 'reasoning'] as EvaluationTaskType[]), maximumImpact: 'critical', requiresEvaluation: true }),
  Object.freeze({ id: 'nuera-quicksilver:query', version: 1, authority: 'propose', tasks: Object.freeze(['reasoning'] as EvaluationTaskType[]), maximumImpact: 'moderate', requiresEvaluation: true }),
  // Aura objective parser: reads an objective into structured fields; proposes nothing.
  Object.freeze({ id: 'nuera-quicksilver:intent', version: 1, authority: 'propose', tasks: Object.freeze(['reasoning'] as EvaluationTaskType[]), maximumImpact: 'low', requiresEvaluation: true }),
])

export function createBuiltInAgentRegistry(): AgentRegistry {
  const registry = new AgentRegistry()
  for (const manifest of BUILT_IN_AGENT_MANIFESTS) registry.register(manifest)
  return registry
}
