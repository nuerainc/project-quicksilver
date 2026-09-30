import { createHash } from 'node:crypto'
import { BUILT_IN_AGENT_MANIFESTS, validateAgentManifest, type AgentManifest } from '@quicksilver/kernel'

export type AgentLifecycle = 'draft' | 'in-review' | 'published' | 'archived'
export class AgentCatalogFault extends Error {
  readonly status: 400 | 404 | 409
  constructor(message: string, status: 400 | 404 | 409) { super(message); this.name = 'AgentCatalogFault'; this.status = status }
}

export function stableAgentJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableAgentJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableAgentJson(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function agentDefinitionDigest(value: { displayName: string; description: string; manifest: AgentManifest }): string {
  return createHash('sha256').update(stableAgentJson(value)).digest('hex')
}
export function assertValidAgentDefinition(agentId: string, manifest: AgentManifest): void {
  const errors = validateAgentManifest(manifest)
  if (manifest?.id !== agentId) errors.push('agentId must match manifest.id.')
  if (errors.length) throw new AgentCatalogFault(errors.join(' '), 400)
  if (BUILT_IN_AGENT_MANIFESTS.some((item) => item.id === agentId)) throw new AgentCatalogFault('Built-in agent definitions cannot be replaced through the catalog.', 409)
}
export function assertCanSubmit(lifecycle: AgentLifecycle): void {
  if (lifecycle !== 'draft') throw new AgentCatalogFault('Only a draft can be submitted for review.', 409)
}
export function assertHumanAgentActor(actor: { id: string; kind: string }): void {
  if (actor.kind !== 'human' || !actor.id.trim()) throw new AgentCatalogFault('A signed-in human is required for agent lifecycle actions.', 409)
}
export function assertCanReview(lifecycle: AgentLifecycle, actorId: string, authoredBy: string, reviewedBy?: string): void {
  if (lifecycle !== 'in-review' || actorId === authoredBy) throw new AgentCatalogFault('A different human must review a submitted agent definition.', 409)
  if (reviewedBy) throw new AgentCatalogFault('This agent definition has already been reviewed.', 409)
}
export function assertCanPublish(lifecycle: AgentLifecycle, authoredBy: string, reviewedBy: string | undefined, actorId: string): void {
  if (lifecycle !== 'in-review' || !reviewedBy || reviewedBy === authoredBy || reviewedBy === actorId || authoredBy === actorId) {
    throw new AgentCatalogFault('Publication requires independent review and author/reviewer/publisher separation of duties.', 409)
  }
}
export function assertAgentDigest(value: { displayName: string; description: string; manifest: AgentManifest }, expected: string): void {
  if (agentDefinitionDigest(value) !== expected) throw new AgentCatalogFault('Stored agent definition failed its integrity check.', 409)
}
