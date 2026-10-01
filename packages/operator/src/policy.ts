/**
 * The command and path policy: what a sandboxed command or a file write may
 * do, independent of who asked. Pure functions; the gate applies them.
 *
 * - Hardline: never runs, in any approval mode (destroying the disk or the
 *   system, fork bombs, piping a download into a shell, reading credential
 *   stores, disabling the policy itself).
 * - Dangerous: runs only with a human's approval in `guarded` mode
 *   (recursive deletes, force pushes, privilege escalation, package installs
 *   from the network, permission changes, process kills, history rewrites).
 * - Paths: writes stay inside the workspace root; credential and system
 *   locations are refused even inside it.
 *
 * Patterns are matched on the command with quotes and backslashes removed
 * and whitespace collapsed, so simple obfuscation does not slip past. The
 * shell-syntax rules tolerate internal whitespace, so a spaced-out fork bomb
 * is still a fork bomb.
 *
 * **What this is and is not.** This is a best-effort tripwire over command
 * *text*. It is sound for `run_command`, where the text is what runs. It is
 * **not** sound for a program: script source can construct its command at
 * runtime, and a pattern match cannot follow that. See `tools/exec.ts` for
 * verified examples that classify as `ok`. Do not describe this as the control
 * that keeps a sandboxed agent from destroying anything — the sandbox is.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface CommandRule {
  id: string
  pattern: RegExp
  reason: string
}

export const HARDLINE_RULES: readonly CommandRule[] = Object.freeze([
  { id: 'rm-root', pattern: /\brm\b(?=[^;&|]*\s-{1,2}[a-z-]*[rf])[^;&|]*\s(\/|~|\$home|\/\*|\/(bin|boot|dev|etc|lib|lib64|opt|proc|root|sbin|sys|usr|var)\b)(?=[\s;&|)]|$)/, reason: 'Deletes the system or the home directory.' },
  { id: 'disk-format', pattern: /\b(mkfs(\.[a-z0-9]+)?|wipefs|fdisk|parted|sfdisk)\b/, reason: 'Formats or repartitions a disk.' },
  { id: 'raw-disk-write', pattern: /\bdd\b[^|;&]*\bof=\/dev\//, reason: 'Writes directly to a device.' },
  { id: 'redirect-device', pattern: />\s*\/dev\/(sd|nvme|hd|disk|mmcblk)/, reason: 'Writes directly to a device.' },
  { id: 'fork-bomb', pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork bomb.' },
  { id: 'pipe-to-shell', pattern: /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, reason: 'Runs a script straight from the network.' },
  { id: 'shutdown', pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/, reason: 'Shuts down or restarts the machine.' },
  { id: 'credential-read', pattern: /(~|\$home|\/root|\/home\/[^/\s]+)\/\.(ssh|aws|gnupg|kube|docker\/config\.json|netrc|git-credentials)\b/, reason: 'Reaches a credential store.' },
  { id: 'chmod-root', pattern: /\bchmod\s+(-[a-z]*\s+)*[0-7]*777\s+\/(\s|$)/, reason: 'Opens permissions on the whole system.' },
  { id: 'policy-tamper', pattern: /\.qs-(audit|checkpoints|approvals)\b/, reason: 'Touches the audit log, checkpoints or approvals.' },
])

export const DANGEROUS_RULES: readonly CommandRule[] = Object.freeze([
  { id: 'recursive-delete', pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\b/, reason: 'Deletes recursively.' },
  { id: 'find-delete', pattern: /\bfind\b.*\s-delete\b|\bfind\b.*-exec\s+rm\b/, reason: 'Deletes files found by a search.' },
  { id: 'force-push', pattern: /\bgit\s+push\b.*(\s-f\b|--force)/, reason: 'Rewrites a remote branch.' },
  { id: 'git-destructive', pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-d)/i, reason: 'Throws away work in git.' },
  { id: 'privilege', pattern: /\b(sudo|su|doas|pkexec)\b/, reason: 'Escalates privileges.' },
  { id: 'package-install', pattern: /\b(apt(-get)?|yum|dnf|apk|brew|pacman)\s+(install|remove|purge|upgrade)\b|\b(pip3?|npm|pnpm|yarn|gem|cargo)\s+(install|add|i|uninstall|remove)\b/, reason: 'Installs or removes software from the network.' },
  { id: 'permissions', pattern: /\b(chmod|chown|chgrp)\b/, reason: 'Changes file permissions or owners.' },
  { id: 'kill', pattern: /\b(kill|pkill|killall)\b/, reason: 'Stops processes.' },
  { id: 'network-send', pattern: /\b(curl|wget)\b.*\s(-X\s*(post|put|delete|patch)|--data|-d\s|--upload-file|-T\s|-F\s)/, reason: 'Sends data over the network.' },
  { id: 'remote-shell', pattern: /\b(ssh|scp|rsync|sftp|nc|ncat|telnet)\b/, reason: 'Connects to another machine.' },
  { id: 'crontab', pattern: /\bcrontab\b|\bsystemctl\b|\bservice\s+\S+\s+(start|stop|restart)/, reason: 'Changes scheduled jobs or services.' },
  { id: 'overwrite-redirect', pattern: /(^|[^>])>\s*(\/|~)/, reason: 'Overwrites a file outside the working directory.' },
  { id: 'env-dump', pattern: /^\s*(env|printenv|set)\s*$|\bcat\s+[^|;&]*\.env\b/, reason: 'Prints environment variables or secrets.' },
])

/** Lower-cased, quotes and backslashes removed, whitespace collapsed. */
export function normalizeCommand(command: string): string {
  return command.toLowerCase().replace(/["'`\\]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Does this command hand text to a program for execution?
 *
 * `run_command` is normally consentable — the approver sees the command and
 * that is the thing that runs. That stops being true the moment the command is
 * `python3 -c '…'` or `bash -c '…'`: the program doing the work is a string
 * inside the command, not the command. Such a call is arbitrary code and is
 * refused in `trusted` mode even though no tool was flagged.
 */
const INLINE_CODE_PATTERNS: readonly RegExp[] = Object.freeze([
  // python -c / node -e / perl -e / php -r and friends
  /\b(python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|lua|tclsh)\s+(-{1,2}[a-z-]+\s+)*-{1,2}(c|e|r|eval)\b/,
  // bash -c / sh -c / zsh -c
  /\b(bash|sh|zsh|dash|ksh)\s+(-{1,2}[a-z-]+\s+)*-{1,2}c\b/,
  // eval as the command itself
  /(^|[\s;&|(])eval\s/,
  // piping into an interpreter: `echo x | sh`
  /\|\s*(sudo\s+)?(python[0-9.]*|node|perl|ruby|php|sh|bash|zsh)\b/,
])

export function isInlineCodeExecution(command: string): boolean {
  const c = normalizeCommand(command)
  return INLINE_CODE_PATTERNS.some((p) => p.test(c))
}

export interface CommandVerdict {
  /** `refuse`: hardline. `ask`: dangerous. `ok`: neither. */
  level: 'refuse' | 'ask' | 'ok'
  rules: string[]
  reasons: string[]
}

/** Classify one command. Pure. */
export function classifyCommand(command: string, extraHardline: readonly CommandRule[] = [], extraDangerous: readonly CommandRule[] = []): CommandVerdict {
  const c = normalizeCommand(command)
  const hard = [...HARDLINE_RULES, ...extraHardline].filter((r) => r.pattern.test(c))
  if (hard.length) return { level: 'refuse', rules: hard.map((r) => r.id), reasons: hard.map((r) => r.reason) }
  const danger = [...DANGEROUS_RULES, ...extraDangerous].filter((r) => r.pattern.test(c))
  if (danger.length) return { level: 'ask', rules: danger.map((r) => r.id), reasons: danger.map((r) => r.reason) }
  return { level: 'ok', rules: [], reasons: [] }
}

/** Path segments a write may never touch, even inside the workspace. */
const PROTECTED_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.kube', '.git/hooks', '.qs-audit', '.qs-checkpoints', '.qs-approvals']
const PROTECTED_FILES = [/(^|\/)\.env(\.[^/]*)?$/, /(^|\/)\.netrc$/, /(^|\/)\.git-credentials$/, /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/]

export type PathVerdict = { ok: true; absolute: string; relative: string } | { ok: false; reason: string }

/**
 * Resolve `path` against the workspace and check it may be written. Refuses
 * anything outside the workspace (including through `..`), and credential,
 * secret and runtime-internal files inside it. Pure (no filesystem access;
 * symlinks are checked by the file tools with realpath before writing).
 */
export function checkWritePath(workspace: string, path: string): PathVerdict {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) return { ok: false, reason: 'The path is empty or invalid.' }
  const root = resolve(workspace)
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, absolute)
  if (rel === '') return { ok: false, reason: 'The workspace root itself cannot be written.' }
  if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: `"${path}" is outside the workspace.` }
  const posix = rel.split(sep).join('/')
  if (PROTECTED_SEGMENTS.some((s) => posix === s || posix.startsWith(`${s}/`) || posix.includes(`/${s}/`) || posix.endsWith(`/${s}`))) {
    return { ok: false, reason: `"${path}" is a protected location (credentials or the runtime's own records).` }
  }
  if (PROTECTED_FILES.some((p) => p.test(posix))) return { ok: false, reason: `"${path}" holds secrets and cannot be written by an agent.` }
  return { ok: true, absolute, relative: posix }
}

/** Resolve a path for reading: inside the workspace only; secret and runtime files are refused too. */
export function checkReadPath(workspace: string, path: string): PathVerdict {
  if (path === '.' || path === '' || path === './') return { ok: true, absolute: resolve(workspace), relative: '.' }
  return checkWritePath(workspace, path)
}

/**
 * Environment variables a sandboxed command may see: an allowlist, so API
 * keys and tokens in the operator's own environment never reach it.
 */
export const SANDBOX_ENV_ALLOW = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'TMPDIR', 'USER', 'SHELL', 'NODE_ENV', 'PYTHONUNBUFFERED'])

export function sandboxEnv(env: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of SANDBOX_ENV_ALLOW) if (env[k] !== undefined) out[k] = env[k]!
  return { ...out, ...extra }
}
