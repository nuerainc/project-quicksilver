import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SanityClient } from '@sanity/client'
import { appendAuthorizationDecision, type AuthorizationAuditRecord } from './authorization-audit-store.ts'
import { persistWebRouteDecision, type GuardResult } from './route-guard.ts'

test('authorization audit appends unique immutable Sanity documents without credential material', async () => {
  const docs: Array<Record<string, unknown>> = []
  const client = { create: async (doc: Record<string, unknown>) => { docs.push(doc); return doc } } as unknown as SanityClient
  const record: AuthorizationAuditRecord = { tenantId: 'acme', route: 'plan', permissions: ['decision:propose'], actorId: 'entity-ana', outcome: 'allow', httpStatus: 200, at: '2026-09-29T00:00:00.000Z', decisionCode: 'authorized' }
  const first = await appendAuthorizationDecision(record, client)
  const second = await appendAuthorizationDecision(record, client)
  assert.notEqual(first, second)
  assert.equal(docs.length, 2)
  assert.deepEqual(docs[0], { _id: first, _type: 'authorizationDecisionAudit', ...record, permissions: ['decision:propose'] })
  assert.equal(JSON.stringify(docs).includes('Bearer'), false)
})

test('web route guard persists both allow and deny decisions before returning them', async () => {
  const records: AuthorizationAuditRecord[] = []
  const append = async (record: AuthorizationAuditRecord) => { records.push(record); return `id-${records.length}` }
  const allow: GuardResult = { ok: true, principalId: 'entity-ana' }
  const denied: GuardResult = { ok: false, status: 403, body: { error: 'denied', code: 'forbidden', needs: ['workflow:read'] } }
  assert.equal(await persistWebRouteDecision('monitoring/workflows', allow, { QUICKSILVER_TENANT_ID: 'acme' }, append), allow)
  assert.equal(await persistWebRouteDecision('monitoring/workflows', denied, { QUICKSILVER_TENANT_ID: 'acme' }, append), denied)
  assert.deepEqual(records.map((r) => [r.outcome, r.httpStatus, r.actorId, r.permissions]), [
    ['allow', 200, 'entity-ana', ['workflow:read']],
    ['deny', 403, undefined, ['workflow:read']],
  ])
})

test('web route guard fails closed when its durable authorization audit append fails', async () => {
  const allow: GuardResult = { ok: true, principalId: 'entity-ana' }
  const result = await persistWebRouteDecision('plan', allow, {}, async () => { throw new Error('store offline') })
  assert.deepEqual(result, { ok: false, status: 503, body: { error: 'Authorization audit storage is unavailable.', code: 'authorization-audit-unavailable' } })
})
