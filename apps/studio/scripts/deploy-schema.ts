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

if (!process.env.SANITY_AUTH_TOKEN) {
  console.error('SANITY_AUTH_TOKEN is required. Set it in .env at the workspace root.')
  process.exit(1)
}

process.env.SANITY_CLI_SCHEMA_STORE_ENABLED = 'true'

console.log(`Deploying schema with project=${process.env.NEXT_PUBLIC_SANITY_PROJECT_ID} dataset=${process.env.NEXT_PUBLIC_SANITY_DATASET}...`)

// Use the project's own pinned Sanity CLI, not `sanity@latest`: a freshly
// downloaded CLI fails to load this workspace's config ("exports is not
// defined"), and `npm run deploy` (sanity deploy) already deploys the schema
// with the local CLI anyway.
const result = spawnSync('npx', ['sanity', 'schema', 'deploy'], {
  env: process.env,
  stdio: 'inherit',
  shell: true,
})

process.exit(result.status ?? 1)