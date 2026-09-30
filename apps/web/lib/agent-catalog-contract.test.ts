import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentManifest } from '@quicksilver/kernel'
import { AgentCatalogFault, agentDefinitionDigest, assertAgentDigest, assertCanPublish, assertCanReview, assertCanSubmit, assertHumanAgentActor, assertValidAgentDefinition } from './agent-catalog-contract.ts'

const manifest: AgentManifest = { id: 'nuera-quicksilver:compliance', version: 1, authority: 'propose', tasks: ['reasoning', 'evaluation'], maximumImpact: 'moderate', requiresEvaluation: true }
const rejected = (run: () => unknown, status: number) => assert.throws(run, (error: unknown) => error instanceof AgentCatalogFault && error.status === status)

test('agent definitions use the kernel manifest contract and protect built-in ids', () => {
  assert.doesNotThrow(() => assertValidAgentDefinition(manifest.id, manifest))
  rejected(() => assertValidAgentDefinition(manifest.id, { ...manifest, authority: 'approve' as AgentManifest['authority'] }), 400)
  rejected(() => assertValidAgentDefinition('nuera-quicksilver:other', manifest), 400)
  rejected(() => assertValidAgentDefinition('nuera-quicksilver:planner', { ...manifest, id: 'nuera-quicksilver:planner' }), 409)
  rejected(() => assertValidAgentDefinition(manifest.id, { ...manifest, tasks: ['reasoning', 'reasoning'] }), 400)
})

test('only a signed-in human may perform an agent lifecycle action', () => {
  assert.doesNotThrow(() => assertHumanAgentActor({ id: 'person-1', kind: 'human' }))
  for (const actor of [{ id: 'agent-1', kind: 'agent' }, { id: 'service-1', kind: 'service' }, { id: ' ', kind: 'human' }]) {
    rejected(() => assertHumanAgentActor(actor), 409)
  }
})

test('agent lifecycle enforces draft submission and an independent three-person release', () => {
  assert.doesNotThrow(() => assertCanSubmit('draft'))
  rejected(() => assertCanSubmit('published'), 409)
  assert.doesNotThrow(() => assertCanReview('in-review', 'reviewer', 'author'))
  rejected(() => assertCanReview('in-review', 'author', 'author'), 409)
  rejected(() => assertCanReview('in-review', 'reviewer', 'author', 'reviewer'), 409)
  assert.doesNotThrow(() => assertCanPublish('in-review', 'author', 'reviewer', 'publisher'))
  for (const publisher of ['author', 'reviewer']) rejected(() => assertCanPublish('in-review', 'author', 'reviewer', publisher), 409)
  rejected(() => assertCanPublish('in-review', 'author', undefined, 'publisher'), 409)
})

test('definition digests are key-order independent and reject stored-content changes', () => {
  const a = { displayName: 'Compliance Agent', description: 'Reviews governed compliance tasks.', manifest }
  const b = { manifest, description: a.description, displayName: a.displayName }
  const digest = agentDefinitionDigest(a)
  assert.equal(agentDefinitionDigest(b), digest)
  assert.doesNotThrow(() => assertAgentDigest(a, digest))
  rejected(() => assertAgentDigest({ ...a, description: 'Tampered definition.' }, digest), 409)
})
