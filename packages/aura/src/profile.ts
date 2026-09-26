/**
 * Intent profile: short forced-choice items, each measuring one dimension of
 * what an intent provider wants (for example, short term vs long term).
 *
 * - Each item offers two reasonable options, each tied to one pole of its
 *   dimension, and the provider says whether they lean slightly or clearly.
 * - Some items come back later reworded with the options swapped ("mirrors").
 *   If the two answers point the same way, the reading is trustworthy; if
 *   not, that dimension is reported with low confidence, never as a firm value.
 * - Honesty and legality are not dimensions: they are fixed limits (the law,
 *   WAES and the provider's own red lines), never weights to trade.
 * - Scoring is deterministic. The result is the provider's own statement, so
 *   it may seed their weights in the intent ledger as provider-stated.
 */

export interface ProfileDimension {
  id: string
  left: string
  right: string
}

export interface ProfileOption {
  text: string
  pole: 'left' | 'right'
}

export interface ProfileItem {
  id: string
  dimension: string
  stem: string
  a: ProfileOption
  b: ProfileOption
  /** For a consistency item: the id of the item it restates. */
  mirrors?: string
}

export interface ProfileInstrument {
  version: number
  dimensions: ProfileDimension[]
  order: string[]
  items: ProfileItem[]
}

export interface ProfileAnswer {
  choice: 'a' | 'b'
  /** 1 = slightly, 2 = clearly. */
  strength: 1 | 2
}

export type Confidence = 'high' | 'medium' | 'low'

export interface DimensionResult {
  dimension: string
  left: string
  right: string
  /** −1 (fully left) to +1 (fully right). */
  score: number
  /** Plain-language reading, e.g. "Long term (clear)" or "Balanced". */
  lean: string
  answered: number
  /** Share of answers on the majority side, 0.5–1. */
  agreement: number
  /** Whether the mirrored pair pointed the same way; null when not answered. */
  consistent: boolean | null
  confidence: Confidence
}

export interface ProfileResult {
  instrumentVersion: number
  complete: boolean
  missing: string[]
  /** Share of mirrored pairs whose two answers point the same way. */
  consistency: number | null
  dimensions: DimensionResult[]
}

export function answerValue(item: ProfileItem, answer: ProfileAnswer): number {
  const pole = answer.choice === 'a' ? item.a.pole : item.b.pole
  return (pole === 'right' ? 1 : -1) * (answer.strength === 2 ? 1 : 0.5)
}

export function scoreProfile(instrument: ProfileInstrument, answers: Record<string, ProfileAnswer | undefined>): ProfileResult {
  const byId = new Map(instrument.items.map((i) => [i.id, i]))
  const valid = (id: string) => {
    const a = answers[id]
    return !!a && (a.choice === 'a' || a.choice === 'b') && (a.strength === 1 || a.strength === 2)
  }
  const missing = instrument.items.filter((i) => !valid(i.id)).map((i) => i.id)
  let pairs = 0
  let agreeing = 0

  const dimensions = instrument.dimensions.map((d): DimensionResult => {
    const items = instrument.items.filter((i) => i.dimension === d.id && valid(i.id))
    const values = items.map((i) => answerValue(i, answers[i.id]!))
    const n = values.length
    const score = n ? round(values.reduce((s, v) => s + v, 0) / n) : 0
    const pos = values.filter((v) => v > 0).length
    const agreement = n ? round(Math.max(pos, n - pos) / n) : 0

    let consistent: boolean | null = null
    for (const m of instrument.items.filter((i) => i.dimension === d.id && i.mirrors)) {
      const original = byId.get(m.mirrors!)
      if (!original || !valid(m.id) || !valid(original.id)) continue
      const same = Math.sign(answerValue(m, answers[m.id]!)) === Math.sign(answerValue(original, answers[original.id]!))
      pairs++
      if (same) agreeing++
      consistent = consistent === false ? false : same
    }

    const confidence: Confidence =
      n < 3 || consistent === false || agreement < 0.6 ? 'low'
        : n >= 5 && agreement >= 0.8 && consistent !== null ? 'high'
          : 'medium'
    const magnitude = Math.abs(score)
    const lean = !n ? 'Not answered' : magnitude < 0.2 ? 'Balanced' : `${score > 0 ? d.right : d.left} (${magnitude >= 0.5 ? 'clear' : 'slight'})`
    return { dimension: d.id, left: d.left, right: d.right, score, lean, answered: n, agreement, consistent, confidence }
  })

  return {
    instrumentVersion: instrument.version,
    complete: missing.length === 0,
    missing,
    consistency: pairs ? round(agreeing / pairs) : null,
    dimensions,
  }
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000
}
