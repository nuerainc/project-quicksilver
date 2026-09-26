/**
 * Shadow mode (M4): Quicksilver recommends, the owner decides, nothing runs.
 *
 * - A recommendation carries the kernel's verdict on it (what the kernel
 *   would have done), but this module has no way to execute anything: every
 *   record says `executed: false`, and there is no function that changes it.
 * - Only a human judges a recommendation: accepted, modified or rejected.
 *   Later, the outcome of what was actually done is recorded.
 * - A department becomes ready for hand-over only with enough judged
 *   recommendations, high agreement and no bad outcomes among accepted ones.
 *   Ready means "propose it": the provider grants autonomy themselves, in
 *   the intent ledger. Shadow mode never grants anything.
 */

export type Verdict = 'accepted' | 'modified' | 'rejected'
export type Outcome = 'good' | 'neutral' | 'bad'

export interface ShadowRecommendation {
  id: string
  department: string
  description: string
  proposedAt: string
  /** What the kernel said about the action (authorize().recommendation), and its risk. */
  kernel: { recommendation: 'execute-autonomously' | 'request-approval' | 'reject'; riskLevel: number }
  executed: false
  verdict?: { value: Verdict; by: string; at: string; note?: string }
  outcome?: { value: Outcome; by: string; at: string; note?: string }
}

export interface ShadowLog {
  recommendations: ShadowRecommendation[]
}

export interface HandOverRules {
  minJudged: number
  minAgreement: number
}

export const DEFAULT_HAND_OVER: HandOverRules = { minJudged: 20, minAgreement: 0.8 }

type Actor = { id: string; kind: 'human' | 'agent' | 'service' }
type Result = { ok: true; log: ShadowLog } | { ok: false; reason: string }

export function recommend(log: ShadowLog, rec: Omit<ShadowRecommendation, 'executed' | 'verdict' | 'outcome'>): Result {
  if (log.recommendations.some((r) => r.id === rec.id)) return { ok: false, reason: `Recommendation "${rec.id}" already exists.` }
  if (!rec.department?.trim() || !rec.description?.trim()) return { ok: false, reason: 'A recommendation needs a department and a description.' }
  return { ok: true, log: { recommendations: [...log.recommendations, { ...rec, executed: false }] } }
}

export function judge(log: ShadowLog, id: string, actor: Actor, value: Verdict, at: Date, note?: string): Result {
  if (actor.kind !== 'human') return { ok: false, reason: 'Only a human judges shadow recommendations.' }
  const rec = log.recommendations.find((r) => r.id === id)
  if (!rec) return { ok: false, reason: `No recommendation "${id}".` }
  if (rec.verdict) return { ok: false, reason: 'This recommendation was already judged; verdicts are not rewritten.' }
  return { ok: true, log: { recommendations: log.recommendations.map((r) => (r.id === id ? { ...r, verdict: { value, by: actor.id, at: at.toISOString(), ...(note ? { note } : {}) } } : r)) } }
}

export function recordOutcome(log: ShadowLog, id: string, actor: Actor, value: Outcome, at: Date, note?: string): Result {
  if (actor.kind !== 'human') return { ok: false, reason: 'Only a human records outcomes.' }
  const rec = log.recommendations.find((r) => r.id === id)
  if (!rec?.verdict) return { ok: false, reason: 'Judge the recommendation before recording its outcome.' }
  if (rec.outcome) return { ok: false, reason: 'The outcome was already recorded.' }
  return { ok: true, log: { recommendations: log.recommendations.map((r) => (r.id === id ? { ...r, outcome: { value, by: actor.id, at: at.toISOString(), ...(note ? { note } : {}) } } : r)) } }
}

export interface DepartmentReport {
  department: string
  recommendations: number
  judged: number
  accepted: number
  modified: number
  rejected: number
  /** accepted + ½ × modified, over judged. */
  agreement: number | null
  badOutcomesOnAccepted: number
  /** Share of recommendations the kernel would have sent to a human anyway. */
  kernelEscalations: number
  readyForHandOver: boolean
  reasons: string[]
}

export function shadowReport(log: ShadowLog, rules: HandOverRules = DEFAULT_HAND_OVER): DepartmentReport[] {
  const departments = [...new Set(log.recommendations.map((r) => r.department))].sort()
  return departments.map((department) => {
    const recs = log.recommendations.filter((r) => r.department === department)
    const judged = recs.filter((r) => r.verdict)
    const count = (v: Verdict) => judged.filter((r) => r.verdict!.value === v).length
    const accepted = count('accepted'), modified = count('modified'), rejected = count('rejected')
    const agreement = judged.length ? Math.round(((accepted + modified / 2) / judged.length) * 1000) / 1000 : null
    const bad = recs.filter((r) => r.verdict?.value !== 'rejected' && r.outcome?.value === 'bad').length
    const reasons: string[] = []
    if (judged.length < rules.minJudged) reasons.push(`${judged.length} of ${rules.minJudged} judged recommendations needed.`)
    if (agreement !== null && agreement < rules.minAgreement) reasons.push(`Agreement ${Math.round(agreement * 100)}% is below ${Math.round(rules.minAgreement * 100)}%.`)
    if (bad) reasons.push(`${bad} accepted recommendation(s) had a bad outcome.`)
    return {
      department,
      recommendations: recs.length,
      judged: judged.length,
      accepted, modified, rejected,
      agreement,
      badOutcomesOnAccepted: bad,
      kernelEscalations: recs.length ? Math.round((recs.filter((r) => r.kernel.recommendation !== 'execute-autonomously').length / recs.length) * 1000) / 1000 : 0,
      readyForHandOver: reasons.length === 0,
      reasons,
    }
  })
}

/** Facts for the Onboard playbook's shadow → graduate transition (overall, across departments). */
export function shadowFacts(log: ShadowLog): { 'shadow.recommendations': number; 'shadow.agreement': number } {
  const judged = log.recommendations.filter((r) => r.verdict)
  const accepted = judged.filter((r) => r.verdict!.value === 'accepted').length
  const modified = judged.filter((r) => r.verdict!.value === 'modified').length
  return { 'shadow.recommendations': judged.length, 'shadow.agreement': judged.length ? Math.round(((accepted + modified / 2) / judged.length) * 1000) / 1000 : 0 }
}
