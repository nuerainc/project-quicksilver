import type { EvaluationTaskType } from '../engine/index.ts'

export interface ModelPerformanceProfile {
  modelId: string
  supportedTasks: EvaluationTaskType[]
  taskAccuracy: Partial<Record<EvaluationTaskType, number>>
  domainAccuracy?: Record<string, number>
  successRate: number
  rateLimitRate?: number
  averageCostPer1kTokens: number
  p95LatencyMs: number
  available: boolean
}

export interface RoutingRequest {
  taskType: EvaluationTaskType
  domain?: string
  estimatedTokens: number
  budget?: number
  maxLatencyMs?: number
  minimumAccuracy?: number
  maximumRateLimitRate?: number
  recentFailureModelIds?: string[]
  candidates: ModelPerformanceProfile[]
}

export interface RoutingDecision {
  selectedModelId: string | null
  fallbackModelIds: string[]
  scores: Array<{ modelId: string; score: number; estimatedCost: number }>
  rejected: Array<{ modelId: string; reasons: string[] }>
  reason: string
}

/** Deterministic route selection using measured quality, reliability, latency, and cost. */
export function selectRoute(request: RoutingRequest): RoutingDecision {
  const rejected: RoutingDecision['rejected'] = []
  const eligible: Array<{ profile: ModelPerformanceProfile; score: number; estimatedCost: number }> = []
  const minAccuracy = request.minimumAccuracy ?? 0.65
  const recentFailures = new Set(request.recentFailureModelIds ?? [])

  for (const profile of request.candidates) {
    const reasons: string[] = []
    const taskAccuracy = profile.taskAccuracy[request.taskType]
    const accuracy = request.domain && profile.domainAccuracy?.[request.domain] !== undefined
      ? profile.domainAccuracy[request.domain]!
      : taskAccuracy
    const estimatedCost = profile.averageCostPer1kTokens * request.estimatedTokens / 1000

    if (!profile.available) reasons.push('Model is unavailable.')
    if (!profile.supportedTasks.includes(request.taskType)) reasons.push('Task type is not supported.')
    if (accuracy === undefined || !Number.isFinite(accuracy)) reasons.push('No measured accuracy is available.')
    else if (accuracy < 0 || accuracy > 1) reasons.push('Measured accuracy must be between 0 and 1.')
    else if (accuracy < minAccuracy) reasons.push(`Accuracy ${accuracy.toFixed(2)} is below ${minAccuracy.toFixed(2)}.`)
    if (!Number.isFinite(profile.successRate) || profile.successRate < 0 || profile.successRate > 1) reasons.push('Success rate must be between 0 and 1.')
    if (!Number.isFinite(profile.averageCostPer1kTokens) || profile.averageCostPer1kTokens < 0) reasons.push('Model cost must be a non-negative number.')
    if (!Number.isFinite(profile.p95LatencyMs) || profile.p95LatencyMs < 0) reasons.push('P95 latency must be a non-negative number.')
    if (profile.rateLimitRate !== undefined && (!Number.isFinite(profile.rateLimitRate) || profile.rateLimitRate < 0 || profile.rateLimitRate > 1)) reasons.push('Rate-limit rate must be between 0 and 1.')
    if (request.maximumRateLimitRate !== undefined && (profile.rateLimitRate ?? 0) > request.maximumRateLimitRate) reasons.push('Rate-limit rate exceeds the task policy.')
    if (!Number.isFinite(request.estimatedTokens) || request.estimatedTokens < 0) reasons.push('Estimated token count must be non-negative.')
    if (request.budget !== undefined && (!Number.isFinite(request.budget) || request.budget < 0)) reasons.push('Budget must be a non-negative number.')
    if (request.budget !== undefined && estimatedCost > request.budget) reasons.push('Estimated cost exceeds the task budget.')
    if (request.maxLatencyMs !== undefined && profile.p95LatencyMs > request.maxLatencyMs) reasons.push('P95 latency exceeds the task limit.')
    if (recentFailures.has(profile.modelId)) reasons.push('Model is temporarily excluded after a recent failure.')

    if (reasons.length > 0) {
      rejected.push({ modelId: profile.modelId, reasons })
      continue
    }

    const quality = accuracy as number
    const reliability = clamp(profile.successRate)
    const costFit = request.budget && request.budget > 0 ? 1 - clamp(estimatedCost / request.budget) : 1 / (1 + estimatedCost)
    const latencyFit = request.maxLatencyMs && request.maxLatencyMs > 0
      ? 1 - clamp(profile.p95LatencyMs / request.maxLatencyMs)
      : 1 / (1 + profile.p95LatencyMs / 10_000)
    const score = quality * 0.55 + reliability * 0.25 + latencyFit * 0.1 + costFit * 0.1
    eligible.push({ profile, score, estimatedCost })
  }

  eligible.sort((a, b) => b.score - a.score || a.estimatedCost - b.estimatedCost || a.profile.modelId.localeCompare(b.profile.modelId))
  const selected = eligible[0]
  return {
    selectedModelId: selected?.profile.modelId ?? null,
    fallbackModelIds: eligible.slice(1).map(({ profile }) => profile.modelId),
    scores: eligible.map(({ profile, score, estimatedCost }) => ({
      modelId: profile.modelId,
      score: Math.round(score * 10_000) / 10_000,
      estimatedCost: Math.round(estimatedCost * 1_000_000) / 1_000_000,
    })),
    rejected,
    reason: selected
      ? `Selected ${selected.profile.modelId} by measured quality, reliability, latency, and cost.`
      : 'No candidate met the task safety, quality, latency, and budget constraints.',
  }
}

export interface RoutingOutcome {
  modelId: string
  taskType: EvaluationTaskType
  success: boolean
  measuredAccuracy?: number
  latencyMs: number
  domain?: string
  costPer1kTokens?: number
  rateLimited?: boolean
}

/** Bounded exponential update so recent outcomes influence, but do not erase, history. */
export function updateModelPerformance(
  profile: ModelPerformanceProfile,
  outcome: RoutingOutcome,
  learningRate = 0.15,
): ModelPerformanceProfile {
  if (outcome.modelId !== profile.modelId) return profile
  const alpha = clamp(learningRate)
  const oldSuccess = clamp(profile.successRate)
  const successRate = oldSuccess * (1 - alpha) + Number(outcome.success) * alpha
  const priorAccuracy = profile.taskAccuracy[outcome.taskType]
  const taskAccuracy = outcome.measuredAccuracy === undefined
    ? priorAccuracy
    : clamp(priorAccuracy === undefined
      ? outcome.measuredAccuracy
      : priorAccuracy * (1 - alpha) + outcome.measuredAccuracy * alpha)
  const priorDomainAccuracy = outcome.domain ? profile.domainAccuracy?.[outcome.domain] : undefined
  const domainAccuracy = outcome.domain && outcome.measuredAccuracy !== undefined
    ? {
      ...profile.domainAccuracy,
      [outcome.domain]: clamp(priorDomainAccuracy === undefined
        ? outcome.measuredAccuracy
        : priorDomainAccuracy * (1 - alpha) + outcome.measuredAccuracy * alpha),
    }
    : profile.domainAccuracy
  const rateLimitRate = outcome.rateLimited === undefined
    ? profile.rateLimitRate
    : (profile.rateLimitRate ?? 0) * (1 - alpha) + Number(outcome.rateLimited) * alpha
  const averageCostPer1kTokens = outcome.costPer1kTokens === undefined
    ? profile.averageCostPer1kTokens
    : Math.max(0, profile.averageCostPer1kTokens * (1 - alpha) + outcome.costPer1kTokens * alpha)
  const latency = Math.max(0, outcome.latencyMs)
  return {
    ...profile,
    successRate,
    p95LatencyMs: Math.max(0, profile.p95LatencyMs * (1 - alpha) + latency * alpha),
    averageCostPer1kTokens,
    ...(rateLimitRate === undefined ? {} : { rateLimitRate }),
    ...(domainAccuracy === undefined ? {} : { domainAccuracy }),
    taskAccuracy: taskAccuracy === undefined
      ? profile.taskAccuracy
      : { ...profile.taskAccuracy, [outcome.taskType]: taskAccuracy },
  }
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}
