import { test } from 'node:test'
import assert from 'node:assert/strict'

import { InMemoryWorkflowPublicationStore, workflowDigest } from './publication.ts'
import type { WorkflowGraph } from './graph.ts'

const graph = (version: number): WorkflowGraph => ({
  schemaVersion: 1, id: 'brief', version, entryNodeId: 'start',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start' },
    { id: 'ask', kind: 'agent', label: 'Ask', config: { agentId: 'query', evaluationRequired: true } },
    { id: 'done', kind: 'output', label: 'Done' },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'ask' }, { id: 'e2', from: 'ask', to: 'done' }],
})

const author = { id: 'human-author', kind: 'human' as const, canPublish: true }
const reviewer = { id: 'human-reviewer', kind: 'human' as const, canPublish: true }
const publisher = { id: 'human-publisher', kind: 'human' as const, canPublish: true }
const agent = { id: 'agent-supervisor', kind: 'agent' as const, canPublish: false }

test('Publication: invalid or duplicate drafts are refused and the digest pins the graph', () => {
  const store = new InMemoryWorkflowPublicationStore()
  const draft = store.createDraft(graph(1), author, 100)
  assert.equal(draft.status, 'draft')
  assert.equal(draft.digest, workflowDigest(graph(1)))
  const changed = graph(1)
  changed.nodes[1]!.label = 'Changed'
  assert.notEqual(draft.digest, workflowDigest(changed))
  assert.throws(() => store.createDraft(graph(1), author), /already exists/)
  assert.throws(() => store.createDraft({ ...graph(2), nodes: [] }, author), /invalid/)
})

test('Publication: author cannot self-review or publish without independent review', () => {
  const store = new InMemoryWorkflowPublicationStore()
  store.createDraft(graph(1), author, 100)
  store.submitForReview('brief', 1, author, 110)
  assert.throws(() => store.review('brief', 1, author, 120), /cannot review/)
  assert.throws(() => store.publish('brief', 1, author, 120), /independently reviewed/)
  assert.throws(() => store.review('brief', 1, agent, 120), /human with workflow:publish/)
})

test('Publication: review, publish, deprecation and rollback are digest-audited', () => {
  const store = new InMemoryWorkflowPublicationStore()
  store.createDraft(graph(1), author, 100)
  store.submitForReview('brief', 1, author, 110)
  store.review('brief', 1, reviewer, 120)
  const first = store.publish('brief', 1, publisher, 130)
  assert.equal(first.status, 'published')

  store.createDraft(graph(2), author, 140)
  store.submitForReview('brief', 2, author, 150)
  store.review('brief', 2, reviewer, 160)
  const second = store.publish('brief', 2, publisher, 170)
  assert.equal(second.status, 'published')
  assert.equal(store.snapshot().versions.find((version) => version.version === 1)?.status, 'deprecated')
  assert.equal(store.getPublished('brief')?.version, 2)

  const restored = store.rollback('brief', 1, publisher, 180)
  assert.equal(restored.status, 'published')
  assert.equal(store.getPublished('brief')?.digest, workflowDigest(graph(1)))
  assert.deepEqual(store.snapshot().audit.map((entry) => entry.event), [
    'draft-created', 'submitted-for-review', 'published', 'draft-created', 'submitted-for-review', 'published', 'rolled-back',
  ])
})
