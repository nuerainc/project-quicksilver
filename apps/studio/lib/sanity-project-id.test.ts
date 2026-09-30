import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dedicatedSanityProjectId } from './sanity-project-id.ts'

test('prefers the explicit Studio project id', () => {
  assert.equal(dedicatedSanityProjectId('studio-project', 'web-project'), 'studio-project')
})

test('falls back to the public project id when Studio id is not configured', () => {
  assert.equal(dedicatedSanityProjectId(undefined, 'dedicated-project'), 'dedicated-project')
  assert.equal(dedicatedSanityProjectId('  ', 'dedicated-project'), 'dedicated-project')
})

test('rejects a missing id and the legacy challenge project', () => {
  assert.throws(() => dedicatedSanityProjectId(undefined, undefined), /must identify the dedicated/)
  assert.throws(() => dedicatedSanityProjectId('d280bqjc', 'dedicated-project'), /legacy challenge access is blocked/)
  assert.throws(() => dedicatedSanityProjectId(undefined, 'd280bqjc'), /legacy challenge access is blocked/)
})
