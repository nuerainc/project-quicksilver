import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// A test file that no script lists never runs, and nothing fails to say so. This keeps every test file in a package.json script.
// It walks the file system (not git), so it behaves the same on every platform and in a checkout with no git on the path.

const root = fileURLToPath(new URL('..', import.meta.url))
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'data', '.turbo', 'out'])
const TEST_FILE = /\.test\.(?:ts|mjs|cjs|js)$/

async function findTests(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) found.push(...(await findTests(join(dir, entry.name))))
    } else if (TEST_FILE.test(entry.name)) {
      found.push(relative(root, join(dir, entry.name)).split(sep).join('/'))
    }
  }
  return found
}

const present = await findTests(root)
const scripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts
const listed = new Set(Object.values(scripts).flatMap((command) => command.match(/[\w./-]+\.test\.(?:ts|mjs|cjs|js)/g) ?? []))

test('every test file is listed in a package.json script', () => {
  assert.ok(present.length > 100, `expected to find the repository's test files, found ${present.length}`)
  const missing = present.filter((file) => !listed.has(file))
  assert.deepEqual(missing, [], `these test files are not run by any script in package.json: ${missing.join(', ')}`)
})

test('every test file a script lists exists', () => {
  const have = new Set(present)
  const stale = [...listed].filter((file) => !have.has(file))
  assert.deepEqual(stale, [], `package.json lists test files that are not in the repository: ${stale.join(', ')}`)
})
