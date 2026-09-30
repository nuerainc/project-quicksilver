import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDedicatedSanityProjectId } from './sanity-config.ts'

test('dedicated Sanity project guard rejects missing and legacy challenge project ids', () => {
  const original = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
  try {
    delete process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
    assert.throws(() => getDedicatedSanityProjectId(), /dedicated Nuera Quicksilver Sanity project/)
    process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = 'd280bqjc'
    assert.throws(() => getDedicatedSanityProjectId(), /Legacy challenge access is blocked/)
    process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = 'f87t11g1'
    assert.equal(getDedicatedSanityProjectId(), 'f87t11g1')
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
    else process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = original
  }
})
