import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

// A test file that no script lists never runs, and nothing fails to say so. This keeps every tracked test file in a package.json script.

const root = new URL('..', import.meta.url).pathname
const tracked = execFileSync('git', ['ls-files', '*.test.ts', '*.test.mjs', '*.test.cjs', '*.test.js'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
const scripts = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).scripts
const listed = new Set(Object.values(scripts).flatMap((command) => command.match(/[\w./-]+\.test\.(?:ts|mjs|cjs|js)/g) ?? []))

test('every tracked test file is listed in a package.json script', () => {
  assert.ok(tracked.length > 100, `expected to find the repository's test files, found ${tracked.length}`)
  const missing = tracked.filter((file) => !listed.has(file))
  assert.deepEqual(missing, [], `these test files are not run by any script in package.json: ${missing.join(', ')}`)
})

test('every test file a script lists exists', () => {
  const present = new Set(tracked)
  const stale = [...listed].filter((file) => !present.has(file))
  assert.deepEqual(stale, [], `package.json lists test files that are not in the repository: ${stale.join(', ')}`)
})
