/**
 * Seed loader — pushes the seed dataset into Sanity via @sanity/client.
 *
 * Run with:
 *   SANITY_AUTH_TOKEN=... npm run seed
 *
 * Token needs write scope on the project (Manage → API → Tokens).
 * Uses deterministic `_id` values so re-running overwrites cleanly.
 */

import { createClient, type SanityClient } from '@sanity/client'
import { seedOrder, seed } from './index'
import { processToSanityFields } from '../../../packages/kernel/src/process-document.ts'
import type {
  CapabilitySeed,
  DecisionSeed,
  DepartmentSeed,
  EntitySeed,
  EvidenceSeed,
  ObjectiveSeed,
  OrganizationSeed,
  PolicySeed,
  WorkflowSeed,
} from './types'

// ── Inline .env loader ────────────────────────────────────────────────────
// Walks up from this file looking for `.env`. Existing process.env wins so a
// caller can still override by exporting a variable directly.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Load EVERY `.env` from this directory up to the repo root, nearest first.
// (Stopping at the first one found picked up apps/studio/.env -- which only
// holds the Studio's SANITY_STUDIO_* vars -- and never reached the root .env
// with SANITY_AUTH_TOKEN.) Earlier files and real env vars win.
function findEnvFiles(startDir: string, maxDepth = 6): string[] {
  const found: string[] = []
  let dir = startDir
  for (let i = 0; i < maxDepth; i++) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) found.push(candidate)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

for (const envPath of findEnvFiles(__dirname)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#\s][^=\s]*)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

interface SRef {
  _type: 'reference'
  _ref: string
  _key: string
}

function refArray(ids: string[]): SRef[] {
  return ids.map((id, i) => ({ _type: 'reference' as const, _ref: id, _key: `k${i}` }))
}

function ref(id: string | null): { _type: 'reference'; _ref: string } | undefined {
  return id ? { _type: 'reference', _ref: id } : undefined
}

// ── Transformers: per-type seed → Sanity document ────────────────────────

function organizationToSanity(s: OrganizationSeed) {
  return {
    _id: s._id,
    _type: 'organization',
    name: s.name,
    mission: s.mission,
    objectives: refArray(s.objectiveIds),
    departments: refArray(s.departmentIds),
    policies: refArray(s.policyIds),
    resources: refArray(s.resourceEntityIds),
  }
}

function departmentToSanity(s: DepartmentSeed) {
  return {
    _id: s._id,
    _type: 'department',
    name: s.name,
    purpose: s.purpose,
    parentDepartment: ref(s.parentDepartmentId),
    leader: ref(s.leaderId),
    members: refArray(s.memberIds),
    capabilities: refArray(s.capabilityIds),
    objectives: refArray(s.objectiveIds),
  }
}

function entityToSanity(s: EntitySeed) {
  return {
    _id: s._id,
    _type: 'entity',
    name: s.name,
    entityType: s.entityType,
    capabilities: refArray(s.capabilityIds),
    permissions: refArray(s.permissionIds),
    constraints: refArray(s.constraintIds),
    reportsTo: ref(s.reportsToId),
    department: ref(s.departmentId),
    availability: s.availability,
    riskProfile: s.riskProfile,
    costProfile: s.costProfile,
  }
}

function capabilityToSanity(s: CapabilitySeed) {
  return {
    _id: s._id,
    _type: 'capability',
    name: s.name,
    description: s.description,
    requiredSkills: s.requiredSkills,
    riskLevel: s.riskLevel,
    authorizedEntities: refArray(s.authorizedEntityIds),
    requiredTools: s.requiredTools,
  }
}

function policyToSanity(s: PolicySeed) {
  return {
    _id: s._id,
    _type: 'policy',
    name: s.name,
    scope: s.scope,
    priority: s.priority,
    rules: s.rules,
    effectiveDate: s.effectiveDate,
    expirationDate: s.expirationDate,
    supersedes: refArray(s.supersedesIds),
    appliesTo: refArray([]),
    approvalRequirements: refArray(s.approvalRequirementIds),
  }
}

function objectiveToSanity(s: ObjectiveSeed) {
  return {
    _id: s._id,
    _type: 'objective',
    name: s.name,
    description: s.description,
    owner: ref(s.ownerId),
    priority: s.priority,
    deadline: s.deadline,
    constraints: s.constraints,
    successMetrics: s.successMetrics,
    budget: s.budget,
    status: s.status,
  }
}

function workflowToSanity(s: WorkflowSeed) {
  // Structured states/transitions/guards go through the kernel's own mapper,
  // so what lands in Content Lake is exactly what processFromSanity() reads.
  return {
    _id: s._id,
    _type: 'workflow',
    trigger: s.trigger,
    ...processToSanityFields({
      id: s._id,
      name: s.name,
      version: s.version,
      initialState: s.initialState,
      states: s.states,
      transitions: s.transitions,
    }),
    requiredCapabilities: refArray(s.requiredCapabilityIds),
    approvalRequirements: refArray(s.approvalRequirementIds),
    failureHandlers: s.failureHandlers,
    rollbackProcedure: s.rollbackProcedure,
  }
}

function evidenceToSanity(s: EvidenceSeed) {
  return {
    _id: s._id,
    _type: 'evidence',
    title: s.title,
    type: s.type,
    source: s.source,
    claim: s.claim,
    confidence: s.confidence,
    effectiveDate: s.effectiveDate,
    relatedEntities: refArray(s.relatedEntityIds),
    supports: refArray(s.supportsObjectiveIds),
    contradicts: refArray(s.contradictsEvidenceIds),
  }
}

function decisionToSanity(s: DecisionSeed) {
  return {
    _id: s._id,
    _type: 'decision',
    question: s.question,
    context: [
      ...refArray(s.contextEntityIds),
      ...refArray(s.contextCapabilityIds),
      ...refArray(s.contextPolicyIds),
    ],
    candidateActions: s.candidateActions.map((c, i) => ({
      _key: `k${i}`,
      description: c.description,
      actor: ref(c.actorId),
      capability: ref(c.capabilityId),
    })),
    selectedAction: s.selectedAction,
    reasoningSummary: s.reasoningSummary,
    evidence: refArray(s.evidenceIds),
    constraints: s.constraints,
    policyChecks: s.policyChecks.map((p, i) => ({
      _key: `k${i}`,
      policy: ref(p.policyId),
      result: p.result,
      reason: p.reason,
    })),
    riskLevel: s.riskLevel,
    requiredApproval: s.requiredApproval,
    status: s.status,
    createdAt: s.createdAt,
    approvedBy: ref(s.approvedById),
    executedAt: s.executedAt,
  }
}

// ── Runner ───────────────────────────────────────────────────────────────

async function pushSeed(client: SanityClient) {
  // One big transaction so cross-document references resolve within it.
  const tx = client.transaction()
  const counts: Record<string, number> = {}
  type SanitySeedDocument = { _id: string; _type: string; [field: string]: unknown }

  function addBatch<T>(type: string, docs: readonly T[], transform: (seed: T) => SanitySeedDocument) {
    const sanityDocs = docs.map(transform)
    counts[type] = sanityDocs.length
    for (const doc of sanityDocs) {
      tx.createOrReplace(doc as Parameters<typeof tx.createOrReplace>[0])
    }
  }

  for (const entry of seedOrder) {
    switch (entry[0]) {
      case 'organization': addBatch(entry[0], entry[1], organizationToSanity); break
      case 'capabilities': addBatch(entry[0], entry[1], capabilityToSanity); break
      case 'policies': addBatch(entry[0], entry[1], policyToSanity); break
      case 'entities': addBatch(entry[0], entry[1], entityToSanity); break
      case 'departments': addBatch(entry[0], entry[1], departmentToSanity); break
      case 'objectives': addBatch(entry[0], entry[1], objectiveToSanity); break
      case 'workflows': addBatch(entry[0], entry[1], workflowToSanity); break
      case 'evidence': addBatch(entry[0], entry[1], evidenceToSanity); break
      case 'decisions': addBatch(entry[0], entry[1], decisionToSanity); break
    }
  }

  await tx.commit()

  for (const [type, count] of Object.entries(counts)) {
    process.stdout.write(`  ${type}: ${count} docs\n`)
  }
}
async function main() {
  const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
  const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET || 'production'
  const token = process.env.SANITY_AUTH_TOKEN
  if (!projectId || projectId === 'd280bqjc') {
    console.error('Set NEXT_PUBLIC_SANITY_PROJECT_ID to the dedicated Nuera Quicksilver Sanity project; legacy challenge writes are blocked.')
    process.exit(1)
  }
  if (!token) {
    console.error('SANITY_AUTH_TOKEN is required. Generate one in Manage → API → Tokens with write scope, then re-run.')
    process.exit(1)
  }

  const client = createClient({
    projectId,
    dataset,
    apiVersion: '2024-10-01',
    token,
    useCdn: false,
  })

  console.log(`Pushing seed to ${projectId}/${dataset}...`)
  await pushSeed(client)
  console.log('Done.')
  console.log(`\nSeed counts:`)
  console.log(`  organization:  1`)
  console.log(`  capabilities:   ${seed.capabilities.length}`)
  console.log(`  policies:       ${seed.policies.length}`)
  console.log(`  entities:       ${seed.entities.length}`)
  console.log(`  departments:    ${seed.departments.length}`)
  console.log(`  objectives:     ${seed.objectives.length}`)
  console.log(`  workflows:      ${seed.workflows.length}`)
  console.log(`  evidence:       ${seed.evidence.length}`)
  console.log(`  decisions:      ${seed.decisions.length}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
