import { defineType, defineField } from 'sanity'

/**
 * Aura's verdict learner for one intent (M4, see packages/aura/src/learn.ts
 * and packages/host/src/shadow-store-sanity.ts): what Aura has inferred from
 * the owner's shadow verdicts. Provenance is always AGENT_INFERRED; it
 * informs predictions and never grants authority. Written by the host only.
 * Id: "aura-verdict-learner.<intentId>".
 */
export default defineType({
  name: 'auraVerdictLearner',
  title: 'Aura verdict learner',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'intentId', type: 'string' }),
    defineField({ name: 'provenance', type: 'string', options: { list: ['AGENT_INFERRED'] } }),
    defineField({ name: 'observations', type: 'number', description: 'Verdicts learned from.' }),
    defineField({ name: 'weightsJson', type: 'text' }),
    defineField({ name: 'stateJson', type: 'text', description: 'The full learner state as Aura uses it.' }),
  ],
  preview: {
    select: { intent: 'intentId', n: 'observations' },
    prepare: ({ intent, n }) => ({ title: `Verdict learner · ${intent ?? '?'}`, subtitle: `${n ?? 0} observation(s) · AGENT_INFERRED` }),
  },
})
