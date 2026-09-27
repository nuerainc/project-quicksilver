import { productionFlagProblems } from '@quicksilver/kernel/production-flags'
import { demoModeProblems } from './lib/demo-mode.ts'

/**
 * Runs once when the Next.js server starts. Refuse to start with a
 * development-only switch (`QUICKSILVER_ALLOW_FAULT_INJECTION`,
 * `QUICKSILVER_WORKFLOW_LIVE_RUNS`) on while `NODE_ENV=production`
 * (threat model A-10), or with public demo mode on in a deployment that could
 * reach anything but a public synthetic dataset (lib/demo-mode.ts). The
 * routes repeat both checks, so a server that starts anyway still refuses.
 */
export function register(): void {
  const problems = [...productionFlagProblems(process.env), ...demoModeProblems(process.env)]
  if (problems.length) {
    const message = `Refusing to start:\n- ${problems.join('\n- ')}`
    console.error(message)
    throw new Error(message)
  }
}
