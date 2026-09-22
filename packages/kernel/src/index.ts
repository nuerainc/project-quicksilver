export * from './types.ts'
export { checkCapability } from './capability.ts'
export { checkAuthority } from './authority.ts'
export { computeRisk, averageEvidenceConfidence } from './risk.ts'
export { authorize } from './approval.ts'
export type { AuthorizeArgs, AuthorizeResult } from './approval.ts'
export {
  GUARD_OPS,
  evaluateCondition,
  evaluateGuard,
  validateProcessDefinition,
  availableTransitions,
  authorizeTransition,
  nextAutomaticTransition,
  historyEntry,
  describeNextSteps,
} from './process.ts'
export type {
  Facts,
  FactValue,
  Guard,
  GuardCondition,
  GuardOp,
  GuardValue,
  ProcessActor,
  ProcessDefinition,
  ProcessHistoryEntry,
  ProcessState,
  ProcessTransition,
  TransitionDecision,
  ValidationResult,
} from './process.ts'
export { processFromSanity, processToSanityFields } from './process-document.ts'
export type { SanityProcessDocument, SanityGuardCondition } from './process-document.ts'
