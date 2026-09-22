/**
 * Day 14 smoke test — verify the seed dataset is queryable, the conflict
 * pair resolves correctly, and the entity/capability graph is intact.
 *
 * Run with: tsx apps/studio/scripts/smoke-test.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@sanity/client'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load EVERY `.env` from this directory up to the repo root, nearest first.
// (Stopping at the first one found picked up apps/studio/.env -- which only
// holds the Studio's SANITY_STUDIO_* vars -- and never reached the root .env
// with SANITY_AUTH_TOKEN.) Earlier files and real env vars win.
function findEnvFiles(startDir: string, maxDepth = 6): string[] {
  const found: string[] = []
  let dir = startDir
  for (let i = 0; i < maxDepth; i++) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) found.push(candidate)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

for (const envPath of findEnvFiles(__dirname)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#\s][^=\s]*)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

async function main() {
  const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
  const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production'
  const token = process.env.SANITY_AUTH_TOKEN

  if (!projectId || !token) {
    console.error('NEXT_PUBLIC_SANITY_PROJECT_ID and SANITY_AUTH_TOKEN required.')
    process.exit(1)
  }

  const client = createClient({ projectId, dataset, apiVersion: '2024-10-01', token, useCdn: false })

  console.log(`\nDataset: ${projectId}/${dataset}\n`)

  const counts = await client.fetch<Record<string, number>>(`{
    "organization": count(*[_type == "organization"]),
    "capabilities": count(*[_type == "capability"]),
    "policies": count(*[_type == "policy"]),
    "entities": count(*[_type == "entity"]),
    "departments": count(*[_type == "department"]),
    "objectives": count(*[_type == "objective"]),
    "workflows": count(*[_type == "workflow"]),
    "evidence": count(*[_type == "evidence"]),
    "decisions": count(*[_type == "decision"]),
    "metrics": count(*[_type == "metric"])
  }`)

  console.log('Document counts:')
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(15)} ${v}`)
  }

  // Conflict pair probe
  const conflict = await client.fetch<{
    ops17: { name: string; scope: string; priority: number } | null
    emergency4: { name: string; scope: string; priority: number } | null
  }>(`{
    "ops17": *[_type == "policy" && _id == "policy-ops-17"][0]{ name, scope, priority },
    "emergency4": *[_type == "policy" && _id == "policy-emergency-4"][0]{ name, scope, priority }
  }`)

  console.log('\nPolicy conflict pair:')
  console.log(`  Ops 17:        ${conflict.ops17 ? `${conflict.ops17.name} (priority ${conflict.ops17.priority})` : '— MISSING —'}`)
  console.log(`  Emergency 4:   ${conflict.emergency4 ? `${conflict.emergency4.name} (priority ${conflict.emergency4.priority})` : '— MISSING —'}`)
  if (conflict.ops17 && conflict.emergency4 && conflict.ops17.scope === conflict.emergency4.scope) {
    console.log(`  ✓ Same scope: ${conflict.ops17.scope}`)
  } else {
    console.log('  ✗ Conflict pair broken or scopes diverged')
  }

  // Capability chain probe
  const capability = await client.fetch<{
    name: string
    authorized: string[]
  }>(`*[_type == "capability" && _id == "cap-process-param"][0]{
    name,
    "authorized": authorizedEntities[]->name
  }`)

  console.log('\nCapability resolution:')
  console.log(`  ${capability.name} authorizes:`)
  for (const name of capability.authorized) console.log(`    • ${name}`)

  // Decision probe
  const decision = await client.fetch<{
    question: string
    status: string
    riskLevel: number
    requiredApproval: boolean
  } | null>(
    `*[_type == "decision" && _id == "decision-cnc2-param"][0]{ question, status, riskLevel, requiredApproval }`,
  )
  console.log('\nSeed decision:')
  if (decision) {
    console.log(`  ${decision.question}`)
    console.log(`  status=${decision.status}  risk=${decision.riskLevel}/5  requiresApproval=${decision.requiredApproval}`)
  } else {
    console.log('  — MISSING —')
  }

  console.log('\n✓ Smoke test complete\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})