/**
 * Seed registry — single import surface for the loader and the kernel test.
 *
 * Each seed file exports an array (or single object for organization).
 * Order matters: capabilities and entities are referenced by id from other docs,
 * so the loader pushes them in dependency order.
 */

import { organization } from './organization'
import { departments } from './departments'
import { capabilities } from './capabilities'
import { entities } from './entities'
import { policies } from './policies'
import { objectives } from './objectives'
import { workflows } from './workflows'
import { evidence } from './evidence'
import { decisions } from './decisions'

export * from './types'

export const seed = {
  organization,
  departments,
  capabilities,
  entities,
  policies,
  objectives,
  workflows,
  evidence,
  decisions,
}

/**
 * Dependency order — push these in sequence so refs resolve.
 */
export const seedOrder = [
  ['organization', [organization]],
  ['capabilities', capabilities],
  ['policies', policies],
  ['entities', entities],
  ['departments', departments],
  ['objectives', objectives],
  ['workflows', workflows],
  ['evidence', evidence],
  ['decisions', decisions],
] as const