import { createHash } from 'node:crypto'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ToolGroup } from './tool-groups.ts'
import type { ToolGroupSummary } from './tool-group-summary.ts'

export type ToolGroupAuditStatus = 'open' | 'success' | 'fallback' | 'failure'

export interface ToolGroupFingerprintInput {
  readonly lifecycle: { readonly sessionId: string; readonly createdAt?: number }
  readonly sourceSeqs: readonly SessionSeq[]
  readonly callIds: readonly string[]
  readonly eventTypes: readonly string[]
  readonly contentDigest: string
  readonly schemaVersion: number
}

export interface ToolGroupAuditRecord {
  readonly requestId: string
  readonly sessionId: string
  /** Session lifecycle identity. Legacy records without createdAt are ignored. */
  readonly lifecycle?: { readonly createdAt?: number }
  readonly fingerprint: string
  readonly sourceSeqs: readonly SessionSeq[]
  readonly surfaceGeneration: number
  readonly provider: string
  readonly model: string
  readonly schemaVersion: number
  readonly status: ToolGroupAuditStatus
  readonly rawOutput?: unknown
  readonly summary?: ToolGroupSummary
  readonly replacementSeqs?: readonly SessionSeq[]
  readonly error?: string
}

export function toolGroupFingerprint(input: ToolGroupFingerprintInput): string {
  const canonical = JSON.stringify({
    lifecycle: input.lifecycle,
    sourceSeqs: [...input.sourceSeqs],
    callIds: [...input.callIds],
    eventTypes: [...input.eventTypes],
    contentDigest: input.contentDigest,
    schemaVersion: input.schemaVersion,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export function contentDigest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function openToolGroupAudit(
  requestId: string,
  sessionId: string,
  group: ToolGroup,
  surfaceGeneration: number,
  provider: string,
  model: string,
  fingerprint: string,
  lifecycle: { readonly createdAt: number } = { createdAt: 0 },
): ToolGroupAuditRecord {
  return {
    requestId,
    sessionId,
    lifecycle,
    fingerprint,
    sourceSeqs: [...group.sourceSeqs],
    surfaceGeneration,
    provider,
    model,
    schemaVersion: 1,
    status: 'open',
  }
}

export function finishToolGroupAudit(
  record: ToolGroupAuditRecord,
  status: Exclude<ToolGroupAuditStatus, 'open'>,
  patch: Pick<ToolGroupAuditRecord, 'rawOutput' | 'summary' | 'replacementSeqs' | 'error'> = {},
): ToolGroupAuditRecord {
  if (record.status !== 'open') throw new Error(`tool-group-audit: cannot finish ${record.status} record`)
  return { ...record, ...patch, status }
}

export function successfulAuditFor(
  records: readonly ToolGroupAuditRecord[],
  fingerprint: string,
): ToolGroupAuditRecord | undefined {
  return records.find(record => record.fingerprint === fingerprint && record.status === 'success')
}

export function recoverableOpenAuditFor(
  records: readonly ToolGroupAuditRecord[],
  fingerprint: string,
): ToolGroupAuditRecord | undefined {
  return records.find(record => record.fingerprint === fingerprint && record.status === 'open')
}

/** Whether one durable tool group still permits semantic summarization work. */
export function shouldAttemptToolGroupSummary(
  records: readonly ToolGroupAuditRecord[],
  fingerprint: string,
): boolean {
  if (successfulAuditFor(records, fingerprint) !== undefined) return false
  if (recoverableOpenAuditFor(records, fingerprint) !== undefined) return true
  if (records.some(record => record.fingerprint === fingerprint && record.status === 'fallback')) return false
  const failures = records.filter(record => record.fingerprint === fingerprint && record.status === 'failure').length
  return failures < 2
}

export function assertToolGroupCommitStable(
  sessionId: string,
  currentGeneration: number,
  currentSourceSeqs: readonly SessionSeq[],
  record: ToolGroupAuditRecord,
): void {
  if (record.sessionId !== sessionId) throw new Error('tool-group-audit: session lifecycle changed')
  if (record.surfaceGeneration !== currentGeneration) throw new Error('tool-group-audit: surface generation changed')
  if (record.sourceSeqs.length !== currentSourceSeqs.length
    || record.sourceSeqs.some((seq, index) => seq !== currentSourceSeqs[index])) {
    throw new Error('tool-group-audit: source surface changed')
  }
}
