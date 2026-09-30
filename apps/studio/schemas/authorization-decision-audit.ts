import { defineField, defineType } from 'sanity'

/** Immutable record of an API authorization decision. Never store credentials or request bodies here. */
export default defineType({
  name: 'authorizationDecisionAudit',
  title: 'Authorization decision audit',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'tenantId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'route', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'permissions', type: 'array', of: [{ type: 'string' }], validation: (rule) => rule.required() }),
    defineField({ name: 'actorId', type: 'string' }),
    defineField({ name: 'outcome', type: 'string', options: { list: ['allow', 'deny'] }, validation: (rule) => rule.required() }),
    defineField({ name: 'httpStatus', type: 'number', validation: (rule) => rule.required().integer() }),
    defineField({ name: 'at', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'decisionCode', type: 'string', validation: (rule) => rule.required() }),
  ],
  preview: { select: { route: 'route', outcome: 'outcome', actorId: 'actorId', at: 'at' }, prepare: ({ route, outcome, actorId, at }) => ({ title: `${outcome ?? 'decision'} · ${route ?? '?'}`, subtitle: `${actorId ?? 'unknown'} · ${at ?? ''}` }) },
})
