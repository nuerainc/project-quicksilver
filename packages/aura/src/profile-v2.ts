/**
 * Intent profile v2 (situational): short concrete dilemmas instead of
 * abstract statements.
 *
 * Why: the v1 readings did not carry over to concrete choices, and a model
 * given them did no better than without them. Concrete decisions carried the
 * useful signal, so v2 asks for decisions.
 *
 * - Each item is a 2–3 sentence small-business situation with three options:
 *   two poles and a middle (compromise) option. Some items add a fourth,
 *   "ask me first", where handing the decision back is natural.
 * - Each option is tagged with the dimension(s) it expresses (pole + weight),
 *   and whether it is the compromise, an "ask", a requirements-first choice
 *   (do it right before doing it fast), or protects a customer or
 *   relationship at a cost to the business. Tags are the designer's
 *   annotation and are never shown to the person answering.
 * - Four items restate an earlier one in other words, with the options
 *   rearranged ("mirrors").
 *
 * Output: a per-dimension lean with confidence 0–10 (v1 conventions), plus
 * behavioral readings (compromise, ask, requirements-first, protect-at-cost
 * rates and mirror consistency), and the answered items as worked examples.
 *
 * Use: examples for the model and a prior for the learner. It is not a
 * predictor, and its value is to be tested on held-out decisions.
 */
import { profileConfidence, type ProfileDimension } from './profile.ts'

export type ProfileV2OptionId = 'a' | 'b' | 'c' | 'ask'
export const PROFILE_V2_OPTION_IDS: readonly ProfileV2OptionId[] = ['a', 'b', 'c', 'ask']

export interface ProfileV2Tag {
  dimension: string
  pole: 'left' | 'right'
  /** 0 < weight ≤ 1. The option's primary expression is 1; a secondary one 0.5. */
  weight: number
}

export interface ProfileV2Option {
  text: string
  tags: ProfileV2Tag[]
  /** The middle or test-first position between the two poles. */
  compromise: boolean
  /** Hands the decision back to the provider. */
  ask: boolean
  /** Meets the requirement or does it right before going fast. */
  requirementsFirst?: boolean
  /** Protects a customer or relationship at a cost to the business. */
  protectsAtCost?: boolean
}

export interface ProfileV2Item {
  id: string
  domain: string
  /** The dimension the item was written to measure. */
  primary: string
  situation: string
  decision: string
  options: Partial<Record<ProfileV2OptionId, ProfileV2Option>> & Record<'a' | 'b' | 'c', ProfileV2Option>
  /** For a consistency item: the id of the item it restates. */
  mirrors?: string
}

export interface ProfileV2Instrument {
  version: number
  createdAt?: string
  instructions?: string
  estimatedMinutes?: number
  dimensions: ProfileDimension[]
  order: string[]
  items: ProfileV2Item[]
}

export type ProfileV2Confidence = 'sure' | 'leaning' | 'coin'

/** The answer page's format: the chosen option id, how sure, an optional note. */
export interface ProfileV2Answer {
  choice?: string | null
  confidence?: string | null
  note?: string
}

/** How much an answer counts, by how sure the provider was. */
export const PROFILE_V2_CONFIDENCE_WEIGHT: Record<ProfileV2Confidence, number> = { sure: 1, leaning: 0.5, coin: 0.25 }

/**
 * Where an item offers an "ask" option, choosing any other non-compromise
 * option also means "act without asking". Unless the option says otherwise,
 * it loads "decide yourself" at this weight.
 */
export const PROFILE_V2_IMPLIED_ACT_WEIGHT = 0.5

export function profileV2OptionIds(item: ProfileV2Item): ProfileV2OptionId[] {
  return PROFILE_V2_OPTION_IDS.filter((id) => item.options[id])
}

function offersAsk(item: ProfileV2Item): boolean {
  return profileV2OptionIds(item).some((id) => item.options[id]!.ask)
}

/** Signed load of one option on one dimension: −1…+1 (left negative), including the implied "decide yourself". */
export function profileV2OptionLoad(item: ProfileV2Item, id: ProfileV2OptionId, dimension: string): number {
  const o = item.options[id]
  if (!o) return 0
  let load = 0
  for (const t of o.tags) if (t.dimension === dimension) load += (t.pole === 'right' ? 1 : -1) * t.weight
  if (dimension === 'autonomy' && !o.tags.some((t) => t.dimension === 'autonomy') && !o.ask && !o.compromise && offersAsk(item)) load -= PROFILE_V2_IMPLIED_ACT_WEIGHT
  return load
}

/** Dimensions an item touches (any option loads it). */
export function profileV2ItemDimensions(item: ProfileV2Item, dimensions: string[]): string[] {
  return dimensions.filter((d) => profileV2OptionIds(item).some((id) => profileV2OptionLoad(item, id, d) !== 0))
}

/** How a choice reads on the item's own dimension: one pole, the middle, a plain ask, or none of these. */
export type ProfileV2ChoiceKind = 'left' | 'right' | 'middle' | 'ask' | 'other'

export function profileV2ChoiceKind(item: ProfileV2Item, id: ProfileV2OptionId): ProfileV2ChoiceKind {
  const o = item.options[id]
  if (!o) return 'other'
  if (o.compromise) return 'middle'
  const load = profileV2OptionLoad(item, id, item.primary)
  if (load > 0) return 'right'
  if (load < 0) return 'left'
  return o.ask ? 'ask' : 'other'
}

function validAnswer(item: ProfileV2Item, a: ProfileV2Answer | undefined): a is ProfileV2Answer & { choice: ProfileV2OptionId; confidence: ProfileV2Confidence } {
  return !!a && typeof a.choice === 'string' && !!item.options[a.choice as ProfileV2OptionId] && typeof a.confidence === 'string' && a.confidence in PROFILE_V2_CONFIDENCE_WEIGHT
}

export interface DimensionResultV2 {
  dimension: string
  left: string
  right: string
  /** −1 (fully left) to +1 (fully right); middle choices pull it toward 0. */
  score: number
  /** Plain-language reading, e.g. "Long term (clear)" or "Balanced". */
  lean: string
  /** Answered items that touch this dimension. */
  answered: number
  /** Items that touch this dimension. */
  items: number
  /** Answers that took a side on this dimension (not the middle, not unloaded). */
  sided: number
  /** Share of this dimension's answered items on the majority side, 0–1. Middle and unloaded choices count against it. */
  agreement: number
  /** Whether mirrored pairs on this dimension agreed; null when none was answered. */
  consistent: boolean | null
  /** 0–10; `profileConfidence` from v1. */
  confidence: number
}

export interface ProfileV2Rate {
  /** chosen / of, or null when there was nothing to choose from. */
  rate: number | null
  chosen: number
  of: number
}

export interface ProfileV2Result {
  instrumentVersion: number
  complete: boolean
  missing: string[]
  dimensions: DimensionResultV2[]
  behaviors: {
    /** Chose the middle option, of answered items. */
    compromise: ProfileV2Rate
    /** Chose an "ask" option, of answered items that offered one. */
    ask: ProfileV2Rate
    /** Chose the requirements-first option, of answered items that had one. */
    requirementsFirst: ProfileV2Rate
    /** Chose to protect a customer or relationship at a cost, of answered items that offered it. */
    protectsAtCost: ProfileV2Rate
    /** Mirrored pairs whose two answers were the same kind (left, right, middle, ask). */
    consistency: ProfileV2Rate
  }
}

function rate(chosen: number, of: number): ProfileV2Rate {
  return { rate: of ? round(chosen / of) : null, chosen, of }
}

/**
 * Per dimension: each answered item that touches it gives a reading
 *   x = (chosen option's load) / (largest |load| any option of that item has),
 * so x runs −1…+1, and the middle option reads 0 unless tagged. The score is
 * the mean of x weighted by answer confidence (sure 1, leaning 0.5, coin flip
 * 0.25). Agreement is the share of answered items on the majority side;
 * middle and unloaded choices count against it, so a lean read from a few
 * sided answers among many middle ones gets low confidence. Confidence is
 * v1's `profileConfidence`: one-sidedness times the share of the
 * dimension's items answered, with a disagreeing mirror capping it at 3.
 */
export function scoreProfileV2(instrument: ProfileV2Instrument, answers: Record<string, ProfileV2Answer | undefined>): ProfileV2Result {
  const byId = new Map(instrument.items.map((i) => [i.id, i]))
  const dimIds = instrument.dimensions.map((d) => d.id)
  const ok = (i: ProfileV2Item) => validAnswer(i, answers[i.id])
  const missing = instrument.items.filter((i) => !ok(i)).map((i) => i.id)
  const answered = instrument.items.filter(ok)
  const pick = (i: ProfileV2Item) => answers[i.id]!.choice as ProfileV2OptionId

  // Mirrors, overall and per primary dimension.
  const mirrorByDim = new Map<string, boolean | null>()
  let pairs = 0
  let same = 0
  for (const m of instrument.items.filter((i) => i.mirrors)) {
    const orig = byId.get(m.mirrors!)
    if (!orig || !ok(m) || !ok(orig)) continue
    const agree = profileV2ChoiceKind(m, pick(m)) === profileV2ChoiceKind(orig, pick(orig))
    pairs++
    if (agree) same++
    const prev = mirrorByDim.get(orig.primary)
    mirrorByDim.set(orig.primary, prev === false ? false : agree)
  }

  const dimensions = instrument.dimensions.map((d): DimensionResultV2 => {
    const touching = instrument.items.filter((i) => profileV2ItemDimensions(i, dimIds).includes(d.id))
    let wsum = 0
    let xsum = 0
    let pos = 0
    let neg = 0
    let n = 0
    for (const i of touching) {
      if (!ok(i)) continue
      n++
      const max = Math.max(...profileV2OptionIds(i).map((id) => Math.abs(profileV2OptionLoad(i, id, d.id))))
      const x = max ? profileV2OptionLoad(i, pick(i), d.id) / max : 0
      const w = PROFILE_V2_CONFIDENCE_WEIGHT[answers[i.id]!.confidence as ProfileV2Confidence]
      wsum += w
      xsum += w * x
      if (x > 0) pos++
      if (x < 0) neg++
    }
    const score = wsum ? round(xsum / wsum) : 0
    const sided = pos + neg
    const agreement = n ? round(Math.max(pos, neg) / n) : 0
    const consistent = mirrorByDim.has(d.id) ? mirrorByDim.get(d.id)! : instrument.items.some((i) => i.mirrors && byId.get(i.mirrors)?.primary === d.id) ? null : true
    const confidence = profileConfidence(agreement, n, touching.length, consistent)
    const magnitude = Math.abs(score)
    const lean = !n ? 'Not answered' : magnitude < 0.2 ? 'Balanced' : `${score > 0 ? d.right : d.left} (${magnitude >= 0.5 ? 'clear' : 'slight'})`
    return { dimension: d.id, left: d.left, right: d.right, score, lean, answered: n, items: touching.length, sided, agreement, consistent, confidence }
  })

  const has = (i: ProfileV2Item, f: (o: ProfileV2Option) => boolean | undefined) => profileV2OptionIds(i).some((id) => f(i.options[id]!))
  const chose = (i: ProfileV2Item, f: (o: ProfileV2Option) => boolean | undefined) => !!f(i.options[pick(i)]!)
  const count = (f: (o: ProfileV2Option) => boolean | undefined) => {
    const pool = answered.filter((i) => has(i, f))
    return rate(pool.filter((i) => chose(i, f)).length, pool.length)
  }

  return {
    instrumentVersion: instrument.version,
    complete: missing.length === 0,
    missing,
    dimensions,
    behaviors: {
      compromise: count((o) => o.compromise),
      ask: count((o) => o.ask),
      requirementsFirst: count((o) => o.requirementsFirst),
      protectsAtCost: count((o) => o.protectsAtCost),
      consistency: rate(same, pairs),
    },
  }
}

export interface ProfileV2ExamplesOptions {
  /** Leave out mirror items (they restate an earlier decision). Default false. */
  skipMirrors?: boolean
  /** Longest note kept, in characters. Default 300 (as in the choice eval). */
  maxNote?: number
}

/**
 * The answered items as worked examples: situation, options, what the
 * provider chose, how sure, and their note. Tags are never included, so the
 * model sees only what the provider saw. Items follow the instrument's order;
 * unanswered ones are skipped. Returns '' when nothing is answered.
 *
 * Intended for the choice eval's examples arm in place of the text it builds
 * from another scenario set, e.g. a future
 *   `--examples-profile-v2 <answers.json>` → `profileV2AsExamples(instrument, read(path).answers)`.
 */
export function profileV2AsExamples(instrument: ProfileV2Instrument, answers: Record<string, ProfileV2Answer | undefined>, opts: ProfileV2ExamplesOptions = {}): string {
  const maxNote = opts.maxNote ?? 300
  const byId = new Map(instrument.items.map((i) => [i.id, i]))
  const ordered = [...instrument.order.map((id) => byId.get(id)).filter((i): i is ProfileV2Item => !!i), ...instrument.items.filter((i) => !instrument.order.includes(i.id))]
  const lines: string[] = []
  for (const i of ordered) {
    if (opts.skipMirrors && i.mirrors) continue
    const a = answers[i.id]
    if (!validAnswer(i, a)) continue
    const note = a.note?.trim() ? `. Their note: "${a.note.trim().slice(0, maxNote)}"` : ''
    lines.push(`- Situation: ${i.situation} Decision: ${i.decision}`)
    lines.push(`  Options: ${profileV2OptionIds(i).map((id) => `${id}) ${i.options[id]!.text}`).join(' | ')}`)
    lines.push(`  They chose: ${a.choice} (${a.confidence})${note}`)
  }
  if (!lines.length) return ''
  return [
    'Here are short everyday business decisions this same provider made, answering as the owner, with the option they chose, how sure they were and, when they gave one, their own note. Learn how they decide: what they protect, when they take a middle path, when they want to be asked, and when they would rather you just act.',
    '',
    ...lines,
  ].join('\n')
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000
}
