import { dirname, join } from 'node:path'

import { FileMemoryStore, MemoryStore } from '@quicksilver/kernel'

import type { HostConfig } from './config.ts'

/**
 * The memory store for this host's one tenant. With the file run store it is a file
 * beside the run store, in the tenant's own folder (same layout as workflow
 * publications); otherwise it lives in memory and is lost on restart, which the
 * caller is told so it can warn.
 */
export function buildGovernedMemory(config: Pick<HostConfig, 'tenantId' | 'store'>): { store: MemoryStore; persistent: boolean; path?: string } {
  if (config.store.kind === 'file') {
    const path = join(dirname(config.store.path), config.tenantId, 'memory.json')
    return { store: new FileMemoryStore(path), persistent: true, path }
  }
  return { store: new MemoryStore(), persistent: false }
}
