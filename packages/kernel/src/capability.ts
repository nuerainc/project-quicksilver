import type { CapabilityRef, EntityRef, ProposedAction } from './types.ts'

/**
 * Capability check: can this entity perform this action?
 *
 * Answer is based on whether the actor has the capability in their profile
 * AND the capability authorizes the actor.
 */
export function checkCapability(
  actor: EntityRef,
  action: ProposedAction,
  capabilities: CapabilityRef[],
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

  return { allowed: true, reason: `Capability verified: ${capability.name}` }
}