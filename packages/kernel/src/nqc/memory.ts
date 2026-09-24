export type MemoryKind = 'failure-exemplar' | 'routing-rule' | 'safety-constraint' | 'domain-pattern' | 'agent-profile' | 'model-profile'

export interface GovernedMemoryEntry {
  id: string
  kind: MemoryKind
  domain: string
  content: string
  source: string
  confidence: number
  retentionDays: number
  approvalId?: string
}

export interface MemoryGovernanceDecision {
  allowed: boolean
  requiresApproval: boolean
  reasons: string[]
  safeEntry?: Omit<GovernedMemoryEntry, 'approvalId'>
}

const SECRET_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i,
]

const SENSITIVE_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\d[ -]*?){13,19}\b/,
]

/** Fail-closed checks before a memory entry reaches any persistence adapter. */
export function governMemoryWrite(
  entry: GovernedMemoryEntry,
  verifySupervisorApproval?: (approvalId: string, entry: GovernedMemoryEntry) => boolean,
): MemoryGovernanceDecision {
  const reasons: string[] = []
  const requiresApproval = entry.kind === 'routing-rule'
    || entry.kind === 'safety-constraint'
    || entry.kind === 'agent-profile'
    || entry.kind === 'model-profile'

  if (!entry.id.trim()) reasons.push('Memory id is required.')
  if (!entry.domain.trim()) reasons.push('Memory domain is required.')
  if (!entry.source.trim()) reasons.push('Memory source is required.')
  if (!entry.content.trim()) reasons.push('Memory content is required.')
  if (entry.content.length > 10_000) reasons.push('Memory content exceeds 10,000 characters.')
  if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) reasons.push('Confidence must be between 0 and 1.')
  if (!Number.isInteger(entry.retentionDays) || entry.retentionDays < 1 || entry.retentionDays > 3_650) reasons.push('Retention must be 1–3,650 days.')
  if (SECRET_PATTERNS.some((pattern) => pattern.test(entry.content))) reasons.push('Memory appears to contain a credential or private key.')
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(entry.content))) reasons.push('Memory appears to contain sensitive personal or payment data.')
  if (requiresApproval && (!entry.approvalId || !verifySupervisorApproval?.(entry.approvalId, entry))) {
    reasons.push('This memory kind requires a verified supervisor approval record.')
  }

  const allowed = reasons.length === 0
  return {
    allowed,
    requiresApproval,
    reasons,
    ...(allowed ? { safeEntry: {
      id: entry.id,
      kind: entry.kind,
      domain: entry.domain,
      content: entry.content,
      source: entry.source,
      confidence: entry.confidence,
      retentionDays: entry.retentionDays,
    } } : {}),
  }
}

/** Store adapter hook: the callback is invoked only for a fully governed write. */
export async function writeGovernedMemory<T>(
  entry: GovernedMemoryEntry,
  persist: (safeEntry: NonNullable<MemoryGovernanceDecision['safeEntry']>) => Promise<T>,
  verifySupervisorApproval?: (approvalId: string, entry: GovernedMemoryEntry) => boolean,
): Promise<{ decision: MemoryGovernanceDecision; result?: T }> {
  const decision = governMemoryWrite(entry, verifySupervisorApproval)
  if (!decision.allowed || !decision.safeEntry) return { decision }
  return { decision, result: await persist(decision.safeEntry) }
}
