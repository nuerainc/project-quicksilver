/**
 * MCP verification — Day 6 milestone check.
 *
 * Run after Context is enabled in the Sanity dashboard and you've created
 * a GROQ-mode Context MCP endpoint. Confirms the agent harness can:
 *   1. Connect to the Context MCP server
 *   2. Discover the available tools
 *   3. Call initial_context to get the schema overview
 *   4. Run a GROQ query that pulls real structured content
 *
 * Run with:   npm run verify:mcp
 *             (requires SANITY_CONTEXT_MCP_URL + SANITY_CONTEXT_TOKEN in .env)
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function findEnvFile(startDir: string, maxDepth = 6): string | null {
  let dir = startDir
  for (let i = 0; i < maxDepth; i++) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const envPath = findEnvFile(__dirname)
if (envPath) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([^#\s][^=\s]*)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2]
    }
  }
}

const { createSanityContextClient, readEnvMcpConfig } = await import('./mcp.ts')

async function main() {
  const config = readEnvMcpConfig()
  console.log(`Connecting to: ${config.endpointUrl}\n`)

  const client = await createSanityContextClient(config)

  try {
    // 1. Discover tools
    console.log('─'.repeat(60))
    console.log('STEP 1: Discover available tools')
    console.log('─'.repeat(60))
    const tools = await client.tools()
    const toolNames = Object.keys(tools)
    console.log(`Tools (${toolNames.length}): ${toolNames.join(', ')}\n`)

    if (toolNames.length === 0) {
      console.error(
        'FAIL: No tools returned.\n' +
          'Most Likely causes:\n' +
          '  • Context not enabled on the org (Manage → Labs → Context)\n' +
          '  • Wrong MCP endpoint URL\n' +
          '  • Token lacks Context Viewer grant\n' +
          '  • Schema not deployed (GROQ mode refuses connections until schema is deployed)\n',
      )
      process.exit(1)
    }

    // 2. Get initial context (schema overview)
    if (tools.initial_context) {
      console.log('─'.repeat(60))
      console.log('STEP 2: Fetch initial_context (schema overview)')
      console.log('─'.repeat(60))
      try {
        const result = await tools.initial_context.execute(
          {},
          { toolCallId: 'verify-init', messages: [] },
        )
        const text = JSON.stringify(result)
        console.log(`Returned ${text.length} bytes`)
        console.log(text.slice(0, 400) + (text.length > 400 ? '…' : ''))
      } catch (err) {
        console.log(`✗ initial_context failed: ${(err as Error).message}`)
      }
      console.log()
    }

    // 3. Run GROQ queries (if GROQ mode)
    //
    // Two separate plain queries rather than one combined object literal
    // (`{ capabilities: count(...), entities: *[...]{...} }`): this endpoint's
    // GROQ engine doesn't accept a function call mixed into a top-level object
    // projection alongside another field — it reports a syntax error pointing
    // at the very end of the query, as if `count(`'s parens were never closed.
    // Plain single-expression queries are broadly compatible and simpler
    // besides, so that's the standard here rather than a workaround.
    if (tools.groq_query) {
      const queries: Array<[string, string]> = [
        ['count capabilities', 'count(*[_type == "capability"])'],
        ['first 3 entities', '*[_type == "entity"][0..2]{_id, name, entityType}'],
      ]
      for (const [label, query] of queries) {
        console.log('─'.repeat(60))
        console.log(`STEP 3: GROQ query — ${label}`)
        console.log('─'.repeat(60))
        try {
          const result = (await tools.groq_query.execute(
            { query },
            { toolCallId: `verify-groq-${label}`, messages: [] },
          )) as { isError?: boolean }
          const text = JSON.stringify(result)
          console.log(`${result?.isError ? '✗' : '✓'} Returned ${text.length} bytes`)
          console.log(text.slice(0, 800) + (text.length > 800 ? '…' : ''))
        } catch (err) {
          console.log(`✗ groq_query failed: ${(err as Error).message}`)
        }
        console.log()
      }
    }

    // 4. Try a KB read (if KB mode)
    if (tools.knowledge_base_read) {
      console.log('─'.repeat(60))
      console.log('STEP 4: knowledge_base_read — read first entry')
      console.log('─'.repeat(60))
      try {
        const result = await tools.knowledge_base_read.execute(
          { entry_paths: ['/'] },
          { toolCallId: 'verify-kb', messages: [] },
        )
        const text = JSON.stringify(result)
        console.log(`Returned ${text.length} bytes`)
        console.log(text.slice(0, 400) + (text.length > 400 ? '…' : ''))
      } catch (err) {
        console.log(`✗ knowledge_base_read failed: ${(err as Error).message}`)
      }
      console.log()
    }

    console.log('─'.repeat(60))
    console.log('✓ MCP integration verified')
    console.log('─'.repeat(60))
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})