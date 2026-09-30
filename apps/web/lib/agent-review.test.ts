import assert from 'node:assert/strict'
import { test } from 'node:test'

import { agentReviewNoteProblem } from './agent-review.ts'

test('agent review rationale matches the API length bounds and ignores surrounding whitespace', () => {
  assert.match(agentReviewNoteProblem('short') ?? '', /at least 10/)
  assert.equal(agentReviewNoteProblem(`  ${'a'.repeat(10)}  `), null)
  assert.equal(agentReviewNoteProblem('a'.repeat(500)), null)
  assert.match(agentReviewNoteProblem('a'.repeat(501)) ?? '', /500 characters/)
})
