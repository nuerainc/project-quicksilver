import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import type { AgentManifest } from '@quicksilver/kernel'
import { AgentCatalogFault } from './agent-catalog-contract.ts'
import type { AgentActor, AgentCatalogDependencies } from './agent-catalog-store.ts'

register('./route-test-loader.mjs', import.meta.url)
const { createAgentDraft, listAgentCatalog, listAgentDefinitions, publishAgentDefinition, reviewAgentDefinition, submitAgentDefinition } = await import('./agent-catalog-store.ts')

type Doc = Record<string, any> & { _id: string; _type: string; _rev: string; tenantId: string }
class MemorySanity {
  readonly docs = new Map<string, Doc>()
  fetch = async <T>(query: string, params: Record<string, unknown> = {}): Promise<T> => {
    let docs = [...this.docs.values()].filter((doc) => doc.tenantId === params.tenant)
    if (query.includes('_type == "agentDefinition"')) {
      docs = docs.filter((doc) => doc._type === 'agentDefinition')
      if (params.id) docs = docs.filter((doc) => doc.agentId === params.id)
      if (typeof params.version === 'number') docs = docs.filter((doc) => doc.version === params.version)
      for (const lifecycle of ['active', 'review', 'draft'] as const) if (query.includes(`lifecycle == "${lifecycle}"`)) docs = docs.filter((doc) => doc.lifecycle === lifecycle)
      if (query.includes('order(agentId asc')) docs.sort((a, b) => a.agentId.localeCompare(b.agentId) || b.version - a.version)
      else docs.sort((a, b) => b.version - a.version)
      if (query.includes('[0...1]')) docs = docs.slice(0, 1)
      if (query.includes('[0...100]')) docs = docs.slice(0, 100)
      if (query.includes('[0...200]')) docs = docs.slice(0, 200)
      if (query.includes('[0]')) return (docs[0] ?? null) as T
      if (query.includes('{version}')) return docs.map(({ version }) => ({ version })) as T
      return docs as T
    }
    if (query.includes('_type == "agentPublicationHead"')) {
      docs = docs.filter((doc) => doc._type === 'agentPublicationHead')
      if (params.id) docs = docs.filter((doc) => doc.agentId === params.id)
      if (query.includes('[0]')) return (docs[0] ?? null) as T
      return docs as T
    }
    if (query.includes('_type == "agentPublicationAudit"')) {
      docs = docs.filter((doc) => doc._type === 'agentPublicationAudit')
      if (params.id) docs = docs.filter((doc) => doc.agentId === params.id)
      return docs.sort((a, b) => b.at.localeCompare(a.at)) as T
    }
    throw new Error(`Unhandled test query: ${query}`)
  }
  transaction() {
    return this.transactionChain([])
  }
  private transactionChain(operations: Array<{ kind: 'create'; doc: Doc } | { kind: 'patch'; id: string; expectedRev: string; set: Record<string, unknown> }>) {
    const chain = {
      create: (doc: Doc) => { operations.push({ kind: 'create', doc }); return chain },
      patch: (id: string, build: (patch: { ifRevisionId: (rev: string) => { set: (value: Record<string, unknown>) => unknown } }) => unknown) => {
        let expectedRev = ''; let set: Record<string, unknown> = {}
        build({ ifRevisionId: (rev) => ({ set: (value) => { expectedRev = rev; set = value } }) })
        operations.push({ kind: 'patch', id, expectedRev, set }); return chain
      },
      commit: async () => {
        for (const op of operations) {
          if (op.kind === 'create' && this.docs.has(op.doc._id)) throw Object.assign(new Error('duplicate'), { statusCode: 409 })
          if (op.kind === 'patch' && this.docs.get(op.id)?._rev !== op.expectedRev) throw new Error('stale revision')
        }
        for (const op of operations) {
          if (op.kind === 'create') this.docs.set(op.doc._id, { ...op.doc, _rev: 'r1' })
          else { const current = this.docs.get(op.id)!; this.docs.set(op.id, { ...current, ...op.set, _rev: `r${Number(current._rev.slice(1)) + 1}` }) }
        }
      },
    }
    return chain
  }
}

const manifest = (): AgentManifest => ({ id: 'nuera-quicksilver:compliance', version: 1, authority: 'propose', tasks: ['reasoning', 'evaluation'], maximumImpact: 'moderate', requiresEvaluation: true })
const actor = (id: string): AgentActor => ({ id, kind: 'human' })
function setup(tenantId = 'tenant-a') {
  const client = new MemorySanity()
  return { client, deps: { client: client as never, tenantId } satisfies AgentCatalogDependencies }
}
const expectConflict = async (promise: Promise<unknown>) => assert.rejects(promise, (error: unknown) => error instanceof AgentCatalogFault && error.status === 409)

test('agent catalog persists isolated immutable versions through draft, independent review, and publication', async () => {
  const { client, deps } = setup()
  const first = await createAgentDraft({ displayName: 'Compliance Agent', description: 'Reviews policy and compliance tasks.', manifest: manifest() }, actor('author-1'), deps)
  assert.equal(first.version, 1)
  assert.equal(first.manifest.version, 1)
  assert.equal((await listAgentCatalog(deps)).drafts.length, 1)
  assert.equal((await listAgentCatalog(deps, 'unrelated-reader')).drafts.length, 0, 'the HTTP catalog only exposes a draft to its author')
  await submitAgentDefinition(first.agentId, first.version, actor('author-1'), deps)
  await expectConflict(reviewAgentDefinition(first.agentId, first.version, actor('author-1'), 'Self review must fail.', deps))
  await assert.rejects(reviewAgentDefinition(first.agentId, first.version, actor('reviewer-1'), 'short', deps), (error: unknown) => error instanceof AgentCatalogFault && error.status === 400)
  await reviewAgentDefinition(first.agentId, first.version, actor('reviewer-1'), 'Manifest scopes match the approved task family.', deps)
  await expectConflict(reviewAgentDefinition(first.agentId, first.version, actor('reviewer-2'), 'Second review is not allowed.', deps))
  await expectConflict(publishAgentDefinition(first.agentId, first.version, actor('reviewer-1'), deps))
  await expectConflict(publishAgentDefinition(first.agentId, first.version, actor('author-1'), deps))
  await publishAgentDefinition(first.agentId, first.version, actor('publisher-1'), deps)

  const second = await createAgentDraft({ displayName: 'Compliance Agent', description: 'Reviews policy and compliance tasks with updated scope.', manifest: manifest() }, actor('author-2'), deps)
  assert.equal(second.version, 2)
  assert.equal(second.manifest.version, 2, 'the server binds manifest version to the immutable stored version')
  await submitAgentDefinition(second.agentId, second.version, actor('author-2'), deps)
  await reviewAgentDefinition(second.agentId, second.version, actor('reviewer-2'), 'The revised task scope remains evaluation-gated.', deps)
  await publishAgentDefinition(second.agentId, second.version, actor('publisher-2'), deps)

  const catalog = await listAgentCatalog(deps)
  assert.equal(catalog.agents.find((item) => item.agentId === first.agentId)?.version, 2)
  assert.equal(catalog.drafts.length, 0)
  assert.equal(catalog.reviewQueue.length, 0)
  const versions = await listAgentDefinitions(first.agentId, deps)
  assert.deepEqual(versions.versions.map((item) => [item.version, item.lifecycle]), [[2, 'published'], [1, 'archived']])
  assert.ok(versions.audit.some((item) => item.event === 'deprecated' && item.version === 1))
  assert.equal(versions.audit.length, 9)

  const otherTenant = setup('tenant-b')
  const isolated = await listAgentCatalog(otherTenant.deps)
  assert.equal(isolated.drafts.length, 0)
  assert.equal(isolated.agents.some((item) => item.agentId === first.agentId), false)
  assert.equal(client.docs.size > 0, true)
})

test('agent catalog fails closed when stored definition content no longer matches its digest', async () => {
  const { client, deps } = setup()
  const draft = await createAgentDraft({ displayName: 'Compliance Agent', description: 'Reviews policy and compliance tasks.', manifest: manifest() }, actor('author'), deps)
  const stored = [...client.docs.values()].find((doc) => doc._type === 'agentDefinition')!
  stored.description = 'Modified outside the audited catalog.'
  await assert.rejects(listAgentDefinitions(draft.agentId, deps), (error: unknown) => error instanceof AgentCatalogFault && error.status === 409)
})
