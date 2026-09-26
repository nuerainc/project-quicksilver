/** Choice predictor v1 tests (the frozen method). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { choiceAgreement, predictChoice, scoreProfile, type ChoiceScenarioLite, type PredictorSpec, type ProfileAnswer, type ProfileInstrument } from './index.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const specText = readFileSync(join(evalDir, 'choice-predictor-v1.json'), 'utf8')
const spec = JSON.parse(specText) as PredictorSpec
const scenarios = (JSON.parse(readFileSync(join(evalDir, 'choice-scenarios.json'), 'utf8')) as { scenarios: ChoiceScenarioLite[] }).scenarios
const instrument = JSON.parse(readFileSync(join(evalDir, 'intent-profile-v1.json'), 'utf8')) as ProfileInstrument

function profileLeaning(lean: Record<string, 'left' | 'right'>) {
  const answers: Record<string, ProfileAnswer> = {}
  for (const i of instrument.items) answers[i.id] = { choice: i.a.pole === lean[i.dimension] ? 'a' : 'b', strength: 2 }
  return scoreProfile(instrument, answers)
}

test('the frozen predictor spec is unchanged (edit means a new version, not a silent change)', () => {
  // Recorded when v1 was frozen, before any scenario answers existed. Hashes the parsed JSON, so line endings don't matter.
  assert.equal(createHash('sha256').update(JSON.stringify(spec)).digest('hex'), FROZEN_SHA256)
  for (const s of scenarios) assert.ok(s.id in spec.annotations, s.id)
})

test('a bold profile picks the bold option; a safe profile picks the safe one', () => {
  const s38 = scenarios.find((s) => s.id === 'cs-38')!
  assert.equal(predictChoice(profileLeaning({ risk: 'right', autonomy: 'left' }), spec, s38).choice, 'b')
  assert.equal(predictChoice(profileLeaning({ risk: 'left', autonomy: 'left' }), spec, s38).choice, 'a')
})

test('a provider who wants to be asked gets "ask" where nothing else fits strongly', () => {
  const s = scenarios.find((x) => x.id === 'cs-05')!
  assert.equal(predictChoice(profileLeaning({ autonomy: 'right' }), spec, s).choice, 'ask')
})

test('uncovered scenarios abstain and count as misses in the headline number', () => {
  const p = profileLeaning({ risk: 'left' })
  const s03 = scenarios.find((x) => x.id === 'cs-03')!
  assert.equal(predictChoice(p, spec, s03).choice, null)
  const r = choiceAgreement(p, spec, [s03, scenarios.find((x) => x.id === 'cs-38')!], { 'cs-03': 'a', 'cs-38': 'a' })
  assert.equal(r.correct, 1)
  assert.equal(r.agreement, 0.5)
  assert.equal(r.coveredAgreement, 1)
  assert.equal(r.chance, 0.25)
})
const FROZEN_SHA256 = '92b47b192ec4d9fd236f2a454d3f5ba3bf0436f5ec6131ee189645fee0f1b9cb'
