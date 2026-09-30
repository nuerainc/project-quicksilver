import { defineCliConfig } from 'sanity/cli'
import { dedicatedSanityProjectId } from './lib/sanity-project-id'

const projectId = dedicatedSanityProjectId()

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
