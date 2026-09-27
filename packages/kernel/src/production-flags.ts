/**
 * Development-only switches that must never be on in production (threat
 * model A-10, T-34).
 *
 * - `QUICKSILVER_ALLOW_FAULT_INJECTION` lets the web app's execute route force
 *   an execution outcome (used by the live end-to-end test).
 * - `QUICKSILVER_WORKFLOW_LIVE_RUNS` lets the web app run workflow graphs
 *   against live models from an HTTP request.
 *
 * With `NODE_ENV=production`, the host refuses to start and the web app
 * refuses to start (and treats both switches as off) while either is on.
 * The host and the web app read the same `.env`, so both check.
 */

export const DEVELOPMENT_ONLY_FLAGS = Object.freeze(['QUICKSILVER_ALLOW_FAULT_INJECTION', 'QUICKSILVER_WORKFLOW_LIVE_RUNS'] as const)
export type DevelopmentOnlyFlag = (typeof DEVELOPMENT_ONLY_FLAGS)[number]

export type FlagEnv = Readonly<Record<string, string | undefined>>

/** True when a switch is on (`on`, any case, surrounding spaces ignored). */
export function flagIsOn(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'on'
}

/** True when `NODE_ENV` is `production` (any case, surrounding spaces ignored). */
export function isProductionEnv(env: FlagEnv): boolean {
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production'
}

/**
 * One problem per development-only switch that is on while
 * `NODE_ENV=production`; empty when it is safe to start. Pure: reads only `env`.
 */
export function productionFlagProblems(env: FlagEnv): string[] {
  if (!isProductionEnv(env)) return []
  return DEVELOPMENT_ONLY_FLAGS
    .filter((name) => flagIsOn(env[name]))
    .map((name) => `${name}=on is not allowed when NODE_ENV=production; it is for development only. Turn it off (unset it or set it to "off") and start again.`)
}

/** Whether a development-only switch may take effect: on, and not in production. */
export function developmentFlagEnabled(env: FlagEnv, name: DevelopmentOnlyFlag): boolean {
  return flagIsOn(env[name]) && !isProductionEnv(env)
}
