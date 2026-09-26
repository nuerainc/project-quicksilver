/** Shadow-stage agent grounding (no model call). */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createIntent } from '@quicksilver/aura'

import { graphFacts, groundProposals } from './shadow-agent.ts'

test('proposals keep only citations that exist in the graph; uncited proposals are dropped', async () => {
  const { graph } = await createIntent('We run a feed store with a $2,000 budget. Help us understand our margins.', { requestedBy: 'entity-founder', id: 'intent-t' })
  const facts = graphFacts(graph)
  assert.ok(facts.length > 0)
  const real = facts[0]!.id
  const base = { department: 'finance', description: 'Review margins by product line.', reversible: true, operationalImpact: 1, uncertainty: 2, financialExposure: null, customerFacing: false }
  const out = groundProposals(graph, [
    { ...base, evidenceIds: [real, 'made-up-fact'] },
    { ...base, description: 'Invented', evidenceIds: ['made-up-fact'] },
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0]!.evidence.map((e) => e.id), [real])
  assert.equal('financialExposure' in out[0]!, false)
})
