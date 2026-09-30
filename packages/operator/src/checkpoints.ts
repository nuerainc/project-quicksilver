/**
 * File checkpoints: before a tool writes a file, its current content (or the
 * fact that it did not exist) is copied into `.qs-checkpoints/<run>/`. A run
 * can then be rolled back, newest change first. Agents cannot touch this
 * directory (policy.ts protects it).
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

import type { CheckpointStore } from './types.ts'

interface Entry { id: string; path: string; existed: boolean; at: string }

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,80}$/

export class FileCheckpointStore implements CheckpointStore {
  private readonly root: string
  private readonly workspace: string

  constructor(workspace: string) {
    this.workspace = resolve(workspace)
    this.root = join(this.workspace, '.qs-checkpoints')
  }

  private dir(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error('Invalid run id.')
    return join(this.root, runId)
  }

  async list(runId: string): Promise<Entry[]> {
    try {
      return JSON.parse(await readFile(join(this.dir(runId), 'index.json'), 'utf8')) as Entry[]
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
  }

  async snapshot(runId: string, path: string): Promise<string> {
    const abs = resolve(this.workspace, path)
    const nativeRel = relative(this.workspace, abs)
    if (nativeRel === '..' || nativeRel.startsWith(`..${sep}`) || resolve(this.workspace, nativeRel) !== abs) throw new Error('Checkpoints cover workspace files only.')
    // Keep persisted checkpoint paths portable so a run can be inspected or
    // restored on another platform without leaking host-specific separators.
    const rel = nativeRel.split(sep).join('/')
    const dir = this.dir(runId)
    await mkdir(join(dir, 'files'), { recursive: true, mode: 0o700 })
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    const existed = existsSync(abs)
    if (existed) await copyFile(abs, join(dir, 'files', id))
    const entries = await this.list(runId)
    entries.push({ id, path: rel, existed, at: new Date().toISOString() })
    await writeFile(join(dir, 'index.json'), JSON.stringify(entries, null, 1), { mode: 0o600 })
    return id
  }

  async rollback(runId: string): Promise<string[]> {
    const dir = this.dir(runId)
    const entries = await this.list(runId)
    const restored: string[] = []
    // Newest first; the oldest snapshot of each path wins, which is the state before the run.
    for (const e of [...entries].reverse()) {
      const abs = resolve(this.workspace, e.path)
      if (e.existed) {
        await mkdir(dirname(abs), { recursive: true })
        await copyFile(join(dir, 'files', e.id), abs)
      } else {
        await rm(abs, { force: true })
      }
      if (!restored.includes(e.path)) restored.push(e.path)
    }
    await rm(dir, { recursive: true, force: true })
    return restored
  }
}
