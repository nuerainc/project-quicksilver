/**
 * The Sanity CLI only auto-loads `.env`/`.env.local` from the current directory
 * (apps/studio), and — confirmed by testing — does not reliably run file-based
 * env-loading side effects placed in this file before evaluating the config
 * object (unlike scripts run directly via tsx, e.g. scripts/deploy-schema.ts).
 * Rather than fight the CLI's own config-loading internals, the project
 * identity is hardcoded below: it's a non-secret, effectively-fixed value for
 * this repo (see README's "Sanity setup" table), same spirit as any real-world
 * sanity.cli.ts, which normally commits these plainly. Env vars still override
 * for anyone who forks this with a different project.
 */
import { defineCliConfig } from 'sanity/cli'

export default defineCliConfig({
  api: {
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || process.env.SANITY_STUDIO_PROJECT_ID || 'd280bqjc',
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  },
  deployment: {
    appId: 'hcdo8yff2ik0w5qd0erb7vso',
  },
})