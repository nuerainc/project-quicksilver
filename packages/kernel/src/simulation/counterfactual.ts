import { DEFAULT_HAND_OVER, type HandOverRules, type ShadowLog, type ShadowRecommendation, type Verdict } from '../playbooks/shadow.ts'

/**
 * Counterfactuals on shadow logs (M7 part 3, the what-if engine).
 *
 * An ESTIMATE from recorded history, never a decision. It grants nothing:
 * hand-over is still the provider's call in the intent ledger.
 *
 * counterfactualAutonomy replays judged recommendations in time order and asks:
 * "if this department had been allowed to act on its own from the moment the
 * hand-over rules were first met, what would have happened?"
 *   - The rules are the shadowReport rules: at least minJudged judged, agreement
 *     (accepted + ½ modified over judged) at least minAgreement, and no bad
 *     outcome among non-rejected recommendations, counting only outcomes
 *     recorded by that moment.
 *   - After that moment, a recommendation would have run without the owner
 *     only if the kernel said execute-autonomously; anything else still goes
 *     to a human (or is refused).
 *   - Only recorded verdicts and outcomes count. An unjudged recommendation's
 *     verdict is unknown; an outcome is known only for accepted
 *     recommendations (for modified or rejected ones, the recorded outcome is
 *     of what the owner did instead). Unknown is never assumed good.
 *   - Once met, hand-over is assumed to stay; revoking it after a bad outcome
 *     is not modeled.
 */

export interface CounterfactualRow {
  minJudged: number
  minAgreement: number
  /** True for the rules the caller passed (default DEFAULT_HAND_OVER). */
  current: boolean
  /** When the rules were first met (the verdict time), or null if never. */
  metAt: string | null
  judgedWhenMet: number | null
  /** Recommendations proposed after the rules were met. */
  afterHandOver: number
  /** Of those, the ones the kernel would have let run without a human. */
  wouldRunAlone: number
  /** Of wouldRunAlone: what the owner actually said. */
  ownerAccepted: number
  ownerModified: number
  ownerRejected: number
  unjudged: number
  /** Would have been wrong: the owner rejected or modified it. */
  wouldHaveBeenWrong: number
  /** Outcomes of wouldRunAlone, known only where the owner accepted and an outcome was recorded. */
  badOutcomes: number
  goodOutcomes: number
  neutralOutcomes: number
  unknownOutcomes: number
}

export interface DepartmentCounterfactual {
  department: string
  recommendations: number
  judged: number
  current: CounterfactualRow
  table: CounterfactualRow[]
  notes: string[]
}

export interface AutonomyCounterfactual {
  kind: 'estimate'
  rules: HandOverRules
  departments: DepartmentCounterfactual[]
  assumptions: string[]
}

export const COUNTERFACTUAL_GRID = { minAgreement: [0.7, 0.8, 0.9], minJudged: [10, 20, 30] } as const

const ms = (iso: string | undefined) => (iso ? new Date(iso).getTime() : Number.NaN)
const byTime = (a: ShadowRecommendation, b: ShadowRecommendation) => ms(a.verdict!.at) - ms(b.verdict!.at) || ms(a.proposedAt) - ms(b.proposedAt) || a.id.localeCompare(b.id)

function replay(recs: ShadowRecommendation[], rules: HandOverRules, current: boolean): CounterfactualRow {
  const judged = recs.filter((r) => r.verdict).sort(byTime)
  let metAtMs: number | null = null
  let judgedWhenMet: number | null = null
  let accepted = 0, modified = 0
  for (let i = 0; i < judged.length; i++) {
    const r = judged[i]!
    if (r.verdict!.value === 'accepted') accepted++
    else if (r.verdict!.value === 'modified') modified++
    const t = ms(r.verdict!.at)
    const n = i + 1
    if (n < rules.minJudged) continue
    const agreement = Math.round(((accepted + modified / 2) / n) * 1000) / 1000
    if (agreement < rules.minAgreement) continue
    const badKnown = judged.slice(0, n).some((x) => x.verdict!.value !== 'rejected' && x.outcome?.value === 'bad' && ms(x.outcome.at) <= t)
    if (badKnown) continue
    metAtMs = t
    judgedWhenMet = n
    break
  }
  const row: CounterfactualRow = {
    minJudged: rules.minJudged,
    minAgreement: rules.minAgreement,
    current,
    metAt: metAtMs === null ? null : new Date(metAtMs).toISOString(),
    judgedWhenMet,
    afterHandOver: 0, wouldRunAlone: 0, ownerAccepted: 0, ownerModified: 0, ownerRejected: 0, unjudged: 0, wouldHaveBeenWrong: 0,
    badOutcomes: 0, goodOutcomes: 0, neutralOutcomes: 0, unknownOutcomes: 0,
  }
  if (metAtMs === null) return row
  const after = recs.filter((r) => ms(r.proposedAt) > metAtMs!)
  row.afterHandOver = after.length
  for (const r of after) {
    if (r.kernel.recommendation !== 'execute-autonomously') continue
    row.wouldRunAlone++
    const v: Verdict | undefined = r.verdict?.value
    if (v === 'accepted') row.ownerAccepted++
    else if (v === 'modified') row.ownerModified++
    else if (v === 'rejected') row.ownerRejected++
    else row.unjudged++
    const o = v === 'accepted' ? r.outcome?.value : undefined
    if (o === 'bad') row.badOutcomes++
    else if (o === 'good') row.goodOutcomes++
    else if (o === 'neutral') row.neutralOutcomes++
    else row.unknownOutcomes++
  }
  row.wouldHaveBeenWrong = row.ownerModified + row.ownerRejected
  return row
}

export function counterfactualAutonomy(log: ShadowLog, options: { rules?: HandOverRules; department?: string; grid?: { minAgreement: readonly number[]; minJudged: readonly number[] } } = {}): AutonomyCounterfactual {
  const rules = options.rules ?? DEFAULT_HAND_OVER
  const grid = options.grid ?? COUNTERFACTUAL_GRID
  const names = [...new Set(log.recommendations.map((r) => r.department))].filter((d) => options.department === undefined || d === options.department).sort()
  const departments = names.map((department): DepartmentCounterfactual => {
    const recs = log.recommendations.filter((r) => r.department === department)
    const judged = recs.filter((r) => r.verdict).length
    const table: CounterfactualRow[] = []
    for (const minJudged of grid.minJudged) for (const minAgreement of grid.minAgreement) table.push(replay(recs, { minJudged, minAgreement }, minJudged === rules.minJudged && minAgreement === rules.minAgreement))
    const current = replay(recs, rules, true)
    const notes: string[] = []
    if (judged < rules.minJudged) notes.push(`Only ${judged} judged recommendation(s): the ${rules.minJudged} the rules need were never reached, so nothing would have run alone.`)
    else if (current.metAt === null) notes.push('The rules were never met in this history.')
    if (current.metAt && current.afterHandOver === 0) notes.push('The rules were met, but no recommendation came after that moment: nothing to replay yet.')
    if (current.unknownOutcomes) notes.push(`${current.unknownOutcomes} action(s) that would have run alone have no known outcome: unknown, not assumed good.`)
    if (judged < 10) notes.push('Very little history: too short to say much.')
    return { department, recommendations: recs.length, judged, current, table, notes }
  })
  return {
    kind: 'estimate',
    rules,
    departments,
    assumptions: [
      'Replays recorded verdicts in time order; the rules are first met at the verdict that satisfies them, counting only outcomes recorded by then.',
      'After that, a recommendation proposed later would have run alone only when the kernel said execute-autonomously.',
      'Owner rejected or modified = it would have been wrong. Outcomes are known only for accepted recommendations; unknown outcomes are never assumed good.',
      'Hand-over, once met, is assumed to stay (revocation is not modeled).',
      'An estimate from history, not a decision: it grants no autonomy.',
    ],
  }
}

// ── The kernel vs the owner ───────────────────────────────────────────────

export type KernelCall = ShadowRecommendation['kernel']['recommendation']

export interface KernelAgreement {
  judged: number
  /** Counts by kernel recommendation, then owner verdict. */
  matrix: Record<KernelCall, Record<Verdict, number>>
  /** execute-autonomously + accepted, or reject + rejected. */
  matched: number
  /** execute-autonomously but the owner rejected or modified (the kernel was too loose). */
  tooLoose: number
  /** reject but the owner accepted or modified (the kernel was too strict). */
  tooStrict: number
  /** request-approval: the kernel sent it to a human, which is neither a match nor a miss. */
  escalated: number
  /** matched ÷ (judged − escalated); null when every case was escalated. */
  matchRate: number | null
}

export interface KernelCounterfactual {
  kind: 'estimate'
  overall: KernelAgreement
  byDepartment: Record<string, KernelAgreement>
  assumptions: string[]
}

function agreementOf(recs: ShadowRecommendation[]): KernelAgreement {
  const empty = () => ({ accepted: 0, modified: 0, rejected: 0 })
  const matrix: KernelAgreement['matrix'] = { 'execute-autonomously': empty(), 'request-approval': empty(), reject: empty() }
  let matched = 0, tooLoose = 0, tooStrict = 0, escalated = 0, judged = 0
  for (const r of recs) {
    if (!r.verdict) continue
    const k = r.kernel.recommendation, v = r.verdict.value
    if (!matrix[k]) continue
    judged++
    matrix[k][v]++
    if (k === 'request-approval') escalated++
    else if ((k === 'execute-autonomously' && v === 'accepted') || (k === 'reject' && v === 'rejected')) matched++
    else if (k === 'execute-autonomously') tooLoose++
    else tooStrict++
  }
  const decisive = judged - escalated
  return { judged, matrix, matched, tooLoose, tooStrict, escalated, matchRate: decisive > 0 ? Math.round((matched / decisive) * 1000) / 1000 : null }
}

/** How often the kernel's own recommendation matched the owner's verdict. */
export function counterfactualKernel(log: ShadowLog): KernelCounterfactual {
  const byDepartment: Record<string, KernelAgreement> = {}
  for (const d of [...new Set(log.recommendations.map((r) => r.department))].sort()) byDepartment[d] = agreementOf(log.recommendations.filter((r) => r.department === d))
  return {
    kind: 'estimate',
    overall: agreementOf(log.recommendations),
    byDepartment,
    assumptions: [
      'Only judged recommendations count.',
      'Match: execute-autonomously and accepted, or reject and rejected. Modified counts as a miss for execute-autonomously and for reject.',
      'request-approval sends the call to a human, so it is counted as escalated, not as a match or a miss.',
    ],
  }
}
