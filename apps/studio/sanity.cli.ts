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
  // Nuera Quicksilver Studio at https://project-quicksilver.sanity.studio (project f87t11g1).
  // The Context MCP endpoints read the schema from this deployed Studio.
  deployment: {
    appId: 'xm30eyo95oc773iodjre8w5f',
  },
})
