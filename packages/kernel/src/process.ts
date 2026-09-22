import type { EntityType } from './types.ts'

/**
 * Process engine — executable process definitions.
 *
 * A process definition (Sanity `workflow` document, shown in Studio as
 * "Process definition") declares states, transitions, and guards. The kernel
 * runs it: given a process's current state and a set of facts, it decides
 * whether a transition is legal. Like the rest of the kernel this is
 * DETERMINISTIC and has NO LLM in it.
 *
 * Guards are structured data, never code. A guard is a list of conditions of
 * the form { fact, op, value } drawn from a closed operator set. Nothing here
 * evaluates a string, so a process definition -- even one proposed by an
 * agent -- can never smuggle executable logic into the kernel.
 *
 * Fail-closed rules:
 *   - A condition on a fact that is missing from `facts` is false.
 *   - An invalid definition authorizes nothing.
 *   - A transition marked `requiresHumanApproval` can only be taken by an
 *     actor whose entityType is 'human'.
 */

// ── Types ────────────────────────────────────────────────────────────────

export type FactValue = string | number | boolean | null | undefined

/** Flat, dotted fact names, e.g. { 'kernel.riskLevel': 4, 'execution.success': true }. */
export type Facts = Record<string, FactValue>

export const GUARD_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'exists'] as const
export type GuardOp = (typeof GUARD_OPS)[number]

/** List values are strings only (Sanity stores them as a string array). */
export type GuardValue = string | number | boolean | string[]

export interface GuardCondition {
  fact: string
  op: GuardOp
  value?: GuardValue
}

/**
 * `all`: every condition must hold. `any`: at least one must hold (when given).
 * Both present → both requirements apply. Neither present → the guard passes.
 */
export interface Guard {
  all?: GuardCondition[]
  any?: GuardCondition[]
}

export interface ProcessState {
  id: string
  label: string
  /** No transitions may leave a terminal state. */
  terminal?: boolean
}

export interface ProcessTransition {
  id: string
  from: string
  to: string
  label?: string
  guard?: Guard
  /** Only an actor with entityType 'human' may take this transition. */
  requiresHumanApproval?: boolean
  /** The kernel may take this transition on its own as soon as its guard holds. */
  automatic?: boolean
}

export interface ProcessDefinition {
  id: string
  name: string
  version: number
  /** Content revision (Sanity `_rev`) -- stamped on every transition for audit. */
  revision?: string
  initialState: string
  states: ProcessState[]
  transitions: ProcessTransition[]
}

export interface ProcessActor {
  id: string
  entityType: EntityType
}

export interface ProcessHistoryEntry {
  transitionId: string
  from: string
  to: string
  actorId: string
  actorType: EntityType
  at: string
  processVersion: number
  processRevision?: string
}

// ── Guard evaluation ─────────────────────────────────────────────────────

export interface ConditionResult {
  condition: GuardCondition
  passed: boolean
  /** Human-readable explanation, e.g. `kernel.riskLevel is 4, needs lte 2`. */
  explanation: string
}

export interface GuardResult {
  passed: boolean
  results: ConditionResult[]
  /** Explanations for the conditions that made the guard fail. */
  failures: string[]
}

function fmt(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`
  return JSON.stringify(v)
}

function compare(actual: FactValue, op: GuardOp, expected: GuardValue | undefined): boolean {
  if (op === 'exists') {
    const shouldExist = expected === undefined ? true : expected === true
    const present = actual !== undefined && actual !== null
    return present === shouldExist
  }
  // Every other operator needs a real fact value -- missing facts fail closed.
  if (actual === undefined || actual === null) return false
  switch (op) {
    case 'eq':
      return actual === expected
    case 'neq':
      return actual !== expected
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof actual !== 'number' || typeof expected !== 'number') return false
      if (op === 'gt') return actual > expected
      if (op === 'gte') return actual >= expected
      if (op === 'lt') return actual < expected
      return actual <= expected
    }
    case 'in':
    case 'notIn': {
      if (!Array.isArray(expected) || typeof actual !== 'string') return false
      const found = expected.includes(actual)
      return op === 'in' ? found : !found
    }
  }
}

export function evaluateCondition(condition: GuardCondition, facts: Facts): ConditionResult {
  const actual = facts[condition.fact]
  const passed = compare(actual, condition.op, condition.value)
  const expectation =
    condition.op === 'exists'
      ? condition.value === false ? 'must be absent' : 'must be present'
      : `needs ${condition.op} ${fmt(condition.value)}`
  const actualText = actual === undefined || actual === null ? 'missing' : `is ${fmt(actual)}`
  return {
    condition,
    passed,
    explanation: `${condition.fact} ${actualText}, ${expectation}`,
  }
}

export function evaluateGuard(guard: Guard | undefined, facts: Facts): GuardResult {
  const all = guard?.all ?? []
  const any = guard?.any ?? []
  const allResults = all.map((c) => evaluateCondition(c, facts))
  const anyResults = any.map((c) => evaluateCondition(c, facts))

  const allPassed = allResults.every((r) => r.passed)
  const anyPassed = any.length === 0 || anyResults.some((r) => r.passed)

  const failures = [
    ...allResults.filter((r) => !r.passed).map((r) => r.explanation),
    ...(anyPassed ? [] : [`none of: ${anyResults.map((r) => r.explanation).join('; ')}`]),
  ]
  return { passed: allPassed && anyPassed, results: [...allResults, ...anyResults], failures }
}

// ── Definition validation ────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

const FACT_NAME = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/

/**
 * Structural checks a process definition must pass before the kernel will
 * run it. Catches the mistakes that make a process unsafe to automate:
 * dangling states, unreachable states, dead ends, and malformed guards.
 */
export function validateProcessDefinition(def: ProcessDefinition): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const stateIds = new Set<string>()
  for (const s of def.states ?? []) {
    if (!s.id) errors.push('A state has no id.')
    else if (stateIds.has(s.id)) errors.push(`Duplicate state id "${s.id}".`)
    else stateIds.add(s.id)
  }
  if (stateIds.size === 0) errors.push('Process has no states.')
  if (!stateIds.has(def.initialState)) errors.push(`Initial state "${def.initialState}" is not a declared state.`)
  if (!Number.isInteger(def.version) || def.version < 1) errors.push('Version must be a positive integer.')

  const terminal = new Set((def.states ?? []).filter((s) => s.terminal).map((s) => s.id))
  if (terminal.size === 0) errors.push('Process has no terminal state.')

  const transitionIds = new Set<string>()
  for (const t of def.transitions ?? []) {
    const where = `Transition "${t.id || `${t.from}->${t.to}`}"`
    if (!t.id) errors.push(`${where} has no id.`)
    else if (transitionIds.has(t.id)) errors.push(`Duplicate transition id "${t.id}".`)
    else transitionIds.add(t.id)
    if (!stateIds.has(t.from)) errors.push(`${where} starts at undeclared state "${t.from}".`)
    if (!stateIds.has(t.to)) errors.push(`${where} ends at undeclared state "${t.to}".`)
    if (terminal.has(t.from)) errors.push(`${where} leaves terminal state "${t.from}".`)
    if (t.automatic && t.requiresHumanApproval) {
      errors.push(`${where} is both automatic and requires human approval.`)
    }
    for (const c of [...(t.guard?.all ?? []), ...(t.guard?.any ?? [])]) {
      if (!FACT_NAME.test(c.fact ?? '')) errors.push(`${where} has an invalid fact name "${c.fact}".`)
      if (!(GUARD_OPS as readonly string[]).includes(c.op)) {
        errors.push(`${where} uses unknown operator "${c.op}".`)
        continue
      }
      if ((c.op === 'in' || c.op === 'notIn') && !(Array.isArray(c.value) && c.value.every((x) => typeof x === 'string'))) {
        errors.push(`${where}: operator "${c.op}" on ${c.fact} needs a list of strings.`)
      }
      if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && typeof c.value !== 'number') {
        errors.push(`${where}: operator "${c.op}" on ${c.fact} needs a number value.`)
      }
      if (['eq', 'neq'].includes(c.op) && (c.value === undefined || Array.isArray(c.value))) {
        errors.push(`${where}: operator "${c.op}" on ${c.fact} needs a single value.`)
      }
    }
    if (t.automatic && !t.guard?.all?.length && !t.guard?.any?.length) {
      warnings.push(`${where} is automatic with no guard -- it fires unconditionally.`)
    }
  }

  if (errors.length === 0) {
    // Reachability from the initial state.
    const out = new Map<string, string[]>()
    const inbound = new Map<string, string[]>()
    for (const t of def.transitions) {
      out.set(t.from, [...(out.get(t.from) ?? []), t.to])
      inbound.set(t.to, [...(inbound.get(t.to) ?? []), t.from])
    }
    const reachable = walk(def.initialState, out)
    for (const id of stateIds) {
      if (!reachable.has(id)) errors.push(`State "${id}" is unreachable from "${def.initialState}".`)
    }
    // Every state must be able to reach some terminal state (no traps).
    const canFinish = new Set<string>()
    for (const t of terminal) for (const s of walk(t, inbound)) canFinish.add(s)
    for (const id of stateIds) {
      if (!canFinish.has(id)) errors.push(`State "${id}" can never reach a terminal state (dead end).`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function walk(start: string, edges: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const next of edges.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

// ── Transition authorization ─────────────────────────────────────────────

export interface TransitionOption {
  transition: ProcessTransition
  guard: GuardResult
}

/** Every transition leaving `currentState`, with its guard evaluated against `facts`. */
export function availableTransitions(
  def: ProcessDefinition,
  currentState: string,
  facts: Facts,
): TransitionOption[] {
  return def.transitions
    .filter((t) => t.from === currentState)
    .map((transition) => ({ transition, guard: evaluateGuard(transition.guard, facts) }))
}

export interface AuthorizeTransitionArgs {
  definition: ProcessDefinition
  currentState: string
  /** Pick by transition id ... */
  transitionId?: string
  /** ... or by target state (the first transition from here to `to` whose guard holds). */
  to?: string
  facts: Facts
  actor: ProcessActor
}

export interface TransitionDecision {
  allowed: boolean
  transition: ProcessTransition | null
  from: string
  to: string | null
  reasons: string[]
  guard: GuardResult | null
}

export function authorizeTransition(args: AuthorizeTransitionArgs): TransitionDecision {
  const { definition, currentState, transitionId, to, facts, actor } = args
  const deny = (reasons: string[], transition: ProcessTransition | null = null, guard: GuardResult | null = null): TransitionDecision => ({
    allowed: false,
    transition,
    from: currentState,
    to: transition?.to ?? to ?? null,
    reasons,
    guard,
  })

  const validation = validateProcessDefinition(definition)
  if (!validation.valid) {
    return deny([`Process definition "${definition.name}" v${definition.version} is invalid: ${validation.errors.join(' ')}`])
  }
  if (!definition.states.some((s) => s.id === currentState)) {
    return deny([`Current state "${currentState}" is not part of "${definition.name}".`])
  }
  if (!transitionId && !to) return deny(['No transition or target state requested.'])

  const options = availableTransitions(definition, currentState, facts).filter(
    (o) => (transitionId ? o.transition.id === transitionId : o.transition.to === to),
  )
  if (options.length === 0) {
    const what = transitionId ? `transition "${transitionId}"` : `a transition to "${to}"`
    return deny([`"${definition.name}" has no ${what} from state "${currentState}".`])
  }

  // With a target state there may be several routes; take the first whose guard holds.
  const chosen = options.find((o) => o.guard.passed) ?? options[0]!
  const { transition, guard } = chosen

  const reasons: string[] = []
  if (!guard.passed) reasons.push(...guard.failures.map((f) => `Guard not met: ${f}.`))
  if (transition.requiresHumanApproval && actor.entityType !== 'human') {
    reasons.push(`Transition "${transition.id}" requires a human; actor "${actor.id}" is ${actor.entityType}.`)
  }
  if (reasons.length > 0) return deny(reasons, transition, guard)

  return { allowed: true, transition, from: currentState, to: transition.to, reasons: [], guard }
}

/**
 * The automatic transition the kernel may take on its own from `currentState`,
 * if any: the first `automatic` transition (declaration order) whose guard holds.
 */
export function nextAutomaticTransition(
  definition: ProcessDefinition,
  currentState: string,
  facts: Facts,
): TransitionDecision | null {
  if (!validateProcessDefinition(definition).valid) return null
  const hit = availableTransitions(definition, currentState, facts).find(
    (o) => o.transition.automatic && o.guard.passed,
  )
  if (!hit) return null
  return { allowed: true, transition: hit.transition, from: currentState, to: hit.transition.to, reasons: [], guard: hit.guard }
}

/** The audit row to append to a process's history after an allowed transition. */
export function historyEntry(
  definition: ProcessDefinition,
  decision: TransitionDecision,
  actor: ProcessActor,
  at: string,
): ProcessHistoryEntry {
  if (!decision.allowed || !decision.transition || !decision.to) {
    throw new Error('historyEntry() called for a transition that was not allowed.')
  }
  return {
    transitionId: decision.transition.id,
    from: decision.from,
    to: decision.to,
    actorId: actor.id,
    actorType: actor.entityType,
    at,
    processVersion: definition.version,
    ...(definition.revision ? { processRevision: definition.revision } : {}),
  }
}

/** Human-facing summary of what can happen next from a state (for the UI). */
export function describeNextSteps(definition: ProcessDefinition, currentState: string, facts: Facts) {
  const state = definition.states.find((s) => s.id === currentState)
  return {
    state: currentState,
    stateLabel: state?.label ?? currentState,
    terminal: state?.terminal ?? false,
    next: availableTransitions(definition, currentState, facts).map(({ transition, guard }) => ({
      id: transition.id,
      label: transition.label ?? transition.id,
      to: transition.to,
      requiresHuman: transition.requiresHumanApproval ?? false,
      automatic: transition.automatic ?? false,
      guardPassed: guard.passed,
    })),
  }
}
