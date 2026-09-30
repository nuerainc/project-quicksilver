import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { WorkflowEdge, WorkflowNode } from '../../../packages/kernel/src/workflows/graph.ts'
import { graphLayout } from './workflow-layout.ts'

const nodes: WorkflowNode[] = [
  { id: 'start', kind: 'trigger', label: 'Start' },
  { id: 'decide', kind: 'condition', label: 'Choose path' },
  { id: 'yes', kind: 'agent', label: 'Yes' },
  { id: 'no', kind: 'tool', label: 'No' },
  { id: 'finish', kind: 'output', label: 'Finish' },
  { id: 'orphan', kind: 'agent', label: 'Disconnected' },
]
const edges: WorkflowEdge[] = [
  { id: 'e1', from: 'start', to: 'decide' },
  { id: 'e2', from: 'decide', to: 'yes', branch: 'true' },
  { id: 'e3', from: 'decide', to: 'no', branch: 'false' },
  { id: 'e4', from: 'yes', to: 'finish' },
  { id: 'e5', from: 'no', to: 'finish' },
]

test('workflow graph map lays out branches and merges deterministically without overlap', () => {
  const layout = graphLayout(nodes, edges)
  assert.deepEqual([...layout.positions.keys()].sort(), nodes.map((node) => node.id).sort())
  assert.deepEqual(layout.positions.get('start'), { x: 32, y: 24 })
  assert.deepEqual(layout.positions.get('decide'), { x: 262, y: 24 })
  assert.deepEqual(layout.positions.get('yes'), { x: 492, y: 24 })
  assert.deepEqual(layout.positions.get('no'), { x: 492, y: 112 })
  assert.deepEqual(layout.positions.get('finish'), { x: 722, y: 24 })
  assert.deepEqual(layout.positions.get('orphan'), { x: 32, y: 112 })
  const coordinates = [...layout.positions.values()].map(({ x, y }) => `${x},${y}`)
  assert.equal(new Set(coordinates).size, nodes.length, 'each node should occupy a unique map cell')

  for (const edge of edges) {
    const from = layout.positions.get(edge.from)!
    const to = layout.positions.get(edge.to)!
    assert.ok(to.x > from.x, `${edge.id} should point to a later column`)
  }
  assert.equal(layout.width, 984)
  assert.equal(layout.height, 224)
  assert.deepEqual(graphLayout(nodes, edges), layout)
})

test('workflow graph map handles an empty draft with finite minimum canvas dimensions', () => {
  const layout = graphLayout([], [])
  assert.equal(layout.positions.size, 0)
  assert.equal(layout.width, 294)
  assert.equal(layout.height, 136)
})

test('workflow editor keeps the visual map available in a responsive full-width canvas', () => {
  const page = readFileSync(new URL('../app/workflows/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /<section aria-label="Workflow graph" className="qs-panel">/)
  assert.match(page, /flex h-\[min\(56svh,44rem\)\] min-h-32 w-full items-center justify-center overflow-hidden/)
  assert.match(page, /role="img" aria-label=\{`Workflow diagram with \$\{nodes\.length\} steps and \$\{edges\.length\} connections`\}/)
  assert.match(page, /preserveAspectRatio="xMidYMid meet"/)
  assert.match(page, /<h3 className="mt-1 text-base font-semibold text-quicksilver-signal">Step settings<\/h3>/)
})
