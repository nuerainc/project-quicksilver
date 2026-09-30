import type { TelemetryAlertThresholds } from './telemetry.ts'

export type TelemetryAlertEnv = Record<string, string | undefined>

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !value.trim()) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

/** Alert thresholds are deployment policy; malformed environment values fail back to documented defaults. */
export function telemetryAlertThresholds(env: TelemetryAlertEnv = process.env, now = Date.now()): TelemetryAlertThresholds {
  return {
    now,
    windowMs: bounded(env.QUICKSILVER_ALERT_WINDOW_MINUTES, 60, 5, 10_080) * 60_000,
    minimumRuns: Math.floor(bounded(env.QUICKSILVER_ALERT_MINIMUM_RUNS, 3, 1, 500)),
    maximumRunFailureRate: bounded(env.QUICKSILVER_ALERT_FAILURE_RATE, 0.5, 0, 1),
    // Cost notifications stay disabled until the operator sets a real budget.
    maximumEstimatedCostUsd: bounded(env.QUICKSILVER_ALERT_COST_USD, 0, 0, 1_000_000),
  }
}
