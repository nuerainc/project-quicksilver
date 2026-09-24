/**
 * Run the Quicksilver Engine's deterministic reasoning challenges against one
 * configured Quicksilver model role. This is opt-in and makes billable/local
 * inference requests only when explicitly invoked.
 *
 *   npm run benchmark:stress -- --role planner --seed 42 --count 12
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReasoningStressSuite, type ReasoningStressReport } from '@quicksilver/kernel'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROLES = ['planner', 'reviewer', 'router', 'executor'] as const
type Role = (typeof ROLES)[number]
const TIMEOUT_MS = 60_000

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

function parseArgs(args: string[]): { role: Role; seed: number; count: number } {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!['--role', '--seed', '--count'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    values.set(flag, value)
    index += 1
  }

  const roleValue = values.get('--role') ?? 'planner'
  if (!ROLES.includes(roleValue as Role)) throw new Error(`--role must be one of: ${ROLES.join(', ')}`)
  const seed = parseInteger(values.get('--seed') ?? '42', '--seed', 0, Number.MAX_SAFE_INTEGER - 50)
  const count = parseInteger(values.get('--count') ?? '12', '--count', 1, 50)
  return { role: roleValue as Role, seed, count }
}

function parseInteger(value: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a whole number.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be from ${min} to ${max}.`)
  }
  return parsed
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const { generateText } = await import('ai')
  const { getMode, isLlmConfigured, modelForRole, resolveId } = await import('./models.ts')
  if (!isLlmConfigured()) {
    throw new Error('No model is configured. Set provider credentials, or explicitly enable local mode in the root .env.')
  }

  const mode = getMode()
  const modelId = resolveId(options.role, mode)
  const report = await runReasoningStressSuite(
    async (challenge, parentSignal) => {
      const controller = new AbortController()
      const abortFromParent = () => controller.abort(parentSignal?.reason)
      parentSignal?.addEventListener('abort', abortFromParent, { once: true })
      const timeout = setTimeout(() => controller.abort(new Error('Model request timed out.')), TIMEOUT_MS)
      try {
        if (parentSignal?.aborted) abortFromParent()
        const result = await generateText({
          model: modelForRole(options.role),
          system: 'Answer with only the requested final answer. Give a concise user-facing justification only when requested. Do not provide private chain-of-thought.',
          prompt: challenge.prompt,
          maxRetries: 0,
          abortSignal: controller.signal,
        })
        return result.text
      } finally {
        clearTimeout(timeout)
        parentSignal?.removeEventListener('abort', abortFromParent)
      }
    },
    { seed: options.seed, count: options.count },
  )
  printReport(report, options.role, modelId, mode)
}

function printReport(report: ReasoningStressReport, role: Role, modelId: string, mode: string): void {
  console.log('\nQuicksilver Engine reasoning benchmark')
  console.log(`Role: ${role} | Model: ${modelId} | Mode: ${mode}`)
  console.log(`Seed: ${report.seed} | Score: ${report.score}% (${report.passedCount}/${report.completedCount})`)
  if (report.completedCount < report.requestedCount) {
    console.log(`Completed ${report.completedCount} of ${report.requestedCount} requested challenges.`)
  }
  for (const item of report.cases) {
    console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.challengeId} [${item.category}] — ${item.diagnostic}`)
  }
  console.log('\nResponses and answer keys are not printed or persisted by this command.')
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : 'Benchmark could not be completed.'
  console.error(`\nReasoning benchmark failed: ${message}`)
  process.exitCode = 1
}
