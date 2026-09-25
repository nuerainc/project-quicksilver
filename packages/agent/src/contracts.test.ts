import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertAgentDispatch } from './governance.ts'
import { executeGovernedAgent, type NueraQuicksilverAgent } from './contracts.ts'
import { plannerQuicksilverAgent } from './planner.ts'
import { reviewerQuicksilverAgent } from './reviewer.ts'

test('planner and reviewer are registered for the dispatches the plan route makes', () => {
  assert.equal(plannerQuicksilverAgent.id, 'nuera-quicksilver:planner')
  assert.ok(plannerQuicksilverAgent.tasks.includes('planning'))
  assert.equal(reviewerQuicksilverAgent.id, 'nuera-quicksilver:reviewer')
  assert.ok(reviewerQuicksilverAgent.tasks.includes('evaluation'))
  assert.doesNotThrow(() => assertAgentDispatch(plannerQuicksilverAgent.id, 'planning', 'moderate'))
  assert.doesNotThrow(() => assertAgentDispatch(reviewerQuicksilverAgent.id, 'evaluation', 'low'))
})

test('the query agent id used by the query route is registered', () => {
  assert.doesNotThrow(() => assertAgentDispatch('nuera-quicksilver:query', 'reasoning', 'low'))
})

test('a governed run rejects a task the worker does not implement', async () => {
  await assert.rejects(
    executeGovernedAgent(reviewerQuicksilverAgent, {
      agentId: reviewerQuicksilverAgent.id,
      taskType: 'planning',
      input: {} as never,
    }),
    /does not implement task/,
  )
})

test('a governed run with a stub worker returns an NQC evaluation', async () => {
  const stub: NueraQuicksilverAgent<{ q: string }, { answer: string }> = {
    id: 'nuera-quicksilver:reviewer',
    version: 1,
    tasks: ['evaluation'],
    async execute() {
      return { output: { answer: 'ok' }, modelId: 'stub-model', evaluationContext: ['ev-1: evidence'] }
    },
  }
  const run = await executeGovernedAgent(stub, { agentId: stub.id, taskType: 'evaluation', input: { q: 'x' } })
  assert.deepEqual(run.output, { answer: 'ok' })
  assert.ok(['ALLOW', 'ESCALATE', 'BLOCK'].includes(run.evaluation.safetyDecision))
  assert.equal(run.mayContinueAutomatically, run.evaluation.safetyDecision === 'ALLOW')
})
