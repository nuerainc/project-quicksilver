import { defineConfig } from 'sanity'
import { structureTool } from 'sanity/structure'
import { workflow } from 'sanity-plugin-workflow'
import { schemaTypes } from './schemas'
import { dedicatedSanityProjectId } from './lib/sanity-project-id'

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
  name: 'nuera-quicksilver',
  title: 'Nuera Quicksilver',
  // The Vercel services deployment mounts Studio at /studio. Keep the
  // existing standalone Sanity Studio deployment at / unless overridden.
  basePath: process.env.SANITY_STUDIO_BASE_PATH || (process.env.VERCEL ? '/studio' : '/'),

  projectId: dedicatedSanityProjectId(),
  dataset: process.env.SANITY_STUDIO_DATASET || 'production',

  plugins: [structureTool(), decisionWorkflow],

  schema: {
    types: schemaTypes,
  },
})
