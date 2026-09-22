/**
 * Schema deploy wrapper.
 *
 * The Sanity CLI's `sanity schema deploy` doesn't read `SANITY_AUTH_TOKEN`
 * from a non-interactive env on its own — it expects a `sanity login` session
 * in `~/.config/sanity/`. This wrapper loads `.env` from the workspace root,
 * sets the env var, then spawns the CLI command with the variable available.
 *
 * Run with:   npm run schema:deploy
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([^#\s][^=\s]*)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2]
    }
  }
}

if (!process.env.SANITY_AUTH_TOKEN) {
  console.error('SANITY_AUTH_TOKEN is required. Set it in .env at the workspace root.')
  process.exit(1)
}

process.env.SANITY_CLI_SCHEMA_STORE_ENABLED = 'true'

console.log(`Deploying schema with project=${process.env.NEXT_PUBLIC_SANITY_PROJECT_ID} dataset=${process.env.NEXT_PUBLIC_SANITY_DATASET}...`)

const result = spawnSync('npx', ['--yes', 'sanity@latest', 'schema', 'deploy'], {
  env: process.env,
  stdio: 'inherit',
  shell: true,
})

process.exit(result.status ?? 1)