/**
 * LLM verification — run after configuring a provider (Azure, or a direct key).
 *
 *   npm run verify:llm
 *
 * For every role it sends a trivial request. For planner and reviewer it also
 * runs the real thing in miniature: a tool call, then structured output that
 * must satisfy the production PlanOutputSchema. That catches the failures that
 * only show up against a live deployment: a model without tool calling, a
 * deployment that rejects the JSON schema, wrong deployment names, no quota.
 * Reads .env from the repo root. Exits non-zero if any check fails.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function findEnvFile(startDir: string, maxDepth = 6): string | null {
  let dir = startDir
  for (let i = 0; i < maxDepth; i++) {
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
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

const { generateText, Output, stepCountIs, tool } = await import('ai')
const { z } = await import('zod')
const { getMode, isLlmConfigured, modelForRole, resolveId } = await import('./models.ts')
const { PlanOutputSchema } = await import('./planner.ts')

type Role = 'planner' | 'reviewer' | 'router' | 'executor'
const ROLES: Role[] = ['planner', 'reviewer', 'router', 'executor']
const TIMEOUT_MS = 60_000

let failures = 0
const pass = (label: string, detail: string) => console.log(`  ✓ ${label.padEnd(26)} ${detail}`)
const fail = (label: string, err: unknown) => {
  failures++
  const msg = err instanceof Error ? err.message : String(err)
  console.log(`  ✗ ${label.padEnd(26)} ${msg.split('\n')[0].slice(0, 220)}`)
}

async function ping(role: Role) {
  const id = resolveId(role, getMode())
  try {
    const r = await generateText({
      model: modelForRole(role),
      prompt: 'Reply with the single word: OK',
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    })
    pass(`${role} → ${id}`, `responded: "${r.text.trim().slice(0, 40)}"`)
  } catch (err) {
    fail(`${role} → ${id}`, err)
  }
}

async function toolAndSchema(role: Role) {
  const id = resolveId(role, getMode())
  const label = `${role} tools+schema`
  try {
    const lookup = tool({
      description: 'Look up an entity by name and return its Sanity document id.',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => ({ id: 'entity-engineering-agent', name }),
    })
    const r = await generateText({
      model: modelForRole(role),
      system: 'You are a planning agent. Use tools to look up ids; never invent ids.',
      prompt:
        'Objective: "Reduce downtime by 20%". Use the lookup tool to find the "Engineering Agent" entity, then emit a plan ' +
        'with ONE candidate action performed by that entity (actorId = the id the tool returned), capabilityId "cap-process-param", ' +
        'empty applicablePolicyIds and evidenceIds arrays, financialExposure 0, reversible true, operationalImpact 1, uncertainty 1.',
      tools: { lookup },
      experimental_output: Output.object({ schema: PlanOutputSchema }),
      stopWhen: stepCountIs(6),
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    } as Parameters<typeof generateText>[0])
    const out = (r as unknown as { experimental_output?: { candidateActions: Array<{ actorId: string }> } }).experimental_output
    if (!out?.candidateActions?.length) throw new Error('no structured plan returned')
    if (out.candidateActions[0].actorId !== 'entity-engineering-agent') {
      throw new Error(`plan did not use the tool result (actorId = ${out.candidateActions[0].actorId})`)
    }
    pass(`${label} (${id})`, `${r.steps.length} steps, plan parsed, actor id taken from tool result`)
  } catch (err) {
    fail(`${label} (${id})`, err)
  }
}

console.log(`\nMode: ${getMode()}`)
if (!isLlmConfigured()) {
  console.error(
    '\nNo LLM configured. Put AZURE_RESOURCE_NAME + AZURE_API_KEY (or a direct provider key) in the root .env.\n',
  )
  process.exit(1)
}
console.log(`Deployments/models: ${ROLES.map((r) => `${r}=${resolveId(r, getMode())}`).join('  ')}\n`)

for (const role of ROLES) await ping(role)
console.log()
for (const role of ['planner', 'reviewer'] as const) await toolAndSchema(role)

console.log(failures === 0 ? '\n✓ LLM verified\n' : `\n✗ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
