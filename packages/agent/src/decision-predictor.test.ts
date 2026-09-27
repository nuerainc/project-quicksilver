/** The own-decision prompt (no model call). */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { founderContext, JOURNAL_PREAMBLE, OWN_DECISION_NOTE, ownDecisionPrompt } from './decision-predictor.ts'
import { CHOICE_GOALS_METHOD, CHOICE_SYSTEM_ALL } from './choice-prompts.ts'

const journal = [{ id: 'd1', at: '2026-09-27T00:00:00Z', by: 'f', situation: 'Our supplier raised prices 8%.', options: [{ id: 'a', text: 'Accept' }, { id: 'b', text: 'Negotiate' }], chosen: 'b', note: 'they are our best supplier', source: 'journal' as const }]

test('the founder context has his principles, profile, sets 1 and 2, profile v2 and his journal, never set 3', () => {
  const ctx = founderContext({ journal })
  assert.match(ctx.principlesText, /confirmed by them/)
  assert.match(ctx.profileText, /intent profile/)
  assert.ok(ctx.examplesText.includes('They chose:'))
  assert.ok(ctx.examplesText.includes('everyday business decisions'), 'profile v2 dilemmas are included')
  assert.ok(!/cs3-|halal butcher|Ridgeview/.test(ctx.examplesText), 'set 3 is left out: mostly answered for other owners')
  assert.ok(ctx.journalText.startsWith(JOURNAL_PREAMBLE))
  assert.match(ctx.journalText, /Our supplier raised prices 8%\.[\s\S]*They chose: b\. Their note: "they are our best supplier"/)
  assert.equal(founderContext({}).journalText, '')
})

test('the prompt says it is the provider\'s own decision, uses the v3 method, and lists the options', () => {
  const { system, prompt } = ownDecisionPrompt({ principlesText: 'P', profileText: 'R', examplesText: 'E', journalText: 'J' }, { situation: 'Hire a second baker?', options: [{ id: 'a', text: 'Hire now' }, { id: 'b', text: 'Wait for spring' }], category: 'hiring' })
  assert.equal(system, `${CHOICE_SYSTEM_ALL}\n${CHOICE_GOALS_METHOD}\n${OWN_DECISION_NOTE}`)
  assert.ok(prompt.startsWith('P\n\nR\n\nE\n\nJ\n\n'))
  assert.ok(prompt.endsWith(`${OWN_DECISION_NOTE}\nArea: hiring\nSituation: Hire a second baker?\nOptions:\n- a: Hire now\n- b: Wait for spring`))
})
