import { defineType, defineField } from 'sanity'

/**
 * Durable Quicksilver Engine evaluation for a governed agent call that isn't a
 * plan decision (query runs, live workflow steps). No private reasoning is stored.
 */
export default defineType({
  name: 'evaluationRecord',
  title: 'Evaluation record',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'source', type: 'string', options: { list: ['query', 'workflow-run'] } }),
    defineField({ name: 'agentId', type: 'string' }),
    defineField({ name: 'taskType', type: 'string' }),
    defineField({ name: 'modelId', type: 'string' }),
    defineField({ name: 'subject', type: 'text', description: 'The question or workflow input (truncated to 2,000 characters).' }),
    defineField({ name: 'requestedBy', type: 'string' }),
    defineField({ name: 'runId', type: 'string' }),
    defineField({ name: 'nodeId', type: 'string' }),
    defineField({ name: 'reasoningScore', type: 'number' }),
    defineField({ name: 'hallucinationRisk', type: 'string' }),
    defineField({ name: 'brittleness', type: 'string' }),
    defineField({ name: 'safetyDecision', type: 'string', options: { list: ['ALLOW', 'ESCALATE', 'BLOCK'] } }),
    defineField({ name: 'issues', type: 'array', of: [{ type: 'string' }] }),
    defineField({ name: 'corrections', type: 'array', of: [{ type: 'string' }] }),
    defineField({ name: 'createdAt', type: 'datetime' }),
  ],
  preview: {
    select: { title: 'subject', source: 'source', decision: 'safetyDecision', score: 'reasoningScore' },
    prepare: ({ title, source, decision, score }) => ({ title: title ?? '(no subject)', subtitle: `${source ?? '?'} · ${decision ?? '?'} · score ${score ?? '?'}` }),
  },
})
