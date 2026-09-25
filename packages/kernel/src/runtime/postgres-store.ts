import type {
  WorkflowRunEvent,
  WorkflowRunFilter,
  WorkflowRunRecord,
  WorkflowRunStore,
} from './store.ts'

/**
 * PostgreSQL `WorkflowRunStore` for multi-process and multi-host deployments.
 *
 * Driver-neutral: pass anything with `query(text, params)` returning
 * `{ rows }`, such as a node-postgres `Pool`, a `Client`, or PGlite. Every
 * mutation is a single statement guarded by the row's revision, so concurrent
 * workers on different hosts are safe; the queue's claim path already
 * relies only on compare-and-set.
 *
 * Call `migrate()` once at deploy time (it is idempotent), or apply
 * `WORKFLOW_RUN_SCHEMA_SQL` with your own migration tool.
 */

export interface SqlClient {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>
}

export interface PostgresWorkflowRunStoreOptions {
  /** Table-name prefix; letters, digits, underscore (default `qs_`). */
  prefix?: string
}

export function workflowRunSchemaSql(prefix = 'qs_'): string {
  const p = safePrefix(prefix)
  return `
CREATE TABLE IF NOT EXISTS ${p}workflow_runs (
  run_id           text PRIMARY KEY,
  tenant_id        text NOT NULL,
  workflow_id      text NOT NULL,
  status           text NOT NULL,
  revision         integer NOT NULL,
  idempotency_key  text,
  graph_digest     text NOT NULL,
  priority         integer NOT NULL,
  available_at     bigint NOT NULL,
  created_at       bigint NOT NULL,
  updated_at       bigint NOT NULL,
  record           jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}workflow_runs_idem
  ON ${p}workflow_runs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${p}workflow_runs_claim
  ON ${p}workflow_runs (status, priority DESC, available_at, created_at);
CREATE INDEX IF NOT EXISTS ${p}workflow_runs_tenant
  ON ${p}workflow_runs (tenant_id, status);
CREATE TABLE IF NOT EXISTS ${p}workflow_run_events (
  run_id  text NOT NULL REFERENCES ${p}workflow_runs (run_id) ON DELETE CASCADE,
  seq     integer NOT NULL,
  at      bigint NOT NULL,
  type    text NOT NULL,
  actor   text,
  detail  text,
  PRIMARY KEY (run_id, seq)
);
`
}

/** Schema for the default `qs_` prefix. */
export const WORKFLOW_RUN_SCHEMA_SQL = workflowRunSchemaSql()

interface RunRow { record: WorkflowRunRecord | string }
interface EventRow { run_id: string; seq: number; at: string | number; type: string; actor: string | null; detail: string | null }

export class PostgresWorkflowRunStore implements WorkflowRunStore {
  private readonly db: SqlClient
  private readonly runs: string
  private readonly events_: string
  private readonly prefix: string

  constructor(db: SqlClient, options: PostgresWorkflowRunStoreOptions = {}) {
    this.db = db
    const p = safePrefix(options.prefix ?? 'qs_')
    this.runs = `${p}workflow_runs`
    this.events_ = `${p}workflow_run_events`
    this.prefix = p
  }

  /** Create tables and indexes if they do not exist. */
  async migrate(): Promise<void> {
    for (const statement of workflowRunSchemaSql(this.prefix).split(';').map((s) => s.trim()).filter(Boolean)) {
      await this.db.query(statement)
    }
  }

  async insert(record: WorkflowRunRecord): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO ${this.runs} (run_id, tenant_id, workflow_id, status, revision, idempotency_key, graph_digest, priority, available_at, created_at, updated_at, record)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [record.runId, record.tenantId, record.workflowId, record.status, record.revision, record.idempotencyKey ?? null, record.graphDigest, record.priority, record.availableAt, record.createdAt, record.updatedAt, JSON.stringify(record)],
      )
    } catch (error) {
      if (isUniqueViolation(error)) {
        const detail = String((error as { constraint?: string; message?: string }).constraint ?? (error as Error).message)
        if (detail.includes('idem')) throw new Error('A run with this idempotency key already exists for the tenant.')
        throw new Error(`Workflow run "${record.runId}" already exists.`)
      }
      throw error
    }
  }

  async get(runId: string): Promise<WorkflowRunRecord | undefined> {
    const { rows } = await this.db.query<RunRow>(`SELECT record FROM ${this.runs} WHERE run_id = $1`, [runId])
    return rows[0] ? parseRecord(rows[0].record) : undefined
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<WorkflowRunRecord | undefined> {
    const { rows } = await this.db.query<RunRow>(`SELECT record FROM ${this.runs} WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, key])
    return rows[0] ? parseRecord(rows[0].record) : undefined
  }

  async compareAndSet(next: WorkflowRunRecord, expectedRevision: number): Promise<boolean> {
    if (next.revision !== expectedRevision + 1) return false
    const { rows } = await this.db.query<{ run_id: string }>(
      `UPDATE ${this.runs}
          SET status = $3, revision = $4, priority = $5, available_at = $6, updated_at = $7, record = $8::jsonb
        WHERE run_id = $1 AND revision = $2
          AND tenant_id = $9 AND idempotency_key IS NOT DISTINCT FROM $10 AND graph_digest = $11
        RETURNING run_id`,
      [next.runId, expectedRevision, next.status, next.revision, next.priority, next.availableAt, next.updatedAt, JSON.stringify(next), next.tenantId, next.idempotencyKey ?? null, next.graphDigest],
    )
    if (rows.length === 1) return true
    // Distinguish a stale revision (normal contention) from an identity change (programming error).
    const current = await this.get(next.runId)
    if (current && current.revision === expectedRevision
      && (current.tenantId !== next.tenantId || current.idempotencyKey !== next.idempotencyKey || current.graphDigest !== next.graphDigest)) {
      throw new Error('Run identity fields (tenant, idempotency key, graph digest) are immutable.')
    }
    return false
  }

  async list(filter: WorkflowRunFilter = {}): Promise<WorkflowRunRecord[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? [...filter.status] : [filter.status]
      params.push(statuses)
      where.push(`status = ANY($${params.length}::text[])`)
    }
    if (filter.tenantId !== undefined) {
      params.push(filter.tenantId)
      where.push(`tenant_id = $${params.length}`)
    }
    if (filter.workflowId !== undefined) {
      params.push(filter.workflowId)
      where.push(`workflow_id = $${params.length}`)
    }
    const { rows } = await this.db.query<RunRow>(
      `SELECT record FROM ${this.runs}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, run_id`,
      params,
    )
    return rows.map((row) => parseRecord(row.record))
  }

  async appendEvent(event: Omit<WorkflowRunEvent, 'seq'>): Promise<WorkflowRunEvent> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const { rows } = await this.db.query<EventRow>(
          `INSERT INTO ${this.events_} (run_id, seq, at, type, actor, detail)
           SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5 FROM ${this.events_} WHERE run_id = $1
           RETURNING run_id, seq, at, type, actor, detail`,
          [event.runId, event.at, event.type, event.actor ?? null, event.detail ?? null],
        )
        return toEvent(rows[0]!)
      } catch (error) {
        if (isForeignKeyViolation(error)) throw new Error(`Cannot record an event for unknown run "${event.runId}".`)
        if (!isUniqueViolation(error)) throw error
        // Another writer took this sequence number; retry with the next one.
      }
    }
    throw new Error(`Could not append event for run "${event.runId}" after concurrent retries.`)
  }

  async events(runId: string): Promise<WorkflowRunEvent[]> {
    const { rows } = await this.db.query<EventRow>(`SELECT run_id, seq, at, type, actor, detail FROM ${this.events_} WHERE run_id = $1 ORDER BY seq`, [runId])
    return rows.map(toEvent)
  }
}

function toEvent(row: EventRow): WorkflowRunEvent {
  return {
    runId: row.run_id,
    seq: Number(row.seq),
    at: Number(row.at),
    type: row.type as WorkflowRunEvent['type'],
    ...(row.actor !== null ? { actor: row.actor } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
  }
}

function parseRecord(value: WorkflowRunRecord | string): WorkflowRunRecord {
  return typeof value === 'string' ? JSON.parse(value) as WorkflowRunRecord : structuredClone(value)
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505'
}

function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23503'
}

function safePrefix(prefix: string): string {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) throw new Error('Table prefix must be lowercase letters, digits, or underscores.')
  return prefix
}
