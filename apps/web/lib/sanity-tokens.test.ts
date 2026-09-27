/**
 * Threat model A-7: separate Sanity read and write tokens, and one auditable
 * place per app or package that creates Sanity clients. Run by `seed:test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

register('./route-test-loader.mjs', import.meta.url)

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** The only files allowed to call @sanity/client's createClient or read the Sanity token variables, and why. */
const CLIENT_HELPERS = new Map([
  ['apps/web/lib/sanity-client.ts', 'the web app\'s one client helper'],
  ['packages/host/src/sanity-client.ts', 'the host\'s one client helper'],
  ['apps/studio/lib/sanity-client.ts', 'the Studio scripts\' one client helper'],
  ['packages/kernel/src/sanity-tokens.ts', 'the shared read/write token choice (reads env, creates no client)'],
  ['apps/studio/scripts/deploy-schema.ts', 'schema deploys: clears SANITY_AUTH_TOKEN so the Sanity CLI uses SANITY_DEPLOY_TOKEN or a login session; creates no client'],
])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) return []
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : []
  })
}

test('Sanity clients (A-7): only the per-app helpers create clients or read SANITY_*_TOKEN', () => {
  const offenders: string[] = []
  for (const root of ['apps/web', 'apps/studio', 'packages/host', 'packages/kernel/src']) {
    for (const file of sourceFiles(join(REPO, root))) {
      const rel = relative(REPO, file).split('\\').join('/')
      if (CLIENT_HELPERS.has(rel)) continue
      const text = readFileSync(file, 'utf8')
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (/\bcreateClient\s*\(/.test(code) && /@sanity\/client/.test(code)) offenders.push(`${rel}: createClient`)
      if (/process\.env\.SANITY_(AUTH|READ|WRITE)_TOKEN|env\.SANITY_(AUTH|READ|WRITE)_TOKEN/.test(code)) offenders.push(`${rel}: reads a Sanity token variable`)
    }
  }
  assert.deepEqual(offenders, [], 'create Sanity clients through the app\'s helper (lib/sanity-client.ts) so read and write tokens stay separate')
})

test('Sanity clients (A-7): the web helper gives read paths the Viewer token and write paths the Editor token; the legacy project stays refused', async () => {
  const { getSanityClient } = await import('./sanity-client.ts')
  const saved = { ...process.env }
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (m: string) => { warnings.push(String(m)) }
  try {
    for (const k of ['SANITY_AUTH_TOKEN', 'SANITY_READ_TOKEN', 'SANITY_WRITE_TOKEN', 'SANITY_DATASET_PUBLIC']) delete process.env[k]
    process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = 'abc123'
    process.env.SANITY_READ_TOKEN = 'viewer-test-token'
    process.env.SANITY_WRITE_TOKEN = 'editor-test-token'
    process.env.SANITY_AUTH_TOKEN = 'combined-test-token'
    assert.equal(getSanityClient('read').config().token, 'viewer-test-token')
    assert.equal(getSanityClient('write').config().token, 'editor-test-token')
    assert.equal(warnings.length, 0, 'no warning once both tokens are set')

    delete process.env.SANITY_READ_TOKEN
    delete process.env.SANITY_WRITE_TOKEN
    assert.equal(getSanityClient('read').config().token, 'combined-test-token')
    assert.equal(getSanityClient('write').config().token, 'combined-test-token')
    getSanityClient('read')
    getSanityClient('write')
    assert.equal(warnings.length, 2, 'the fallback is warned about once per access kind')
    assert.ok(warnings.every((w) => !w.includes('combined-test-token')), 'warnings never print the token')

    process.env.SANITY_DATASET_PUBLIC = 'on'
    assert.equal(getSanityClient('read').config().token, undefined, 'a public dataset is read without a token')

    process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = 'd280bqjc'
    assert.throws(() => getSanityClient('read'), /Legacy challenge access is blocked/)
    assert.throws(() => getSanityClient('write'), /Legacy challenge access is blocked/)
  } finally {
    console.warn = warn
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})
