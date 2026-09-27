import { productionFlagProblems } from '@quicksilver/kernel/production-flags'

/**
 * Runs once when the Next.js server starts. Refuse to start with a
 * development-only switch (`QUICKSILVER_ALLOW_FAULT_INJECTION`,
 * `QUICKSILVER_WORKFLOW_LIVE_RUNS`) on while `NODE_ENV=production`
 * (threat model A-10). The routes also treat both switches as off in
 * production, so a server that starts anyway still refuses them.
 */
export function register(): void {
  const problems = productionFlagProblems(process.env)
  if (problems.length) {
    const message = `Refusing to start:\n- ${problems.join('\n- ')}`
    console.error(message)
    throw new Error(message)
  }
}
