import { defineArrayMember, defineField, defineType } from 'sanity'
import { validateWorkflowGraph, type WorkflowGraph } from '../../../packages/kernel/src/workflows/graph.ts'

const graphNode = defineArrayMember({
  name: 'automationNode',
  type: 'object',
  fields: [
    defineField({ name: 'id', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'kind', type: 'string', options: { list: ['trigger', 'agent', 'tool', 'condition', 'output'] }, validation: (rule) => rule.required() }),
    defineField({ name: 'label', type: 'string', validation: (rule) => rule.required() }),
    defineField({
      name: 'config',
      type: 'object',
      fields: [
        { name: 'agentId', type: 'string' },
        { name: 'toolId', type: 'string' },
        { name: 'conditionExpression', type: 'text', rows: 2 },
        { name: 'impact', type: 'string', options: { list: ['low', 'moderate', 'high', 'critical'] } },
        { name: 'evaluationRequired', type: 'boolean' },
        { name: 'sideEffect', type: 'boolean' },
        { name: 'supervisorApprovalRequired', type: 'boolean' },
        { name: 'maxAttempts', type: 'number', validation: (rule) => rule.integer().min(1).max(10) },
        { name: 'timeoutMs', type: 'number', validation: (rule) => rule.integer().min(1).max(300000) },
      ],
    }),
  ],
  preview: {
    select: { id: 'id', kind: 'kind', label: 'label' },
    prepare: ({ id, kind, label }) => ({ title: label ?? id ?? 'Workflow step', subtitle: kind ?? 'untyped step' }),
  },
})

const graphEdge = defineArrayMember({
  name: 'automationEdge',
  type: 'object',
  fields: [
    defineField({ name: 'id', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'from', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'to', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'branch', type: 'string', options: { list: ['true', 'false'] } }),
  ],
  preview: {
    select: { from: 'from', to: 'to', branch: 'branch' },
    prepare: ({ from, to, branch }) => ({ title: `${from ?? '?'} → ${to ?? '?'}`, subtitle: branch ? `branch: ${branch}` : 'unbranched' }),
  },
})

export default defineType({
  name: 'automationWorkflow',
  title: 'Automation workflow',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'graphId', type: 'string', description: 'Stable workflow identifier used by the platform API.', validation: (rule) => rule.required().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/) }),
    defineField({ name: 'schemaVersion', type: 'number', initialValue: 1, readOnly: true, validation: (rule) => rule.required().integer().min(1).max(1) }),
    defineField({ name: 'version', type: 'number', validation: (rule) => rule.required().integer().min(1) }),
    defineField({ name: 'lifecycle', type: 'string', options: { list: ['draft', 'review', 'active', 'archived'] }, initialValue: 'draft', validation: (rule) => rule.required() }),
    defineField({ name: 'entryNodeId', type: 'string', description: 'The trigger node that starts this workflow.', validation: (rule) => rule.required() }),
    defineField({ name: 'nodes', type: 'array', of: [graphNode], validation: (rule) => rule.required().min(1).max(500) }),
    defineField({ name: 'edges', type: 'array', of: [graphEdge], validation: (rule) => rule.required().max(1000) }),
  ],
  validation: (rule) => rule.custom((document) => {
    if (!document || typeof document !== 'object') return true
    const graph = document as Record<string, unknown>
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return true
    const validation = validateWorkflowGraph({
      schemaVersion: Number(graph.schemaVersion) as 1,
      id: String(graph.graphId ?? ''),
      version: Number(graph.version),
      entryNodeId: String(graph.entryNodeId ?? ''),
      nodes: graph.nodes.map((node) => {
        if (!node || typeof node !== 'object') return node
        const { _key: _ignored, ...fields } = node as Record<string, unknown>
        return fields
      }) as WorkflowGraph['nodes'],
      edges: graph.edges.map((edge) => {
        if (!edge || typeof edge !== 'object') return edge
        const { _key: _ignored, ...fields } = edge as Record<string, unknown>
        return fields
      }) as WorkflowGraph['edges'],
    })
    return validation.valid || validation.errors.join(' ')
  }),
  preview: {
    select: { name: 'name', graphId: 'graphId', version: 'version', lifecycle: 'lifecycle' },
    prepare: ({ name, graphId, version, lifecycle }) => ({
      title: name ?? graphId ?? 'Untitled workflow',
      subtitle: `v${version ?? '?'} · ${lifecycle ?? 'draft'}`,
    }),
  },
})
