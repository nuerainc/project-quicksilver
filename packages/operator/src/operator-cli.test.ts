/** User-facing memory backup and feedback commands in the Operator CLI. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { generateToken } from '@quicksilver/kernel/identity/tokens'
import { MemoryBook } from './memory.ts'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(repo, 'packages', 'operator', 'src', 'cli.ts')

test('Operator CLI exports, restores, and records reviewer feedback without overwriting backups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-operator-cli-memory-'))
  const credential = generateToken()
  const developerCredential = generateToken()
  const { verifyAudit } = await import('./audit.ts')
  const env = {
    ...process.env,
    INIT_CWD: dir,
    QUICKSILVER_OPERATOR_APPROVER: 'forged-supervisor',
    QUICKSILVER_OPERATOR_TOKEN: credential.token,
    QUICKSILVER_TENANT_ID: 'default',
    QUICKSILVER_PRINCIPALS: JSON.stringify([
      { id: 'user:memory-reviewer', kind: 'human', tenantId: 'default', roles: ['supervisor'], tokenDigest: credential.tokenDigest },
      { id: 'user:developer', kind: 'human', tenantId: 'default', roles: ['developer'], tokenDigest: developerCredential.tokenDigest },
    ]),
  }
  const runWith = (runEnv: NodeJS.ProcessEnv, ...args: string[]) => exec(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { cwd: repo, env: runEnv })
  const run = (...args: string[]) => runWith(env, ...args)
  try {
    await assert.rejects(runWith({ ...env, QUICKSILVER_OPERATOR_TOKEN: 'invalid-credential' }, '--workspace', 'source', '--memory', 'export', '--memory-file', 'denied.json'), /Memory operation denied/)
    await assert.rejects(runWith({ ...env, QUICKSILVER_OPERATOR_TOKEN: developerCredential.token }, '--workspace', 'source', '--memory', 'export', '--memory-file', 'denied-by-role.json'), /Memory operation denied/)
    await assert.rejects(runWith({ ...env, QUICKSILVER_PRINCIPALS: '{invalid' }, '--workspace', 'source', '--memory', 'export', '--memory-file', 'denied-by-config.json'), /Memory operation denied/)
    const source = new MemoryBook(join(dir, 'source', '.qs-memory', 'memory.json'))
    const stated = await source.addStated('user', 'Prefers concise rollout reports.', 'person')
    const note = await source.agentWrite({ scope: 'notes', text: 'Check the health endpoint after rollout.' }, { by: 'agent:operator', runId: 'run-7' })
    assert.ok(note.ok)
    const backup = join(dir, 'memory-backup.json')
    const exported = await run('--workspace', 'source', '--memory', 'export', '--memory-file', 'memory-backup.json')
    assert.match(exported.stdout, /Protect it as sensitive plaintext/)
    if (process.platform !== 'win32') assert.equal((await stat(backup)).mode & 0o777, 0o600)
    await assert.rejects(run('--workspace', 'source', '--memory', 'export', '--memory-file', 'memory-backup.json'), /EEXIST/)

    const restored = await run('--workspace', 'restored', '--memory', 'restore', '--memory-file', 'memory-backup.json')
    assert.match(restored.stdout, /Restored verified memory/)
    const restoredBook = new MemoryBook(join(dir, 'restored', '.qs-memory', 'memory.json'))
    assert.equal((await restoredBook.all()).find((entry) => entry.id === stated.id)?.text, stated.text)
    assert.equal((await restoredBook.all()).find((entry) => note.ok && entry.id === note.entry.id)?.text, note.ok ? note.entry.text : undefined)

    const feedback = await run('--workspace', 'restored', '--memory', 'feedback', '--memory-id', note.entry.id, '--outcome', 'useful')
    assert.match(feedback.stdout, /Recorded useful feedback/)
    assert.equal((await restoredBook.all()).find((entry) => entry.id === note.entry.id)?.effectiveness?.useful, 1)
    await assert.rejects(run('--workspace', 'restored', '--memory', 'feedback', '--memory-id', note.entry.id, '--outcome', 'harmful'), /Feedback was not recorded/)
    await assert.rejects(run('--workspace', 'restored', '--memory', 'restore', '--memory-file', 'memory-backup.json'), /empty memory book/)

    const badBackup = JSON.parse(await readFile(backup, 'utf8')) as { digest: string }
    await writeFile(join(dir, 'tampered.json'), JSON.stringify({ ...badBackup, digest: 'sha256:tampered' }))
    await assert.rejects(run('--workspace', 'tampered', '--memory', 'restore', '--memory-file', 'tampered.json'), /digest does not match/)
    const audit = await readFile(join(dir, 'source', '.qs-audit', 'operator.jsonl'), 'utf8')
    assert.match(audit, /memory\.authorization/)
    assert.match(audit, /"allowed":false/)
    assert.match(audit, /user:memory-reviewer/)
    assert.equal(verifyAudit(audit.trim().split('\n').map((line) => JSON.parse(line))).valid, true, 'memory authorization decisions are recorded in the verified audit chain')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
