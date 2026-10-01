import { defineField, defineType } from 'sanity'

/** Revocable browser session. The only credential stored is its SHA-256 digest. */
export default defineType({
  name: 'oidcWebSession',
  title: 'OIDC browser session',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'tokenDigest', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'identity', type: 'object', fields: [
      defineField({ name: 'issuer', type: 'url', validation: (rule) => rule.required() }),
      defineField({ name: 'subject', type: 'string', validation: (rule) => rule.required() }),
    ], validation: (rule) => rule.required() }),
    defineField({ name: 'principal', type: 'object', fields: [
      defineField({ name: 'id', type: 'string', validation: (rule) => rule.required() }),
      defineField({ name: 'kind', type: 'string', options: { list: ['human'] }, validation: (rule) => rule.required() }),
      defineField({ name: 'tenantId', type: 'string', validation: (rule) => rule.required() }),
      defineField({ name: 'roles', type: 'array', of: [{ type: 'string' }], validation: (rule) => rule.required() }),
      defineField({ name: 'displayName', type: 'string' }),
    ], validation: (rule) => rule.required() }),
    defineField({ name: 'createdAt', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'expiresAt', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'revokedAt', type: 'datetime' }),
  ],
  preview: { select: { principalId: 'principal.id', tenantId: 'principal.tenantId', expiresAt: 'expiresAt' }, prepare: ({ principalId, tenantId, expiresAt }) => ({ title: `Browser session • ${principalId ?? '?'}`, subtitle: `${tenantId ?? '?'} • expires ${expiresAt ?? '?'}` }) },
})
