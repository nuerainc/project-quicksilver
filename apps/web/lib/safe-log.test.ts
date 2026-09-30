import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeErrorName } from './safe-log.ts'

test('web error reporting exposes only a safe error class, never its message', () => {
  const secret = 'sk-test-very-secret-value'
  assert.equal(safeErrorName(new Error(`request failed using ${secret}`)), 'Error')
  assert.equal(safeErrorName({ name: 'Bad\nAuthorization', message: secret }), 'UnknownError')
  assert.equal(safeErrorName(null), 'UnknownError')
})

test('web API routes never return or log raw exception messages', () => {
  const root = fileURLToPath(new URL('../app/api/', import.meta.url))
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/^route\.tsx?$/.test(name)) files.push(path)
    }
  }
  walk(root)
  const unsafe: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (/console\.(?:error|warn|log)\([^\n]*,\s*(?:err|error)\s*\)/.test(text)) unsafe.push(`${file}: raw exception logged`)
    if (/(?:detail|error)\s*:\s*\(err\s+as\s+Error\)\.message/.test(text)) unsafe.push(`${file}: raw exception returned`)
  }
  assert.deepEqual(unsafe, [])
})
