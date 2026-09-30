import { defineField, defineType } from 'sanity'
import { validateAgentManifest, type AgentManifest } from '../../../packages/kernel/src/agents/registry.ts'

/** Versioned declarative agent contract. It is metadata only; no user code executes. */
export default defineType({
  name: 'agentDefinition',
  title: 'Nuera Quicksilver agent definition',
  type: 'document',
  fields: [
    defineField({ name: 'tenantId', type: 'string', readOnly: true, validation: (rule) => rule.required() }),
    defineField({ name: 'agentId', type: 'string', readOnly: true, validation: (rule) => rule.required().regex(/^nuera-quicksilver:[a-z][a-z0-9-]{0,62}$/) }),
    defineField({ name: 'displayName', type: 'string', validation: (rule) => rule.required().min(2).max(100) }),
    defineField({ name: 'description', type: 'text', rows: 3, validation: (rule) => rule.required().min(10).max(1000) }),
    defineField({ name: 'version', type: 'number', validation: (rule) => rule.required().integer().min(1) }),
    defineField({ name: 'lifecycle', type: 'string', options: { list: ['draft', 'review', 'active', 'archived'] }, initialValue: 'draft', validation: (rule) => rule.required() }),
    defineField({ name: 'manifest', type: 'object', fields: [
      { name: 'id', type: 'string', validation: (rule) => rule.required() },
      { name: 'version', type: 'number', validation: (rule) => rule.required().integer().min(1) },
      { name: 'authority', type: 'string', options: { list: ['propose', 'review'] }, validation: (rule) => rule.required() },
      { name: 'tasks', type: 'array', of: [{ type: 'string' }], validation: (rule) => rule.required().min(1) },
      { name: 'maximumImpact', type: 'string', options: { list: ['low', 'moderate', 'high', 'critical'] }, validation: (rule) => rule.required() },
      { name: 'requiresEvaluation', type: 'boolean', validation: (rule) => rule.required() },
    ], validation: (rule) => rule.required() }),
    defineField({ name: 'definitionDigest', type: 'string', readOnly: true, validation: (rule) => rule.required() }),
    defineField({ name: 'authoredBy', type: 'string', readOnly: true, validation: (rule) => rule.required() }),
    defineField({ name: 'createdAt', type: 'datetime', readOnly: true, validation: (rule) => rule.required() }),
    defineField({ name: 'reviewedBy', type: 'string', readOnly: true }),
    defineField({ name: 'reviewNote', type: 'text', rows: 3, readOnly: true }),
    defineField({ name: 'reviewedAt', type: 'datetime', readOnly: true }),
    defineField({ name: 'publishedAt', type: 'datetime', readOnly: true }),
  ],
  validation: (rule) => rule.custom((document) => {
    if (!document || typeof document !== 'object') return true
    const value = document as { agentId?: unknown; manifest?: unknown }
    if (!value.manifest || typeof value.manifest !== 'object') return true
    const manifest = value.manifest as AgentManifest
    const errors = validateAgentManifest(manifest)
    if (typeof value.agentId === 'string' && manifest.id !== value.agentId) errors.push('agentId must match manifest.id.')
    return errors.length ? errors.join(' ') : true
  }),
  preview: { select: { name: 'displayName', id: 'agentId', version: 'version', lifecycle: 'lifecycle' }, prepare: ({ name, id, version, lifecycle }) => ({ title: name ?? id ?? 'Agent', subtitle: `v${version ?? '?'} · ${lifecycle ?? 'draft'}` }) },
})
