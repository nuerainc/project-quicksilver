import type { Guard, GuardCondition, GuardValue, ProcessDefinition } from './process.ts'

/**
 * Converting process definitions to and from their Sanity document shape.
 *
 * Sanity fields are typed, so a guard condition's value is stored in one of
 * four typed slots (valueString / valueNumber / valueBoolean / valueList)
 * instead of a single untyped field. These two functions are exact inverses
 * for every valid definition (see the round-trip test).
 */

export interface SanityGuardCondition {
  _key: string
  fact: string
  op: string
  valueString?: string
  valueNumber?: number
  valueBoolean?: boolean
  valueList?: string[]
}

export interface SanityProcessDocument {
  _id: string
  _rev?: string
  name: string
  version?: number | null
  initialState?: string | null
  states?: Array<{ _key?: string; id: string; label: string; terminal?: boolean | null }> | null
  transitions?: Array<{
    _key?: string
    id?: string | null
    from: string
    to: string
    label?: string | null
    automatic?: boolean | null
    requiresHumanApproval?: boolean | null
    guardAll?: SanityGuardCondition[] | null
    guardAny?: SanityGuardCondition[] | null
  }> | null
}

function conditionToSanity(c: GuardCondition, i: number): SanityGuardCondition {
  const out: SanityGuardCondition = { _key: `c${i}`, fact: c.fact, op: c.op }
  const v = c.value
  if (Array.isArray(v)) out.valueList = v.map(String)
  else if (typeof v === 'string') out.valueString = v
  else if (typeof v === 'number') out.valueNumber = v
  else if (typeof v === 'boolean') out.valueBoolean = v
  return out
}

function conditionFromSanity(c: SanityGuardCondition): GuardCondition {
  let value: GuardValue | undefined
  if (Array.isArray(c.valueList)) value = c.valueList
  else if (typeof c.valueString === 'string') value = c.valueString
  else if (typeof c.valueNumber === 'number') value = c.valueNumber
  else if (typeof c.valueBoolean === 'boolean') value = c.valueBoolean
  return value === undefined
    ? { fact: c.fact, op: c.op as GuardCondition['op'] }
    : { fact: c.fact, op: c.op as GuardCondition['op'], value }
}

/** Kernel definition → the fields to write on a Sanity `workflow` document. */
export function processToSanityFields(def: ProcessDefinition) {
  return {
    name: def.name,
    version: def.version,
    initialState: def.initialState,
    states: def.states.map((s) => ({ _key: s.id, id: s.id, label: s.label, terminal: s.terminal ?? false })),
    transitions: def.transitions.map((t) => ({
      _key: t.id,
      id: t.id,
      from: t.from,
      to: t.to,
      label: t.label ?? t.id,
      automatic: t.automatic ?? false,
      requiresHumanApproval: t.requiresHumanApproval ?? false,
      guardAll: (t.guard?.all ?? []).map(conditionToSanity),
      guardAny: (t.guard?.any ?? []).map(conditionToSanity),
    })),
  }
}

/**
 * A Sanity `workflow` document → kernel definition.
 * Missing structural fields are passed through as empty/invalid values on
 * purpose: validateProcessDefinition() then rejects the document instead of
 * this function guessing a default.
 */
export function processFromSanity(doc: SanityProcessDocument): ProcessDefinition {
  return {
    id: doc._id,
    name: doc.name,
    version: doc.version ?? 0,
    ...(doc._rev ? { revision: doc._rev } : {}),
    initialState: doc.initialState ?? '',
    states: (doc.states ?? []).map((s) => ({ id: s.id, label: s.label, terminal: s.terminal ?? false })),
    transitions: (doc.transitions ?? []).map((t) => {
      const guard: Guard = {}
      if (t.guardAll?.length) guard.all = t.guardAll.map(conditionFromSanity)
      if (t.guardAny?.length) guard.any = t.guardAny.map(conditionFromSanity)
      return {
        id: t.id ?? '',
        from: t.from,
        to: t.to,
        label: t.label ?? t.id ?? '',
        automatic: t.automatic ?? false,
        requiresHumanApproval: t.requiresHumanApproval ?? false,
        ...(guard.all || guard.any ? { guard } : {}),
      }
    }),
  }
}
