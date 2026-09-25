/**
 * Structured JSON logs for the hosted runtime.
 *
 * One JSON object per line on stdout, so any log collector can ingest them.
 * Secrets are redacted before anything is written:
 *   - values under sensitive keys (token, secret, password, authorization, …);
 *   - values that look like Quicksilver credentials (`qs_…`, `whsec_…`,
 *     `sha256:` digests are kept because they are not credentials);
 *   - any exact value registered with `redactValue` (vault secrets are
 *     registered when they are resolved).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const SENSITIVE_KEY = /(pass(word)?|secret|token|authori[sz]ation|api[-_]?key|cookie|credential|private[-_]?key|master[-_]?key)/i
const CREDENTIAL_VALUE = /\b(qs_[A-Za-z0-9_-]{20,}|whsec_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+\S{16,})/g
export const REDACTED = '[redacted]'

export interface LogSink {
  write(line: string): void
}

export interface LoggerOptions {
  level?: LogLevel
  sink?: LogSink
  bindings?: Record<string, unknown>
  now?: () => number
}

/** Values that must never appear in logs, shared by all loggers in the process. */
const knownSecrets = new Set<string>()

/** Register an exact secret value so it is redacted wherever it appears. */
export function redactValue(value: string): void {
  if (typeof value === 'string' && value.length >= 8) knownSecrets.add(value)
}

export function redactString(text: string): string {
  let out = text.replace(CREDENTIAL_VALUE, REDACTED)
  for (const secret of knownSecrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  return out
}

/** Deep-copy `value` with secrets removed. Handles cycles and errors. */
export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > 8) return '[truncated]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, seen, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) && !/digest$/i.test(key) ? REDACTED : redact(item, seen, depth + 1)
  }
  return out
}

export class Logger {
  private readonly levelName: LogLevel
  private readonly level: number
  private readonly sink: LogSink
  private readonly bindings: Record<string, unknown>
  private readonly now: () => number

  constructor(options: LoggerOptions = {}) {
    this.levelName = options.level ?? 'info'
    this.level = LEVELS[this.levelName]
    this.sink = options.sink ?? { write: (line) => process.stdout.write(`${line}\n`) }
    this.bindings = options.bindings ?? {}
    this.now = options.now ?? Date.now
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger({ level: this.levelName, sink: this.sink, bindings: { ...this.bindings, ...bindings }, now: this.now })
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.write('debug', msg, fields) }
  info(msg: string, fields?: Record<string, unknown>): void { this.write('info', msg, fields) }
  warn(msg: string, fields?: Record<string, unknown>): void { this.write('warn', msg, fields) }
  error(msg: string, fields?: Record<string, unknown>): void { this.write('error', msg, fields) }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < this.level) return
    const entry = redact({ ...this.bindings, ...fields }) as Record<string, unknown>
    try {
      this.sink.write(JSON.stringify({ time: new Date(this.now()).toISOString(), level, msg: redactString(msg), ...entry }))
    } catch {
      // Logging must never break the runtime.
    }
  }
}

export function parseLogLevel(value: string | undefined): LogLevel {
  return value && value in LEVELS ? (value as LogLevel) : 'info'
}
