import { createHash, randomUUID } from 'node:crypto'
import type { SanityClient } from '@sanity/client'
import { validateWorkflowGraph, workflowDigest, type WorkflowGraph } from '@quicksilver/kernel'
import { getSanityClient } from './sanity-client.ts'

export type PublicationStatus = 'draft' | 'in-review' | 'published' | 'deprecated'
export type PublicationEvent = 'draft-created' | 'submitted-for-review' | 'reviewed' | 'published' | 'deprecated' | 'rolled-back'

export interface PublicationActor {
  id: string
  kind: 'human' | 'service' | 'agent'
}

export interface PublishedWorkflowVersion {
  workflowId: string
  version: number
  graph: WorkflowGraph
  digest: string
  authoredBy: string
  createdAt: number
  status: PublicationStatus
  reviewedBy?: string
  reviewNote?: string
  reviewedAt?: number
  publishedAt?: number
  deprecatedAt?: number
  rollbackOfVersion?: number
}

export interface WorkflowPublicationAuditEntry {
  event: PublicationEvent
  workflowId: string
  version: number
  actorId: string
  at: number
  digest: string
  detail?: string
}

export interface WorkflowVersionDiff {
  workflowId: string
  fromVersion: number
  toVersion: number
  fromDigest: string
  toDigest: string
  entryNodeChanged: boolean
  nodes: Array<{ id: string; change: 'added' | 'removed' | 'modified'; changedFields: string[] }>
  edges: Array<{ id: string; change: 'added' | 'removed' | 'modified'; changedFields: string[] }>
  riskChanges: Array<{ nodeId: string; field: string; from: string | boolean | null; to: string | boolean | null }>
}

export interface WorkflowExecutionRecord {
  runId: string
  workflowId: string
  version: number
  digest: string
  requestedBy: string
  status: 'succeeded' | 'blocked' | 'failed'
  startedAt: number
  completedAt: number
  durationMs: number
  evaluationCount: number
}

interface WorkflowDocument {
  _id: string
  _rev: string
  _type: 'automationWorkflow'
  tenantId: string
  name: string
  graphId: string
  schemaVersion: 1
  version: number
  lifecycle: 'draft' | 'review' | 'active' | 'archived'
  entryNodeId: string
  nodes: WorkflowGraph['nodes']
  edges: WorkflowGraph['edges']
  graphDigest: string
  authoredBy: string
  createdAt: string
  reviewedBy?: string
  reviewNote?: string
  reviewedAt?: string
  publishedAt?: string
  deprecatedAt?: string
  rollbackOfVersion?: number
}

interface HeadDocument {
  _id: string
  _rev: string
  _type: 'workflowPublicationHead'
  tenantId: string
  graphId: string
  activeVersion?: number
}

interface AuditDocument {
  _type: 'workflowPublicationAudit'
  _id: string
  tenantId: string
  event: PublicationEvent
  graphId: string
  version: number
  actorId: string
  at: string
  graphDigest: string
  detail?: string
}

interface ExecutionDocument extends Omit<WorkflowExecutionRecord, 'startedAt' | 'completedAt'> {
  _id: string
  _type: 'workflowExecution'
  tenantId: string
  startedAt: string
  completedAt: string
}

export class WorkflowPublicationFault extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message)
    this.name = 'WorkflowPublicationFault'
  }
}

const versionProjection = `{_id,_rev,_type,tenantId,name,graphId,schemaVersion,version,lifecycle,entryNodeId,nodes[]{id,kind,label,config},edges[]{id,from,to,branch},graphDigest,authoredBy,createdAt,reviewedBy,reviewNote,reviewedAt,publishedAt,deprecatedAt,rollbackOfVersion}`

function tenantId(): string {
  return process.env.QUICKSILVER_TENANT_ID?.trim() || 'default'
}

function digestId(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function versionDocumentId(tenant: string, workflowId: string, version: number): string {
  return `automation-workflow-${digestId(`${tenant}\0${workflowId}\0${version}`)}`
}

function headDocumentId(tenant: string, workflowId: string): string {
  return `workflow-publication-head-${digestId(`${tenant}\0${workflowId}`)}`
}

function executionDocumentId(tenant: string, runId: string): string {
  return `workflow-execution-${digestId(`${tenant}\0${runId}`)}`
}

function mapVersion(document: WorkflowDocument): PublishedWorkflowVersion {
  const graph: WorkflowGraph = {
    schemaVersion: document.schemaVersion,
    id: document.graphId,
    version: document.version,
    entryNodeId: document.entryNodeId,
    nodes: document.nodes,
    edges: document.edges,
  }
  const validation = validateWorkflowGraph(graph)
  if (!validation.valid || workflowDigest(graph) !== document.graphDigest) {
    throw new WorkflowPublicationFault('Stored workflow content failed its integrity check.', 409)
  }
  const status: PublicationStatus = document.lifecycle === 'review'
    ? 'in-review'
    : document.lifecycle === 'active'
      ? 'published'
      : document.lifecycle === 'archived'
        ? 'deprecated'
        : 'draft'
  return {
    workflowId: document.graphId,
    version: document.version,
    graph,
    digest: document.graphDigest,
    authoredBy: document.authoredBy,
    createdAt: Date.parse(document.createdAt),
    status,
    ...(document.reviewedBy ? { reviewedBy: document.reviewedBy } : {}),
    ...(document.reviewNote ? { reviewNote: document.reviewNote } : {}),
    ...(document.reviewedAt ? { reviewedAt: Date.parse(document.reviewedAt) } : {}),
    ...(document.publishedAt ? { publishedAt: Date.parse(document.publishedAt) } : {}),
    ...(document.deprecatedAt ? { deprecatedAt: Date.parse(document.deprecatedAt) } : {}),
    ...(document.rollbackOfVersion !== undefined ? { rollbackOfVersion: document.rollbackOfVersion } : {}),
  }
}

function toDocument(graph: WorkflowGraph, actor: PublicationActor, at: number, tenant: string): Omit<WorkflowDocument, '_rev'> {
  return {
    _id: versionDocumentId(tenant, graph.id, graph.version),
    _type: 'automationWorkflow',
    tenantId: tenant,
    name: graph.id,
    graphId: graph.id,
    schemaVersion: graph.schemaVersion,
    version: graph.version,
    lifecycle: 'draft',
    entryNodeId: graph.entryNodeId,
    nodes: graph.nodes,
    edges: graph.edges,
    graphDigest: workflowDigest(graph),
    authoredBy: actor.id,
    createdAt: new Date(at).toISOString(),
  }
}

function auditDocument(
  tenant: string,
  graphId: string,
  version: number,
  digest: string,
  event: PublicationEvent,
  actorId: string,
  at: number,
  detail?: string,
): AuditDocument {
  return {
    _id: `workflow-publication-audit-${randomUUID()}`,
    _type: 'workflowPublicationAudit',
    tenantId: tenant,
    event,
    graphId,
    version,
    actorId,
    at: new Date(at).toISOString(),
    graphDigest: digest,
    ...(detail ? { detail } : {}),
  }
}

function ensureHuman(actor: PublicationActor): void {
  if (actor.kind !== 'human' || !actor.id.trim()) throw new WorkflowPublicationFault('A signed-in human is required for workflow lifecycle actions.', 409)
}

async function versionDocument(client: SanityClient, graphId: string, version: number, tenant: string): Promise<WorkflowDocument> {
  const document = await client.fetch<WorkflowDocument | null>(
    `*[_type == "automationWorkflow" && tenantId == $tenant && graphId == $graphId && version == $version][0]${versionProjection}`,
    { tenant, graphId, version },
  )
  if (!document) throw new WorkflowPublicationFault(`Workflow ${graphId}@${version} was not found.`, 404)
  return document
}

function auditedPatch(
  client: SanityClient,
  document: WorkflowDocument,
  update: Record<string, unknown>,
  audit: AuditDocument,
) {
  return client.transaction()
    .patch(document._id, (patch) => patch.ifRevisionId(document._rev).set(update))
    .create(audit)
}

export async function listWorkflowPublications(workflowId: string): Promise<{
  versions: PublishedWorkflowVersion[]
  audit: WorkflowPublicationAuditEntry[]
}> {
  const client = getSanityClient('read')
  const tenant = tenantId()
  const documents = await client.fetch<WorkflowDocument[]>(
    `*[_type == "automationWorkflow" && tenantId == $tenant && graphId == $graphId] | order(version desc)[0...100]${versionProjection}`,
    { tenant, graphId: workflowId },
  )
  const events = await client.fetch<AuditDocument[]>(
    '*[_type == "workflowPublicationAudit" && tenantId == $tenant && graphId == $graphId] | order(at desc)[0...100]{event,graphId,version,actorId,at,graphDigest,detail}',
    { tenant, graphId: workflowId },
  )
  return {
    versions: documents.map(mapVersion),
    audit: events.map((event) => ({
      event: event.event,
      workflowId: event.graphId,
      version: event.version,
      actorId: event.actorId,
      at: Date.parse(event.at),
      digest: event.graphDigest,
      ...(event.detail ? { detail: event.detail } : {}),
    })),
  }
}

/** A review compares immutable, digest-verified versions without returning config values. */
export async function compareWorkflowVersions(workflowId: string, fromVersion: number, toVersion: number): Promise<WorkflowVersionDiff> {
  if (fromVersion === toVersion) throw new WorkflowPublicationFault('Choose two different workflow versions to compare.', 400)
  const client = getSanityClient('read')
  const tenant = tenantId()
  const [from, to] = await Promise.all([
    versionDocument(client, workflowId, fromVersion, tenant),
    versionDocument(client, workflowId, toVersion, tenant),
  ])
  const previous = mapVersion(from)
  const next = mapVersion(to)
  const nodeChanges = compareItems(previous.graph.nodes, next.graph.nodes, ['id', 'kind', 'label', 'config'])
  const edgeChanges = compareItems(previous.graph.edges, next.graph.edges, ['from', 'to', 'branch'])
  const beforeNodes = new Map(previous.graph.nodes.map((node) => [node.id, node]))
  const afterNodes = new Map(next.graph.nodes.map((node) => [node.id, node]))
  const riskChanges: WorkflowVersionDiff['riskChanges'] = []
  for (const id of new Set([...beforeNodes.keys(), ...afterNodes.keys()])) {
    const before = beforeNodes.get(id)?.config
    const after = afterNodes.get(id)?.config
    for (const field of ['impact', 'sideEffect', 'evaluationRequired', 'supervisorApprovalRequired'] as const) {
      const oldValue = before?.[field] ?? null
      const newValue = after?.[field] ?? null
      if (oldValue !== newValue) riskChanges.push({ nodeId: id, field, from: oldValue, to: newValue })
    }
  }
  return {
    workflowId,
    fromVersion,
    toVersion,
    fromDigest: previous.digest,
    toDigest: next.digest,
    entryNodeChanged: previous.graph.entryNodeId !== next.graph.entryNodeId,
    nodes: nodeChanges,
    edges: edgeChanges,
    riskChanges,
  }
}

function compareItems<T extends { id: string }>(before: T[], after: T[], fields: string[]): WorkflowVersionDiff['nodes'] {
  const previous = new Map(before.map((item) => [item.id, item]))
  const next = new Map(after.map((item) => [item.id, item]))
  const changes: WorkflowVersionDiff['nodes'] = []
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const oldItem = previous.get(id)
    const newItem = next.get(id)
    if (!oldItem) changes.push({ id, change: 'added', changedFields: fields.filter((field) => field !== 'id') })
    else if (!newItem) changes.push({ id, change: 'removed', changedFields: fields.filter((field) => field !== 'id') })
    else {
      const changedFields = fields.flatMap((field) => {
        const oldValue = (oldItem as Record<string, unknown>)[field]
        const newValue = (newItem as Record<string, unknown>)[field]
        if (field !== 'config') return stableValue(oldValue) === stableValue(newValue) ? [] : [field]
        const oldConfig = (oldValue && typeof oldValue === 'object' ? oldValue : {}) as Record<string, unknown>
        const newConfig = (newValue && typeof newValue === 'object' ? newValue : {}) as Record<string, unknown>
        return [...new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)])]
          .filter((key) => stableValue(oldConfig[key]) !== stableValue(newConfig[key]))
          .map((key) => `config.${key}`)
      })
      if (changedFields.length) changes.push({ id, change: 'modified', changedFields })
    }
  }
  return changes
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${key}:${stableValue(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** Resolve only the version currently named by the tenant-scoped publication head. */
export async function getActivePublishedWorkflow(workflowId: string): Promise<PublishedWorkflowVersion> {
  const client = getSanityClient('read')
  const tenant = tenantId()
  const head = await client.fetch<HeadDocument | null>(
    '*[_type == "workflowPublicationHead" && tenantId == $tenant && graphId == $graphId][0]{_id,_rev,_type,tenantId,graphId,activeVersion}',
    { tenant, graphId: workflowId },
  )
  if (!head?.activeVersion) throw new WorkflowPublicationFault(`Workflow ${workflowId} has no active published version.`, 404)
  const document = await versionDocument(client, workflowId, head.activeVersion, tenant)
  if (document.lifecycle !== 'active') {
    throw new WorkflowPublicationFault('Publication head does not point to an active workflow version.', 409)
  }
  return mapVersion(document)
}

/** Persist metadata only; input and output payloads are never copied into history. */
export async function recordWorkflowExecution(record: WorkflowExecutionRecord): Promise<void> {
  const client = getSanityClient('write')
  const tenant = tenantId()
  const document: ExecutionDocument = {
    ...record,
    _id: executionDocumentId(tenant, record.runId),
    _type: 'workflowExecution',
    tenantId: tenant,
    startedAt: new Date(record.startedAt).toISOString(),
    completedAt: new Date(record.completedAt).toISOString(),
  }
  await client.createIfNotExists(document)
}

export async function listWorkflowExecutions(workflowId: string, limit = 25): Promise<WorkflowExecutionRecord[]> {
  const client = getSanityClient('read')
  const tenant = tenantId()
  const documents = await client.fetch<ExecutionDocument[]>(
    '*[_type == "workflowExecution" && tenantId == $tenant && workflowId == $workflowId] | order(completedAt desc)[0...$limit]{runId,workflowId,version,digest,requestedBy,status,startedAt,completedAt,durationMs,evaluationCount}',
    { tenant, workflowId, limit: Math.max(1, Math.min(100, Math.floor(limit))) },
  )
  return documents.map((document) => ({
    runId: document.runId,
    workflowId: document.workflowId,
    version: document.version,
    digest: document.digest,
    requestedBy: document.requestedBy,
    status: document.status,
    startedAt: Date.parse(document.startedAt),
    completedAt: Date.parse(document.completedAt),
    durationMs: document.durationMs,
    evaluationCount: document.evaluationCount,
  }))
}

export async function createWorkflowDraft(graph: WorkflowGraph, actor: PublicationActor): Promise<PublishedWorkflowVersion> {
  ensureHuman(actor)
  const validation = validateWorkflowGraph(graph)
  if (!validation.valid) throw new WorkflowPublicationFault(`Workflow graph is invalid: ${validation.errors.join(' ')}`, 400)
  const client = getSanityClient('write')
  const tenant = tenantId()
  const at = Date.now()
  const doc = toDocument(graph, actor, at, tenant)
  const headId = headDocumentId(tenant, graph.id)
  const event = auditDocument(tenant, graph.id, graph.version, doc.graphDigest, 'draft-created', actor.id, at)
  try {
    await client.transaction()
      .createIfNotExists({ _id: headId, _type: 'workflowPublicationHead', tenantId: tenant, graphId: graph.id, updatedAt: new Date(at).toISOString() })
      .create(doc)
      .create(event)
      .commit()
  } catch (error) {
    const existing = await client.fetch<{ _id: string } | null>(
      '*[_type == "automationWorkflow" && tenantId == $tenant && graphId == $graphId && version == $version][0]{_id}',
      { tenant, graphId: graph.id, version: graph.version },
    ).catch(() => null)
    if (existing) throw new WorkflowPublicationFault(`Workflow ${graph.id}@${graph.version} already exists.`, 409)
    throw error
  }
  return mapVersion({ ...doc, _rev: '' } as WorkflowDocument)
}

export async function submitWorkflowForReview(workflowId: string, version: number, actor: PublicationActor): Promise<PublishedWorkflowVersion> {
  ensureHuman(actor)
  const client = getSanityClient('write')
  const tenant = tenantId()
  const current = await versionDocument(client, workflowId, version, tenant)
  if (current.lifecycle !== 'draft') throw new WorkflowPublicationFault('Only a draft workflow can be submitted for review.', 409)
  const at = Date.now()
  const updated = { ...current, lifecycle: 'review' as const }
  await auditedPatch(client, current, { lifecycle: 'review' }, auditDocument(tenant, workflowId, version, current.graphDigest, 'submitted-for-review', actor.id, at)).commit()
  return mapVersion(updated)
}

export async function reviewWorkflow(workflowId: string, version: number, actor: PublicationActor, note: string): Promise<PublishedWorkflowVersion> {
  ensureHuman(actor)
  const reviewNote = note.trim()
  if (reviewNote.length < 10 || reviewNote.length > 500) throw new WorkflowPublicationFault('Review rationale must contain 10–500 characters.', 400)
  const client = getSanityClient('write')
  const tenant = tenantId()
  const current = await versionDocument(client, workflowId, version, tenant)
  if (current.lifecycle !== 'review') throw new WorkflowPublicationFault('Only a workflow awaiting review can be reviewed.', 409)
  if (current.authoredBy === actor.id) throw new WorkflowPublicationFault('Workflow authors cannot review their own workflow.', 409)
  if (current.reviewedBy) throw new WorkflowPublicationFault('This workflow version has already been reviewed.', 409)
  const at = Date.now()
  const reviewedAt = new Date(at).toISOString()
  await auditedPatch(client, current, { reviewedBy: actor.id, reviewNote, reviewedAt }, auditDocument(tenant, workflowId, version, current.graphDigest, 'reviewed', actor.id, at, reviewNote)).commit()
  return mapVersion({ ...current, reviewedBy: actor.id, reviewNote, reviewedAt })
}

export async function publishWorkflow(workflowId: string, version: number, actor: PublicationActor): Promise<PublishedWorkflowVersion> {
  ensureHuman(actor)
  const client = getSanityClient('write')
  const tenant = tenantId()
  const current = await versionDocument(client, workflowId, version, tenant)
  if (current.lifecycle !== 'review' || !current.reviewedBy) throw new WorkflowPublicationFault('A workflow must be independently reviewed before publishing.', 409)
  if (current.authoredBy === actor.id) throw new WorkflowPublicationFault('Workflow authors cannot publish their own workflow version.', 409)
  if (current.reviewedBy === actor.id) throw new WorkflowPublicationFault('The reviewer cannot publish the same workflow version.', 409)
  const head = await client.fetch<HeadDocument | null>(
    '*[_type == "workflowPublicationHead" && tenantId == $tenant && graphId == $graphId][0]{_id,_rev,_type,tenantId,graphId,activeVersion}',
    { tenant, graphId: workflowId },
  )
  if (!head) throw new WorkflowPublicationFault('Workflow publication head is missing; save the draft again.', 409)
  const active = await client.fetch<WorkflowDocument[]>(
    `*[_type == "automationWorkflow" && tenantId == $tenant && graphId == $graphId && lifecycle == "active"]${versionProjection}`,
    { tenant, graphId: workflowId },
  )
  if ((head.activeVersion === undefined && active.length > 0) || (head.activeVersion !== undefined && active.filter((item) => item.version === head.activeVersion).length !== 1)) {
    throw new WorkflowPublicationFault('Publication head and active workflow versions are inconsistent.', 409)
  }
  if (active.some((item) => item.version === version)) throw new WorkflowPublicationFault('This workflow version is already published.', 409)
  const at = Date.now()
  const publishedAt = new Date(at).toISOString()
  const transaction = client.transaction()
    .patch(head._id, (patch) => patch.ifRevisionId(head._rev).set({ activeVersion: version, updatedAt: publishedAt }))
    .patch(current._id, (patch) => patch.ifRevisionId(current._rev).set({ lifecycle: 'active', publishedAt }))
    .create(auditDocument(tenant, workflowId, version, current.graphDigest, 'published', actor.id, at))
  for (const previous of active) {
    transaction.patch(previous._id, (patch) => patch.ifRevisionId(previous._rev).set({ lifecycle: 'archived', deprecatedAt: publishedAt }))
    transaction.create(auditDocument(tenant, workflowId, previous.version, previous.graphDigest, 'deprecated', actor.id, at))
  }
  await transaction.commit()
  return mapVersion({ ...current, lifecycle: 'active', publishedAt })
}

export async function rollbackWorkflow(workflowId: string, targetVersion: number, actor: PublicationActor): Promise<PublishedWorkflowVersion> {
  ensureHuman(actor)
  const client = getSanityClient('write')
  const tenant = tenantId()
  const target = await versionDocument(client, workflowId, targetVersion, tenant)
  if (target.lifecycle !== 'archived' || !target.reviewedBy) throw new WorkflowPublicationFault('Only a previously reviewed, deprecated version may be rolled back.', 409)
  if (target.authoredBy === actor.id || target.reviewedBy === actor.id) {
    throw new WorkflowPublicationFault('The workflow author and reviewer cannot publish its rollback.', 409)
  }
  const head = await client.fetch<HeadDocument | null>(
    '*[_type == "workflowPublicationHead" && tenantId == $tenant && graphId == $graphId][0]{_id,_rev,_type,tenantId,graphId,activeVersion}',
    { tenant, graphId: workflowId },
  )
  if (!head) throw new WorkflowPublicationFault('Workflow publication head is missing.', 409)
  const active = await client.fetch<WorkflowDocument[]>(
    `*[_type == "automationWorkflow" && tenantId == $tenant && graphId == $graphId && lifecycle == "active"]${versionProjection}`,
    { tenant, graphId: workflowId },
  )
  if ((head.activeVersion === undefined && active.length > 0) || (head.activeVersion !== undefined && active.filter((item) => item.version === head.activeVersion).length !== 1)) {
    throw new WorkflowPublicationFault('Publication head and active workflow versions are inconsistent.', 409)
  }
  const at = Date.now()
  const publishedAt = new Date(at).toISOString()
  const transaction = client.transaction()
    .patch(head._id, (patch) => patch.ifRevisionId(head._rev).set({ activeVersion: targetVersion, updatedAt: publishedAt }))
    .patch(target._id, (patch) => patch.ifRevisionId(target._rev).set({ lifecycle: 'active', publishedAt, rollbackOfVersion: targetVersion }))
    .create(auditDocument(tenant, workflowId, targetVersion, target.graphDigest, 'rolled-back', actor.id, at))
  for (const previous of active) {
    transaction.patch(previous._id, (patch) => patch.ifRevisionId(previous._rev).set({ lifecycle: 'archived', deprecatedAt: publishedAt }))
    transaction.create(auditDocument(tenant, workflowId, previous.version, previous.graphDigest, 'deprecated', actor.id, at))
  }
  await transaction.commit()
  return mapVersion({ ...target, lifecycle: 'active', publishedAt, rollbackOfVersion: targetVersion })
}
