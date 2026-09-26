import type { AutonomyDepth } from './types.ts'
import type { ParsedObjective } from './parse.ts'

/**
 * Combine the rule-based and model-based parses field by field, taking each
 * field from the source that is reliable for it (rules fixed 2026-09-26,
 * before the held-out set was scored):
 *
 *   - budget, revenueTarget: the model. Telling a budget from a revenue goal
 *     needs context, which literal patterns get wrong.
 *   - timeframeDays, weeklyHours: the rules. These are literal numbers with
 *     units; the model tends to read rates ("per month", "weekly report") as
 *     deadlines.
 *   - mode: the rules' literal cue when there is one, else the model.
 *   - constraints: the union of both. A missed hard limit costs more than an
 *     extra one the provider can remove.
 *   - autonomy: the model can never grant autonomy. It may only make it more
 *     restrictive (advise, act-with-approval); acting alone needs a literal cue.
 * Both inputs are already grounded (every value has a span in the text).
 */

const RESTRICTIVENESS: Record<AutonomyDepth, number> = { 'advise': 0, 'propose': 1, 'act-with-approval': 2, 'act-within-limits': 3 }

export function combineParses(rules: ParsedObjective, model: ParsedObjective): ParsedObjective {
  let autonomy = rules.autonomy
  if (model.autonomy && model.autonomy.value !== 'act-within-limits') {
    if (!autonomy || RESTRICTIVENESS[model.autonomy.value] < RESTRICTIVENESS[autonomy.value]) autonomy = model.autonomy
  }
  const constraints = new Map(rules.constraints.map((c) => [c.id, c]))
  for (const c of model.constraints) if (!constraints.has(c.id)) constraints.set(c.id, c)
  return {
    mode: rules.mode ?? model.mode,
    budget: model.budget,
    revenueTarget: model.revenueTarget,
    timeframeDays: rules.timeframeDays,
    weeklyHours: rules.weeklyHours,
    autonomy,
    constraints: [...constraints.values()],
  }
}
