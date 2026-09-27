/** Deterministic cycle finding for small directed graphs. Pure; no LLM. */

export interface GraphCycle {
  /** Every node in the strongly connected component, in `ids` order. */
  members: string[]
  /** One closed path through the component, e.g. `['a', 'b', 'a']`. */
  path: string[]
}

/**
 * Deterministic cycle finding for small directed graphs (policy supersession,
 * capability inheritance and dependencies). Pure; no LLM.
 *
 * Returns one entry per strongly connected component that contains a cycle
 * (two or more nodes, or a node with an edge to itself): all its members, and
 * a closed path starting and ending at the component's first node in `ids`
 * order, e.g. `['a', 'b', 'c', 'a']`. Edges to ids not in `ids` are ignored.
 */
export function findCycles(ids: string[], edges: (id: string) => string[]): GraphCycle[] {
  const known = new Set(ids)
  const next = (id: string) => [...new Set(edges(id))].filter((n) => known.has(n))

  // Tarjan's algorithm (recursive; these graphs are small).
  let index = 0
  const indexOf = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []

  const visit = (v: string) => {
    indexOf.set(v, index)
    low.set(v, index)
    index += 1
    stack.push(v)
    onStack.add(v)
    for (const w of next(v)) {
      if (!indexOf.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indexOf.get(w)!))
      }
    }
    if (low.get(v) === indexOf.get(v)) {
      const component: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        component.push(w)
      } while (w !== v)
      components.push(component)
    }
  }
  for (const id of ids) if (!indexOf.has(id)) visit(id)

  const order = new Map(ids.map((id, i) => [id, i]))
  const cycles: GraphCycle[] = []
  for (const component of components) {
    const members = new Set(component)
    const start = [...component].sort((a, b) => order.get(a)! - order.get(b)!)[0]!
    if (component.length === 1 && !next(start).includes(start)) continue
    // Shortest path back to `start` inside the component (BFS, neighbors in `ids` order).
    const parent = new Map<string, string>()
    const queue = [start]
    let closing: string | undefined
    while (queue.length > 0 && closing === undefined) {
      const v = queue.shift()!
      for (const w of next(v).sort((a, b) => order.get(a)! - order.get(b)!)) {
        if (!members.has(w)) continue
        if (w === start) { closing = v; break }
        if (!parent.has(w)) { parent.set(w, v); queue.push(w) }
      }
    }
    const path = [start]
    for (let v = closing!; v !== start; v = parent.get(v)!) path.splice(1, 0, v)
    path.push(start)
    cycles.push({ members: [...component].sort((a, b) => order.get(a)! - order.get(b)!), path })
  }
  return cycles.sort((a, b) => order.get(a.path[0]!)! - order.get(b.path[0]!)!)
}
