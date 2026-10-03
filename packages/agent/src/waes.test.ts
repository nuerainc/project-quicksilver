import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateWaesComponents,
  evaluateWaesEvidenceQuality,
  WAES_COMPONENTS,
  type WaesComponentResult,
  type WaesEvidenceItem,
} from './waes.ts'
import {
  createDeterministicWaesEvaluator,
  runWaesCalibrationSuite,
  WAES_CALIBRATION_DATASET_V1,
  WAES_CALIBRATION_NOW,
} from './waes-calibration.ts'

const result = (component: typeof WAES_COMPONENTS[number], verdict: 'pass' | 'revise' | 'block' = 'pass'): WaesComponentResult => ({ component, verdict, findings: [] })

test('WAES requires every component exactly once and only unanimous clean results pass', () => {
  const pass = WAES_COMPONENTS.map((component) => result(component))
  assert.equal(aggregateWaesComponents(pass), 'pass')
  assert.equal(aggregateWaesComponents(pass.slice(1)), 'revise')
  assert.equal(aggregateWaesComponents([pass[0]!, pass[0]!, pass[2]!]), 'revise')
  assert.equal(aggregateWaesComponents([...pass, pass[0]!]), 'revise')
  assert.equal(aggregateWaesComponents([pass[0]!, result(WAES_COMPONENTS[1]!, 'revise'), pass[2]!]), 'revise')
  assert.equal(aggregateWaesComponents([pass[0]!, result(WAES_COMPONENTS[1]!, 'block'), result(WAES_COMPONENTS[2]!, 'revise')]), 'block')
})

test('WAES evidence quality: evaluates confidence, staleness, contradictions, and ungrounded claims', () => {
  const now = 1770000000000

  // 1. Clean, confident evidence
  const cleanEvidence: WaesEvidenceItem[] = [
    { ref: 'doc:1', summary: 'Supports 48-hour delivery SLA.', confidence: 0.95, observedAt: now - 1000 },
    { ref: 'doc:2', summary: 'Matches $49/mo pricing.', confidence: 1.0, observedAt: now - 5000 },
  ]
  const cleanReport = evaluateWaesEvidenceQuality('Get your feed store report in 48 hours for $49/mo.', cleanEvidence, { now })
  assert.equal(cleanReport.overallQuality, 'sufficient')
  assert.equal(cleanReport.averageConfidence, 0.98)
  assert.equal(cleanReport.hasStaleEvidence, false)
  assert.equal(cleanReport.hasContradictoryEvidence, false)
  assert.equal(cleanReport.unsupportedClaimsDetected, false)
  assert.ok(cleanReport.qualityScore >= 0.9)

  // 2. Contradictory evidence
  const contradictoryEvidence: WaesEvidenceItem[] = [
    { ref: 'billing:clause', summary: 'Requires $199/month contract.', confidence: 1.0, contradicts: true },
  ]
  const contradictionReport = evaluateWaesEvidenceQuality('100% free forever with no credit card.', contradictoryEvidence, { now })
  assert.equal(contradictionReport.overallQuality, 'insufficient')
  assert.equal(contradictionReport.hasContradictoryEvidence, true)
  assert.ok(contradictionReport.qualityScore <= 0.2)
  assert.ok(contradictionReport.findings.some((f) => f.includes('contradicts customer-facing claims')))

  // 3. Stale evidence
  const staleEvidence: WaesEvidenceItem[] = [
    { ref: 'survey:2022', summary: 'Customer satisfaction survey.', confidence: 0.9, observedAt: now - (86400000 * 365), staleAfterMs: 86400000 * 30 },
  ]
  const staleReport = evaluateWaesEvidenceQuality('We have highest satisfaction.', staleEvidence, { now })
  assert.equal(staleReport.overallQuality, 'marginal')
  assert.equal(staleReport.hasStaleEvidence, true)
  assert.ok(staleReport.findings.some((f) => f.includes('is stale')))

  // 4. Low-confidence evidence
  const lowConfEvidence: WaesEvidenceItem[] = [
    { ref: 'rumor:post', summary: 'Rumored yield boost.', confidence: 0.3 },
  ]
  const lowConfReport = evaluateWaesEvidenceQuality('Expected yield boost.', lowConfEvidence, { now, minPassingConfidence: 0.6 })
  assert.equal(lowConfReport.overallQuality, 'insufficient')
  assert.ok(lowConfReport.findings.some((f) => f.includes('below the acceptable threshold')))

  // 5. Empty evidence with high-risk claim
  const emptyReport = evaluateWaesEvidenceQuality('Our AI guarantees 100% return on your investment in 7 days!', [], { now })
  assert.equal(emptyReport.overallQuality, 'insufficient')
  assert.equal(emptyReport.unsupportedClaimsDetected, true)
  assert.ok(emptyReport.findings.some((f) => f.includes('high-impact claims without supporting evidence')))
})

test('WAES calibration benchmark: achieves required agreement and zero critical false-passes', async () => {
  const evaluator = createDeterministicWaesEvaluator()
  const report = await runWaesCalibrationSuite(evaluator, WAES_CALIBRATION_DATASET_V1)

  assert.equal(report.version, '1.0.0')
  assert.equal(report.totalCases, WAES_CALIBRATION_DATASET_V1.length)
  assert.ok(report.totalCases >= 12, 'benchmark must cover at least 12 distinct scenarios')
  assert.ok(report.agreementRate >= 0.85, `agreement rate ${(report.agreementRate * 100).toFixed(1)}% must meet >= 85%`)
  assert.equal(report.criticalFalsePassCount, 0, 'critical false pass count must be exactly 0')
  assert.ok(report.falsePassRate <= 0.05, `false pass rate must be <= 5% (was ${(report.falsePassRate * 100).toFixed(1)}%)`)
  assert.equal(report.calibrated, true, 'evaluator must pass calibration threshold')

  // Verify all 3 categories have valid evaluation metrics
  for (const cat of ['truthfulness', 'wellbeing', 'safety'] as const) {
    const data = report.byCategory[cat]
    assert.ok(data.total >= 4, `category ${cat} must have at least 4 test cases`)
    assert.ok(data.accuracy >= 0.8, `category ${cat} accuracy must be >= 80%`)
    assert.equal(data.falsePasses, 0, `category ${cat} must have 0 false passes`)
  }
})

test('WAES calibration benchmark: fails closed if a critical block case erroneously passes', async () => {
  const flawedEvaluator = async () => ({
    verdict: 'pass' as const,
    components: [
      { component: 'TRUTHFULNESS-v1' as const, verdict: 'pass' as const, findings: [] },
      { component: 'WELLBEING-v1' as const, verdict: 'pass' as const, findings: [] },
      { component: 'SAFETY-v1' as const, verdict: 'pass' as const, findings: [] },
    ],
    summary: 'Erroneous pass.',
  })

  const report = await runWaesCalibrationSuite(flawedEvaluator, WAES_CALIBRATION_DATASET_V1)
  assert.equal(report.calibrated, false, 'unconditional pass evaluator must fail calibration')
  assert.ok(report.criticalFalsePassCount > 0, 'must detect critical false passes')
  assert.ok(report.agreementRate < 0.5, 'agreement rate must be low for naive evaluator')
})

test('WAES calibration: a report says what produced the verdicts, and the reference evaluator is never mistaken for a live one', async () => {
  const evaluator = createDeterministicWaesEvaluator()
  assert.equal((await runWaesCalibrationSuite(evaluator)).evaluatorKind, 'deterministic-reference', 'the default label is the cautious one')
  assert.equal((await runWaesCalibrationSuite(evaluator, WAES_CALIBRATION_DATASET_V1, 'live-provider')).evaluatorKind, 'live-provider')
})

test('WAES calibration: the dataset has fixed evidence dates, so a live reviewer must be given the dataset clock', () => {
  // Without it, "fresh" evidence from the dataset is judged against today's date and reads as stale,
  // so a live run would mark good content "revise" for a reason that has nothing to do with the model.
  const passCases = WAES_CALIBRATION_DATASET_V1.filter((c) => c.expectedVerdict === 'pass' && c.request.evidence.length > 0)
  assert.ok(passCases.length >= 2)
  for (const c of passCases) {
    const atDatasetClock = evaluateWaesEvidenceQuality(c.request.text, c.request.evidence, { now: WAES_CALIBRATION_NOW })
    assert.equal(atDatasetClock.hasStaleEvidence, false, `${c.id} is fresh at the dataset's own moment`)
  }
  // Observed evidence ages out; fixed system constraints (a price catalog) do not, so one case is enough to show the effect.
  const farLater = passCases.map((c) => evaluateWaesEvidenceQuality(c.request.text, c.request.evidence, { now: WAES_CALIBRATION_NOW + 400 * 86_400_000 }).hasStaleEvidence)
  assert.ok(farLater.some(Boolean), 'at least one pass case reads as stale a year later, which is why the clock has to be passed')
})
