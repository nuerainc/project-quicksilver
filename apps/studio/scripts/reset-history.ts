/**
 * Reset decision history — one command, in order, safe by default.
 *
 *   npm run reset:history              # dry run: backup + show exactly what would be deleted
 *   npm run reset:history -- --confirm # do it
 *
 * Steps:
 *   1. Preflight   — token present, every process definition in seed/workflows.ts valid.
 *   2. Backup      — `sanity dataset export` to apps/studio/backups/ (aborts on failure;
 *                    --skip-backup to bypass, not recommended).
 *   3. Inventory   — every `decision`, runtime `metric`, and Sanity Workflows plugin
 *                    metadata doc (`workflow.metadata`), drafts included.
 *   4. Delete      — only with --confirm. Plugin metadata and rollback decisions go
 *                    first, because they hold strong references to other decisions.
 *   5. Re-seed     — `npm run seed`: restores the 53 baseline docs, including the one
 *                    seeded decision and both process definitions (Decision Lifecycle v2).
 *   6. Verify      — counts after, definition version in Content Lake, `npm run smoke`.
 *
 * Nothing else is touched: organization, departments, entities, capabilities,
 * policies, objectives, evidence, and the Knowledge Base are left as they are
 * (the re-seed rewrites them with identical content).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createClient } from '@sanity/client'
import { workflows } from '../seed/workflows'
import { validateProcessDefinition } from '../../../packages/kernel/src/process.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const studioDir = join(__dirname, '..')

// Load EVERY `.env` from this directory up to the repo root, nearest first.
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

const args = new Set(process.argv.slice(2))
const CONFIRM = args.has('--confirm')
const SKIP_BACKUP = args.has('--skip-backup')

const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || 'd280bqjc'
const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET || 'production'

function step(n: number, title: string) {
  console.log(`\n── ${n}. ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}
function fail(msg: string): never {
  console.error(`\n✗ ${msg}\nNothing was deleted.`)
  process.exit(1)
}
function run(cmd: string, cmdArgs: string[], cwd: string): number {
  const r = spawnSync(cmd, cmdArgs, { cwd, env: process.env, stdio: 'inherit', shell: true })
  return r.status ?? 1
}

async function main() {
  console.log(`Quicksilver history reset — ${projectId}/${dataset} — ${CONFIRM ? 'LIVE RUN' : 'DRY RUN (add -- --confirm to delete)'}`)

  // 1. Preflight
  step(1, 'Preflight')
  const token = process.env.SANITY_AUTH_TOKEN
  if (!token) fail('SANITY_AUTH_TOKEN is required (write scope) in the root .env.')
  for (const w of workflows) {
    const v = validateProcessDefinition({ id: w._id, name: w.name, version: w.version, initialState: w.initialState, states: w.states, transitions: w.transitions })
    if (!v.valid) fail(`${w.name} v${w.version} is invalid: ${v.errors.join(' ')}`)
    console.log(`✓ ${w.name} v${w.version} is valid`)
  }
  const client = createClient({ projectId, dataset, apiVersion: '2024-10-01', token, useCdn: false, perspective: 'raw' })

  // 2. Backup
  step(2, 'Backup')
  if (SKIP_BACKUP) {
    console.log('! --skip-backup given: no backup taken.')
  } else {
    const backupsDir = join(studioDir, 'backups')
    mkdirSync(backupsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join('backups', `quicksilver-${dataset}-${stamp}.tar.gz`)
    console.log(`Exporting ${dataset} → apps/studio/${file.replace(/\\/g, '/')}`)
    const code = run('npx', ['sanity', 'dataset', 'export', dataset, `"${file}"`], studioDir)
    if (code !== 0) fail(`Backup failed (exit ${code}). If the Sanity CLI isn't logged in, run "npx sanity login" in apps/studio, or re-run with --skip-backup at your own risk.`)
    console.log('✓ Backup written')
  }

  // 3. Inventory
  step(3, 'Inventory')
  const inv = await client.fetch<{
    decisions: Array<{ _id: string; hasParent: boolean }>
    metrics: string[]
    metadata: string[]
  }>(`{
    "decisions": *[_type == "decision"]{ _id, "hasParent": defined(rollbackOf) },
    "metrics": *[_type == "metric"]._id,
    "metadata": *[_type == "workflow.metadata"]._id
  }`)
  console.log(`decisions:              ${inv.decisions.length}`)
  console.log(`metrics (runtime):      ${inv.metrics.length}`)
  console.log(`workflow plugin meta:   ${inv.metadata.length}`)
  const total = inv.decisions.length + inv.metrics.length + inv.metadata.length
  if (!CONFIRM) {
    console.log(`\nDry run complete: ${total} documents would be deleted, then the baseline re-seeded.`)
    console.log('Run again with:  npm run reset:history -- --confirm')
    return
  }

  // 4. Delete — referencing docs first, in batches.
  step(4, `Delete ${total} documents`)
  const ordered = [
    ...inv.metadata,
    ...inv.decisions.filter((d) => d.hasParent).map((d) => d._id),
    ...inv.decisions.filter((d) => !d.hasParent).map((d) => d._id),
    ...inv.metrics,
  ]
  const BATCH = 100
  for (let i = 0; i < ordered.length; i += BATCH) {
    const tx = client.transaction()
    for (const id of ordered.slice(i, i + BATCH)) tx.delete(id)
    try {
      await tx.commit()
    } catch (err) {
      console.error(`\n✗ Batch ${i / BATCH + 1} failed: ${(err as Error).message}`)
      console.error(`  ${i} of ${ordered.length} documents were already deleted. Your backup is in apps/studio/backups/.`)
      console.error('  Re-running this script is safe: it only deletes what is still there.')
      process.exit(1)
    }
    console.log(`✓ Deleted ${Math.min(i + BATCH, ordered.length)} / ${ordered.length}`)
  }

  // 5. Re-seed baseline
  step(5, 'Re-seed baseline (npm run seed)')
  const seedCode = run('npm', ['run', 'seed'], studioDir)
  if (seedCode !== 0) {
    console.error(`\n✗ Re-seed failed (exit ${seedCode}). The history is deleted; run "npm run seed" again once fixed.`)
    process.exit(1)
  }

  // 6. Verify
  step(6, 'Verify')
  const after = await client.fetch<{ decisions: number; metrics: number; metadata: number; lifecycle: { version: number; transitions: number } | null }>(`{
    "decisions": count(*[_type == "decision"]),
    "metrics": count(*[_type == "metric"]),
    "metadata": count(*[_type == "workflow.metadata"]),
    "lifecycle": *[_id == "workflow-decision-lifecycle"][0]{ version, "transitions": count(transitions) }
  }`)
  console.log(`decisions now:          ${after.decisions} (expected 1 seeded)`)
  console.log(`metrics now:            ${after.metrics} (expected 0)`)
  console.log(`workflow plugin meta:   ${after.metadata} (expected 0)`)
  console.log(`Decision Lifecycle:     v${after.lifecycle?.version ?? '?'}, ${after.lifecycle?.transitions ?? '?'} transitions (expected v2, 12)`)
  const smoke = run('npm', ['run', 'smoke'], studioDir)
  const ok = after.decisions === 1 && after.metrics === 0 && after.metadata === 0 && after.lifecycle?.version === 2 && smoke === 0
  console.log(ok ? '\n✓ Reset complete. The decision history is clean and ready to rebuild.' : '\n! Reset finished, but a check above did not match — paste this output to Claude.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
