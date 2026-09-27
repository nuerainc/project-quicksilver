/**
 * Reset the public demo dataset (Sanity Challenge edition) to the synthetic
 * seed. Refuses any dataset that is not a demo dataset.
 *
 *   npm run demo:reset              # dry run: shows what would be deleted
 *   npm run demo:reset -- --confirm # do it
 *
 * Steps: check the demo guard (the same one the web app uses, see
 * apps/web/lib/demo-mode.ts), delete the evaluation records visitors created,
 * then run `reset:history` (decisions, metrics and workflow metadata, then
 * re-seed and smoke test). No backup: the demo dataset holds only synthetic
 * seed data and visitors' test decisions.
 *
 * Run it from a shell whose environment names the demo dataset
 * (NEXT_PUBLIC_SANITY_DATASET=challenge, SANITY_DATASET_PUBLIC=on,
 * NEXT_PUBLIC_QUICKSILVER_DEMO_MODE=on) and holds no real credential, for
 * example a scheduled GitHub Action in the challenge repository.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { demoModeProblems } from '../../web/lib/demo-mode.ts'
import { requireStudioSanityClient } from '../lib/sanity-client.ts'

const studioDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const confirm = process.argv.includes('--confirm')

if ((process.env.NEXT_PUBLIC_QUICKSILVER_DEMO_MODE ?? '').trim().toLowerCase() !== 'on') {
  console.error('demo:reset only runs with NEXT_PUBLIC_QUICKSILVER_DEMO_MODE=on (it resets the public demo dataset, never a private one).')
  process.exit(1)
}
const problems = demoModeProblems(process.env)
if (problems.length) {
  console.error(`Refusing to reset:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}

const { client, config } = requireStudioSanityClient('write')
console.log(`Demo reset: ${config.projectId}/${config.dataset} (${confirm ? 'LIVE RUN' : 'DRY RUN, add -- --confirm'})`)

const ids = await client.fetch<string[]>('*[_type == "evaluationRecord"]._id')
console.log(`Evaluation records to delete: ${ids.length}`)
if (confirm && ids.length) {
  for (let i = 0; i < ids.length; i += 100) {
    const tx = client.transaction()
    for (const id of ids.slice(i, i + 100)) tx.delete(id)
    await tx.commit()
  }
}

const args = ['run', 'reset:history', '--', '--skip-backup', ...(confirm ? ['--confirm'] : [])]
const r = spawnSync('npm', args, { cwd: studioDir, stdio: 'inherit', shell: true })
process.exit(r.status ?? 1)
