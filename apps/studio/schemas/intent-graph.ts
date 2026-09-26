import { defineType, defineField } from 'sanity'

/**
 * An Aura intent graph: an objective, its provenance-tagged variables and the
 * edges between them (see packages/aura). Written by Aura; values that a
 * provider stated change only through Aura's governed updates, so the
 * document is read-only here.
 */
export default defineType({
  name: 'intentGraph',
  title: 'Intent graph',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'graphId', type: 'string' }),
    defineField({ name: 'objective', type: 'text' }),
    defineField({ name: 'mode', type: 'string', options: { list: ['genesis', 'onboard', 'operate'] } }),
    defineField({ name: 'autonomyDepth', type: 'string', options: { list: ['advise', 'propose', 'act-with-approval', 'act-within-limits'] } }),
    defineField({ name: 'requestedBy', type: 'string' }),
    defineField({ name: 'createdAt', type: 'datetime' }),
    defineField({
      name: 'variables',
      type: 'array',
      of: [{
        type: 'object',
        name: 'graphVariable',
        fields: [
          defineField({ name: 'id', type: 'string' }),
          defineField({ name: 'label', type: 'string' }),
          defineField({ name: 'kind', type: 'string', options: { list: ['goal', 'constraint', 'metric', 'assumption', 'unknown'] } }),
          defineField({ name: 'valueJson', type: 'string' }),
          defineField({ name: 'unit', type: 'string' }),
          defineField({ name: 'provenance', type: 'string', options: { list: ['HUMAN_SPECIFIED', 'SYSTEM_CONSTRAINT', 'OBSERVED', 'AGENT_INFERRED'] } }),
          defineField({ name: 'confidence', type: 'number' }),
          defineField({ name: 'importance', type: 'number' }),
          defineField({ name: 'sourcesJson', type: 'text' }),
          defineField({ name: 'explanation', type: 'text' }),
          defineField({ name: 'updatedAt', type: 'datetime' }),
          defineField({ name: 'updatedBy', type: 'string' }),
        ],
        preview: { select: { title: 'label', subtitle: 'provenance' } },
      }],
    }),
    defineField({
      name: 'edges',
      type: 'array',
      of: [{
        type: 'object',
        name: 'decisionEdge',
        fields: [
          defineField({ name: 'from', type: 'string' }),
          defineField({ name: 'to', type: 'string' }),
          defineField({ name: 'relation', type: 'string', options: { list: ['depends-on', 'constrains', 'informs'] } }),
        ],
      }],
    }),
    defineField({ name: 'historyJson', type: 'text', description: 'Append-only record of accepted belief changes.' }),
    defineField({ name: 'questionFeedbackJson', type: 'text', readOnly: true, description: 'What the provider did with the questions Aura asked: answered, or marked not worth asking (append-only).' }),
  ],
  preview: {
    select: { title: 'objective', mode: 'mode', by: 'requestedBy' },
    prepare: ({ title, mode, by }) => ({ title: title ?? '(no objective)', subtitle: `${mode ?? 'mode unknown'} · ${by ?? '?'}` }),
  },
})
