/**
 * Generate a supervisor/principal bearer token for QUICKSILVER_PRINCIPALS.
 *   npm run principal:token -- entity-ana supervisor
 * Prints the token once (give it to the person) and the JSON entry to paste
 * into QUICKSILVER_PRINCIPALS, which stores only the token's SHA-256 digest.
 */
import { generateToken } from '../packages/kernel/src/identity/tokens.ts'
import { validatePrincipal, type Principal } from '../packages/kernel/src/identity/rbac.ts'

const [id, ...roles] = process.argv.slice(2)
const principal: Principal = {
  id: id ?? '',
  kind: 'human',
  tenantId: process.env.QUICKSILVER_TENANT_ID?.trim() || 'default',
  roles: roles.length ? roles : ['supervisor'],
}
const errors = validatePrincipal(principal)
if (errors.length) {
  console.error(`Usage: npm run principal:token -- <sanity-entity-id> [role ...]\n${errors.join('\n')}`)
  process.exit(1)
}
const { token, tokenDigest } = generateToken()
console.log(`Token for ${principal.id} (shown once; send it privately):\n\n  ${token}\n`)
console.log('Add this entry to the QUICKSILVER_PRINCIPALS JSON array:\n')
console.log(`  ${JSON.stringify({ ...principal, tokenDigest })}`)
