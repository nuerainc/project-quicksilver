import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatRequest } from './chat-request.ts'

test('Ask mode uses the read-only company query contract', () => {
  assert.deepEqual(chatRequest('ask', 'Which policy applies?'), {
    path: '/api/query', body: { question: 'Which policy applies?' },
  })
})

test('Plan mode creates a governed proposal through the existing planning contract', () => {
  assert.deepEqual(chatRequest('plan', 'Improve delivery reliability.'), {
    path: '/api/plan', body: { objective: 'Improve delivery reliability.' },
  })
})
