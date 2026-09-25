/**
 * Minimal metrics registry with Prometheus text exposition (format 0.0.4).
 * No dependencies. Label values are escaped; label sets are bounded per
 * metric so a bad caller can't grow memory without limit.
 */

type Labels = Record<string, string>

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const MAX_SERIES = 1_000

function key(labels: Labels): string {
  return Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join('\u0000')
}

function format(labels: Labels): string {
  const parts = Object.keys(labels).sort().map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`)
  return parts.length ? `{${parts.join(',')}}` : ''
}

function checkLabels(labels: Labels): void {
  for (const k of Object.keys(labels)) if (!LABEL.test(k) || k === 'le') throw new Error(`Invalid metric label "${k}".`)
}

abstract class Metric {
  readonly name: string
  readonly help: string
  readonly type: 'counter' | 'gauge' | 'histogram'
  constructor(name: string, help: string, type: 'counter' | 'gauge' | 'histogram') {
    this.name = name
    this.help = help
    this.type = type
    if (!NAME.test(name)) throw new Error(`Invalid metric name "${name}".`)
  }
  abstract render(): string[]
  protected header(): string[] {
    return [`# HELP ${this.name} ${this.help.replace(/\n/g, ' ')}`, `# TYPE ${this.name} ${this.type}`]
  }
}

export class Counter extends Metric {
  private readonly series = new Map<string, { labels: Labels; value: number }>()
  constructor(name: string, help: string) { super(name, help, 'counter') }
  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0)) throw new Error('Counters only increase.')
    checkLabels(labels)
    const k = key(labels)
    const entry = this.series.get(k)
    if (entry) entry.value += by
    else if (this.series.size < MAX_SERIES) this.series.set(k, { labels: { ...labels }, value: by })
  }
  get(labels: Labels = {}): number { return this.series.get(key(labels))?.value ?? 0 }
  render(): string[] {
    return [...this.header(), ...[...this.series.values()].map((s) => `${this.name}${format(s.labels)} ${s.value}`)]
  }
}

export class Gauge extends Metric {
  private readonly series = new Map<string, { labels: Labels; value: number }>()
  constructor(name: string, help: string) { super(name, help, 'gauge') }
  set(labels: Labels, value: number): void {
    checkLabels(labels)
    const k = key(labels)
    if (this.series.has(k) || this.series.size < MAX_SERIES) this.series.set(k, { labels: { ...labels }, value })
  }
  reset(): void { this.series.clear() }
  get(labels: Labels = {}): number | undefined { return this.series.get(key(labels))?.value }
  render(): string[] {
    return [...this.header(), ...[...this.series.values()].map((s) => `${this.name}${format(s.labels)} ${s.value}`)]
  }
}

export const DEFAULT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]

export class Histogram extends Metric {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>()
  private readonly buckets: number[]
  constructor(name: string, help: string, buckets = DEFAULT_BUCKETS) {
    super(name, help, 'histogram')
    this.buckets = [...buckets].sort((a, b) => a - b)
  }
  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return
    checkLabels(labels)
    const k = key(labels)
    let entry = this.series.get(k)
    if (!entry) {
      if (this.series.size >= MAX_SERIES) return
      entry = { labels: { ...labels }, counts: this.buckets.map(() => 0), sum: 0, count: 0 }
      this.series.set(k, entry)
    }
    this.buckets.forEach((b, i) => { if (value <= b) entry!.counts[i]! += 1 })
    entry.sum += value
    entry.count += 1
  }
  render(): string[] {
    const lines = this.header()
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${format({ ...s.labels, le: String(b) })} ${s.counts[i]}`))
      lines.push(`${this.name}_bucket${format({ ...s.labels, le: '+Inf' })} ${s.count}`)
      lines.push(`${this.name}_sum${format(s.labels)} ${s.sum}`)
      lines.push(`${this.name}_count${format(s.labels)} ${s.count}`)
    }
    return lines
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>()
  private readonly collectors: Array<() => void | Promise<void>> = []

  counter(name: string, help: string): Counter { return this.register(new Counter(name, help)) }
  gauge(name: string, help: string): Gauge { return this.register(new Gauge(name, help)) }
  histogram(name: string, help: string, buckets?: number[]): Histogram { return this.register(new Histogram(name, help, buckets)) }

  /** Run before each scrape, e.g. to refresh queue-depth gauges. Errors are ignored. */
  onCollect(fn: () => void | Promise<void>): void { this.collectors.push(fn) }

  async render(): Promise<string> {
    for (const fn of this.collectors) await Promise.resolve().then(fn).catch(() => undefined)
    return `${[...this.metrics.values()].flatMap((m) => m.render()).join('\n')}\n`
  }

  private register<M extends Metric>(metric: M): M {
    if (this.metrics.has(metric.name)) throw new Error(`Metric "${metric.name}" is already registered.`)
    this.metrics.set(metric.name, metric)
    return metric
  }
}

/** The runtime's standard metric set. */
export function createHostMetrics(registry = new MetricsRegistry()) {
  return {
    registry,
    runsFinished: registry.counter('quicksilver_runs_finished_total', 'Workflow runs that reached a stored outcome, by status.'),
    runDuration: registry.histogram('quicksilver_run_duration_seconds', 'Time from run creation to stored outcome.'),
    queueRuns: registry.gauge('quicksilver_queue_runs', 'Runs in the store, by status.'),
    webhookDeliveries: registry.counter('quicksilver_webhook_deliveries_total', 'Webhook deliveries, by endpoint and HTTP status.'),
    scheduleEnqueues: registry.counter('quicksilver_schedule_enqueues_total', 'Schedule slots processed, by schedule and outcome.'),
    httpRequests: registry.counter('quicksilver_http_requests_total', 'Host HTTP requests, by route and status.'),
    vaultAccess: registry.counter('quicksilver_vault_access_total', 'Secrets vault operations, by operation and outcome.'),
    evaluations: registry.counter('quicksilver_evaluations_total', 'NQC evaluations of agent steps, by safety decision.'),
    up: registry.gauge('quicksilver_up', 'Host process is running (1).'),
  }
}

export type HostMetrics = ReturnType<typeof createHostMetrics>
