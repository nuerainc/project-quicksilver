import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatRequest } from './chat-request.ts'

test('Ask mode uses the read-only chat assistant, which reads the app as the person asking', () => {
  assert.deepEqual(chatRequest('ask', 'Which policy applies?'), {
    path: '/api/chat', body: { message: 'Which policy applies?' },
  })
})

test('Ask mode sends the last six turns as history', () => {
  const turns = Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }))
  const request = chatRequest('ask', 'And now?', 'auto', [], turns)
  assert.equal(request.path, '/api/chat')
  assert.deepEqual((request.body as { history: unknown[] }).history, turns.slice(-6))
})

test('Plan mode creates a governed proposal through the existing planning contract', () => {
  assert.deepEqual(chatRequest('plan', 'Improve delivery reliability.'), {
    path: '/api/plan', body: { objective: 'Improve delivery reliability.' },
  })
})

test('Work mode dispatches to the explicitly selected business specialist', () => {
  assert.deepEqual(chatRequest('agent', 'Find the cause of delivery delays.', 'fulfillment'), {
    path: '/api/agents/run', body: { objective: 'Find the cause of delivery delays.', agentKey: 'fulfillment' },
  })
})

test('Work mode defaults to transparent server-side specialist routing', () => {
  assert.deepEqual(chatRequest('agent', 'Please review our market.'), {
    path: '/api/agents/run', body: { objective: 'Please review our market.', agentKey: 'auto' },
  })
})

test('Work mode forwards prior conversation context with the current objective', () => {
  const context = ['Prior user request (context only): revise launch plan']
  assert.deepEqual(chatRequest('agent', 'Make the timeline shorter', 'research', context), {
    path: '/api/agents/run',
    body: { objective: 'Make the timeline shorter', agentKey: 'research', context },
  })
})
