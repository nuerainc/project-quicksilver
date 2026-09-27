import type { CapabilityRef, EntityRef, ProposedAction } from './types.ts'
import { checkCapabilityGraph, type CapabilityGraph, type SeparationSettings } from './capability-graph.ts'

/**
 * Capability check: can this entity perform this action?
 *
 * Answer is based on whether the actor has the capability in their profile
 * AND the capability authorizes the actor. Since M7 the capability graph
 * (capability-graph.ts) also applies: an invalid graph for this capability,
 * a missing required capability, or a conflicting capability the actor holds
 * refuses the action. Inheritance never grants a right: the actor must hold
 * the exact capability. Without graph fields, behavior is unchanged.
 */
export function checkCapability(
  actor: EntityRef,
  action: ProposedAction,
  capabilities: CapabilityRef[],
  options: { graph?: CapabilityGraph; separation?: SeparationSettings } = {},
): { allowed: boolean; reason: string } {
  const capability = capabilities.find((c) => c.id === action.capabilityId)
  if (!capability) {
    return {
      allowed: false,
      reason: `Capability ${action.capabilityId} not found in the company model.`,
    }
  }

  if (!actor.capabilityIds.includes(capability.id)) {
    return {
      allowed: false,
      reason: `${actor.name} does not have capability "${capability.name}".`,
    }
  }

  if (!capability.authorizedEntityIds.includes(actor.id)) {
    return {
      allowed: false,
      reason: `Capability "${capability.name}" is not granted to ${actor.name}.`,
    }
  }

  const graph = checkCapabilityGraph(actor, capability.id, capabilities, options.graph, options.separation)
  if (graph.blockingReasons.length > 0) {
    return { allowed: false, reason: graph.blockingReasons[0]! }
  }

  return { allowed: true, reason: `Capability verified: ${capability.name}` }
}
