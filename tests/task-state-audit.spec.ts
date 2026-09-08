import { describe, expect, it } from 'vitest'
import {
  TaskStateRequestId,
  deriveAuditTimeline,
  finishAuditRow,
  highestCertifiedRevision,
  openAuditRow,
  rowsForLifecycle,
  selectRepairRow,
  type TaskStateAuditRecord,
} from '../src/task-state.ts'

/** One pre-dispatch request-evidence payload reused across rows. */
function requestData(revision: number, seqs: number[]) {
  return {
    requestId: TaskStateRequestId(`ts-req-${revision}`),
    revision,
    base: null,
    includedSeqs: seqs,
    filterVersion: 'task-state-basic/filter-v2',
    system: 'update the task state',
    route: { provider: 'deepseek', model: 'deepseek-v4' },
    maxTokens: 4000,
    schema: { version: 1 },
    truncation: [],
  }
}

/** The lifecycle identity all rows of one scenario share. */
const IDENTITY = { createdAt: 1_700_000_000_000, cwd: '/work' }

describe('task-state audit domain (pure, keyless)', () => {
  it('opens one row keyed by request id and attaches at most one finished phase', () => {
    const request = requestData(1, [3, 4])
    const row = openAuditRow(request.requestId, IDENTITY, request, 1000)
    expect(row.requestId).toBe(request.requestId)
    expect(row.session).toEqual(IDENTITY)
    expect(row.request.includedSeqs).toEqual([3, 4])
    expect(row.finished).toBeUndefined()

    const finished: TaskStateAuditRecord['finished'] = {
      outcome: 'success',
      requestId: request.requestId,
      revision: 1,
      sourceCursor: 4,
      llmStreamCall: true,
      rawOutput: [{ type: 'text', text: '{"facts":[]}' }],
      finish: { kind: 'stop' },
    }
    const settled = finishAuditRow(row, finished)
    expect(settled.finished).toEqual(finished)
    // The open phase stays untouched.
    expect(settled.request).toEqual(row.request)
    expect(settled.time).toBe(1000)
  })

  it('derives a deterministic time-ascending timeline with certification facts', () => {
    const r1 = openAuditRow(TaskStateRequestId('a'), IDENTITY, requestData(1, [3]), 3000)
    const r2 = openAuditRow(TaskStateRequestId('b'), IDENTITY, requestData(2, [5]), 1000)
    const settled2 = finishAuditRow(r2, {
      outcome: 'success',
      requestId: r2.requestId,
      revision: 2,
      sourceCursor: 5,
      llmStreamCall: true,
      rawOutput: [{ type: 'text', text: '{}' }],
      finish: { kind: 'stop' },
    })
    const timeline = deriveAuditTimeline([r1, settled2])
    expect(timeline.map(entry => entry.requestId)).toEqual(['b', 'a'])
    expect(timeline[0]?.certified).toBe(true)
    expect(timeline[0]?.certifiedRevision).toBe(2)
    expect(timeline[1]?.certified).toBe(false)
    expect(timeline[1]?.certifiedRevision).toBeUndefined()
  })

  it('highestCertifiedRevision counts model, manual, and repair certifications', () => {
    const ok = openAuditRow(TaskStateRequestId('ok'), IDENTITY, requestData(3, [8]), 100)
    const settledOk = finishAuditRow(ok, {
      outcome: 'success',
      requestId: ok.requestId,
      revision: 3,
      sourceCursor: 8,
      llmStreamCall: true,
      rawOutput: [],
      finish: { kind: 'stop' },
    })
    const failed = openAuditRow(TaskStateRequestId('bad'), IDENTITY, requestData(1, [1]), 200)
    const settledFailed = finishAuditRow(failed, {
      outcome: 'failure',
      requestId: failed.requestId,
      error: { stage: 'parse', code: 'PARSE', message: 'bad json' },
    })
    const open = openAuditRow(TaskStateRequestId('open'), IDENTITY, requestData(4, [9]), 300)
    const manual = openAuditRow(TaskStateRequestId('manual'), IDENTITY, requestData(4, []), 250)
    const settledManual = finishAuditRow(manual, {
      outcome: 'manual',
      requestId: manual.requestId,
      revision: 4,
      sourceCursor: 8,
    })
    expect(highestCertifiedRevision([settledOk, settledFailed, settledManual, open])).toBe(4)
    expect(deriveAuditTimeline([settledManual])[0]).toMatchObject({ certified: true, certifiedRevision: 4 })
  })

  it('selects the single newest open row whose target revision equals the committed one', () => {
    // Two pre-commit retry rows target revision 2 (same window); a third open
    // row targets revision 3 (a later wave). Only the newest rev-2 open row is
    // eligible to certify committed revision 2.
    const older2 = openAuditRow(TaskStateRequestId('r2a'), IDENTITY, requestData(2, [4]), 500)
    const newer2 = openAuditRow(TaskStateRequestId('r2b'), IDENTITY, requestData(2, [4]), 600)
    const later3 = openAuditRow(TaskStateRequestId('r3'), IDENTITY, requestData(3, [6]), 700)
    const picked = selectRepairRow([older2, newer2, later3], 2)
    expect(picked?.requestId).toBe(newer2.requestId)
    // A committed revision with no matching open row yields undefined.
    expect(selectRepairRow([older2, newer2, later3], 5)).toBeUndefined()
    // An already-finished row is never re-selected.
    const finished2 = finishAuditRow(newer2, {
      outcome: 'failure',
      requestId: newer2.requestId,
      error: { stage: 'stream', code: 'TRANSIENT_LLM', message: 'retry' },
    })
    expect(selectRepairRow([older2, finished2, later3], 2)?.requestId).toBe(older2.requestId)
  })

  it('filters audit rows by one lifecycle identity and leaves mismatches untouched', () => {
    const mine = openAuditRow(TaskStateRequestId('m'), IDENTITY, requestData(1, [1]), 10)
    const other = openAuditRow(
      TaskStateRequestId('o'),
      { createdAt: 1_800_000_000_000, cwd: '/elsewhere' },
      requestData(1, [2]),
      11,
    )
    const kept = rowsForLifecycle([mine, other], IDENTITY)
    expect(kept.map(row => row.requestId)).toEqual([mine.requestId])
  })
})
