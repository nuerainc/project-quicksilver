/** Aura intent layer tests. Run with `npm run aura:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyBeliefUpdate,
  createIntent,
  evaluateParser,
  parseObjectiveBaseline,
  provenanceReport,
  scoreImpact,
  topThreeAgreement,
  targetedQuestions,
  validateIntentGraph,
  validateVariable,
  type GraphVariable,
  type IntentGraph,
  type LabeledObjective,
} from './index.ts'

const NOW = new Date('2026-09-26T12:00:00Z')
const founder = { id: 'entity-founder', kind: 'human' as const }
const agent = { id: 'nuera-quicksilver:planner', kind: 'agent' as const }

const base = { updatedAt: NOW.toISOString(), updatedBy: 'test' }
function variable(overrides: Partial<GraphVariable> & Pick<GraphVariable, 'id'>): GraphVariable {
  return { label: overrides.id, kind: 'assumption', value: 'x', provenance: 'HUMAN_SPECIFIED', confidence: 1, importance: 0.5, sources: [{ type: 'human', ref: 'entity-founder' }], ...base, ...overrides }
}

test('provenance: every tag has its own source rules', () => {
  assert.deepEqual(validateVariable(variable({ id: 'a' })), [])
  assert.ok(validateVariable(variable({ id: 'b', sources: [{ type: 'agent', ref: 'x' }] })).some((i) => i.rule === 'human-source'))
  assert.ok(validateVariable(variable({ id: 'c', confidence: 0.8 })).some((i) => i.rule === 'confidence'))
  assert.ok(validateVariable(variable({ id: 'd', provenance: 'SYSTEM_CONSTRAINT' })).some((i) => i.rule === 'constraint-source'))
  assert.deepEqual(validateVariable(variable({ id: 'e', provenance: 'SYSTEM_CONSTRAINT', sources: [{ type: 'waes', ref: 'waes-core' }] })), [])
  assert.ok(validateVariable(variable({ id: 'f', provenance: 'OBSERVED', confidence: 0.9, sources: [{ type: 'human', ref: 'x' }] })).some((i) => i.rule === 'observation-source'))
  assert.ok(validateVariable(variable({ id: 'g', provenance: 'AGENT_INFERRED', confidence: 0.6 })).some((i) => i.rule === 'explanation'))
  assert.ok(validateVariable(variable({ id: 'h', provenance: 'AGENT_INFERRED', confidence: 0.6, explanation: 'Because the planner said so.', sources: [{ type: 'agent', ref: 'planner' }] })).some((i) => i.rule === 'unsupported-inference'))
  assert.ok(validateVariable(variable({ id: 'i', provenance: 'AGENT_INFERRED', confidence: 1, explanation: 'From the quoted budget line.' })).some((i) => i.rule === 'confidence'))
  assert.ok(validateVariable({ ...variable({ id: 'j' }), provenance: undefined as never }).some((i) => i.rule === 'provenance'))
  assert.ok(validateVariable(variable({ id: 'k', kind: 'unknown' })).some((i) => i.rule === 'unknown'))
})

test('graph validation: duplicates, dangling edges and cycles are refused', () => {
  const g: IntentGraph = {
    id: 'g', objective: 'x', mode: null, autonomyDepth: 'propose', requestedBy: 'u', createdAt: NOW.toISOString(), history: [],
    variables: [variable({ id: 'a' }), variable({ id: 'b' }), variable({ id: 'a' })],
    edges: [{ from: 'a', to: 'b', relation: 'depends-on' }, { from: 'b', to: 'a', relation: 'depends-on' }, { from: 'a', to: 'zz', relation: 'informs' }],
  }
  const rules = validateIntentGraph(g).map((i) => i.rule)
  assert.ok(rules.includes('duplicate') && rules.includes('cycle') && rules.includes('edge'))
})

test('entry point: a genesis objective becomes a valid, fully tagged graph with stated values quoted', async () => {
  const { graph, report, issues, questions } = await createIntent('I have $500 and want to start a small online business in 30 days, no paid ads.', { requestedBy: 'entity-founder', now: NOW, id: 'intent-test' })
  assert.deepEqual(issues, [])
  assert.equal(graph.mode, 'genesis')
  assert.equal(report.provenanceCoverage, 1)
  assert.equal(report.unsupportedInferences, 0)
  assert.equal(report.explainedInferences, report.inferred)
  const budget = graph.variables.find((v) => v.id === 'budget')!
  assert.equal(budget.value, 500)
  assert.equal(budget.provenance, 'HUMAN_SPECIFIED')
  assert.equal(budget.sources[0]!.quote, '$500')
  assert.equal(graph.variables.find((v) => v.id === 'timeframe')!.value, 30)
  assert.equal(graph.variables.find((v) => v.id === 'mode')!.provenance, 'AGENT_INFERRED')
  assert.ok(graph.variables.some((v) => v.id === 'constraint.no_paid_ads' && v.provenance === 'HUMAN_SPECIFIED'))
  assert.ok(graph.variables.some((v) => v.id === 'rule.waes_review' && v.provenance === 'SYSTEM_CONSTRAINT'))
  // Unstated genesis slots are open unknowns, asked about in impact order.
  const unknowns = graph.variables.filter((v) => v.kind === 'unknown').map((v) => v.id).sort()
  assert.deepEqual(unknowns, ['risk_tolerance', 'skills', 'success_metric', 'weekly_hours'])
  assert.equal(questions.length, 3)
  assert.match(questions[0]!, /lose|number/)
})

test('entry point: with no mode cue, the mode itself is the first question', async () => {
  const { graph, questions } = await createIntent('Help me grow.', { requestedBy: 'entity-founder', now: NOW })
  assert.equal(graph.mode, null)
  assert.match(questions[0]!, /starting something new/)
  const chosen = await createIntent('Help me grow.', { requestedBy: 'entity-founder', now: NOW, mode: 'onboard' })
  assert.equal(chosen.graph.variables.find((v) => v.id === 'mode')!.provenance, 'HUMAN_SPECIFIED')
  assert.ok(chosen.graph.variables.some((v) => v.id === 'business_type' && v.kind === 'unknown'))
})

test('impact scoring is deterministic, explained, and favors uncertain high-stakes unknowns', async () => {
  const { graph } = await createIntent('I have $500 and want to start a business.', { requestedBy: 'u', now: NOW })
  const a = scoreImpact(graph)
  const b = scoreImpact(structuredClone(graph))
  assert.deepEqual(a, b)
  assert.equal(a[0]!.variableId, 'risk_tolerance', 'risk tolerance informs the stated budget, so it outranks other unknowns')
  for (const item of a) assert.match(item.explanation, /uncertainty .* × importance .* × \(1 \+ leverage .*\) = /)
  assert.ok(a.every((item, i) => i === 0 || a[i - 1]!.score >= item.score))
  assert.equal(targetedQuestions(graph, 2).length, 2)
})

test('beliefs: agents may infer, but never overwrite what a human stated or a policy sets', async () => {
  const { graph } = await createIntent('I have $500 and want to start a business.', { requestedBy: 'entity-founder', now: NOW })
  const inferred = applyBeliefUpdate(graph, agent, {
    variableId: 'risk_tolerance', value: 0.2, provenance: 'AGENT_INFERRED', confidence: 0.5,
    sources: [{ type: 'human', ref: 'entity-founder', quote: '$500' }],
    explanation: 'A $500 total budget suggests losing at most about a fifth on any single test.',
  }, NOW)
  assert.equal(inferred.accepted, true)
  if (!inferred.accepted) return
  assert.equal(inferred.graph.variables.find((v) => v.id === 'risk_tolerance')!.kind, 'assumption')
  assert.equal(inferred.graph.history.length, 1)
  assert.equal(graph.history.length, 0, 'the input graph is not mutated')

  const overwrite = applyBeliefUpdate(inferred.graph, agent, { variableId: 'budget', value: 1000, provenance: 'AGENT_INFERRED', confidence: 0.6, sources: [{ type: 'human', ref: 'x', quote: '$500' }], explanation: 'Market rates suggest more.' }, NOW)
  assert.equal(overwrite.accepted, false)
  assert.equal(applyBeliefUpdate(graph, agent, { variableId: 'budget', value: 1000, provenance: 'HUMAN_SPECIFIED', confidence: 1, sources: [{ type: 'human', ref: 'x' }] }, NOW).accepted, false)
  assert.equal(applyBeliefUpdate(graph, founder, { variableId: 'rule.waes_review', value: false, provenance: 'HUMAN_SPECIFIED', confidence: 1, sources: [{ type: 'human', ref: 'entity-founder' }] }, NOW).accepted, false)

  const restated = applyBeliefUpdate(graph, founder, { variableId: 'budget', value: 750, provenance: 'HUMAN_SPECIFIED', confidence: 1, sources: [{ type: 'human', ref: 'entity-founder', quote: 'make it $750' }] }, NOW)
  assert.equal(restated.accepted, true)
})

test('beliefs: an inference cannot replace an observation, and the memory governor refuses personal data', async () => {
  const { graph } = await createIntent('We sell hay to local ranchers.', { requestedBy: 'entity-founder', now: NOW })
  const observed = applyBeliefUpdate(graph, { id: 'svc:ledger-sync', kind: 'service' }, {
    variableId: 'revenue_model', value: 'per-ton sales, net 30', provenance: 'OBSERVED', confidence: 0.9, sources: [{ type: 'observation', ref: 'ledger:2026-09' }],
  }, NOW)
  assert.equal(observed.accepted, true)
  if (!observed.accepted) return
  const guess = applyBeliefUpdate(observed.graph, agent, { variableId: 'revenue_model', value: 'subscriptions', provenance: 'AGENT_INFERRED', confidence: 0.4, sources: [{ type: 'human', ref: 'x', quote: 'hay' }], explanation: 'Many farms move to subscriptions.' }, NOW)
  assert.equal(guess.accepted, false)
  const pii = applyBeliefUpdate(graph, agent, { variableId: 'business_type', value: 'Owner SSN 123-45-6789 hay farm', provenance: 'AGENT_INFERRED', confidence: 0.5, sources: [{ type: 'human', ref: 'x', quote: 'hay' }], explanation: 'The objective says they sell hay.' }, NOW)
  assert.equal(pii.accepted, false)
  if (!pii.accepted) assert.ok(pii.reasons.some((r) => r.startsWith('Memory governor')))
})

test('provenance report meets the charter measures on every labeled objective', async () => {
  const setPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'objectives.json')
  const set = (JSON.parse(readFileSync(setPath, 'utf8')) as { objectives: LabeledObjective[] }).objectives
  assert.ok(set.length >= 50, 'the charter asks for 50 or more labeled objectives')
  for (const item of set) {
    const { report, issues } = await createIntent(item.text, { requestedBy: 'entity-founder', now: NOW })
    assert.deepEqual(issues, [], item.id)
    assert.equal(report.provenanceCoverage, 1, item.id)
    assert.equal(report.unsupportedInferences, 0, item.id)
    assert.equal(report.explainedInferences, report.inferred, item.id)
  }
})

test('evaluation harness scores the baseline parser and counts parser errors as misses', async () => {
  const set: LabeledObjective[] = [
    { id: 'x1', text: 'Start a business with $300 in 2 weeks.', expected: { mode: 'genesis', budget: 300, revenueTarget: null, timeframeDays: 14, weeklyHours: null, autonomy: null, constraints: [] } },
    { id: 'x2', text: 'Help me grow.', expected: { mode: null, budget: null, revenueTarget: null, timeframeDays: null, weeklyHours: null, autonomy: null, constraints: [] } },
  ]
  const report = await evaluateParser(parseObjectiveBaseline, set)
  assert.equal(report.parsingAccuracy, 1)
  const broken = await evaluateParser(() => { throw new Error('model offline') }, set)
  assert.equal(broken.exactMatches, 0)
  assert.equal(broken.errors.length, 2)
})

test('top-3 agreement: set overlap per objective, skips small sets, flags missing rankings', () => {
  const rank = (...ids: string[]) => ids.map((variableId, i) => ({ variableId, score: 1 - i / 10 }))
  const aura = { a: rank('x', 'y', 'z', 'w'), b: rank('p', 'q', 'r', 's', 't'), c: rank('m', 'n', 'o'), d: rank('e', 'f', 'g', 'h') }
  const r = topThreeAgreement(aura, { a: ['z', 'x', 'y'], b: ['p', 's', 't'], d: ['e', 'f'] })
  assert.equal(r.objectives, 2)
  assert.deepEqual(r.missing, ['d'])
  assert.equal(r.perObjective.find((o) => o.id === 'a')!.agreement, 1, 'order inside the top three is not scored')
  assert.equal(r.perObjective.find((o) => o.id === 'b')!.agreement, 1 / 3)
  assert.equal(r.meanAgreement, 2 / 3)
  assert.equal(r.chanceBaseline, (3 / 4 + 3 / 5) / 2)
  assert.equal(r.meetsCharterTarget, false)
  assert.equal(topThreeAgreement({ a: aura.a }, { a: ['x', 'y', 'z'] }).meetsCharterTarget, true)
  assert.deepEqual(topThreeAgreement({ a: aura.a }, { a: ['x', 'y', 'nope'] }).missing, ['a'])
  const tied = [{ variableId: 'x', score: 0.9 }, { variableId: 'y', score: 0.8 }, { variableId: 'z', score: 0.7 }, { variableId: 'w', score: 0.7 }]
  assert.equal(topThreeAgreement({ a: tied }, { a: ['x', 'y', 'w'] }).meanAgreement, 1, 'a pick tied with Aura’s third counts')
})

test('implied intent: what the objective clearly implies is inferred with its quote, not asked', async () => {
  const feed = await createIntent('We run a feed store. Set up Quicksilver for it with read-only access.', { requestedBy: 'entity-founder', now: NOW })
  const bt = feed.graph.variables.find((v) => v.id === 'business_type')!
  assert.equal(bt.value, 'feed store')
  assert.equal(bt.provenance, 'AGENT_INFERRED')
  assert.ok(bt.confidence < 1)
  assert.equal(bt.sources[0]!.quote, 'We run a feed store')
  assert.match(bt.explanation!, /Implied by "We run a feed store"/)
  assert.ok(!feed.impact.some((i) => i.variableId === 'business_type'), 'Aura no longer asks what the business is')
  assert.deepEqual(feed.issues, [])

  const hay = await createIntent('We sell hay and alfalfa to local ranchers. Help us understand our margins.', { requestedBy: 'entity-founder', now: NOW })
  assert.equal(hay.graph.variables.find((v) => v.id === 'revenue_model')!.value, 'Sales of hay and alfalfa to ranchers')
  assert.equal(hay.graph.variables.find((v) => v.id === 'success_metric')!.value, 'Margins')

  const brief = await createIntent('Send me a weekly report on sales and open decisions.', { requestedBy: 'entity-founder', now: NOW })
  assert.equal(brief.graph.variables.find((v) => v.id === 'cadence')!.value, 'Weekly')

  // Nothing implied, nothing inferred: a vague objective still gets asked.
  const vague = await createIntent('Bring my existing business into Quicksilver.', { requestedBy: 'entity-founder', now: NOW })
  assert.ok(vague.impact.some((i) => i.variableId === 'business_type'))
})

test('combined parser: money from the model, durations from the rules, constraints unioned, autonomy never granted by the model', async () => {
  const { combineParses } = await import('./index.ts')
  const text = 'Start a side hustle with $200 per month in 30 days, weekly.'
  const rules = parseObjectiveBaseline(text)
  const span = (t: string) => ({ text: t, index: text.indexOf(t) })
  const model = { ...rules, budget: { value: 200, span: span('$200') }, revenueTarget: null, timeframeDays: { value: 7, span: span('weekly') }, autonomy: { value: 'act-within-limits' as const, cue: span('weekly') }, constraints: [{ id: 'digital_only', label: 'x', span: span('side hustle') }] }
  const c = combineParses(rules, model)
  assert.equal(c.budget?.value, 200)
  assert.equal(c.timeframeDays?.value, 30, 'the rate "weekly" is not a deadline')
  assert.equal(c.autonomy, null, 'the model cannot grant acting alone')
  assert.deepEqual(c.constraints.map((x) => x.id).sort(), ['digital_only', 'keep_day_job'])
  const restrict = combineParses({ ...rules, autonomy: { value: 'act-within-limits', cue: span('weekly') } }, { ...model, autonomy: { value: 'advise', cue: span('weekly') } })
  assert.equal(restrict.autonomy?.value, 'advise', 'the model may make autonomy more restrictive')
})

test('baseline reads "the next quarter" as a 90-day timeframe', () => {
  assert.equal(parseObjectiveBaseline('Our company needs a clear picture of cash flow for the next quarter.').timeframeDays?.value, 90)
})

test('production parser: the model\'s parse, except it can never grant acting alone', async () => {
  const { guardModelParse } = await import('./index.ts')
  const text = 'Keep the books tidy.'
  const rules = parseObjectiveBaseline(text)
  const model = { ...rules, mode: { value: 'operate' as const, cue: { text: 'Keep', index: 0 } }, autonomy: { value: 'act-within-limits' as const, cue: { text: 'Keep', index: 0 } } }
  const g = guardModelParse(rules, model)
  assert.equal(g.mode?.value, 'operate', 'the model\'s other fields are kept')
  assert.equal(g.autonomy, null)
})
