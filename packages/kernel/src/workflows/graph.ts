import { validateWorkflowConditionExpression, workflowConditionNodeReference } from './condition.ts'

export type WorkflowNodeKind = 'trigger' | 'agent' | 'tool' | 'condition' | 'output'
export type WorkflowImpact = 'low' | 'moderate' | 'high' | 'critical'

export interface WorkflowNode {
  id: string
  kind: WorkflowNodeKind
  label: string
  config?: {
    agentId?: string
    toolId?: string
    conditionExpression?: string
    impact?: WorkflowImpact
    evaluationRequired?: boolean
    sideEffect?: boolean
    supervisorApprovalRequired?: boolean
    maxAttempts?: number
    timeoutMs?: number
  }
}

export interface WorkflowEdge {
  id: string
  from: string
  to: string
  branch?: string
}

/** Versioned authoring contract consumed by future visual editors and runtimes. */
export interface WorkflowGraph {
  schemaVersion: 1
  id: string
  version: number
  entryNodeId: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface WorkflowGraphValidation {
  valid: boolean
  errors: string[]
  topologicalOrder: string[]
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/

/** Validate the stored graph before a workflow can be published or run. */
export function validateWorkflowGraph(graph: WorkflowGraph): WorkflowGraphValidation {
  const errors: string[] = []
  if (!graph || typeof graph !== 'object') {
    return { valid: false, errors: ['Workflow graph must be an object.'], topologicalOrder: [] }
  }
  if (graph.schemaVersion !== 1) errors.push('schemaVersion must be 1.')
  if (typeof graph.id !== 'string' || !ID_PATTERN.test(graph.id)) errors.push('Workflow id is invalid.')
  if (!Number.isInteger(graph.version) || graph.version < 1) errors.push('Workflow version must be a positive integer.')
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return { valid: false, errors: [...errors, 'Workflow must include at least one node.'], topologicalOrder: [] }
  }
  if (graph.nodes.length > 500) return { valid: false, errors: [...errors, 'Workflow exceeds the 500-node limit.'], topologicalOrder: [] }
  if (!Array.isArray(graph.edges)) return { valid: false, errors: [...errors, 'Workflow edges must be an array.'], topologicalOrder: [] }
  if (graph.edges.length > 1000) return { valid: false, errors: [...errors, 'Workflow exceeds the 1,000-edge limit.'], topologicalOrder: [] }

  const nodes = new Map<string, WorkflowNode>()
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !ID_PATTERN.test(node.id)) {
      errors.push('Every workflow node must have a valid id.')
      continue
    }
    if (nodes.has(node.id)) errors.push(`Duplicate workflow node id "${node.id}".`)
    else nodes.set(node.id, node)
    if (!['trigger', 'agent', 'tool', 'condition', 'output'].includes(node.kind)) errors.push(`Node "${node.id}" has an unsupported kind.`)
    if (typeof node.label !== 'string' || !node.label.trim()) errors.push(`Node "${node.id}" needs a label.`)
    validateNodeConfig(node, errors)
  }

  const entry = nodes.get(graph.entryNodeId)
  if (!entry || entry.kind !== 'trigger') errors.push('entryNodeId must identify a trigger node.')
  const triggers = [...nodes.values()].filter((node) => node.kind === 'trigger')
  if (triggers.length !== 1) errors.push('A workflow must have exactly one trigger node.')

  const outgoing = new Map<string, WorkflowEdge[]>()
  const incoming = new Map<string, WorkflowEdge[]>()
  const edgeKeys = new Set<string>()
  const edgeIds = new Set<string>()
  for (const edge of graph.edges ?? []) {
    if (!edge || typeof edge !== 'object' || typeof edge.id !== 'string' || !ID_PATTERN.test(edge.id)) {
      errors.push('Every workflow edge must have a valid id.')
      continue
    }
    if (edgeIds.has(edge.id)) errors.push(`Duplicate workflow edge id "${edge.id}".`)
    edgeIds.add(edge.id)
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      errors.push(`Edge "${edge.id}" references a missing node.`)
      continue
    }
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.branch ?? ''}`
    if (edgeKeys.has(key)) errors.push(`Duplicate connection from "${edge.from}" to "${edge.to}".`)
    edgeKeys.add(key)
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge])
  }

  if (entry && (incoming.get(entry.id)?.length ?? 0) > 0) errors.push('The trigger node cannot have incoming edges.')
  for (const node of nodes.values()) {
    const next = outgoing.get(node.id) ?? []
    if (node.kind === 'output' && next.length > 0) errors.push(`Output node "${node.id}" cannot have outgoing edges.`)
    if (node.kind !== 'output' && next.length === 0) errors.push(`Non-output node "${node.id}" must connect to a next step.`)
    if (node.kind === 'condition') {
      const branches = next.map((edge) => edge.branch)
      if (next.length !== 2 || branches.filter((branch) => branch === 'true').length !== 1 || branches.filter((branch) => branch === 'false').length !== 1) {
        errors.push(`Condition node "${node.id}" must have one true and one false branch.`)
      }
    } else if (next.some((edge) => edge.branch !== undefined)) {
      errors.push(`Only condition nodes may label outgoing branches (node "${node.id}").`)
    }
  }

  const topologicalOrder = topologicalSort(nodes, outgoing, incoming)
  if (topologicalOrder.length !== nodes.size) errors.push('Workflow graph contains a cycle; loops require a future bounded-loop node.')
  for (const node of nodes.values()) {
    if (node.kind !== 'condition' || !node.config?.conditionExpression) continue
    const reference = workflowConditionNodeReference(node.config.conditionExpression)
    if (!reference) continue
    const target = nodes.get(reference.nodeId)
    if (!target) errors.push(`Condition node "${node.id}" references missing node "${reference.nodeId}".`)
    else {
      if (reference.source === 'nqc' && target.kind !== 'agent') errors.push(`Condition node "${node.id}" uses an NQC path that does not reference an agent node.`)
      if (!canReach(reference.nodeId, node.id, outgoing)) errors.push(`Condition node "${node.id}" may only reference an earlier step that connects to it.`)
    }
  }
  if (entry && !allReachable(entry.id, nodes, outgoing)) errors.push('Every workflow node must be reachable from the trigger.')

  return { valid: errors.length === 0, errors, topologicalOrder }
}

function validateNodeConfig(node: WorkflowNode, errors: string[]) {
  const config = node.config ?? {}
  if (node.kind === 'agent' && config.evaluationRequired !== true) {
    errors.push(`Agent node "${node.id}" must require Quicksilver Engine evaluation.`)
  }
  if (node.kind === 'agent' && (typeof config.agentId !== 'string' || !config.agentId.trim())) {
    errors.push(`Agent node "${node.id}" must include an agent id.`)
  }
  if (node.kind === 'condition' && (typeof config.conditionExpression !== 'string' || !config.conditionExpression.trim())) {
    errors.push(`Condition node "${node.id}" must include a condition expression.`)
  }
  if (node.kind === 'condition' && typeof config.conditionExpression === 'string' && config.conditionExpression.trim()) {
    const error = validateWorkflowConditionExpression(config.conditionExpression)
    if (error) errors.push(`Condition node "${node.id}" has an invalid expression: ${error}`)
  }
  if (node.kind === 'tool' && (typeof config.toolId !== 'string' || !config.toolId.trim())) {
    errors.push(`Tool node "${node.id}" must include a tool id.`)
  }
  if (node.kind === 'tool' && config.sideEffect && !config.supervisorApprovalRequired) {
    errors.push(`Side-effect tool node "${node.id}" must require supervisor approval.`)
  }
  if (node.kind === 'tool' && config.sideEffect && config.evaluationRequired !== true) {
    errors.push(`Side-effect tool node "${node.id}" must require evaluation.`)
  }
  if (config.impact !== undefined && !['low', 'moderate', 'high', 'critical'].includes(config.impact)) errors.push(`Node "${node.id}" has an invalid impact level.`)
  if ((config.impact === 'high' || config.impact === 'critical') && config.evaluationRequired !== true) {
    errors.push(`High-impact node "${node.id}" must require evaluation.`)
  }
  if ((config.impact === 'high' || config.impact === 'critical') && config.supervisorApprovalRequired !== true) {
    errors.push(`High-impact node "${node.id}" must require supervisor approval.`)
  }
  if (config.maxAttempts !== undefined && node.kind !== 'agent') {
    errors.push(`Node "${node.id}" maxAttempts is only supported for agent nodes; tools are never retried automatically.`)
  } else if (config.maxAttempts !== undefined && (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 10)) {
    errors.push(`Node "${node.id}" maxAttempts must be an integer from 1 to 10.`)
  }
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 300_000)) {
    errors.push(`Node "${node.id}" timeoutMs must be between 1 and 300000.`)
  }
}

function topologicalSort(
  nodes: Map<string, WorkflowNode>,
  outgoing: Map<string, WorkflowEdge[]>,
  incoming: Map<string, WorkflowEdge[]>,
): string[] {
  const remaining = new Map([...nodes.keys()].map((id) => [id, incoming.get(id)?.length ?? 0]))
  const ready = [...remaining].filter(([, degree]) => degree === 0).map(([id]) => id).sort()
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)
    for (const edge of outgoing.get(id) ?? []) {
      const degree = (remaining.get(edge.to) ?? 0) - 1
      remaining.set(edge.to, degree)
      if (degree === 0) {
        ready.push(edge.to)
        ready.sort()
      }
    }
  }
  return order
}

function allReachable(
  entryId: string,
  nodes: Map<string, WorkflowNode>,
  outgoing: Map<string, WorkflowEdge[]>,
): boolean {
  const reached = new Set<string>()
  const pending = [entryId]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (reached.has(id)) continue
    reached.add(id)
    for (const edge of outgoing.get(id) ?? []) pending.push(edge.to)
  }
  return reached.size === nodes.size
}

function canReach(from: string, to: string, outgoing: Map<string, WorkflowEdge[]>): boolean {
  if (from === to) return false
  const reached = new Set<string>()
  const pending = [from]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (reached.has(id)) continue
    reached.add(id)
    for (const edge of outgoing.get(id) ?? []) {
      if (edge.to === to) return true
      pending.push(edge.to)
    }
  }
  return false
}
