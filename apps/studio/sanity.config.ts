import { defineConfig } from 'sanity'
import { structureTool } from 'sanity/structure'
import { workflow } from 'sanity-plugin-workflow'
import { schemaTypes } from './schemas'

/**
 * Sanity Workflows (the actual product feature, not our own `workflow`
 * document type or the kernel's status machine) -- a Studio-side curation
 * layer for human reviewers triaging `decision` documents.
 *
 * This is purely additive: it tracks its own metadata document per
 * `decision`, separate from the `status` field the kernel and /api routes
 * already drive. Nothing in the running app reads or writes these states --
 * they exist so a human reviewer can open Studio, see every
 * awaiting-approval decision on one kanban board, and drag it through
 * Approved/Rejected/Executed as a lightweight editorial view alongside the
 * app's own approve/reject buttons. Path Two bonus feature.
 */
const decisionWorkflow = workflow({
  schemaTypes: ['decision'],
  states: [
    {
      id: 'awaitingApproval',
      title: 'Awaiting Approval',
      color: 'warning',
      transitions: ['approved', 'rejected'],
    },
    {
      id: 'approved',
      title: 'Approved',
      color: 'primary',
      transitions: ['executed'],
    },
    {
      id: 'rejected',
      title: 'Rejected',
      color: 'danger',
      transitions: [],
    },
    {
      id: 'executed',
      title: 'Executed',
      color: 'success',
      transitions: [],
    },
  ],
})

export default defineConfig({
  name: 'quicksilver',
  title: 'Quicksilver — Autonomous Company OS',

  // Vite only exposes SANITY_STUDIO_-prefixed env vars to this file (unlike
  // sanity.cli.ts, which runs in Node and can read anything) -- NEXT_PUBLIC_*
  // vars are a Next.js convention meaningful in apps/web, not here, so they
  // resolve to undefined in the Studio bundle. Falls back to the same
  // non-secret, effectively-fixed project identity hardcoded in sanity.cli.ts.
  projectId: process.env.SANITY_STUDIO_PROJECT_ID || 'd280bqjc',
  dataset: process.env.SANITY_STUDIO_DATASET || 'production',

  plugins: [structureTool(), decisionWorkflow],

  schema: {
    types: schemaTypes,
  },
})
