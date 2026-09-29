/**
 * Skills (M8 part 3) on the open SKILL.md standard: a folder holding a
 * SKILL.md (front matter with `name` and `description`, then instructions)
 * and any files it refers to.
 *
 * - Loaded progressively: the run's prompt lists only names and
 *   descriptions; `use_skill` loads the instructions, `read_skill_file` a file.
 * - Written by the agent: `propose_skill` saves a new skill, or a revision of
 *   an existing one, as pending. A person reviews it (with the diff) before it
 *   becomes active. An agent never overwrites an active skill.
 * - Scanned: a skill whose text contains a command the policy refuses is
 *   rejected; lines that try to change the agent's rules are flagged.
 * - Scored by outcomes: each run that used a skill counts towards it, and
 *   the listing shows how many of those runs the runtime verified.
 *
 * Layout under the skills root:
 *   active/<name>/SKILL.md      skills in use
 *   pending/<name>/SKILL.md     proposals waiting for a person
 *   scores.json                 uses and outcomes per skill
 * Skills in `<workspace>/skills/<name>/` (checked into a project) are read too
 * and win over the root's active skills with the same name.
 */
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { z } from 'zod'

import { classifyCommand } from './policy.ts'
import type { RunStatus } from './loop.ts'
import type { OperatorTool } from './types.ts'

export interface Skill {
  name: string
  description: string
  body: string
  dir: string
  source: 'project' | 'library'
  /** Front matter keys beyond name and description, kept as text. */
  meta: Record<string, string>
}

export interface SkillScore { uses: number; verified: number; failed: number; lastUsed?: string }

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const INJECTION = /(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier|your)\s+(instructions|rules|prompts?)|you are now|disable (the )?(policy|gate|approvals?)|approve (all|every)|yolo/i

/** Parse SKILL.md: `---` front matter of `key: value` lines, then the body. */
export function parseSkillMd(text: string): { meta: Record<string, string>; body: string } | { error: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { error: 'SKILL.md must start with front matter between --- lines.' }
  const meta: Record<string, string> = {}
  let key: string | null = null
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) {
      key = kv[1]!
      meta[key] = kv[2]!.replace(/^(['"])(.*)\1$/, '$2').replace(/^[>|]-?$/, '')
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = `${meta[key] ? `${meta[key]} ` : ''}${line.trim()}`
    }
  }
  return { meta, body: m[2]!.trim() }
}

export function renderSkillMd(s: { name: string; description: string; body: string }): string {
  return `---\nname: ${s.name}\ndescription: ${s.description.replace(/\n+/g, ' ')}\n---\n\n${s.body.trim()}\n`
}

/** Validate and scan one skill. Returns problems (refusals) and flags (warnings). */
export function checkSkill(s: { name: string; description: string; body: string }): { problems: string[]; flags: string[] } {
  const problems: string[] = []
  const flags: string[] = []
  if (!NAME.test(s.name)) problems.push('The name must be lowercase letters, digits and dashes (up to 64).')
  if (!s.description.trim() || s.description.length > 1024) problems.push('The description must say when to use the skill, in up to 1024 characters.')
  if (!s.body.trim()) problems.push('The skill has no instructions.')
  if (s.body.length > 50_000) problems.push('The instructions are longer than 50,000 characters.')
  const blocks = [...s.body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((b) => b[1]!)
  for (const text of [s.body, ...blocks]) {
    for (const line of text.split('\n')) {
      const v = classifyCommand(line)
      if (v.level === 'refuse') problems.push(`It contains a command the policy refuses: ${v.reasons.join(' ')}`)
    }
  }
  for (const line of s.body.split('\n')) if (INJECTION.test(line)) flags.push(`A line tries to change the agent's rules: ${line.trim().slice(0, 120)}`)
  return { problems: [...new Set(problems)], flags }
}

export class SkillLibrary {
  readonly root: string
  private readonly projectDir?: string

  constructor(root: string, projectDir?: string) {
    this.root = resolve(root)
    this.projectDir = projectDir ? resolve(projectDir) : undefined
  }

  private async loadDir(dir: string, source: Skill['source']): Promise<Skill[]> {
    if (!existsSync(dir)) return []
    const out: Skill[] = []
    for (const name of (await readdir(dir)).sort()) {
      const file = join(dir, name, 'SKILL.md')
      if (!NAME.test(name) || !existsSync(file)) continue
      const parsed = parseSkillMd(await readFile(file, 'utf8'))
      if ('error' in parsed) continue
      const s = { name: parsed.meta.name ?? name, description: parsed.meta.description ?? '', body: parsed.body }
      if (s.name !== name || checkSkill(s).problems.length) continue
      const { name: _n, description: _d, ...meta } = parsed.meta
      out.push({ ...s, dir: join(dir, name), source, meta })
    }
    return out
  }

  /** Active skills: project skills win over library skills with the same name. */
  async active(): Promise<Skill[]> {
    const lib = await this.loadDir(join(this.root, 'active'), 'library')
    const proj = this.projectDir ? await this.loadDir(join(this.projectDir, 'skills'), 'project') : []
    const byName = new Map(lib.map((s) => [s.name, s]))
    for (const s of proj) byName.set(s.name, s)
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async pending(): Promise<Skill[]> { return this.loadDir(join(this.root, 'pending'), 'library') }

  async get(name: string): Promise<Skill | undefined> { return (await this.active()).find((s) => s.name === name) }

  async scores(): Promise<Record<string, SkillScore>> {
    try { return JSON.parse(await readFile(join(this.root, 'scores.json'), 'utf8')) } catch { return {} }
  }

  /** Count a run's outcome for every skill it used. */
  async recordOutcome(names: readonly string[], status: RunStatus): Promise<void> {
    if (!names.length) return
    const scores = await this.scores()
    for (const n of new Set(names)) {
      const s = scores[n] ?? { uses: 0, verified: 0, failed: 0 }
      s.uses++
      if (status === 'verified') s.verified++
      if (status === 'failed' || status === 'stopped') s.failed++
      s.lastUsed = new Date().toISOString()
      scores[n] = s
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFile(join(this.root, 'scores.json'), JSON.stringify(scores, null, 1), { mode: 0o600 })
  }

  /** The prompt block: names, descriptions and track records. */
  async listing(): Promise<string> {
    const [skills, scores] = await Promise.all([this.active(), this.scores()])
    if (!skills.length) return ''
    const lines = skills.map((s) => {
      const sc = scores[s.name]
      return `- ${s.name}: ${s.description}${sc ? ` (used ${sc.uses}×, verified ${sc.verified})` : ''}`
    })
    return `Skills you can load with use_skill when one fits the task:\n${lines.join('\n')}`
  }

  /** The agent proposes a new skill or a revision; it lands in pending/. */
  async propose(input: { name: string; description: string; body: string }, source: { runId?: string }): Promise<{ ok: true; revision: boolean; flags: string[] } | { ok: false; problems: string[] }> {
    const c = checkSkill(input)
    if (c.problems.length) return { ok: false, problems: c.problems }
    const dir = join(this.root, 'pending', input.name)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const md = renderSkillMd(input)
    await writeFile(join(dir, 'SKILL.md'), md.replace(/^---\n/, `---\nproposed-by: agent${source.runId ? `\nproposed-in: ${source.runId}` : ''}\n`), { mode: 0o600 })
    return { ok: true, revision: existsSync(join(this.root, 'active', input.name, 'SKILL.md')), flags: c.flags }
  }

  /** A person accepts (moves to active, replacing any earlier version) or rejects a proposal. */
  async review(name: string, accept: boolean): Promise<boolean> {
    if (!NAME.test(name)) return false
    const from = join(this.root, 'pending', name)
    if (!existsSync(join(from, 'SKILL.md'))) return false
    if (!accept) { await rm(from, { recursive: true, force: true }); return true }
    const to = join(this.root, 'active', name)
    await mkdir(join(this.root, 'active'), { recursive: true, mode: 0o700 })
    if (existsSync(to)) {
      const archived = join(this.root, 'archive', `${name}-${Date.now().toString(36)}`)
      await mkdir(join(this.root, 'archive'), { recursive: true, mode: 0o700 })
      await cp(to, archived, { recursive: true })
      await rm(to, { recursive: true, force: true })
    }
    await rename(from, to)
    return true
  }

  /** Install a skill folder a person chose (for example one downloaded from a hub): scanned, then pending. */
  async importFolder(dir: string): Promise<{ ok: true; name: string; flags: string[] } | { ok: false; problems: string[] }> {
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) return { ok: false, problems: ['There is no SKILL.md in that folder.'] }
    const parsed = parseSkillMd(await readFile(file, 'utf8'))
    if ('error' in parsed) return { ok: false, problems: [parsed.error] }
    const s = { name: parsed.meta.name ?? '', description: parsed.meta.description ?? '', body: parsed.body }
    const c = checkSkill(s)
    if (c.problems.length) return { ok: false, problems: c.problems }
    const to = join(this.root, 'pending', s.name)
    await rm(to, { recursive: true, force: true })
    await cp(dir, to, { recursive: true })
    return { ok: true, name: s.name, flags: c.flags }
  }
}

/** A simple line diff for review prompts. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  const out: string[] = []
  const setA = new Set(a)
  const setB = new Set(b)
  for (const l of a) if (!setB.has(l)) out.push(`- ${l}`)
  for (const l of b) if (!setA.has(l)) out.push(`+ ${l}`)
  return out.join('\n') || '(no changes)'
}

/** Tools. `used` collects the skills a run loaded, for outcome scoring. */
export function skillTools(lib: SkillLibrary, used: string[]): OperatorTool<any>[] {
  const use: OperatorTool<{ name: string }> = {
    name: 'use_skill',
    description: 'Load a skill\'s instructions by name (from the skills list). Follow them for the task.',
    tier: 'read',
    input: z.object({ name: z.string() }),
    summarize: (i) => `use skill ${i.name}`,
    async run(i) {
      const s = await lib.get(i.name)
      if (!s) return { ok: false, output: `No skill "${i.name}".` }
      used.push(s.name)
      const files = existsSync(s.dir) ? (await readdir(s.dir, { recursive: true })).map(String).filter((f) => f !== 'SKILL.md') : []
      return { ok: true, output: `${s.body}${files.length ? `\n\nFiles in this skill (read_skill_file): ${files.join(', ')}` : ''}`, facts: { skill: s.name } }
    },
  }
  const readFileInSkill: OperatorTool<{ name: string; path: string }> = {
    name: 'read_skill_file',
    description: 'Read a file that belongs to a skill.',
    tier: 'read',
    input: z.object({ name: z.string(), path: z.string() }),
    summarize: (i) => `read ${i.name}/${i.path}`,
    async run(i) {
      const s = await lib.get(i.name)
      if (!s) return { ok: false, output: `No skill "${i.name}".` }
      const abs = resolve(s.dir, i.path)
      if (relative(s.dir, abs).startsWith('..')) return { ok: false, output: 'That path is outside the skill.' }
      try { return { ok: true, output: (await readFile(abs, 'utf8')).slice(0, 40_000) } } catch (e) { return { ok: false, output: (e as Error).message } }
    },
  }
  const propose: OperatorTool<{ name: string; description: string; body: string }> = {
    name: 'propose_skill',
    description: 'After solving a task that will come up again, save how to do it as a skill: a lowercase-dashed name, a description of when to use it, and step-by-step instructions (commands, checks, pitfalls). A person reviews it before it is used. To improve an existing skill, propose it again under the same name.',
    tier: 'write',
    input: z.object({ name: z.string(), description: z.string(), body: z.string() }),
    summarize: (i) => `propose skill ${i.name}`,
    async run(i, ctx) {
      const r = await lib.propose(i, { runId: ctx.runId })
      if (!r.ok) return { ok: false, output: `Not saved: ${r.problems.join(' ')}` }
      return { ok: true, output: `Saved "${i.name}" ${r.revision ? 'as a revision ' : ''}for review.${r.flags.length ? ` Flags: ${r.flags.join(' ')}` : ''}`, facts: { skill: i.name, revision: r.revision } }
    },
  }
  return [use, readFileInSkill, propose]
}
