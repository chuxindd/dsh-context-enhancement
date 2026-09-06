import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import { isIsolatedOldSummaryRange } from '../src/internal/compaction/selection-guard.ts'

const SURFACE = { surfaceOp: 'append' as const }
const SYSTEM_PROMPT_SOURCE = '@deepseek-ai/dsh-system-prompt'

/** Append an ordinary direct-human user prompt and return its node seq. */
function userPrompt(session: Session, text = 'hello'): SessionSeqType {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), SURFACE).seq
}

/** Append a plugin-owned non-snapshot injected notice (another non-tool surface node). */
function injectedContext(session: Session, plugin: string, text = 'notice'): SessionSeqType {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  }), SURFACE).seq
}

/** Append the durable runtime-context snapshot the system-prompt projection emits. */
function runtimeContext(session: Session, text = 'Current runtime context: ...'): SessionSeqType {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: SYSTEM_PROMPT_SOURCE, form: 'snapshot', sections: [] },
  }), SURFACE).seq
}

/** Land one compaction checkpoint over the current inclusive surface range; returns its node seq. */
function compactRange(session: Session, start: SessionSeqType, end: SessionSeqType, compactionId = CompactionId('c')): SessionSeqType {
  const nodes = [...session.surface.nodes]
  const shadowedSeqs = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1)
  const startEvent = session.append('compaction/start', { compactionId, turn: null })
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text' as const, text: 'summary' }],
    shadowedRange: { start, end },
    shadowedSeqs,
    shadowedTokenCount: 0,
    provider: 'mock',
    model: 'mock',
  })
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'summary' }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  }).seq
}

function currentSurfaceSeqs(session: Session): SessionSeqType[] {
  return [...session.surface.nodes]
}

describe('isolated-old-summary empty-benefit guard (ported coverage)', () => {
  it('rejects an isolated head of consecutive old summaries', () => {
    const session = Session.create(SessionId('ported-consecutive-summaries'))
    const first = userPrompt(session, 'first era')
    compactRange(session, first, first)
    // A later era compacts to a second checkpoint sitting beside the first.
    const later = userPrompt(session, 'second era')
    compactRange(session, later, later, CompactionId('c2'))
    const seqs = currentSurfaceSeqs(session)
    expect(seqs).toHaveLength(2)
    expect(isIsolatedOldSummaryRange(session, seqs)).toBe(true)
    // A sub-range naming only the two checkpoints is equally isolated.
    expect(isIsolatedOldSummaryRange(session, seqs.slice(0, 2))).toBe(true)
  })

  it('allows an old summary combined with a tool pair or ordinary assistant content', () => {
    const session = Session.create(SessionId('ported-summary-plus-tool'))
    const original = userPrompt(session, 'original')
    const checkpoint = compactRange(session, original, original)
    const assistantSeq = session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: ToolCallId('c1'),
          name: 'bash',
          arguments: '{}',
        }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, SURFACE).seq
    const resultSeq = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      }),
    }, SURFACE).seq
    const seqs = currentSurfaceSeqs(session)
    expect(seqs[0]).toBe(checkpoint)
    expect(seqs[1]).toBe(assistantSeq)
    expect(seqs[2]).toBe(resultSeq)
    expect(isIsolatedOldSummaryRange(session, seqs)).toBe(false)
  })

  it('treats a non-checkpoint plugin context node as any current non-checkpoint node', () => {
    const session = Session.create(SessionId('ported-summary-plus-context'))
    const original = userPrompt(session, 'original')
    const checkpoint = compactRange(session, original, original)
    const injectedSeq = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'file changed' }],
      source: { kind: 'plugin', plugin: 'some-plugin' },
    }), SURFACE).seq
    const seqs = currentSurfaceSeqs(session)
    expect(seqs).toEqual([checkpoint, injectedSeq])
    expect(isIsolatedOldSummaryRange(session, seqs)).toBe(false)
  })

  it('allows an old summary flanked by a runtime snapshot or notice', () => {
    for (const [name, middle] of [
      ['runtime-context snapshot', (session: Session) => runtimeContext(session, 'context changed')],
      ['injected plugin notice', (session: Session) => injectedContext(session, 'some-plugin', 'notice')],
    ] as const) {
      const session = Session.create(SessionId(`ported-summary-${name.replaceAll(' ', '-')}`))
      const firstEra = userPrompt(session, 'first era')
      const firstCheckpoint = compactRange(session, firstEra, firstEra)
      const mid = middle(session)
      const secondEra = userPrompt(session, 'second era')
      const secondCheckpoint = compactRange(session, secondEra, secondEra, CompactionId('c2'))
      const seqs = currentSurfaceSeqs(session)
      expect(seqs).toEqual([firstCheckpoint, mid, secondCheckpoint])
      // The whole sandwich holds a current non-checkpoint node, so it is not isolated.
      expect(isIsolatedOldSummaryRange(session, seqs)).toBe(false)
    }
  })

  it('requires a summary to be a surface replacement, matching the invariant recognition', () => {
    const session = Session.create(SessionId('ported-appended-checkpoint-marker'))
    const original = userPrompt(session, 'original work')
    // A user message carrying the checkpoint marker but APPENDED (no shadowed
    // range) is not a compaction replacement and must not count as an old summary.
    const marker = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'not a real replacement' }],
      source: compactCheckpointSource(CompactionId('append-only')),
    }), SURFACE).seq
    expect(session.surface.nodes).toEqual([original, marker])
    expect(isIsolatedOldSummaryRange(session, [marker])).toBe(false)
  })

  it('rejects out-of-order, sparse, and duplicated candidate spans loudly', () => {
    const session = Session.create(SessionId('ported-invalid-spans'))
    const first = userPrompt(session, 'one')
    const second = userPrompt(session, 'two')
    const third = userPrompt(session, 'three')
    const seqs = currentSurfaceSeqs(session)
    expect(seqs).toEqual([first, second, third])
    // Out of surface order.
    expect(() => isIsolatedOldSummaryRange(session, [second, first]))
      .toThrow(/contiguous span of the current surface in surface order/)
    // Sparse: skips a current surface node.
    expect(() => isIsolatedOldSummaryRange(session, [first, third]))
      .toThrow(/contiguous span of the current surface in surface order/)
    // Duplicated seq.
    expect(() => isIsolatedOldSummaryRange(session, [first, first]))
      .toThrow(/must not repeat surface seq/)
    expect(() => isIsolatedOldSummaryRange(session, [first, second, second, third]))
      .toThrow(/must not repeat surface seq/)
  })

  it('throws when a candidate seq is absent from the current surface', () => {
    const session = Session.create(SessionId('ported-off-surface-candidate'))
    const original = userPrompt(session, 'original')
    const checkpoint = compactRange(session, original, original)
    // A shadowed prompt is in the log but not on the current surface.
    const shadowed = original
    expect(() => isIsolatedOldSummaryRange(session, [shadowed])).toThrow(/not a current surface node/)
    expect(() => isIsolatedOldSummaryRange(session, [SessionSeq(999)]))
      .toThrow(/surface seq 999 is not a current surface node/)
    // The surviving checkpoint stays a current node and is isolated.
    expect(isIsolatedOldSummaryRange(session, [checkpoint])).toBe(true)
  })

  it('throws when a current surface seq has no matching log event', () => {
    // A fabricated session whose surface names an event the log does not hold
    // exercises the guard's corrupt-surface check directly.
    const missingSeq = SessionSeq(5)
    const session = {
      eventAt: () => undefined,
      surface: { nodes: [missingSeq], replaceGeneration: 0 },
    } as unknown as Session
    expect(() => isIsolatedOldSummaryRange(session, [missingSeq])).toThrow(/no matching session event/)
  })
})
