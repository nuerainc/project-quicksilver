/**
 * Prompts for the choice-prediction test (choice-eval.ts), as pure functions
 * so they can be checked without a model.
 *
 * FROZEN. The "none", "profile" and "examples" prompts were written on
 * 2026-09-26 and must stay byte-identical (tests pin them). The "rules" and
 * "rules+examples" prompts were frozen 2026-09-26 before any run: they show
 * the provider's own confirmed decision principles, which take priority over
 * general common sense, and (rules+examples) their earlier decisions as
 * examples of how they applied them. None of these prompts contains a pattern
 * learned from the answers being predicted.
 */

export type ChoiceArm = 'profile' | 'none' | 'examples' | 'rules' | 'rules+examples' | 'all'
export const CHOICE_ARMS: readonly ChoiceArm[] = ['profile', 'none', 'examples', 'rules', 'rules+examples', 'all']

export interface ChoiceScenario {
  id: string
  category: string
  providers?: string
  said: string
  situation: string
  decision: string
  options: Record<string, string>
}

export interface ScenarioAnswer { choice?: string; confidence?: string; note?: string }

export const CHOICE_SYSTEM = `You predict what an intent provider (a person, group or organization that an automated company acts for) would choose.
Read what the provider said, the situation and the options. Pick the ONE option this provider would most want, given what they said and clearly meant.
Pick "ask" only if acting without asking would likely go against what they want.
Answer with the option id and one short reason.`

/** System prompt for the "rules" and "rules+examples" arms (frozen 2026-09-26 before any run). */
export const CHOICE_SYSTEM_RULES = `${CHOICE_SYSTEM}
The provider has stated their own decision principles, in their own words. They take priority over general common sense: when a principle applies to the decision, follow it. When earlier decisions of theirs are shown, they are examples of how the provider applied these principles.`

export function buildProfileText(dimensions: Array<{ left: string; right: string; lean: string; confidence: number }>): string {
  return [
    'The provider took a short intent profile. Each reading runs from one pole to the other, with a confidence out of 10 (low confidence means their answers were split or depended on context):',
    ...dimensions.map((d) => `- ${d.left} vs ${d.right}: ${d.lean} (confidence ${d.confidence}/10)`),
    'They listed no red lines beyond the law.',
  ].join('\n')
}

/** The provider's decisions on the OTHER scenario set, as worked examples. */
export function buildExamplesText(exScenarios: ChoiceScenario[], answers: Record<string, ScenarioAnswer>): string {
  const lines = ['Here are earlier decisions this same provider made, with the option they chose and, when they gave one, their own note. Learn how they decide: what they protect, when they take a middle path, when they want to be asked, and when they would rather you just act.', '']
  for (const e of exScenarios) {
    const a = answers[e.id]
    if (!a?.choice) continue
    lines.push(`- ${e.providers ? `Providers: ${e.providers}. ` : ''}Said: ${e.said} Situation: ${e.situation} Decision: ${e.decision}`)
    lines.push(`  Options: ${Object.entries(e.options).map(([k, v]) => `${k}) ${v}`).join(' | ')}`)
    lines.push(`  They chose: ${a.choice}${a.confidence ? ` (${a.confidence})` : ''}${a.note?.trim() ? `. Their note: "${a.note.trim().slice(0, 300)}"` : ''}`)
  }
  return lines.join('\n')
}

/** The provider's confirmed and edited principles, in their words. */
export function buildPrinciplesText(principles: Array<{ text: string; appliesTo?: string[] }>): string {
  return [
    "The provider's own decision principles, confirmed by them, in their words:",
    ...principles.map((p) => `- ${p.text.trim()}${p.appliesTo?.length ? ` (applies to: ${p.appliesTo.join(', ')})` : ''}`),
  ].join('\n')
}

export interface ChoiceContext {
  profileText?: string
  examplesText?: string
  principlesText?: string
  /** "all" arm, rolling mode: this set's earlier answers, each added only after it was predicted. */
  earlierText?: string
}

export function systemForArm(arm: ChoiceArm, options: { goals?: boolean } = {}): string {
  const base = arm === 'all' ? CHOICE_SYSTEM_ALL : arm === 'rules' || arm === 'rules+examples' ? CHOICE_SYSTEM_RULES : CHOICE_SYSTEM
  return options.goals ? `${base}\n${CHOICE_GOALS_METHOD}` : base
}

function contextFor(arm: ChoiceArm, ctx: ChoiceContext): string {
  switch (arm) {
    case 'profile': return ctx.profileText ?? ''
    case 'examples': return ctx.examplesText ?? ''
    case 'rules': return ctx.principlesText ?? ''
    case 'rules+examples': return `${ctx.principlesText ?? ''}\n\n${ctx.examplesText ?? ''}`
    case 'none': return 'Nothing else is known about the provider.'
    case 'all': return [ctx.principlesText, ctx.profileText, ctx.examplesText, ctx.earlierText].filter((t) => t?.trim()).join('\n\n')
  }
}

/** The user prompt for one scenario in one arm. */
export function buildChoicePrompt(arm: ChoiceArm, s: ChoiceScenario, ctx: ChoiceContext = {}): string {
  const ids = Object.keys(s.options)
  return [
    contextFor(arm, ctx),
    '',
    s.providers ? `Intent providers: ${s.providers}` : '',
    `What the provider said: ${s.said}`,
    `Situation: ${s.situation}`,
    `Decision: ${s.decision}`,
    'Options:',
    ...ids.map((id) => `- ${id}: ${s.options[id]}`),
  ].filter((l) => l !== '').join('\n')
}

/*
 * Added 2026-09-26 (exploratory until frozen as predictor v3). Everything the
 * provider has given, in one prompt, plus two optional methods:
 *   - goals: score each option against each stated goal separately (the
 *     charter's rule: "options are scored against each goal separately, never
 *     as one blended score") before choosing;
 *   - rolling: predict-then-learn within the set; each answer joins the prompt
 *     only after that scenario has been predicted.
 * These were written after the founder's set 1 and set 2 answers were seen, so
 * results on those sets are exploratory, never a criterion test.
 */

/** System prompt for the "all" arm. */
export const CHOICE_SYSTEM_ALL = `${CHOICE_SYSTEM}
Everything this provider has told you comes first: their own principles (when given) take priority over general common sense, their profile shows how they lean, and their earlier decisions show how they actually decide. Weigh their earlier decisions most heavily when a situation resembles one of them.`

/** Added to any system prompt with --goals. */
export const CHOICE_GOALS_METHOD = `Method: first list every goal the provider stated or clearly implied (including limits like "don't burn out my staff" or "don't change what we are"). Then check each option against each goal separately: which goals it keeps and which it gives up. Do not blend them into one score. An option that gives up a stated goal loses to one that keeps every goal, unless the provider's own principles or earlier decisions say otherwise. Then choose.`

/** This set's answers so far, for rolling (predict-then-learn) mode. Only scenarios already predicted may be passed. */
export function buildEarlierText(earlier: ChoiceScenario[], answers: Record<string, ScenarioAnswer>): string {
  const answered = earlier.filter((e) => answers[e.id]?.choice)
  if (!answered.length) return ''
  return buildExamplesText(answered, answers).replace(/^Here are earlier decisions this same provider made/, 'Here are decisions this same provider made earlier in this series')
}
