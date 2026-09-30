import { randomUUID } from 'node:crypto'
import type { SanityClient } from '@sanity/client'

export interface AuthorizationAuditRecord {
  tenantId: string
  route: string
  permissions: readonly string[]
  actorId?: string
  outcome: 'allow' | 'deny'
  httpStatus: number
  at: string
  decisionCode: string
}

let configuredAppender: ((record: AuthorizationAuditRecord) => Promise<string>) | undefined

/** Inject a durable adapter at the composition boundary (also used by route integration tests). */
export function setAuthorizationAuditAppender(appender: ((record: AuthorizationAuditRecord) => Promise<string>) | undefined): void {
  configuredAppender = appender
}

/** Awaited durable append. Sanity create() gives each event a unique immutable document ID. */
export async function appendAuthorizationDecision(record: AuthorizationAuditRecord, client?: SanityClient): Promise<string> {
  if (!client && configuredAppender) return configuredAppender(record)
  const id = `authorizationDecisionAudit-${randomUUID()}`
  const target = client ?? (await import('./sanity-client.ts')).getSanityClient('write')
  await target.create({ _id: id, _type: 'authorizationDecisionAudit', ...record, permissions: [...record.permissions] })
  return id
}
