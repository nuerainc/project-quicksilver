import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateWorkflowGraph, type WorkflowGraph } from './graph.ts'

export type WorkflowPublicationStatus = 'draft' | 'in-review' | 'published' | 'deprecated'

export interface WorkflowPublicationActor {
  id: string
  kind: 'human' | 'service' | 'agent'
  canPublish: boolean
}

export interface WorkflowPublicationVersion {
  workflowId: string
  version: number
  graph: WorkflowGraph
  digest: string
  authoredBy: string
  createdAt: number
  status: WorkflowPublicationStatus
  reviewedBy?: string
  reviewedAt?: number
  publishedAt?: number
  deprecatedAt?: number
  rollbackOfVersion?: number
}

export interface WorkflowPublicationAudit {
  event: 'draft-created' | 'submitted-for-review' | 'published' | 'deprecated' | 'rolled-back'
  workflowId: string
  version: number
  actorId: string
  at: number
  digest: string
  detail?: string
}

export interface WorkflowPublicationSnapshot {
  versions: WorkflowPublicationVersion[]
  audit: WorkflowPublicationAudit[]
}

/**
 * Kernel-owned publication lifecycle for versioned workflow content.
 *
 * This store deliberately contains no executor and grants no runtime authority.
 * A published graph is only an immutable, digest-pinned input for a separately
 * authenticated runtime. Publication always requires a human actor with the
 * workflow:publish permission and a reviewer different from the author.
 */
export class InMemoryWorkflowPublicationStore {
  protected readonly versions = new Map<string, WorkflowPublicationVersion[]>()
  protected readonly auditLog: WorkflowPublicationAudit[] = []

  createDraft(graph: WorkflowGraph, actor: WorkflowPublicationActor, now = Date.now()): WorkflowPublicationVersion {
    if (actor.kind !== 'human') throw new Error('Only a human may create a workflow draft.')
    const validation = validateWorkflowGraph(graph)
    if (!validation.valid) throw new Error(`Workflow graph is invalid: ${validation.errors.join(' ')}`)
    const versions = this.versions.get(graph.id) ?? []
    if (versions.some((version) => version.version === graph.version)) throw new Error(`Workflow version ${graph.id}@${graph.version} already exists.`)
    const record: WorkflowPublicationVersion = Object.freeze({
      workflowId: graph.id, version: graph.version, graph: cloneGraph(graph), digest: workflowDigest(graph),
      authoredBy: actor.id, createdAt: now, status: 'draft',
    })
    this.versions.set(graph.id, [...versions, record])
    this.audit('draft-created', record, actor.id, now)
    return record
  }

  submitForReview(workflowId: string, version: number, actor: WorkflowPublicationActor, now = Date.now()): WorkflowPublicationVersion {
    const current = this.require(workflowId, version)
    if (current.status !== 'draft') throw new Error(`Workflow ${workflowId}@${version} is not a draft.`)
    if (actor.kind !== 'human') throw new Error('Only a human may submit a workflow for review.')
    const updated = Object.freeze({ ...current, status: 'in-review' as const })
    this.replace(updated)
    this.audit('submitted-for-review', updated, actor.id, now)
    return updated
  }

  review(workflowId: string, version: number, reviewer: WorkflowPublicationActor, now = Date.now()): WorkflowPublicationVersion {
    const current = this.require(workflowId, version)
    if (current.status !== 'in-review') throw new Error(`Workflow ${workflowId}@${version} is not awaiting review.`)
    this.assertPublisher(reviewer)
    if (reviewer.id === current.authoredBy) throw new Error('Workflow authors cannot review their own workflow.')
    const updated = Object.freeze({ ...current, reviewedBy: reviewer.id, reviewedAt: now })
    this.replace(updated)
    return updated
  }

  publish(workflowId: string, version: number, publisher: WorkflowPublicationActor, now = Date.now()): WorkflowPublicationVersion {
    const current = this.require(workflowId, version)
    this.assertPublisher(publisher)
    if (current.status !== 'in-review' || !current.reviewedBy) throw new Error('A workflow must be independently reviewed before publishing.')
    if (current.reviewedBy === publisher.id) throw new Error('The reviewer cannot publish the same workflow version.')
    const versions = (this.versions.get(workflowId) ?? []).map((item) => {
      if (item.version === version) return Object.freeze({ ...item, status: 'published' as const, publishedAt: now })
      if (item.status === 'published') return Object.freeze({ ...item, status: 'deprecated' as const, deprecatedAt: now })
      return item
    })
    this.versions.set(workflowId, versions)
    const published = this.require(workflowId, version)
    this.audit('published', published, publisher.id, now)
    return published
  }

  rollback(workflowId: string, targetVersion: number, publisher: WorkflowPublicationActor, now = Date.now()): WorkflowPublicationVersion {
    const target = this.require(workflowId, targetVersion)
    this.assertPublisher(publisher)
    if (!target.reviewedBy || target.status !== 'deprecated') throw new Error('Only a previously reviewed, deprecated version may be rolled back.')
    const versions = (this.versions.get(workflowId) ?? []).map((item) => {
      if (item.version === targetVersion) return Object.freeze({ ...item, status: 'published' as const, publishedAt: now, rollbackOfVersion: targetVersion })
      if (item.status === 'published') return Object.freeze({ ...item, status: 'deprecated' as const, deprecatedAt: now })
      return item
    })
    this.versions.set(workflowId, versions)
    const restored = this.require(workflowId, targetVersion)
    this.audit('rolled-back', restored, publisher.id, now, `Restored ${workflowId}@${targetVersion}.`)
    return restored
  }

  getPublished(workflowId: string): WorkflowPublicationVersion | undefined {
    const published = (this.versions.get(workflowId) ?? []).find((version) => version.status === 'published')
    return published ? cloneRecord(published) : undefined
  }

  snapshot(): WorkflowPublicationSnapshot {
    return {
      versions: [...this.versions.values()].flat().map(cloneRecord),
      audit: this.auditLog.map((entry) => ({ ...entry })),
    }
  }

  protected restore(snapshot: WorkflowPublicationSnapshot): void {
    this.versions.clear()
    this.auditLog.length = 0
    for (const record of snapshot.versions) {
      const restored = Object.freeze({ ...record, graph: cloneGraph(record.graph) })
      this.versions.set(record.workflowId, [...(this.versions.get(record.workflowId) ?? []), restored])
    }
    this.auditLog.push(...snapshot.audit.map((entry) => ({ ...entry })))
  }

  private assertPublisher(actor: WorkflowPublicationActor): void {
    if (actor.kind !== 'human' || actor.canPublish !== true) throw new Error('A human with workflow:publish is required.')
  }

  private require(workflowId: string, version: number): WorkflowPublicationVersion {
    const record = (this.versions.get(workflowId) ?? []).find((item) => item.version === version)
    if (!record) throw new Error(`Workflow ${workflowId}@${version} was not found.`)
    return record
  }

  private replace(updated: WorkflowPublicationVersion): void {
    this.versions.set(updated.workflowId, (this.versions.get(updated.workflowId) ?? []).map((item) => item.version === updated.version ? updated : item))
  }

  private audit(event: WorkflowPublicationAudit['event'], record: WorkflowPublicationVersion, actorId: string, at: number, detail?: string): void {
    this.auditLog.push({ event, workflowId: record.workflowId, version: record.version, actorId, at, digest: record.digest, ...(detail ? { detail } : {}) })
  }
}

/** File-backed adapter for a single tenant or deployment boundary. */
export class FileWorkflowPublicationStore extends InMemoryWorkflowPublicationStore {
  private readonly filePath: string

  constructor(filePath: string) {
    super()
    this.filePath = filePath
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as WorkflowPublicationSnapshot
      if (!Array.isArray(parsed.versions) || !Array.isArray(parsed.audit)) throw new Error('invalid snapshot')
      this.restore(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Unable to load workflow publication store: ${(error as Error).message}`)
    }
  }

  override createDraft(graph: WorkflowGraph, actor: WorkflowPublicationActor, now = Date.now()): WorkflowPublicationVersion {
    const result = super.createDraft(graph, actor, now); this.persist(); return result
  }

  override submitForReview(workflowId: string, version: number, actor: WorkflowPublicationActor, now = Date.now()): WorkflowPublicationVersion {
    const result = super.submitForReview(workflowId, version, actor, now); this.persist(); return result
  }

  override review(workflowId: string, version: number, reviewer: WorkflowPublicationActor, now = Date.now()): WorkflowPublicationVersion {
    const result = super.review(workflowId, version, reviewer, now); this.persist(); return result
  }

  override publish(workflowId: string, version: number, publisher: WorkflowPublicationActor, now = Date.now()): WorkflowPublicationVersion {
    const result = super.publish(workflowId, version, publisher, now); this.persist(); return result
  }

  override rollback(workflowId: string, targetVersion: number, publisher: WorkflowPublicationActor, now = Date.now()): WorkflowPublicationVersion {
    const result = super.rollback(workflowId, targetVersion, publisher, now); this.persist(); return result
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(this.snapshot(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.filePath)
  }
}

export function workflowDigest(graph: WorkflowGraph): string {
  return `sha256:${createHash('sha256').update(canonical(graph)).digest('hex')}`
}

function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  return JSON.parse(JSON.stringify(graph)) as WorkflowGraph
}

function cloneRecord(record: WorkflowPublicationVersion): WorkflowPublicationVersion {
  return Object.freeze({ ...record, graph: cloneGraph(record.graph) })
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
