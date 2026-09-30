import type { WorkflowEdge, WorkflowNode } from '../../../packages/kernel/src/workflows/graph.ts'

export interface WorkflowLayout {
  positions: Map<string, { x: number; y: number }>
  width: number
  height: number
}

/** Deterministic left-to-right layout for the workflow editor's graph map. */
export function graphLayout(graphNodes: WorkflowNode[], graphEdges: WorkflowEdge[]): WorkflowLayout {
  const depths = new Map<string, number>()
  const entryId = graphNodes.find((node) => node.kind === 'trigger')?.id
  if (entryId) depths.set(entryId, 0)
  for (let pass = 0; pass < graphNodes.length; pass += 1) {
    let changed = false
    for (const edge of graphEdges) {
      const sourceDepth = depths.get(edge.from)
      if (sourceDepth === undefined) continue
      const nextDepth = Math.min(sourceDepth + 1, graphNodes.length - 1)
      if ((depths.get(edge.to) ?? -1) < nextDepth) {
        depths.set(edge.to, nextDepth)
        changed = true
      }
    }
    if (!changed) break
  }
  for (const node of graphNodes) if (!depths.has(node.id)) depths.set(node.id, 0)

  const layers = new Map<number, WorkflowNode[]>()
  for (const node of graphNodes) {
    const depth = depths.get(node.id) ?? 0
    layers.set(depth, [...(layers.get(depth) ?? []), node])
  }
  const positions = new Map<string, { x: number; y: number }>()
  let maxRows = 1
  for (const [depth, layer] of layers) {
    maxRows = Math.max(maxRows, layer.length)
    layer.forEach((node, row) => positions.set(node.id, { x: 32 + depth * 230, y: 24 + row * 88 }))
  }
  const maxDepth = Math.max(0, ...layers.keys())
  return { positions, width: 64 + (maxDepth + 1) * 230, height: 48 + maxRows * 88 }
}
