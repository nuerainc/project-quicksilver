import { defineField, defineType } from 'sanity'

/** Short-lived server-side OIDC state; PKCE material expires after ten minutes. */
export default defineType({
  name: 'oidcLoginTransaction',
  title: 'OIDC login transaction',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'stateDigest', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'browserBindingDigest', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'nonce', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'codeVerifier', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'returnTo', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'createdAt', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'expiresAt', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'consumedAt', type: 'datetime' }),
  ],
  preview: { select: { createdAt: 'createdAt', expiresAt: 'expiresAt' }, prepare: ({ createdAt, expiresAt }) => ({ title: 'Short-lived OIDC transaction', subtitle: `${createdAt ?? '?'} • expires ${expiresAt ?? '?'}` }) },
})
