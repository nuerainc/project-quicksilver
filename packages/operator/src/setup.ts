/**
 * One place that assembles an operator run for a person: their memory, the
 * skills, project context, the tools and the gate. The terminal CLI, the
 * channel gateway and scheduled automations all use it, so a run behaves the
 * same wherever it starts.
 */
import { lstat, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

import type { AuditSink } from './audit.ts'
import { Gate, type Approver } from './gate.ts'
import { runOperator, type ModelDriver, type RunOptions, type RunResult } from './loop.ts'
import { loadProjectContext, MemoryBook, memoryTools, SessionArchive } from './memory.ts'
import { SkillLibrary, skillTools } from './skills.ts'
import { EXEC_TOOLS } from './tools/exec.ts'
import { FILE_TOOLS } from './tools/files.ts'
import type { ApprovalMode, CheckpointStore, OperatorTool, Sandbox } from './types.ts'

export interface OperatorEnvironment {
  workspace: string
  sandbox: Sandbox
  checkpoints: CheckpointStore
  audit: AuditSink
  skills: SkillLibrary
  model: ModelDriver
  /** Extra tools (for example delivery tools for automations). */
  extraTools?: OperatorTool<any>[]
}

/** Memory directory for a person (one memory across every channel). `null` = the workspace's own. */
export function memoryDir(workspace: string, personId: string | null): string {
  return personId !== null ? join(workspace, '.qs-memory', 'people', `id-${Buffer.from(personId, 'utf8').toString('base64url')}`) : join(workspace, '.qs-memory')
}

/**
 * Move unambiguous legacy namespaces for simple IDs. Legacy paths for IDs
 * containing punctuation were lossy and may have been shared by multiple
 * people, so they are deliberately left untouched for an owner-led migration.
 */
export async function migrateLegacyMemoryNamespace(workspace: string, personId: string | null): Promise<'none' | 'migrated' | 'manual-review-required'> {
  if (!personId) return 'none'
  const simpleId = /^[A-Za-z0-9_-]{1,180}$/.test(personId)
  const legacyName = simpleId ? personId : personId.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!simpleId && !/^[A-Za-z0-9_-]{1,180}$/.test(legacyName)) return 'manual-review-required'
  const legacy = join(workspace, '.qs-memory', legacyName)
  const target = memoryDir(workspace, personId)
  let sourceStat
  try { sourceStat = await lstat(legacy) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none'
    throw error
  }
  if (!simpleId) return 'manual-review-required'
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error('Legacy memory namespace is not a regular directory; refusing migration.')
  try {
    await lstat(target)
    throw new Error('Both legacy and collision-safe memory namespaces exist; refusing to merge them automatically.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(join(workspace, '.qs-memory', 'people'), { recursive: true, mode: 0o700 })
  try {
    await rename(legacy, target)
    return 'migrated'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await lstat(target)
        return 'migrated'
      } catch (targetError) {
        if ((targetError as NodeJS.ErrnoException).code === 'ENOENT') throw error
        throw targetError
      }
    }
    throw error
  }
}

export interface PersonRun {
  goal: string
  personId: string | null
  mode: ApprovalMode
  approver: Approver
  /** Lines placed before memory, skills and project context. */
  preamble?: string[]
  options?: Omit<RunOptions, 'goal' | 'instructions'>
}

/** Run the operator for one goal with the person's memory; archive the run and score the skills it used. */
export async function runForPerson(envr: OperatorEnvironment, run: PersonRun): Promise<RunResult & { pendingMemory: number; pendingSkills: number }> {
  const migration = await migrateLegacyMemoryNamespace(envr.workspace, run.personId)
  if (migration === 'manual-review-required') {
    throw new Error('Legacy person memory path may be shared by multiple identities; manual owner review is required before this person can use memory.')
  }
  const dir = memoryDir(envr.workspace, run.personId)
  const book = new MemoryBook(join(dir, 'memory.json'))
  const archive = new SessionArchive(dir)
  const used: string[] = []
  const project = await loadProjectContext(envr.workspace)
  try {
    await book.purgeExpired()
    const gate = new Gate([...FILE_TOOLS, ...EXEC_TOOLS, ...memoryTools(book, archive), ...skillTools(envr.skills, used), ...(envr.extraTools ?? [])], { mode: run.mode, workspace: envr.workspace, audit: envr.audit })
    const result = await runOperator(
      { gate, sandbox: envr.sandbox, checkpoints: envr.checkpoints, audit: envr.audit, workspace: envr.workspace, model: envr.model, approver: run.approver },
      { ...run.options, goal: run.goal, instructions: [...(run.preamble ?? []), await book.snapshot(), await envr.skills.listing(), project.text].filter(Boolean).join('\n\n') },
    )
    await archive.save(run.goal, result, result.messages)
    await envr.skills.recordOutcome(used, result.status)
    return {
      ...result,
      pendingMemory: (await book.all()).filter((e) => e.status === 'pending').length,
      pendingSkills: (await envr.skills.pending()).length,
    }
  } finally {
    archive.close()
  }
}
