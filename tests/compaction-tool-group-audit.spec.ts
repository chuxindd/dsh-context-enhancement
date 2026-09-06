import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { assertToolGroupCommitStable, contentDigest, finishToolGroupAudit, openToolGroupAudit, recoverableOpenAuditFor, successfulAuditFor, toolGroupFingerprint } from '../src/internal/compaction/tool-group-audit.ts'
import type { ToolGroup } from '../src/internal/compaction/tool-groups.ts'

const group: ToolGroup = {
  sourceSeqs: [SessionSeq(2), SessionSeq(3)],
  toolResultSeqs: [SessionSeq(3)],
  callIds: ['c1'],
  startSeq: SessionSeq(2),
  endSeq: SessionSeq(3),
  estimatedTokens: 100,
  startPosition: 0,
  endPosition: 1,
  turn: 1,
}

describe('tool group audit helpers', () => {
  it('creates stable fingerprints and prevents duplicate success work', () => {
    const fingerprint = toolGroupFingerprint({ lifecycle: { sessionId: 's' }, sourceSeqs: group.sourceSeqs, callIds: group.callIds, eventTypes: ['assistant/message', 'tool/result'], contentDigest: contentDigest(['a', 'b']), schemaVersion: 1 })
    const record = openToolGroupAudit('r', 's', group, 2, 'p', 'm', fingerprint)
    expect(recoverableOpenAuditFor([record], fingerprint)).toBe(record)
    const success = finishToolGroupAudit(record, 'success', { replacementSeqs: [SessionSeq(8)] })
    expect(successfulAuditFor([success], fingerprint)).toBe(success)
    expect(() => finishToolGroupAudit(success, 'success')).toThrow(/cannot finish/)
  })

  it('rejects changed lifecycle, generation, or source surface', () => {
    const record = openToolGroupAudit('r', 's', group, 2, 'p', 'm', 'f')
    expect(() => assertToolGroupCommitStable('other', 2, group.sourceSeqs, record)).toThrow(/lifecycle/)
    expect(() => assertToolGroupCommitStable('s', 3, group.sourceSeqs, record)).toThrow(/generation/)
    expect(() => assertToolGroupCommitStable('s', 2, [SessionSeq(9), SessionSeq(3)], record)).toThrow(/source surface/)
  })
})
