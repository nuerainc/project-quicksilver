/**
 * Top-3 agreement between Aura's impact ranking and a human's ranking.
 *
 * For each objective with more than three open questions, agreement is the
 * share of the human's top three that also appear in Aura's top three
 * (order inside the three is not scored). The charter's 0.4.0 target is a
 * mean of at least 0.8. Objectives with three or fewer questions are skipped:
 * any ranking of them agrees trivially.
 *
 * Ties: when other questions score exactly the same as Aura's third, Aura
 * has no real preference among them, so a human pick from that tied group
 * also counts as a match. (Fixed before any rankings were collected.)
 *
 * The chance baseline is what a random top three would score on average:
 * for n candidates it is 3/n.
 */

export interface HumanRankingSet {
  /** The scorer version the rankings were collected against. */
  scorerVersion: number
  rankedBy: string
  rankedAt: string
  /** Objective id → the human's top three variable ids, most important first. */
  rankings: Record<string, string[]>
}

export interface AgreementReport {
  objectives: number
  meanAgreement: number
  chanceBaseline: number
  exactTopThree: number
  perObjective: Array<{ id: string; candidates: number; agreement: number; aura: string[]; human: string[] }>
  /** Objectives that needed a ranking but have none, or an incomplete one. */
  missing: string[]
  meetsCharterTarget: boolean
}

export interface RankedItem { variableId: string; score: number }

export function topThreeAgreement(aura: Record<string, RankedItem[]>, human: Record<string, string[]>, target = 0.8): AgreementReport {
  const perObjective: AgreementReport['perObjective'] = []
  const missing: string[] = []
  let chance = 0
  for (const [id, items] of Object.entries(aura)) {
    const ranked = items.map((i) => i.variableId)
    if (ranked.length <= 3) continue
    const picks = human[id]
    if (!picks || picks.length !== 3 || new Set(picks).size !== 3 || picks.some((p) => !ranked.includes(p))) { missing.push(id); continue }
    const third = items[2]!.score
    const top = new Set(items.filter((i, k) => k < 3 || Math.abs(i.score - third) < 1e-9).map((i) => i.variableId))
    const agreement = picks.filter((p) => top.has(p)).length / 3
    perObjective.push({ id, candidates: ranked.length, agreement, aura: ranked.slice(0, 3), human: picks })
    chance += 3 / ranked.length
  }
  const n = perObjective.length
  const meanAgreement = n ? perObjective.reduce((s, o) => s + o.agreement, 0) / n : 0
  return {
    objectives: n,
    meanAgreement,
    chanceBaseline: n ? chance / n : 0,
    exactTopThree: perObjective.filter((o) => o.agreement === 1).length,
    perObjective,
    missing,
    meetsCharterTarget: n > 0 && missing.length === 0 && meanAgreement >= target,
  }
}
