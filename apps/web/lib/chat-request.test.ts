import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatTurnRequest, offerRequest, pageHint } from './chat-request.ts'

test('every turn goes to the read-only assistant, which reads the app as the person asking', () => {
  assert.deepEqual(chatTurnRequest('Which policy applies?'), { path: '/api/chat', body: { message: 'Which policy applies?' } })
})

test('a turn sends the last six turns as history and the page the person has open', () => {
  const turns = Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }))
  const request = chatTurnRequest('And now?', turns, '/decisions?id=d-1')
  assert.deepEqual(request.body.history, turns.slice(-6))
  assert.equal(request.body.page, '/decisions?id=d-1')
})

test('the page hint keeps a decision id and drops anything that is not a plain page of the app', () => {
  assert.equal(pageHint('/decisions', '?id=abc-123'), '/decisions?id=abc-123')
  assert.equal(pageHint('/workflows', '?id=abc'), '/workflows')
  assert.equal(pageHint('/monitoring/traces'), '/monitoring/traces')
  assert.equal(pageHint('/'), '/')
  assert.equal(pageHint('/decisions', '?id=' + encodeURIComponent('a b<script>')), '/decisions')
  assert.equal(pageHint('//evil.example'), undefined)
})

test('pressing a plan card creates a plan through the planning route with the text the person saw', () => {
  assert.deepEqual(offerRequest({ kind: 'plan', objective: 'x' }, 'Improve delivery reliability.'), { path: '/api/plan', body: { objective: 'Improve delivery reliability.' } })
})

test('pressing a specialist card asks that specialist, proposal only', () => {
  assert.deepEqual(offerRequest({ kind: 'specialist', agentKey: 'fulfillment', objective: 'x' }, 'Find the cause of delays.'), { path: '/api/agents/run', body: { objective: 'Find the cause of delays.', agentKey: 'fulfillment' } })
})

test('pressing a workflow card runs that published workflow through its own route', () => {
  assert.deepEqual(offerRequest({ kind: 'workflow', workflowId: 'wf-1', input: 'x' }, 'Run for Acme.'), { path: '/api/workflows/run', body: { workflowId: 'wf-1', input: 'Run for Acme.' } })
})
