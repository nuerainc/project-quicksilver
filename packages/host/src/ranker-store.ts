import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { RankerState } from '@quicksilver/aura'

/** The provider's learned question order, kept as one JSON file (Aura inference, AGENT_INFERRED). */
export function fileRankerStore(path: string): { load(): Promise<RankerState | null>; save(state: RankerState): Promise<void> } {
  return {
    async load() {
      try {
        const s = JSON.parse(await readFile(path, 'utf8')) as RankerState
        return s && s.version === 1 && typeof s.weights === 'object' ? s : null
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(`${path}.tmp`, JSON.stringify({ ...state, provenance: 'AGENT_INFERRED' }, null, 1), { mode: 0o600 })
      await rename(`${path}.tmp`, path)
    },
  }
}

export function memoryRankerStore(initial: RankerState | null = null) {
  let s = initial
  return { async load() { return s }, async save(state: RankerState) { s = state } }
}
