export type ReasoningChallengeCategory = 'multi-step-arithmetic' | 'invalid-inference' | 'insufficient-information' | 'constraint-conflict'

export interface ReasoningStressChallenge {
  id: string
  category: ReasoningChallengeCategory
  prompt: string
}

export interface ReasoningStressCaseResult {
  challengeId: string
  category: ReasoningChallengeCategory
  passed: boolean
  score: 0 | 100
  diagnostic: string
}

export interface ReasoningStressReport {
  version: 1
  seed: number
  requestedCount: number
  completedCount: number
  passedCount: number
  failedCount: number
  score: number
  cases: ReasoningStressCaseResult[]
}

/** Generate a deterministic challenge. Its ID is sufficient to reproduce the answer key. */
export function generateReasoningStressChallenge(seed: number): ReasoningStressChallenge {
  validateSeed(seed)
  const variant = seed % 4
  const id = `qs-reasoning-v1-${seed}`

  if (variant === 0) {
    const groups = 2 + (seed % 7)
    const perGroup = 3 + (((seed % 9) * 7) % 9)
    const removed = seed % Math.min(groups * perGroup, 6)
    return {
      id,
      category: 'multi-step-arithmetic',
      prompt: `A shipment has ${groups} kits with ${perGroup} seals in each kit. ${removed} seals are removed before shipping. How many seals ship? Give the final number only.`,
    }
  }
  if (variant === 1) {
    return {
      id,
      category: 'invalid-inference',
      prompt: 'Every certified inspector can access the report. Morgan can access the report. Does that prove Morgan is a certified inspector? Answer yes or no and give a brief justification.',
    }
  }
  if (variant === 2) {
    return {
      id,
      category: 'insufficient-information',
      prompt: 'A tank is partly full. A pump adds water, but the starting volume and pump rate are not given. How many liters are in the tank after 10 minutes? State whether the amount can be determined.',
    }
  }
  return {
    id,
    category: 'constraint-conflict',
    prompt: 'A, B, and C are tasks. A must happen before B, B before C, and C before A. Can any schedule satisfy all three constraints? Answer yes or no.',
  }
}

/** Score only the final answer; do not collect or inspect hidden reasoning traces. */
export function scoreReasoningStressAnswer(challengeId: string, answer: string): ReasoningStressCaseResult {
  const match = /^qs-reasoning-v1-(0|[1-9]\d*)$/.exec(challengeId)
  if (!match) throw new Error('Unknown reasoning challenge ID.')
  const seed = Number(match[1])
  validateSeed(seed)
  const challenge = generateReasoningStressChallenge(seed)
  const normalized = normalizeAnswer(answer)
  const variant = seed % 4
  let passed = false

  if (variant === 0) {
    const groups = 2 + (seed % 7)
    const perGroup = 3 + (((seed % 9) * 7) % 9)
    const removed = seed % Math.min(groups * perGroup, 6)
    const expected = groups * perGroup - removed
    const numbers = normalized.match(/-?\d+/g)
    passed = numbers?.at(-1) === String(expected)
  } else if (variant === 1) {
    passed = /^(no|not necessarily|cannot be concluded|does not prove|not enough information)\b/.test(normalized)
  } else if (variant === 2) {
    passed = ['cannot be determined', 'cannot determine', 'not enough information', 'insufficient information', 'unknown'].some((phrase) => normalized.includes(phrase))
  } else {
    passed = /^(no|impossible|cannot|not possible)\b/.test(normalized)
  }

  return {
    challengeId: challenge.id,
    category: challenge.category,
    passed,
    score: passed ? 100 : 0,
    diagnostic: passed
      ? 'Final answer matches the challenge rubric.'
      : 'Final answer did not match the challenge rubric; inspect the stated facts and constraints.',
  }
}

/** Run a bounded, provider-neutral benchmark without retaining model answers. */
export async function runReasoningStressSuite(
  answer: (challenge: ReasoningStressChallenge, signal?: AbortSignal) => Promise<string>,
  options: { seed: number; count: number; signal?: AbortSignal },
): Promise<ReasoningStressReport> {
  validateSeed(options.seed)
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 50) {
    throw new Error('Reasoning stress suite count must be an integer from 1 to 50.')
  }

  const cases: ReasoningStressCaseResult[] = []
  for (let index = 0; index < options.count; index += 1) {
    if (options.signal?.aborted) break
    const challenge = generateReasoningStressChallenge(options.seed + index)
    try {
      const response = await answer(challenge, options.signal)
      cases.push(scoreReasoningStressAnswer(challenge.id, response))
    } catch {
      cases.push({
        challengeId: challenge.id,
        category: challenge.category,
        passed: false,
        score: 0,
        diagnostic: options.signal?.aborted ? 'Challenge was cancelled.' : 'Answer provider failed for this challenge.',
      })
    }
  }

  const passedCount = cases.filter((item) => item.passed).length
  return {
    version: 1,
    seed: options.seed,
    requestedCount: options.count,
    completedCount: cases.length,
    passedCount,
    failedCount: cases.length - passedCount,
    score: cases.length === 0 ? 0 : Math.round(passedCount / cases.length * 100),
    cases,
  }
}

function validateSeed(seed: number): void {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > Number.MAX_SAFE_INTEGER - 50) {
    throw new Error('Reasoning challenge seed must be a non-negative safe integer with room for the requested suite.')
  }
}

function normalizeAnswer(answer: string): string {
  if (typeof answer !== 'string') return ''
  return answer.toLocaleLowerCase('en-US').replace(/[’']/g, '').replace(/[^a-z0-9-]+/g, ' ').trim().replace(/\s+/g, ' ')
}
