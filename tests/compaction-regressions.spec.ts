import { describe, expect, it } from 'vitest'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { assertNoActiveCompaction } from '../src/internal/compaction/region.ts'
import { recordsForSession } from '../src/internal/compaction/tool-group-domain.ts'
import { toolGroupFingerprint } from '../src/internal/compaction/tool-group-audit.ts'
import type { ToolGroupAuditRecord } from '../src/internal/compaction/tool-group-audit.ts'

describe('compaction regression contracts', () => {
  it('isolates audit records by lifecycle and ignores legacy rows', () => {
    const base = { sourceSeqs: [SessionSeq(1)], callIds: ['c'], eventTypes: ['tool/result'], contentDigest: 'd', schemaVersion: 1 } as const
    const one = toolGroupFingerprint({ ...base, lifecycle: { sessionId: 's', createdAt: 1 } })
    expect(one).toBe(toolGroupFingerprint({ ...base, lifecycle: { sessionId: 's', createdAt: 1 } }))
    expect(one).not.toBe(toolGroupFingerprint({ ...base, lifecycle: { sessionId: 's', createdAt: 2 } }))
    const records = [
      { sessionId: 's', lifecycle: { createdAt: 1 }, fingerprint: one },
      { sessionId: 's', lifecycle: { createdAt: 2 }, fingerprint: 'other' },
      { sessionId: 's', fingerprint: 'legacy' },
    ]
    expect(records.filter(record => record.sessionId === 's' && record.lifecycle?.createdAt === 1)).toHaveLength(1)
    expect(records.filter(record => record.sessionId === 's' && record.lifecycle?.createdAt === 3)).toHaveLength(0)
    expect(records.filter(record => record.lifecycle?.createdAt === undefined)).toHaveLength(1)
  })

  it('filters audit records by exact lifecycle and ignores legacy rows', () => {
    const records = [
      { sessionId: 's', lifecycle: { createdAt: 1 } },
      { sessionId: 's', lifecycle: { createdAt: 2 } },
      { sessionId: 's' },
    ] as unknown as ToolGroupAuditRecord[]
    expect(recordsForSession(records, 's', 1)).toHaveLength(1)
    expect(recordsForSession(records, 's', 2)).toHaveLength(1)
    expect(recordsForSession(records, 's', 3)).toHaveLength(0)
  })

  it('keeps the durable compaction lock for a mismatched end marker', () => {
    const session = Session.create(SessionId('lock-mismatch'))
    session.append('compaction/start', { compactionId: CompactionId('a'), turn: null })
    session.append('compaction/end', { compactionId: CompactionId('b') } as never)
    expect(() => assertNoActiveCompaction(session, 'regression')).toThrow(/already in progress/)
  })
})
