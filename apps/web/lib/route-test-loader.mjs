// Resolve hook: lets node --experimental-strip-types import Next.js route modules in tests.
// Maps the "@/" alias to apps/web/, and retries extensionless specifiers with .ts, .tsx, .js and /index.ts.
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const WEB_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const SUFFIXES = ['.ts', '.tsx', '.js', '/index.ts', '/index.js']

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) specifier = pathToFileURL(resolvePath(WEB_ROOT, specifier.slice(2))).href
  try {
    return await next(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw error
    for (const suffix of SUFFIXES) {
      try {
        return await next(specifier + suffix, context)
      } catch {}
    }
    throw error
  }
}
