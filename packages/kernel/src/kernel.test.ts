/**
 * Day 2 kernel test — the question is "Which entities have the capabilities
 * required for process parameter modification?" If yes, ontology works.
 *
 * Plus the demo's killer scenario: kernel authorize() against the same data
 * the agent will see on Day 7, surfacing the policy conflict.
 *
 * Run with:   node --test packages/kernel/src/kernel.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { authorize, checkCapability, checkAuthority, computeRisk } from './index.ts'
import type { CapabilityRef, EntityRef, EvidenceRef, PolicyRef, ProposedAction } from './types.ts'

// ── Minimal scenario mirroring the seed dataset ───────────────────────────

const entities: EntityRef[] = [
  { id: 'entity-engineering-agent', name: 'Engineering Agent', entityType: 'agent', capabilityIds: ['cap-process-param', 'cap-process-simulation', 'cap-incident-response'], reportsToId: 'entity-marcus-webb' },
  { id: 'entity-jin-tanaka', name: 'Jin Tanaka', entityType: 'human', capabilityIds: ['cap-process-param', 'cap-incident-response', 'cap-process-simulation'], reportsToId: 'entity-marcus-webb' },
  { id: 'entity-marcus-webb', name: 'Marcus Webb', entityType: 'human', capabilityIds: ['cap-process-param'], reportsToId: 'entity-sarah-chen' },
  { id: 'entity-sarah-chen', name: 'Sarah Chen', entityType: 'human', capabilityIds: ['cap-emergency-override', 'cap-budget-reallocation'], reportsToId: null },
  { id: 'entity-diego-ruiz', name: 'Diego Ruiz', entityType: 'human', capabilityIds: ['cap-line-adjustment', 'cap-emergency-override'], reportsToId: 'entity-sarah-chen' },
  { id: 'entity-tom-bradley', name: 'Tom Bradley', entityType: 'human', capabilityIds: ['cap-machine-diagnostics', 'cap-maintenance-scheduling', 'cap-incident-response'], reportsToId: 'entity-diego-ruiz' },
]

const capabilities: CapabilityRef[] = [
  { id: 'cap-process-param', name: 'Process Parameter Modification', baseRiskLevel: 4, authorizedEntityIds: ['entity-engineering-agent', 'entity-jin-tanaka', 'entity-marcus-webb'] },
  { id: 'cap-machine-diagnostics', name: 'Machine Diagnostics', baseRiskLevel: 1, authorizedEntityIds: ['entity-maintenance-agent', 'entity-tom-bradley'] },
  { id: 'cap-maintenance-scheduling', name: 'Maintenance Scheduling', baseRiskLevel: 2, authorizedEntityIds: ['entity-maintenance-agent', 'entity-tom-bradley'] },
  { id: 'cap-emergency-override', name: 'Emergency Override', baseRiskLevel: 5, authorizedEntityIds: ['entity-sarah-chen', 'entity-diego-ruiz'] },
  { id: 'cap-process-simulation', name: 'Process Simulation', baseRiskLevel: 1, authorizedEntityIds: ['entity-process-simulator', 'entity-engineering-agent', 'entity-jin-tanaka'] },
]

const policies: PolicyRef[] = [
  { id: 'policy-ops-17', name: 'Operations Policy 17', scope: 'production.parameter_changes', priority: 5, effectiveDate: '2026-01-15', expirationDate: null, supersedesIds: [], approvalRequirementIds: ['entity-diego-ruiz', 'entity-marcus-webb'] },
  { id: 'policy-emergency-4', name: 'Emergency Policy 4', scope: 'production.parameter_changes', priority: 7, effectiveDate: '2026-02-01', expirationDate: null, supersedesIds: [], approvalRequirementIds: ['entity-sarah-chen', 'entity-diego-ruiz'] },
  { id: 'policy-ops-17-superseded', name: 'Operations Policy 17 (legacy 2024)', scope: 'production.parameter_changes', priority: 3, effectiveDate: '2024-06-01', expirationDate: '2026-01-14', supersedesIds: [], approvalRequirementIds: ['entity-jin-tanaka'] },
  { id: 'policy-maint-12', name: 'Maintenance Policy 12', scope: 'maintenance.scheduling', priority: 6, effectiveDate: '2026-03-10', expirationDate: null, supersedesIds: [], approvalRequirementIds: ['entity-tom-bradley'] },
]

const evidence: EvidenceRef[] = [
  { id: 'evidence-maint-847', title: 'Maintenance Report #847', confidence: 0.85 },
  { id: 'evidence-eng-analysis-c2', title: 'Engineering Analysis', confidence: 0.78 },
  { id: 'evidence-historical-17', title: 'Historical Incident #17', confidence: 0.92 },
  { id: 'evidence-vendor-bulletin', title: 'Vendor Bulletin', confidence: 0.7 },
  { id: 'evidence-eng-procedure', title: 'Engineering Procedure', confidence: 0.95 },
  { id: 'evidence-ops-memo', title: 'Operations Memo', confidence: 0.6 },
]

// ── Tests ──────────────────────────────────────────────────────────────────────────────────────────────

test('Day 2 question: which entities have capability for Process Parameter Modification?', () => {
  const capability = capabilities.find((c) => c.id === 'cap-process-param')!
  const authorized = capability.authorizedEntityIds
    .map((id) => entities.find((e) => e.id === id)?.name)
    .filter(Boolean)

  assert.deepEqual(
    authorized.sort(),
    ['Engineering Agent', 'Jin Tanaka', 'Marcus Webb'],
    'Expected three authorized entities for Process Parameter Modification',
  )
})

test('Capability check: Engineering Agent is authorized for Process Parameter Modification', () => {
  const actor = entities.find((e) => e.id === 'entity-engineering-agent')!
  const action: ProposedAction = {
    description: 'Adjust controller parameter X by +5%',
    actorId: actor.id,
    capabilityId: 'cap-process-param',
    applicablePolicyIds: [],
    evidenceIds: [],
    financialExposure: 5000,
    reversible: true,
    operationalImpact: 3,
    uncertainty: 2,
  }
  const result = checkCapability(actor, action, capabilities)
  assert.equal(result.allowed, true)
  assert.match(result.reason, /Capability verified/)
})

test('Capability check: Diego Ruiz is NOT authorized for Process Parameter Modification', () => {
  const diego = entities.find((e) => e.id === 'entity-diego-ruiz')!
  const action: ProposedAction = {
    description: 'Adjust controller parameter X by +5%',
    actorId: diego.id,
    capabilityId: 'cap-process-param',
    applicablePolicyIds: [],
    evidenceIds: [],
    financialExposure: 0,
    reversible: true,
    operationalImpact: 0,
    uncertainty: 0,
  }
  const result = checkCapability(diego, action, capabilities)
  assert.equal(result.allowed, false)
  assert.match(result.reason, /does not have capability/)
})

test('Authority: parameter-change action triggers policy conflict between Ops-17 and Emergency-4', () => {
  const action: ProposedAction = {
    description: 'Adjust controller parameter X by +5%',
    actorId: 'entity-engineering-agent',
    capabilityId: 'cap-process-param',
    applicablePolicyIds: ['policy-ops-17', 'policy-emergency-4'],
    evidenceIds: ['evidence-maint-847', 'evidence-eng-analysis-c2'],
    financialExposure: 5000,
    reversible: true,
    operationalImpact: 3,
    uncertainty: 2,
  }
  const result = checkAuthority(action, policies)
  assert.deepEqual(
    result.conflicts,
    [
      'Multiple non-superseded policies share scope "production.parameter_changes": Operations Policy 17, Emergency Policy 4.',
    ],
    'Both policies must be flagged as conflicting in the same scope',
  )
})

test('Authority: superseded 2024 policy is filtered out', () => {
  const action: ProposedAction = {
    description: 'Adjust controller parameter X by +5%',
    actorId: 'entity-engineering-agent',
    capabilityId: 'cap-process-param',
    applicablePolicyIds: ['policy-ops-17', 'policy-emergency-4', 'policy-ops-17-superseded'],
    evidenceIds: [],
    financialExposure: 0,
    reversible: true,
    operationalImpact: 0,
    uncertainty: 0,
  }
  const result = checkAuthority(action, policies)
  const supersededCheck = result.checks.find((c) => c.policyId === 'policy-ops-17-superseded')
  assert.ok(supersededCheck, 'superseded policy should still appear in checks')
  assert.equal(supersededCheck!.result, 'inapplicable', 'expired 2024 policy must be filtered as inapplicable')
})

test('Risk: parameter change proposal computes to risk 4', () => {
  const action: ProposedAction = {
    description: 'Adjust controller parameter X by +5%',
    actorId: 'entity-engineering-agent',
    capabilityId: 'cap-process-param',
    applicablePolicyIds: [],
    evidenceIds: ['evidence-maint-847', 'evidence-eng-analysis-c2', 'evidence-historical-17'],
    financialExposure: 5000,
    reversible: true,
    operationalImpact: 3,
    uncertainty: 2,
  }
  const capability = capabilities.find((c) => c.id === 'cap-process-param')
  const risk = computeRisk(action, capability, evidence)
  // base 4 + financial 0 (<10k tier 0 or 1) + operational 3 + reversibility 0 + uncertainty 2
  // expected: 4 + 0 + 3 + 0 + 2 = 9 → clamped to 5. The exact clamp may shift with calibration.
  assert.ok(risk >= 4 && risk <= 5, `Expected risk in [4,5], got ${risk}`)
})

test('Authorize: parameter change requires approval (kill-shot demo scenario)', () => {
  const action: ProposedAction = {
    description: 'Adjust controller parameter X on CNC 2 by +5%',
    actorId: 'entity-engineering-agent',
    capabilityId: 'cap-process-param',
    applicablePolicyIds: ['policy-ops-17', 'policy-emergency-4'],
    evidenceIds: ['evidence-maint-847', 'evidence-eng-analysis-c2', 'evidence-historical-17'],
    financialExposure: 5000,
    reversible: true,
    operationalImpact: 3,
    uncertainty: 2,
  }
  const actor = entities.find((e) => e.id === 'entity-engineering-agent')!
  const result = authorize({ action, actor, capabilities, policies, evidence })

  assert.equal(result.authorized, true, 'kernel must authorize the agent to attempt; humans approve the action')
  assert.equal(result.requiresApproval, true, 'risk level demands human approval')
  assert.equal(result.recommendation, 'request-approval', 'must route to approval gate')
  assert.ok(result.policyConflicts.length > 0, 'policy conflict must be surfaced')
  assert.ok(result.riskLevel >= 4, `risk must be >= 4, got ${result.riskLevel}`)
})

test('Authorize: routine machine diagnostics is autonomous', () => {
  const action: ProposedAction = {
    description: 'Run diagnostics on CNC 2',
    actorId: 'entity-tom-bradley',
    capabilityId: 'cap-machine-diagnostics',
    applicablePolicyIds: [],
    evidenceIds: ['evidence-maint-847'],
    financialExposure: 0,
    reversible: true,
    operationalImpact: 0,
    uncertainty: 0,
  }
  const actor = entities.find((e) => e.id === 'entity-tom-bradley')!
  const result = authorize({ action, actor, capabilities, policies, evidence })

  assert.equal(result.authorized, true)
  assert.equal(result.requiresApproval, false)
  assert.equal(result.recommendation, 'execute-autonomously')
})

test('Authorize: no evidence at all is a hard block (cannot review what does not exist)', () => {
  const action: ProposedAction = {
    description: 'Bump production line speed by 10%',
    actorId: 'entity-diego-ruiz',
    capabilityId: 'cap-line-adjustment',
    applicablePolicyIds: [],
    evidenceIds: [],
    financialExposure: 0,
    reversible: true,
    operationalImpact: 2,
    uncertainty: 1,
  }
  const actor = entities.find((e) => e.id === 'entity-diego-ruiz')!
  const result = authorize({ action, actor, capabilities, policies, evidence })

  assert.equal(result.recommendation, 'reject')
  assert.ok(
    result.blockingReasons.some((r) => /no evidence/i.test(r)),
    'must block when no evidence supports the action',
  )
})

// ── Risk-threshold configuration (regression: NaN thresholds failed open) ─────────────────

const RISK_ENV_KEYS = ['QUICKSILVER_RISK_AUTO_MAX', 'QUICKSILVER_RISK_REVIEW_THRESHOLD'] as const

/** Run `fn` with the risk env vars set to `values` (undefined = unset), then restore them. */
function withRiskEnv(values: Partial<Record<(typeof RISK_ENV_KEYS)[number], string | undefined>>, fn: () => void) {
  const saved = RISK_ENV_KEYS.map((k) => [k, process.env[k]] as const)
  try {
    for (const k of RISK_ENV_KEYS) {
      const v = values[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** A maximally risky, irreversible action by an actor who *is* authorized, with clean evidence and no policy concerns. */
function highRiskAction() {
  const action: ProposedAction = {
    description: 'Shut down and reconfigure the entire line',
    actorId: 'entity-engineering-agent',
    capabilityId: 'cap-process-param',
    applicablePolicyIds: [],
    evidenceIds: ['evidence-eng-procedure'],
    financialExposure: 500_000,
    reversible: false,
    operationalImpact: 5,
    uncertainty: 5,
  }
  const actor = entities.find((e) => e.id === 'entity-engineering-agent')!
  return { action, actor, capabilities, policies, evidence }
}

test('Thresholds: env vars unset -> defaults apply, high-risk action is NOT autonomous', () => {
  withRiskEnv({}, () => {
    const result = authorize(highRiskAction())
    assert.equal(result.riskLevel, 5)
    assert.equal(result.requiresApproval, true)
    assert.equal(result.recommendation, 'request-approval')
  })
})

test('Thresholds: empty or garbage env values fall back to defaults instead of NaN', () => {
  for (const bad of ['', '   ', 'abc', '9', '-1', '2.5']) {
    withRiskEnv({ QUICKSILVER_RISK_AUTO_MAX: bad, QUICKSILVER_RISK_REVIEW_THRESHOLD: bad }, () => {
      const result = authorize(highRiskAction())
      assert.equal(result.recommendation, 'request-approval', `value ${JSON.stringify(bad)} must not disable the gate`)
      assert.equal(result.requiresApproval, true)
    })
  }
})

test('Thresholds: valid env values are respected', () => {
  // autoMax=5 / review=5 means the operator explicitly accepted even risk-5 actions.
  withRiskEnv({ QUICKSILVER_RISK_AUTO_MAX: '5', QUICKSILVER_RISK_REVIEW_THRESHOLD: '5' }, () => {
    const result = authorize(highRiskAction())
    assert.equal(result.recommendation, 'execute-autonomously')
    assert.equal(result.requiresApproval, false)
  })
  // Tightening to 0 forces approval for anything with non-zero risk.
  withRiskEnv({ QUICKSILVER_RISK_AUTO_MAX: '0', QUICKSILVER_RISK_REVIEW_THRESHOLD: '0' }, () => {
    const actor = entities.find((e) => e.id === 'entity-tom-bradley')!
    const action: ProposedAction = {
      description: 'Run diagnostics on CNC 2',
      actorId: actor.id,
      capabilityId: 'cap-machine-diagnostics',
      applicablePolicyIds: [],
      evidenceIds: ['evidence-maint-847'],
      financialExposure: 0,
      reversible: true,
      operationalImpact: 0,
      uncertainty: 0,
    }
    const result = authorize({ action, actor, capabilities, policies, evidence })
    assert.equal(result.riskLevel, 1)
    assert.equal(result.requiresApproval, true)
  })
})

test('Thresholds: explicit thresholds argument overrides env', () => {
  withRiskEnv({ QUICKSILVER_RISK_AUTO_MAX: '0', QUICKSILVER_RISK_REVIEW_THRESHOLD: '0' }, () => {
    const result = authorize({ ...highRiskAction(), thresholds: { autoMax: 5, review: 5 } })
    assert.equal(result.recommendation, 'execute-autonomously')
  })
})

test('Authorize: result carries per-policy audit rows for the decision record', () => {
  const actor = entities.find((e) => e.id === 'entity-engineering-agent')!
  const action: ProposedAction = {
    description: 'Adjust controller parameter X by +5%',
    actorId: actor.id,
    capabilityId: 'cap-process-param',
    applicablePolicyIds: ['policy-ops-17', 'policy-emergency-4'],
    evidenceIds: ['evidence-maint-847', 'evidence-eng-analysis-c2'],
    financialExposure: 0,
    reversible: false,
    operationalImpact: 1,
    uncertainty: 1,
  }
  const result = authorize({ action, actor, capabilities, policies, evidence })
  assert.deepEqual(
    result.policyChecks.map((c) => c.policyId).sort(),
    ['policy-emergency-4', 'policy-ops-17'],
  )
})