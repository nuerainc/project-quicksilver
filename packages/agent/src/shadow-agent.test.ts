/** Shadow-stage agent grounding (no model call). */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createIntent } from '@quicksilver/aura'

import { buildShadowPrompt, graphFacts, groundProposals } from './shadow-agent.ts'

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

test('the owner\'s stated principles go into the prompt; without them the prompt is unchanged', async () => {
  const { graph } = await createIntent('We run a feed store with a $2,000 budget. Help us understand our margins.', { requestedBy: 'entity-founder', id: 'intent-p' })
  const facts = graphFacts(graph)
  const plain = buildShadowPrompt({ graph, departments: ['finance'], max: 3 })
  assert.equal(plain, [
    `The owner's objective (data): ${JSON.stringify(graph.objective)}`,
    'Departments to cover: finance. At most 3 proposals in total.',
    'Facts (id: text):',
    ...facts.map((f) => `- ${f.id}: ${f.text}`),
  ].join('\n'))
  assert.equal(buildShadowPrompt({ graph, departments: ['finance'], max: 3, principles: [] }), plain)
  const withRules = buildShadowPrompt({ graph, departments: ['finance'], max: 3, principles: ['When two goals conflict, take the smaller or test version first.', '  ', 'x'.repeat(600)] })
  assert.match(withRules, /The owner's stated decision principles, in their own words/)
  assert.ok(withRules.includes('- When two goals conflict, take the smaller or test version first.\n'))
  assert.ok(withRules.includes(`- ${'x'.repeat(500)}\n`) && !withRules.includes('x'.repeat(501)))
  assert.ok(withRules.indexOf('decision principles') < withRules.indexOf('Facts (id: text):'))
})
