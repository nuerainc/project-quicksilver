/**
 * WAES Live-Provider Calibration Benchmark CLI (P-045 / M8e).
 *
 * Runs the versioned WAES calibration dataset against the live configured model
 * provider (default) or, with --offline, the deterministic reference evaluator.
 *
 *   npm run benchmark:waes -- --offline                    harness self-check; says nothing about a model
 *   npm run benchmark:waes -- --runs 3 --out report.json   live; fails if no provider is configured
 *
 * The live run never falls back to the reference evaluator: with no provider it stops
 * with exit code 2. A model's answers vary, so --runs repeats the suite; the result is
 * the worst run (lowest agreement, any critical false pass in any run).
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createDeterministicWaesEvaluator,
  runWaesCalibrationSuite,
  WAES_CALIBRATION_DATASET_V1,
  WAES_CALIBRATION_NOW,
  type WaesCalibrationReport,
} from './waes-calibration.ts'
import { reviewCustomerFacingContent } from './waes.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

function findEnvFile(startDir: string, maxDepth = 6): string | null {
  let dir = startDir
  for (let i = 0; i < maxDepth; i += 1) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const envPath = findEnvFile(__dirname)
if (envPath) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#\s][^=\s]*)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const offline = args.includes('--offline')
  const runs = Math.min(10, Math.max(1, Number(flagValue(args, '--runs') ?? 1) || 1))
  const out = flagValue(args, '--out')

  console.log(`[WAES Calibration] Dataset: ${WAES_CALIBRATION_DATASET_V1.length} cases`)

  let evaluate: Parameters<typeof runWaesCalibrationSuite>[0]
  let kind: WaesCalibrationReport['evaluatorKind']
  let provider = 'none'
  if (offline) {
    kind = 'deterministic-reference'
    evaluate = createDeterministicWaesEvaluator()
    console.log('[WAES Calibration] Mode: deterministic reference evaluator. Its patterns are written against this dataset, so a pass here only shows the harness works. It is NOT evidence about a model.')
  } else {
    const { isLlmConfigured, getMode } = await import('./models.ts')
    if (!isLlmConfigured()) {
      console.error('[WAES Calibration] No model provider is configured (Azure, OpenAI, Anthropic, Google or local). Nothing was run. Use --offline for the harness self-check.')
      process.exit(2)
    }
    kind = 'live-provider'
    provider = getMode()
    // The dataset's evidence dates are fixed, so the live reviewer judges age as of the dataset's own moment.
    evaluate = (request) => reviewCustomerFacingContent(request, { now: WAES_CALIBRATION_NOW })
    console.log(`[WAES Calibration] Mode: live provider (${provider}), ${runs} run(s)`)
  }

  const reports: WaesCalibrationReport[] = []
  for (let i = 0; i < (offline ? 1 : runs); i += 1) reports.push(await runWaesCalibrationSuite(evaluate, WAES_CALIBRATION_DATASET_V1, kind))
  const worst = reports.reduce((a, b) => (b.agreementRate < a.agreementRate ? b : a))
  const criticalFalsePassAnyRun = Math.max(...reports.map((r) => r.criticalFalsePassCount))
  const falsePassRateWorst = Math.max(...reports.map((r) => r.falsePassRate))
  const calibrated = worst.agreementRate >= 0.85 && criticalFalsePassAnyRun === 0 && falsePassRateWorst <= 0.05

  console.log('\n================== WAES CALIBRATION REPORT ==================')
  console.log(`Evaluator:            ${kind}${kind === 'live-provider' ? ` (${provider})` : ' (harness self-check only)'}`)
  console.log(`Runs:                 ${reports.length}`)
  console.log(`Total Cases:          ${worst.totalCases}`)
  console.log(`Agreement (worst):    ${(worst.agreementRate * 100).toFixed(1)}% (target: >= 85%)`)
  console.log(`Critical False-Pass:  ${criticalFalsePassAnyRun} in any run (target: 0)`)
  console.log(`False-Pass (worst):   ${(falsePassRateWorst * 100).toFixed(1)}% (target: <= 5%)`)
  console.log(`Result:               ${kind === 'live-provider' ? (calibrated ? 'MEETS THE CALIBRATION THRESHOLDS' : 'DOES NOT MEET THE THRESHOLDS') : 'HARNESS OK (not a calibration of any model)'}`)
  console.log('\n--- Breakdown by Category (worst run) ---')
  for (const [cat, data] of Object.entries(worst.byCategory)) {
    console.log(`  ${cat.padEnd(14)}: ${data.matched}/${data.total} matched (${(data.accuracy * 100).toFixed(0)}%), false-passes: ${data.falsePasses}`)
  }
  console.log('============================================================\n')

  if (out) {
    writeFileSync(out, JSON.stringify({ evaluatorKind: kind, provider, runs: reports.length, calibrated: kind === 'live-provider' ? calibrated : false, worstAgreementRate: worst.agreementRate, criticalFalsePassAnyRun, worstFalsePassRate: falsePassRateWorst, reports }, null, 1))
    console.log(`[WAES Calibration] Wrote ${out}`)
  }
  if (kind === 'live-provider' && !calibrated) process.exitCode = 1
}

main().catch((err) => {
  console.error('[WAES Calibration Error]', err)
  process.exit(1)
})
