/**
 * Schema deploy wrapper.
 *
 * Schema deployment needs Sanity's deployStudio/deploySchema grants, which the
 * app's content token (SANITY_AUTH_TOKEN, Editor) should not have. Pick one:
 *
 *   npm run schema:deploy                 uses SANITY_DEPLOY_TOKEN (a "Deploy Studio"
 *                                         token), else falls back to SANITY_AUTH_TOKEN
 *   npm run schema:deploy -- --login      uses your `npx sanity login` session and
 *                                         ignores every token in .env
 *
 * `.env` files are loaded from this directory up to the repo root, nearest
 * first. Token values are never printed; only which file supplied them.
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

const sources: Record<string, string> = {}
for (const key of Object.keys(process.env)) sources[key] = 'shell environment'
for (const envPath of findEnvFiles(__dirname)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#\s][^=\s]*)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2]
      sources[match[1]] = envPath
    }
  }
}

const useLogin = process.argv.includes('--login')
if (useLogin) {
  // The CLI prefers SANITY_AUTH_TOKEN over a login session, so remove it.
  delete process.env.SANITY_AUTH_TOKEN
  console.log('Using your `sanity login` session (tokens from .env are ignored).')
} else if (process.env.SANITY_DEPLOY_TOKEN) {
  process.env.SANITY_AUTH_TOKEN = process.env.SANITY_DEPLOY_TOKEN
  console.log(`Using SANITY_DEPLOY_TOKEN from ${sources.SANITY_DEPLOY_TOKEN ?? 'environment'}.`)
} else if (process.env.SANITY_AUTH_TOKEN) {
  console.log(`Using SANITY_AUTH_TOKEN from ${sources.SANITY_AUTH_TOKEN ?? 'environment'} (no SANITY_DEPLOY_TOKEN set).`)
} else {
  console.error('No credential: set SANITY_DEPLOY_TOKEN in the root .env, or run `npm run schema:deploy -- --login` after `npx sanity login`.')
  process.exit(1)
}

process.env.SANITY_CLI_SCHEMA_STORE_ENABLED = 'true'

console.log(`Deploying schema with project=${process.env.SANITY_STUDIO_PROJECT_ID} dataset=${process.env.SANITY_STUDIO_DATASET || 'production'}...`)

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