import { defineCliConfig } from 'sanity/cli'

const projectId = process.env.SANITY_STUDIO_PROJECT_ID
if (!projectId || projectId === 'd280bqjc') {
  throw new Error('SANITY_STUDIO_PROJECT_ID must identify the dedicated Nuera Quicksilver Sanity project; legacy challenge writes are blocked.')
}

export default defineCliConfig({
  api: {
    projectId,
    dataset: process.env.SANITY_STUDIO_DATASET || 'production',
  },
})
