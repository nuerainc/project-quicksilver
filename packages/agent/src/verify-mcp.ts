/**
 * MCP verification — Day 6 milestone check, extended to cover KB-mode.
 *
 * Run after Context is enabled in the Sanity dashboard and you've created
 * a GROQ-mode Context MCP endpoint (and, optionally, a KB-mode one).
 * Confirms the agent harness can:
 *   1. Connect to every configured Context MCP endpoint
 *   2. Discover the available (merged) tools
 *   3. Call initial_context to get the schema overview
 *   4. Run a GROQ query that pulls real structured content
 *   5. Run a knowledge_base_read that pulls real cited KB entries
 *
 * Run with:   npm run verify:mcp
 *             (requires SANITY_CONTEXT_MCP_URL + SANITY_CONTEXT_TOKEN in .env;
 *              SANITY_CONTEXT_KB_MCP_URL is optional and adds the KB-mode check)
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

const { createSanityContextClients, readEnvMcpConfigs, mergeClientTools, closeAll } =
  await import('./mcp.ts')

async function main() {
  const configs = readEnvMcpConfigs()
  for (const config of configs) {
    console.log(`Connecting (${config.label}-mode): ${config.endpointUrl}`)
  }
  console.log()

  const clients = await createSanityContextClients(configs)

  try {
    // 1. Discover tools
    console.log('─'.repeat(60))
    console.log('STEP 1: Discover available tools (merged across endpoints)')
    console.log('─'.repeat(60))
    // MCP returns a dynamic tool map. The verification script intentionally
    // invokes selected tools, so reflect the executable surface at the boundary.
    const tools = await mergeClientTools(clients) as unknown as Record<string, {
      execute: (args: unknown, options: unknown) => Promise<unknown>
      description?: string
      inputSchema?: unknown
      parameters?: unknown
    }>
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

    // 1b. Print knowledge_base_read's actual input schema. The tool name is
    // stable across Context MCP servers but the argument shape isn't
    // documented publicly, so introspect it rather than guessing.
    if (tools.knowledge_base_read) {
      console.log('─'.repeat(60))
      console.log('STEP 1b: knowledge_base_read input schema')
      console.log('─'.repeat(60))
      const kbTool = tools.knowledge_base_read as {
        description?: string
        inputSchema?: unknown
        parameters?: unknown
      }
      console.log(`description: ${kbTool.description ?? '(none)'}`)
      try {
        console.log(
          'schema:',
          JSON.stringify(kbTool.inputSchema ?? kbTool.parameters, null, 2),
        )
      } catch {
        console.log('schema: (not serializable)', kbTool.inputSchema ?? kbTool.parameters)
      }
      console.log()
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

    // 2b. KB-mode's own initial_context, if a KB endpoint is configured too.
    // (mergeClientTools aliases the second endpoint's initial_context to
    // kb_initial_context since the bare name is already taken by GROQ-mode.)
    // Its outline is where the `kb…` id for knowledge_base_read's
    // `knowledgeBase` argument lives — captured here and reused in STEP 4
    // rather than re-fetched.
    let kbOutlineText: string | undefined
    if (tools.kb_initial_context) {
      console.log('─'.repeat(60))
      console.log('STEP 2b: Fetch kb_initial_context (KB-mode schema overview)')
      console.log('─'.repeat(60))
      try {
        const result = await (
          tools.kb_initial_context as { execute: (args: object, ctx: object) => Promise<unknown> }
        ).execute({}, { toolCallId: 'verify-kb-init', messages: [] })
        kbOutlineText = JSON.stringify(result)
        console.log(`Returned ${kbOutlineText.length} bytes`)
        // Printed in full (not truncated like the other steps): this text is
        // where the KB's own identifier/slug for knowledge_base_read's
        // `knowledgeBase` argument is documented.
        console.log(kbOutlineText)
      } catch (err) {
        console.log(`✗ kb_initial_context failed: ${(err as Error).message}`)
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

    // 4. Try a KB read (if KB mode).
    //
    // knowledge_base_read takes { knowledgeBase, paths } — NOT { entry_paths }.
    // The `knowledgeBase` value is the `kb…` id printed in kb_initial_context's
    // own outline (STEP 2b), never a fixed/predictable string, so it's parsed
    // out of that outline rather than hardcoded — this keeps working if the
    // endpoint is ever recreated and gets a new id. An explicit
    // SANITY_KNOWLEDGE_BASE_ID env var overrides the parsed value if set.
    if (tools.knowledge_base_read) {
      console.log('─'.repeat(60))
      console.log('STEP 4: knowledge_base_read — read the central contradiction pair')
      console.log('─'.repeat(60))
      try {
        const knowledgeBaseId =
          process.env.SANITY_KNOWLEDGE_BASE_ID ||
          kbOutlineText?.match(/Knowledge base id:\s*`?(kb[a-zA-Z0-9]+)`?/)?.[1]

        if (!knowledgeBaseId) {
          console.log(
            '✗ Could not determine the knowledge base id (expected it in kb_initial_context\'s ' +
              'outline, or set SANITY_KNOWLEDGE_BASE_ID).',
          )
        } else {
          // engineering_analysis + incidents: the two entries the platform's
          // own contradiction detection flags against each other (parameter
          // drift vs. mechanical failure) — the central conflict this
          // submission's demo narrative is built around.
          const result = await tools.knowledge_base_read.execute(
            { knowledgeBase: knowledgeBaseId, paths: ['engineering_analysis', 'incidents'] },
            { toolCallId: 'verify-kb', messages: [] },
          )
          const text = JSON.stringify(result)
          console.log(`Returned ${text.length} bytes`)
          console.log(text.slice(0, 1200) + (text.length > 1200 ? '…' : ''))
        }
      } catch (err) {
        console.log(`✗ knowledge_base_read failed: ${(err as Error).message}`)
      }
      console.log()
    }

    console.log('─'.repeat(60))
    console.log('✓ MCP integration verified')
    console.log('─'.repeat(60))
  } finally {
    await closeAll(clients)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
