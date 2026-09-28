import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export type ExecutionAuthorizationStatus = 'issued' | 'consumed' | 'revoked'

export interface ExecutionAuthorizationPayload {
  authorizationId: string
  tenantId: string
  runId: string
  nodeId: string
  actionFingerprint: string
  policySnapshot: string
  evidenceDigest: string
  capability: string
  issuedAt: number
  expiresAt: number
}

export interface ExecutionAuthorizationRecord extends ExecutionAuthorizationPayload {
  contractVersion: 1
  status: ExecutionAuthorizationStatus
  keyId: string
  signature: string
  consumedAt?: number
  revokedAt?: number
  revokeReason?: string
}

export interface AuthorizationSigningKey {
  keyId: string
  secret: string
}

export interface AuthorizationVerification {
  valid: boolean
  reasons: string[]
}

/** Issue a signed authorization record. This is the only function that creates a record. */
export function issueExecutionAuthorization(
  payload: Omit<ExecutionAuthorizationPayload, 'authorizationId' | 'issuedAt'> & { authorizationId?: string; issuedAt?: number },
  key: AuthorizationSigningKey,
  now = Date.now(),
): ExecutionAuthorizationRecord {
  const authorizationId = payload.authorizationId ?? `auth:${randomUUID()}`
  const issuedAt = payload.issuedAt ?? now
  validateSigningKey(key)
  const base: ExecutionAuthorizationPayload = {
    authorizationId,
    tenantId: payload.tenantId,
    runId: payload.runId,
    nodeId: payload.nodeId,
    actionFingerprint: payload.actionFingerprint,
    policySnapshot: payload.policySnapshot,
    evidenceDigest: payload.evidenceDigest,
    capability: payload.capability,
    issuedAt,
    expiresAt: payload.expiresAt,
  }
  const record: ExecutionAuthorizationRecord = {
    ...base,
    contractVersion: 1,
    status: 'issued',
    keyId: key.keyId,
    signature: signAuthorization(base, key),
  }
  verifyOrThrow(record, key, now)
  return Object.freeze({ ...record })
}

/** Verify identity bindings, lifetime, status, and the tamper-evident signature. */
export function verifyExecutionAuthorization(
  record: ExecutionAuthorizationRecord,
  key: AuthorizationSigningKey,
  expected: { tenantId: string; runId: string; nodeId: string; actionFingerprint: string; now?: number },
): AuthorizationVerification {
  const reasons: string[] = []
  const now = expected.now ?? Date.now()
  try { validateSigningKey(key) } catch (error) { reasons.push((error as Error).message) }
  if (!record || record.contractVersion !== 1) reasons.push('Authorization record contract version is invalid.')
  if (!record?.authorizationId?.trim()) reasons.push('Authorization id is required.')
  if (record?.keyId !== key?.keyId) reasons.push('Authorization signing key does not match.')
  if (record?.status !== 'issued') reasons.push(`Authorization record is not issued (status: ${record?.status ?? 'unknown'}).`)
  if (record?.tenantId !== expected.tenantId) reasons.push('Authorization tenant does not match the execution tenant.')
  if (record?.runId !== expected.runId) reasons.push('Authorization run does not match the execution run.')
  if (record?.nodeId !== expected.nodeId) reasons.push('Authorization node does not match the execution step.')
  if (record?.actionFingerprint !== expected.actionFingerprint) reasons.push('Authorization action fingerprint does not match.')
  if (record?.issuedAt > now) reasons.push('Authorization was issued in the future.')
  if (record?.expiresAt <= now) reasons.push('Authorization has expired.')
  if (record?.expiresAt <= record?.issuedAt) reasons.push('Authorization expiry must be after issue time.')
  if (record?.signature && key?.secret) {
    const expectedSignature = signAuthorization(payloadOf(record), key)
    if (!safeEqual(record.signature, expectedSignature)) reasons.push('Authorization signature is invalid or the record was tampered with.')
  }
  return { valid: reasons.length === 0, reasons }
}

/** Consume exactly one issued authorization after the executor accepts it. */
export function consumeExecutionAuthorization(record: ExecutionAuthorizationRecord, key: AuthorizationSigningKey, now = Date.now()): ExecutionAuthorizationRecord {
  const verification = verifyExecutionAuthorization(record, key, {
    tenantId: record.tenantId, runId: record.runId, nodeId: record.nodeId, actionFingerprint: record.actionFingerprint, now,
  })
  if (!verification.valid) throw new Error(`Cannot consume execution authorization: ${verification.reasons.join(' ')}`)
  return Object.freeze({ ...record, status: 'consumed', consumedAt: now })
}

/** Revoke an issued authorization; revoked records can never be consumed. */
export function revokeExecutionAuthorization(record: ExecutionAuthorizationRecord, key: AuthorizationSigningKey, reason: string, now = Date.now()): ExecutionAuthorizationRecord {
  if (!reason.trim()) throw new Error('A revocation reason is required.')
  const verification = verifyExecutionAuthorization(record, key, {
    tenantId: record.tenantId, runId: record.runId, nodeId: record.nodeId, actionFingerprint: record.actionFingerprint, now,
  })
  if (!verification.valid) throw new Error(`Cannot revoke execution authorization: ${verification.reasons.join(' ')}`)
  return Object.freeze({ ...record, status: 'revoked', revokedAt: now, revokeReason: reason })
}

function payloadOf(record: ExecutionAuthorizationRecord): ExecutionAuthorizationPayload {
  return {
    authorizationId: record.authorizationId, tenantId: record.tenantId, runId: record.runId, nodeId: record.nodeId,
    actionFingerprint: record.actionFingerprint, policySnapshot: record.policySnapshot, evidenceDigest: record.evidenceDigest,
    capability: record.capability, issuedAt: record.issuedAt, expiresAt: record.expiresAt,
  }
}

function signAuthorization(payload: ExecutionAuthorizationPayload, key: AuthorizationSigningKey): string {
  return `hmac-sha256:${createHmac('sha256', key.secret).update(canonicalJson(payload)).digest('hex')}`
}

function canonicalJson(value: ExecutionAuthorizationPayload): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
  }) ?? 'null'
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function validateSigningKey(key: AuthorizationSigningKey): void {
  if (!key || typeof key.keyId !== 'string' || !key.keyId.trim()) throw new Error('Authorization signing key id is required.')
  if (typeof key.secret !== 'string' || key.secret.length < 32) throw new Error('Authorization signing key must contain at least 32 characters.')
}

function verifyOrThrow(record: ExecutionAuthorizationRecord, key: AuthorizationSigningKey, now: number): void {
  const result = verifyExecutionAuthorization(record, key, {
    tenantId: record.tenantId, runId: record.runId, nodeId: record.nodeId, actionFingerprint: record.actionFingerprint, now,
  })
  if (!result.valid) throw new Error(`Invalid execution authorization: ${result.reasons.join(' ')}`)
}
