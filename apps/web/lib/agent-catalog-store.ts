import { createHash, randomUUID } from 'node:crypto'
import type { SanityClient } from '@sanity/client'
import { BUILT_IN_AGENT_MANIFESTS, validateAgentManifest, type AgentManifest } from '@quicksilver/kernel'
import { getSanityClient } from './sanity-client.ts'
import { AgentCatalogFault, agentDefinitionDigest, assertAgentDigest, assertCanPublish, assertCanReview, assertCanSubmit, assertHumanAgentActor, assertValidAgentDefinition, type AgentLifecycle } from './agent-catalog-contract.ts'

export type { AgentLifecycle } from './agent-catalog-contract.ts'
export interface AgentDefinition {
  agentId: string
  displayName: string
  description: string
  version: number
  manifest: AgentManifest
  digest: string
  authoredBy: string
  createdAt: number
  lifecycle: AgentLifecycle
  reviewedBy?: string
  reviewNote?: string
  reviewedAt?: number
  publishedAt?: number
  builtIn?: true
}
export interface AgentCatalogAudit { event: string; agentId: string; version: number; actorId: string; at: number; digest: string; detail?: string }
export interface AgentActor { id: string; kind: 'human' | 'service' | 'agent' }
type AgentEvent = 'draft-created' | 'submitted-for-review' | 'reviewed' | 'published' | 'deprecated'
interface DefinitionDoc extends Omit<AgentDefinition, 'digest' | 'createdAt' | 'reviewedAt' | 'publishedAt' | 'lifecycle' | 'builtIn'> {
  _id: string; _rev: string; _type: 'agentDefinition'; tenantId: string; lifecycle: 'draft' | 'review' | 'active' | 'archived'; definitionDigest: string; createdAt: string; reviewedAt?: string; publishedAt?: string
}
interface AuditDoc { _id: string; _type: 'agentPublicationAudit'; tenantId: string; event: AgentEvent; agentId: string; version: number; actorId: string; at: string; definitionDigest: string; detail?: string }
interface HeadDoc { _id: string; _rev: string; _type: 'agentPublicationHead'; tenantId: string; agentId: string; activeVersion?: number }
export interface AgentCatalogDependencies { client: SanityClient; tenantId: string }
const projection = '{_id,_rev,_type,tenantId,agentId,displayName,description,version,lifecycle,manifest,definitionDigest,authoredBy,createdAt,reviewedBy,reviewNote,reviewedAt,publishedAt}'
const tenantId = () => process.env.QUICKSILVER_TENANT_ID?.trim() || 'default'
function dependencies(access: 'read' | 'write', provided?: AgentCatalogDependencies) {
  return { client: provided?.client ?? getSanityClient(access), tenant: provided?.tenantId ?? tenantId() }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function docId(tenant: string, agentId: string, version: number): string { return `agent-definition-${digest(`${tenant}\0${agentId}\0${version}`)}` }
function mapDoc(doc: DefinitionDoc): AgentDefinition {
  if (validateAgentManifest(doc.manifest).length || doc.agentId !== doc.manifest.id) throw new AgentCatalogFault('Stored agent definition failed its integrity check.', 409)
  assertAgentDigest({ displayName: doc.displayName, description: doc.description, manifest: doc.manifest }, doc.definitionDigest)
  return { agentId: doc.agentId, displayName: doc.displayName, description: doc.description, version: doc.version, manifest: doc.manifest, digest: doc.definitionDigest, authoredBy: doc.authoredBy, createdAt: Date.parse(doc.createdAt), lifecycle: doc.lifecycle === 'review' ? 'in-review' : doc.lifecycle === 'active' ? 'published' : doc.lifecycle === 'archived' ? 'archived' : 'draft', ...(doc.reviewedBy ? { reviewedBy: doc.reviewedBy } : {}), ...(doc.reviewNote ? { reviewNote: doc.reviewNote } : {}), ...(doc.reviewedAt ? { reviewedAt: Date.parse(doc.reviewedAt) } : {}), ...(doc.publishedAt ? { publishedAt: Date.parse(doc.publishedAt) } : {}) }
}
function human(actor: AgentActor) { assertHumanAgentActor(actor) }
function audit(tenant: string, definition: AgentDefinition, event: AgentEvent, actor: AgentActor, at: number, detail?: string): AuditDoc {
  return { _id: `agent-publication-audit-${randomUUID()}`, _type: 'agentPublicationAudit', tenantId: tenant, event, agentId: definition.agentId, version: definition.version, actorId: actor.id, at: new Date(at).toISOString(), definitionDigest: definition.digest, ...(detail ? { detail } : {}) }
}
async function getVersion(client: SanityClient, id: string, version: number, tenant: string): Promise<DefinitionDoc> {
  const found = await client.fetch<DefinitionDoc | null>(`*[_type == "agentDefinition" && tenantId == $tenant && agentId == $id && version == $version][0]${projection}`, { tenant, id, version })
  if (!found) throw new AgentCatalogFault(`Agent definition ${id}@${version} was not found.`, 404)
  return found
}
async function auditedPatch(client: SanityClient, doc: DefinitionDoc, patch: Record<string, unknown>, record: AuditDoc) {
  return client.transaction().patch(doc._id, (item) => item.ifRevisionId(doc._rev).set(patch)).create(record).commit()
}

export async function listAgentCatalog(provided?: AgentCatalogDependencies, actorId?: string): Promise<{ agents: AgentDefinition[]; drafts: AgentDefinition[]; reviewQueue: AgentDefinition[]; audit: AgentCatalogAudit[] }> {
  const { client, tenant } = dependencies('read', provided)
  const docs = await client.fetch<DefinitionDoc[]>(`*[_type == "agentDefinition" && tenantId == $tenant && lifecycle == "active"] | order(agentId asc, version desc)[0...200]${projection}`, { tenant })
  const heads = await client.fetch<HeadDoc[]>('*[_type == "agentPublicationHead" && tenantId == $tenant]{_id,_rev,_type,tenantId,agentId,activeVersion}', { tenant })
  const pendingDocs = await client.fetch<DefinitionDoc[]>(`*[_type == "agentDefinition" && tenantId == $tenant && lifecycle == "review"] | order(createdAt asc)[0...100]${projection}`, { tenant })
  const draftDocs = await client.fetch<DefinitionDoc[]>(`*[_type == "agentDefinition" && tenantId == $tenant && lifecycle == "draft"] | order(createdAt desc)[0...100]${projection}`, { tenant })
  const latestPublished = new Map<string, AgentDefinition>()
  for (const doc of docs) if (!latestPublished.has(doc.agentId)) latestPublished.set(doc.agentId, mapDoc(doc))
  for (const [id, definition] of latestPublished) {
    const head = heads.filter((item) => item.agentId === id)
    if (head.length !== 1 || head[0].activeVersion !== definition.version || docs.filter((item) => item.agentId === id).length !== 1) {
      throw new AgentCatalogFault(`Agent ${id} has inconsistent active-version metadata.`, 409)
    }
  }
  if (heads.some((head) => !latestPublished.has(head.agentId))) throw new AgentCatalogFault('An agent publication pointer does not resolve to one active definition.', 409)
  const audits = await client.fetch<AuditDoc[]>('*[_type == "agentPublicationAudit" && tenantId == $tenant] | order(at desc)[0...100]{event,agentId,version,actorId,at,definitionDigest,detail}', { tenant })
  const builtins: AgentDefinition[] = BUILT_IN_AGENT_MANIFESTS.map((manifest) => ({ agentId: manifest.id, displayName: manifest.id.split(':')[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), description: 'Built-in Nuera Quicksilver agent. Governed by the NQC Kernel.', version: manifest.version, manifest, digest: digest(manifest), authoredBy: 'Nuera Quicksilver', createdAt: 0, lifecycle: 'published', builtIn: true }))
  return { agents: [...builtins, ...latestPublished.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)), drafts: draftDocs.filter((doc) => !actorId || doc.authoredBy === actorId).map(mapDoc), reviewQueue: pendingDocs.map(mapDoc), audit: audits.map((entry) => ({ event: entry.event, agentId: entry.agentId, version: entry.version, actorId: entry.actorId, at: Date.parse(entry.at), digest: entry.definitionDigest, ...(entry.detail ? { detail: entry.detail } : {}) })) }
}

export async function listAgentDefinitions(agentId: string, provided?: AgentCatalogDependencies): Promise<{ versions: AgentDefinition[]; audit: AgentCatalogAudit[] }> {
  const { client, tenant } = dependencies('read', provided)
  const docs = await client.fetch<DefinitionDoc[]>(`*[_type == "agentDefinition" && tenantId == $tenant && agentId == $id] | order(version desc)[0...100]${projection}`, { tenant, id: agentId })
  const events = await client.fetch<AuditDoc[]>('*[_type == "agentPublicationAudit" && tenantId == $tenant && agentId == $id] | order(at desc)[0...100]{event,agentId,version,actorId,at,definitionDigest,detail}', { tenant, id: agentId })
  return { versions: docs.map(mapDoc), audit: events.map((e) => ({ event: e.event, agentId: e.agentId, version: e.version, actorId: e.actorId, at: Date.parse(e.at), digest: e.definitionDigest, ...(e.detail ? { detail: e.detail } : {}) })) }
}

export async function createAgentDraft(input: { displayName: string; description: string; manifest: AgentManifest }, actor: AgentActor, provided?: AgentCatalogDependencies): Promise<AgentDefinition> {
  human(actor)
  assertValidAgentDefinition(input.manifest.id, input.manifest)
  const displayName = input.displayName.trim(); const description = input.description.trim()
  if (displayName.length < 2 || displayName.length > 100 || description.length < 10 || description.length > 1000) throw new AgentCatalogFault('Display name must be 2–100 characters and description 10–1,000 characters.', 400)
  const { client, tenant } = dependencies('write', provided)
  const previous = await client.fetch<Array<{ version: number }>>('*[_type == "agentDefinition" && tenantId == $tenant && agentId == $id] | order(version desc)[0...1]{version}', { tenant, id: input.manifest.id })
  const version = (previous[0]?.version ?? 0) + 1; const at = Date.now()
  const manifest: AgentManifest = { ...input.manifest, version }
  const definition = { agentId: manifest.id, displayName, description, version, manifest, digest: agentDefinitionDigest({ displayName, description, manifest }), authoredBy: actor.id, createdAt: at, lifecycle: 'draft' as const }
  const document = { _id: docId(tenant, definition.agentId, version), _type: 'agentDefinition', tenantId: tenant, ...definition, definitionDigest: definition.digest, lifecycle: 'draft', createdAt: new Date(at).toISOString() }
  try { await client.transaction().create(document).create(audit(tenant, definition, 'draft-created', actor, at)).commit() }
  catch (error) { if ((error as { statusCode?: number }).statusCode === 409) throw new AgentCatalogFault('A definition version was created concurrently; refresh and retry.', 409); throw error }
  return definition
}

export async function submitAgentDefinition(agentId: string, version: number, actor: AgentActor, provided?: AgentCatalogDependencies): Promise<AgentDefinition> {
  human(actor); const { client, tenant } = dependencies('write', provided); const doc = await getVersion(client, agentId, version, tenant); const current = mapDoc(doc)
  assertCanSubmit(current.lifecycle)
  await auditedPatch(client, doc, { lifecycle: 'review' }, audit(tenant, current, 'submitted-for-review', actor, Date.now()))
  return { ...current, lifecycle: 'in-review' }
}

export async function reviewAgentDefinition(agentId: string, version: number, actor: AgentActor, note: string, provided?: AgentCatalogDependencies): Promise<AgentDefinition> {
  human(actor); const { client, tenant } = dependencies('write', provided); const doc = await getVersion(client, agentId, version, tenant); const current = mapDoc(doc)
  assertCanReview(current.lifecycle, actor.id, doc.authoredBy, doc.reviewedBy)
  const reviewNote = note.trim()
  if (reviewNote.length < 10 || reviewNote.length > 500) throw new AgentCatalogFault('Review rationale must contain 10–500 characters.', 400)
  const at = Date.now(); await auditedPatch(client, doc, { reviewedBy: actor.id, reviewNote, reviewedAt: new Date(at).toISOString() }, audit(tenant, current, 'reviewed', actor, at, reviewNote))
  return { ...current, reviewedBy: actor.id, reviewNote, reviewedAt: at }
}

export async function publishAgentDefinition(agentId: string, version: number, actor: AgentActor, provided?: AgentCatalogDependencies): Promise<AgentDefinition> {
  human(actor); const { client, tenant } = dependencies('write', provided); const doc = await getVersion(client, agentId, version, tenant); const current = mapDoc(doc)
  assertCanPublish(current.lifecycle, doc.authoredBy, doc.reviewedBy, actor.id)
  const headId = `agent-publication-head-${digest(`${tenant}\0${agentId}`)}`
  const head = await client.fetch<HeadDoc | null>('*[_type == "agentPublicationHead" && tenantId == $tenant && agentId == $id][0]{_id,_rev,_type,tenantId,agentId,activeVersion}', { tenant, id: agentId })
  const active = await client.fetch<DefinitionDoc[]>(`*[_type == "agentDefinition" && tenantId == $tenant && agentId == $id && lifecycle == "active"]${projection}`, { tenant, id: agentId })
  if ((head?.activeVersion === undefined && active.length > 0) || (head?.activeVersion !== undefined && active.filter((item) => item.version === head.activeVersion).length !== 1)) throw new AgentCatalogFault('Agent publication head and active versions are inconsistent.', 409)
  const at = Date.now(); const publishedAt = new Date(at).toISOString(); const event = audit(tenant, current, 'published', actor, at)
  const transaction = client.transaction()
  if (head) transaction.patch(head._id, (patch) => patch.ifRevisionId(head._rev).set({ activeVersion: version, updatedAt: publishedAt }))
  else transaction.create({ _id: headId, _type: 'agentPublicationHead', tenantId: tenant, agentId, activeVersion: version, updatedAt: publishedAt })
  transaction.patch(doc._id, (patch) => patch.ifRevisionId(doc._rev).set({ lifecycle: 'active', publishedAt }))
  transaction.create(event)
  for (const previous of active) {
    transaction.patch(previous._id, (patch) => patch.ifRevisionId(previous._rev).set({ lifecycle: 'archived' }))
    transaction.create(audit(tenant, mapDoc(previous), 'deprecated', actor, at, `superseded by v${version}`))
  }
  try { await transaction.commit() } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 409) throw new AgentCatalogFault('Agent publication changed concurrently; refresh and retry.', 409)
    throw error
  }
  return { ...current, lifecycle: 'published', publishedAt: at }
}
