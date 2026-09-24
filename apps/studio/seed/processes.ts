/**
 * Push ONLY the process definitions (seed/workflows.ts) to Sanity.
 *
 * Use this instead of the full `npm run seed` when you just want the kernel's
 * process definitions in Content Lake -- it touches the two `workflow`
 * documents and nothing else, so it can't overwrite decisions or other
 * content edited since the original seed.
 *
 * Before writing, every definition is run through the kernel's own validator;
 * an invalid definition is never pushed.
 *
 * Run with:   npm run seed:processes
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@sanity/client'
import { workflows } from './workflows'
import { processToSanityFields } from '../../../packages/kernel/src/process-document.ts'
import { validateProcessDefinition } from '../../../packages/kernel/src/process.ts'

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
  if (!projectId || projectId === 'd280bqjc') {
    console.error('Set NEXT_PUBLIC_SANITY_PROJECT_ID to the dedicated Nuera Quicksilver Sanity project; legacy challenge writes are blocked.')
    process.exit(1)
  }
  const token = process.env.SANITY_AUTH_TOKEN
  if (!token) {
    console.error('SANITY_AUTH_TOKEN is required (write scope). Set it in the root .env.')
    process.exit(1)
  }
  const client = createClient({
    projectId,
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
    apiVersion: '2024-10-01',
    token,
    useCdn: false,
  })

  const tx = client.transaction()
  for (const w of workflows) {
    const def = { id: w._id, name: w.name, version: w.version, initialState: w.initialState, states: w.states, transitions: w.transitions }
    const v = validateProcessDefinition(def)
    if (!v.valid) {
      console.error(`✗ ${w.name} v${w.version} is invalid, not pushing anything:\n  - ${v.errors.join('\n  - ')}`)
      process.exit(1)
    }
    for (const warning of v.warnings) console.warn(`! ${w.name}: ${warning}`)
    tx.createOrReplace({
      _id: w._id,
      _type: 'workflow',
      trigger: w.trigger,
      ...processToSanityFields(def),
      requiredCapabilities: w.requiredCapabilityIds.map((id, i) => ({ _type: 'reference', _ref: id, _key: `k${i}` })),
      approvalRequirements: w.approvalRequirementIds.map((id, i) => ({ _type: 'reference', _ref: id, _key: `k${i}` })),
      failureHandlers: w.failureHandlers,
      rollbackProcedure: w.rollbackProcedure,
    })
    console.log(`✓ ${w.name} v${w.version} (${w.states.length} states, ${w.transitions.length} transitions)`)
  }
  await tx.commit()
  console.log('Process definitions pushed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
