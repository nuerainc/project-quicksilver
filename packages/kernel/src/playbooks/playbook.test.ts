/** Playbook tests (M4). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AccessController, type Principal } from '../identity/rbac.ts'
import {
  advancePlaybookRun,
  draftPlaybook,
  judgeMetric,
  playbookDigest,
  publishPlaybook,
  stageResultFacts,
  startPlaybookRun,
  validatePlaybook,
  type PlaybookDefinition,
} from './playbook.ts'

const onboard = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'deploy', 'playbooks', 'onboard.json'), 'utf8')) as PlaybookDefinition
const T = 'nuera'
const author: Principal = { id: 'user:author', kind: 'human', tenantId: T, roles: ['developer'] }
const supervisor: Principal = { id: 'user:sup', kind: 'human', tenantId: T, roles: ['supervisor'] }
const access = new AccessController()
const human = { id: 'entity-founder', entityType: 'human' as const }
const agent = { id: 'agent:x', entityType: 'agent' as const }

function published() {
  const r = publishPlaybook(draftPlaybook(onboard, author.id), supervisor, access)
  assert.ok(r.ok, r.ok ? '' : r.reasons.join(' '))
  return r.record
}

test('the Onboard playbook is valid content', () => {
  assert.deepEqual(validatePlaybook(onboard), { valid: true, errors: [] })
})

test('validation: every step names its capability; metric thresholds are ordered; stages exist', () => {
  const bad = structuredClone(onboard)
  delete bad.stepCapabilities['shadow/work']
  bad.metrics[0]!.kill = 0.1
  bad.stageGraphs['nowhere'] = bad.stageGraphs['observe']!
  const errors = validatePlaybook(bad).errors.join(' | ')
  assert.match(errors, /"work" does not name its capability/)
  assert.match(errors, /out of order/)
  assert.match(errors, /nowhere: no such process state/)
})

test('publishing needs a human supervisor who is not the author, and pins the digest', () => {
  const draft = draftPlaybook(onboard, author.id)
  assert.equal(publishPlaybook(draft, author, access).ok, false, 'the author cannot publish')
  assert.equal(publishPlaybook(draft, { ...supervisor, id: author.id }, access).ok, false, 'separation of duties')
  assert.equal(publishPlaybook(draft, { ...supervisor, kind: 'agent' }, access).ok, false)
  const edited = { ...draft, definition: { ...draft.definition, name: 'Changed after drafting' } }
  assert.equal(publishPlaybook(edited, supervisor, access).ok, false)
  const ok = publishPlaybook(draft, supervisor, access)
  assert.ok(ok.ok && ok.record.status === 'published' && ok.record.publishedBy === 'user:sup')
})

test('a run needs the required variables, then advances only when facts allow', () => {
  const record = published()
  assert.equal(startPlaybookRun(record, 'r1', []).ok, false)
  const started = startPlaybookRun(record, 'r1', ['business_type'])
  assert.ok(started.ok)
  let run = started.run
  assert.equal(run.stage, 'connect')
  let step = advancePlaybookRun(record, run, {})
  assert.equal(step.moved, false)
  for (const [facts, stage] of [
    [{ 'connectors.connected': 1 }, 'observe'],
    [{ 'observed.variables': 12 }, 'interview'],
    [{ 'aura.openQuestions': 0 }, 'backtest'],
    [{ 'backtest.passed': true }, 'shadow'],
  ] as const) {
    step = advancePlaybookRun(record, run, facts)
    assert.ok(step.moved, `${stage}: ${step.moved ? '' : step.reason}`)
    run = step.run
    assert.equal(run.stage, stage)
  }
  // Shadow needs enough recommendations AND agreement.
  assert.equal(advancePlaybookRun(record, run, { 'shadow.recommendations': 25, 'shadow.agreement': 0.6 }).moved, false)
  step = advancePlaybookRun(record, run, { 'shadow.recommendations': 25, 'shadow.agreement': 0.84 })
  assert.ok(step.moved)
  run = step.run
  assert.equal(run.stage, 'graduate')
  // Hand-over is human-only, and never automatic.
  assert.equal(advancePlaybookRun(record, run, {}).moved, false)
  assert.equal(advancePlaybookRun(record, run, {}, { actor: agent, transitionId: 'hand-over' }).moved, false)
  step = advancePlaybookRun(record, run, {}, { actor: human, transitionId: 'hand-over' })
  assert.ok(step.moved)
  assert.equal(step.run.stage, 'handed-over')
  assert.equal(step.run.history.at(-1)!.actorId, 'entity-founder')
})

test('a failed back-test loops back to the interview', () => {
  const record = published()
  let run = startPlaybookRun(record, 'r2', ['business_type']).ok ? (startPlaybookRun(record, 'r2', ['business_type']) as { run: any }).run : null
  for (const f of [{ 'connectors.connected': 1 }, { 'observed.variables': 3 }, { 'aura.openQuestions': 0 }]) run = advancePlaybookRun(record, run, f).run
  const r = advancePlaybookRun(record, run, { 'backtest.passed': false })
  assert.ok(r.moved && r.run.stage === 'interview')
})

test('a run refuses a playbook whose content changed after it started', () => {
  const record = published()
  const run = (startPlaybookRun(record, 'r3', ['business_type']) as { run: any }).run
  const changed = { ...record, definition: { ...record.definition, name: 'x' } }
  const r = advancePlaybookRun(changed, run, { 'connectors.connected': 1 })
  assert.equal(r.moved, false)
  assert.notEqual(playbookDigest(changed.definition), record.digest)
})

test('metrics are judged against thresholds fixed in advance, in the right direction', () => {
  const err = onboard.metrics.find((m) => m.id === 'backtest-error')!
  assert.equal(judgeMetric(err, 0.1), 'scale')
  assert.equal(judgeMetric(err, 0.2), 'continue')
  assert.equal(judgeMetric(err, 0.4), 'hold')
  assert.equal(judgeMetric(err, 0.6), 'kill')
  const agree = onboard.metrics.find((m) => m.id === 'shadow-agreement')!
  assert.equal(judgeMetric(agree, 0.9), 'scale')
  assert.equal(judgeMetric(agree, 0.75), 'continue')
  assert.equal(judgeMetric(agree, 0.6), 'hold')
  assert.equal(judgeMetric(agree, 0.4), 'kill')
})

test('stage results flatten into facts for the next transition', () => {
  const f = stageResultFacts({ status: 'completed', steps: [], outputs: { work: { passed: true, mape: 0.12, note: 'ok', nested: { x: 1 } }, done: 'fine' } })
  assert.deepEqual(f, { 'stage.status': 'completed', 'stage.work.passed': true, 'stage.work.mape': 0.12, 'stage.work.note': 'ok', 'stage.done': 'fine' })
})
