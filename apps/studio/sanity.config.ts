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

  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || process.env.SANITY_STUDIO_PROJECT_ID || '',
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',

  plugins: [structureTool(), decisionWorkflow],

  schema: {
    types: schemaTypes,
  },
})
