/**
 * Public demo mode for the Sanity Challenge edition (synthetic data only).
 *
 * With `NEXT_PUBLIC_QUICKSILVER_DEMO_MODE=on`, anyone who opens the console
 * can sign in as one of two people from the synthetic seed company, with no
 * private credential:
 *
 * - Marcus Webb, VP Engineering (`developer` role): plans decisions, asks the
 *   query agent, builds and runs workflows. He cannot approve.
 * - Sarah Chen, CEO (`supervisor` role): approves, executes and rolls back.
 *   She cannot propose, so separation of duties is shown working rather than
 *   waived: Marcus proposes, Sarah decides.
 *
 * Their tokens are public on purpose (they are printed on the page). What
 * keeps that safe is the guard below: demo mode refuses to run unless the
 * deployment can only touch a public, synthetic dataset and carries no real
 * credential. The server checks it at start (instrumentation.ts) and on every
 * request (nqc-approval.ts `principalProvider`); a failed check fails closed
 * (the server refuses to start; a route that runs anyway answers 503).
 *
 * The client reads only the switch and the public demo tokens from this
 * module, so it has no Node imports.
 */

export type DemoEnv = Readonly<Record<string, string | undefined>>

export interface DemoPrincipal {
  /** The seed entity id (apps/studio/seed/entities.ts). */
  id: string
  displayName: string
  title: string
  roles: readonly string[]
  /** Public, fixed demo token (>= 32 characters, the principal token minimum). */
  token: string
  /** What this person is for in the demo, shown on the sign-in button. */
  purpose: string
}

export const DEMO_PRINCIPALS: readonly DemoPrincipal[] = Object.freeze([
  Object.freeze({
    id: 'entity-marcus-webb',
    displayName: 'Marcus Webb',
    title: 'VP Engineering',
    roles: Object.freeze(['developer']),
    token: 'demo-public-marcus-webb-requester-synthetic-only',
    purpose: 'plans and requests',
  }),
  Object.freeze({
    id: 'entity-sarah-chen',
    displayName: 'Sarah Chen',
    title: 'Chief Executive Officer',
    roles: Object.freeze(['supervisor']),
    token: 'demo-public-sarah-chen-approver-synthetic-only',
    purpose: 'approves, executes and rolls back',
  }),
])

/** Datasets a demo may use: never `production`; names start with `challenge` or `demo`. */
export const DEMO_DATASET_PATTERN = /^(challenge|demo)[a-z0-9-]{0,40}$/

/**
 * Variables that would put a real credential or a development-only switch
 * into a public demo. Demo mode refuses to run while any is set.
 */
export const DEMO_FORBIDDEN_VARIABLES = Object.freeze([
  'QUICKSILVER_PRINCIPALS',
  'NQC_SUPERVISOR_TOKEN',
  'NQC_SUPERVISOR_ID',
  'QUICKSILVER_SOLE_OPERATOR_ID',
  'QUICKSILVER_ALLOW_FAULT_INJECTION',
  'QUICKSILVER_WORKFLOW_LIVE_RUNS',
  'SANITY_AUTH_TOKEN',
] as const)

/** True when the demo switch is on (`on`, any case). */
export function demoModeOn(env: DemoEnv): boolean {
  return (env.NEXT_PUBLIC_QUICKSILVER_DEMO_MODE ?? '').trim().toLowerCase() === 'on'
}

/** Why demo mode may not run here; empty when it is safe (or when it is off). Pure. */
export function demoModeProblems(env: DemoEnv): string[] {
  if (!demoModeOn(env)) return []
  const problems: string[] = []
  const dataset = (env.NEXT_PUBLIC_SANITY_DATASET ?? '').trim()
  if (!DEMO_DATASET_PATTERN.test(dataset)) {
    problems.push(`NEXT_PUBLIC_SANITY_DATASET must name a synthetic demo dataset (starting with "challenge" or "demo", never "production"); it is "${dataset || 'unset'}".`)
  }
  if ((env.SANITY_DATASET_PUBLIC ?? '').trim().toLowerCase() !== 'on') {
    problems.push('SANITY_DATASET_PUBLIC=on is required: a demo dataset must be public, so nothing private can be in it.')
  }
  for (const name of DEMO_FORBIDDEN_VARIABLES) {
    const value = (env[name] ?? '').trim()
    if (value && value.toLowerCase() !== 'off') problems.push(`${name} must be unset in demo mode (a public demo carries no real credential and no development switch).`)
  }
  return problems.map((p) => `Demo mode: ${p}`)
}

/** The demo principal a public token belongs to, or undefined. */
export function demoPrincipalForToken(token: string): DemoPrincipal | undefined {
  return DEMO_PRINCIPALS.find((p) => p.token === token)
}
