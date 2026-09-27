/**
 * File tools: read, list, search, write and edit files inside the workspace.
 * Reads refuse secret and runtime files; writes are checkpointed first and
 * refuse to follow a symlink out of the workspace.
 */
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'

import { checkReadPath, checkWritePath } from '../policy.ts'
import type { OperatorTool, ToolContext, ToolResult } from '../types.ts'

const MAX_READ = 60_000

async function insideAfterLinks(ctx: ToolContext, abs: string): Promise<boolean> {
  const root = await realpath(ctx.workspace)
  let probe = abs
  while (!existsSync(probe)) probe = dirname(probe)
  const real = await realpath(probe)
  const rel = relative(root, real)
  return !rel.startsWith('..')
}

const fail = (output: string): ToolResult => ({ ok: false, output })

export const readFileTool: OperatorTool<{ path: string; startLine?: number; endLine?: number }> = {
  name: 'read_file',
  description: 'Read a text file in the workspace, optionally a range of lines (1-based, inclusive). Output shows line numbers.',
  tier: 'read',
  input: z.object({ path: z.string(), startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() }),
  summarize: (i) => `read ${i.path}${i.startLine ? `:${i.startLine}-${i.endLine ?? ''}` : ''}`,
  async run(i, ctx) {
    const v = checkReadPath(ctx.workspace, i.path)
    if (!v.ok) return fail(v.reason)
    if (!(await insideAfterLinks(ctx, v.absolute))) return fail('That path leads outside the workspace.')
    let text: string
    try { text = await readFile(v.absolute, 'utf8') } catch (e) { return fail(`Cannot read ${i.path}: ${(e as Error).message}`) }
    const lines = text.split('\n')
    const from = (i.startLine ?? 1) - 1
    const to = Math.min(lines.length, i.endLine ?? lines.length)
    let out = lines.slice(from, to).map((l, n) => `${String(from + n + 1).padStart(5)}  ${l}`).join('\n')
    let note = ''
    if (out.length > MAX_READ) { out = out.slice(0, MAX_READ); note = `\n[cut at ${MAX_READ} characters; read a smaller range]` }
    return { ok: true, output: `${out}${note}`, facts: { path: v.relative, lines: lines.length } }
  },
}

export const listDirTool: OperatorTool<{ path?: string; depth?: number }> = {
  name: 'list_dir',
  description: 'List files and folders in the workspace (default: the root), up to a depth (default 2).',
  tier: 'read',
  input: z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(5).optional() }),
  summarize: (i) => `list ${i.path ?? '.'}`,
  async run(i, ctx) {
    const v = checkReadPath(ctx.workspace, i.path ?? '.')
    if (!v.ok) return fail(v.reason)
    const out: string[] = []
    const walk = async (dir: string, depth: number) => {
      if (out.length > 500) return
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch (e) { out.push(`! ${(e as Error).message}`); return }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.qs-') || e.name === 'node_modules' || e.name === '.git') continue
        const rel = relative(ctx.workspace, join(dir, e.name))
        out.push(e.isDirectory() ? `${rel}/` : rel)
        if (e.isDirectory() && depth > 1) await walk(join(dir, e.name), depth - 1)
      }
    }
    await walk(v.absolute, i.depth ?? 2)
    return { ok: true, output: out.length ? out.join('\n') + (out.length > 500 ? '\n[more entries not shown]' : '') : '(empty)' }
  },
}

export const searchFilesTool: OperatorTool<{ pattern: string; path?: string; glob?: string }> = {
  name: 'search_files',
  description: 'Search file contents in the workspace with a regular expression (ripgrep when available). Returns matching lines as path:line: text.',
  tier: 'read',
  input: z.object({ pattern: z.string().min(1), path: z.string().optional(), glob: z.string().optional() }),
  summarize: (i) => `search /${i.pattern}/ in ${i.path ?? '.'}`,
  async run(i, ctx) {
    const v = checkReadPath(ctx.workspace, i.path ?? '.')
    if (!v.ok) return fail(v.reason)
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    const cmd = `rg --no-heading -n --max-count 50 --glob '!.qs-*' --glob '!.env*' ${i.glob ? `--glob ${q(i.glob)} ` : ''}-e ${q(i.pattern)} ${q(v.absolute)} | head -200`
    const r = await ctx.sandbox.run(cmd, { timeoutMs: 30_000 })
    const out = r.stdout.split('\n').map((l) => l.startsWith(ctx.workspace) ? l.slice(ctx.workspace.length + 1) : l).join('\n').trim()
    return { ok: r.exitCode === 0 || r.exitCode === 1, output: out || 'No matches.' }
  },
}

export const writeFileTool: OperatorTool<{ path: string; content: string }> = {
  name: 'write_file',
  description: 'Create or replace a file in the workspace with the given content. The previous version is checkpointed.',
  tier: 'write',
  input: z.object({ path: z.string(), content: z.string().max(2_000_000) }),
  summarize: (i) => `write ${i.path} (${i.content.length} characters)`,
  writes: (i) => [i.path],
  async run(i, ctx) {
    const v = checkWritePath(ctx.workspace, i.path)
    if (!v.ok) return fail(v.reason)
    if (!(await insideAfterLinks(ctx, v.absolute))) return fail('That path leads outside the workspace.')
    if (existsSync(v.absolute) && (await lstat(v.absolute)).isSymbolicLink()) return fail('Refusing to write through a symbolic link.')
    await ctx.checkpoints.snapshot(ctx.runId, v.relative)
    await mkdir(dirname(v.absolute), { recursive: true })
    await writeFile(v.absolute, i.content)
    return { ok: true, output: `Wrote ${v.relative}.`, facts: { path: v.relative, bytes: Buffer.byteLength(i.content) } }
  },
}

export const editFileTool: OperatorTool<{ path: string; find: string; replace: string; all?: boolean }> = {
  name: 'edit_file',
  description: 'Replace exact text in a file. `find` must match exactly once unless `all` is true. The previous version is checkpointed.',
  tier: 'write',
  input: z.object({ path: z.string(), find: z.string().min(1), replace: z.string(), all: z.boolean().optional() }),
  summarize: (i) => `edit ${i.path}`,
  writes: (i) => [i.path],
  async run(i, ctx) {
    const v = checkWritePath(ctx.workspace, i.path)
    if (!v.ok) return fail(v.reason)
    if (!(await insideAfterLinks(ctx, v.absolute))) return fail('That path leads outside the workspace.')
    let text: string
    try {
      if ((await lstat(v.absolute)).isSymbolicLink()) return fail('Refusing to edit through a symbolic link.')
      text = await readFile(v.absolute, 'utf8')
    } catch (e) { return fail(`Cannot read ${i.path}: ${(e as Error).message}`) }
    const count = text.split(i.find).length - 1
    if (count === 0) return fail('The text to find is not in the file. Read the file and copy the text exactly.')
    if (count > 1 && !i.all) return fail(`The text to find appears ${count} times. Add surrounding lines so it is unique, or set all to true.`)
    await ctx.checkpoints.snapshot(ctx.runId, v.relative)
    await writeFile(v.absolute, i.all ? text.split(i.find).join(i.replace) : text.replace(i.find, () => i.replace))
    return { ok: true, output: `Edited ${v.relative} (${i.all ? count : 1} replacement${(i.all ? count : 1) === 1 ? '' : 's'}).`, facts: { path: v.relative, replacements: i.all ? count : 1 } }
  },
}

export const FILE_TOOLS = [readFileTool, listDirTool, searchFilesTool, writeFileTool, editFileTool] as const

/** Used by tests and the CLI to make sure a workspace exists. */
export async function ensureWorkspace(path: string): Promise<string> {
  const abs = resolve(path)
  await mkdir(abs, { recursive: true })
  if (!(await stat(abs)).isDirectory()) throw new Error(`${abs} is not a folder.`)
  return abs
}
