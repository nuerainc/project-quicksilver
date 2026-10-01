/**
 * WAES Live-Provider Calibration Benchmark CLI (P-045 / M8e).
 *
 * Runs the versioned WAES calibration dataset against either the live configured
 * model role (default) or the deterministic reference evaluator (--offline).
 *
 *   npm run benchmark:waes -- --offline
 *   npm run benchmark:waes -- --role reviewer
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createDeterministicWaesEvaluator,
  runWaesCalibrationSuite,
  WAES_CALIBRATION_DATASET_V1,
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

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const isOffline = args.includes('--offline')

  console.log(`[WAES Calibration] Initializing benchmark (dataset: ${WAES_CALIBRATION_DATASET_V1.length} cases)...`)
  console.log(`[WAES Calibration] Mode: ${isOffline ? 'Offline Deterministic Reference Evaluator' : 'Live Provider Evaluator'}`)

  let evaluator: (typeof reviewCustomerFacingContent)
  if (isOffline) {
    evaluator = createDeterministicWaesEvaluator() as unknown as typeof reviewCustomerFacingContent
  } else {
    const { isLlmConfigured } = await import('./models.ts')
    if (!isLlmConfigured()) {
      console.warn('[WAES Calibration] No live model provider configured. Falling back to deterministic reference evaluator.')
      evaluator = createDeterministicWaesEvaluator() as unknown as typeof reviewCustomerFacingContent
    } else {
      evaluator = reviewCustomerFacingContent
    }
  }

  const report = await runWaesCalibrationSuite(evaluator)

  console.log('\n================== WAES CALIBRATION REPORT ==================')
  console.log(`Version:              ${report.version}`)
  console.log(`Timestamp:            ${report.timestamp}`)
  console.log(`Total Cases:          ${report.totalCases}`)
  console.log(`Agreement Rate:       ${(report.agreementRate * 100).toFixed(1)}% (target: >= 85%)`)
  console.log(`Critical False-Pass:  ${report.criticalFalsePassCount} (target: 0)`)
  console.log(`False-Pass Rate:      ${(report.falsePassRate * 100).toFixed(1)}% (target: <= 5%)`)
  console.log(`Status:               ${report.calibrated ? 'PASS (CALIBRATED)' : 'FAIL (UNEVEN CALIBRATION)'}`)
  console.log('\n--- Breakdown by Category ---')
  for (const [cat, data] of Object.entries(report.byCategory)) {
    console.log(`  ${cat.padEnd(14)}: ${data.matched}/${data.total} matched (${(data.accuracy * 100).toFixed(0)}%), false-passes: ${data.falsePasses}`)
  }
  console.log('============================================================\n')

  if (!report.calibrated && !isOffline) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[WAES Calibration Error]', err)
  process.exit(1)
})
