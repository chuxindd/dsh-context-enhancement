/**
 * Recent-result hard limit (`hardLimitChars`) coverage.
 *
 * The three-zone engine hands the deterministic pruner an explicit
 * `olderRange` (the tool zone) plus provenance-derived candidates, so a tool
 * result inside the protected recent region is normally left at high fidelity.
 * `hardLimitChars` is the one opt-in exception: an exceptionally large recent
 * result is still bounded, because leaving it raw is exactly what keeps a
 * high-pressure session above the threshold. This spec pins that exception,
 * its shadow-price protocol, and the fact that a recent result between
 * `thresholdChars` and `hardLimitChars` stays untouched.
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { ToolResultPruner } from '../src/tool-result-pruner.ts'
import { resolveConfig } from '../src/internal/compaction/pruner-config.ts'

const SURFACE = { surfaceOp: 'append' as const }
const THRESHOLD = 64
const HARD_LIMIT = 200

function pruner(hardLimitChars?: number): ToolResultPruner {
  return Object.assign(Object.create(ToolResultPruner.prototype) as ToolResultPruner, {
    config: resolveConfig({
      thresholdChars: THRESHOLD,
      headChars: 8,
      tailChars: 8,
      ...hardLimitChars === undefined ? {} : { hardLimitChars },
    }),
    ctx: { tokenMeter: { estimateMessage: () => 7 } },
  })
}

function addToolStep(session: Session, step: number, callId: string, text: string): SessionSeq {
  session.append('assistant/message', {
    turn: 1,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
  return session.append('tool/result', {
    turn: 1,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, SURFACE).seq
}

/** user prompt, then `old` (inside the older span) and two recent results. */
function sessionWithRecentResults(id: string): {
  session: Session
  old: SessionSeq
  middle: SessionSeq
  huge: SessionSeq
} {
  const session = Session.create(SessionId(id))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: { kind: 'user' },
  }), SURFACE)
  const old = addToolStep(session, 1, 'old', 'o'.repeat(THRESHOLD + 20))
  // Between the ordinary threshold and the hard limit: recent, so it must stay raw.
  const middle = addToolStep(session, 2, 'middle', 'm'.repeat(THRESHOLD + 30))
  const huge = addToolStep(session, 3, 'huge', 'h'.repeat(HARD_LIMIT + 200))
  return { session, old, middle, huge }
}

describe('recent-result hard limit', () => {
  it('bounds only the recent result above hardLimitChars and leaves the rest raw', () => {
    const { session, old, middle, huge } = sessionWithRecentResults('recent-hard-limit')
    const pruned = pruner(HARD_LIMIT).pruneSession(session, { olderRange: { start: old, end: old } })

    // `old` is inside the older span (ordinary threshold); `huge` is recent but
    // above the hard limit; `middle` is recent and below the hard limit.
    expect(pruned.pruned.map(entry => entry.originalSeq)).toEqual([old, huge])
    expect(pruned.pruned.map(entry => entry.charsBefore)).toEqual([THRESHOLD + 20, HARD_LIMIT + 200])
    for (const entry of pruned.pruned) {
      expect(entry.charsAfter).toBeLessThan(entry.charsBefore)
      expect(entry.charsAfter).toBeLessThanOrEqual(THRESHOLD)
      // Shadow-price protocol: the metering event is synchronously adjacent and
      // cites exactly the shadowed node, so replay folds can subtract its price.
      const price = session.eventAt((entry.replacementSeq - 1) as SessionSeq)
      expect(price?.type).toBe('compaction/prune')
      if (price?.type !== 'compaction/prune') throw new Error('expected a shadow-price event')
      expect(price.data.shadowedSeqs).toEqual([entry.originalSeq])
      expect(price.data.shadowedTokenCount).toBe(7)
      const replacement = session.eventAt(entry.replacementSeq) as
        | { sourceEventSeqs?: readonly SessionSeq[] }
        | undefined
      expect(replacement?.sourceEventSeqs).toEqual([entry.originalSeq])
    }
    // The protected recent result below the hard limit keeps its exact content.
    const middleEvent = session.eventAt(middle)
    expect(middleEvent?.type).toBe('tool/result')
    if (middleEvent?.type !== 'tool/result') throw new Error('expected the recent result')
    expect(middleEvent.data.message.content[0]!.content).toEqual([
      { type: 'text', text: 'm'.repeat(THRESHOLD + 30) },
    ])
    expect(session.eventAt(middle)?.seq).toBe(middle)
  })

  it('leaves every recent result raw when no hard limit is configured', () => {
    const { session, old, huge } = sessionWithRecentResults('recent-hard-limit-off')
    const pruned = pruner().pruneSession(session, { olderRange: { start: old, end: old } })
    expect(pruned.pruned.map(entry => entry.originalSeq)).toEqual([old])
    // The huge recent result is untouched: the opt-in limit is the only path
    // that may reduce a recent result.
    const hugeEvent = session.eventAt(huge)
    expect(hugeEvent?.type).toBe('tool/result')
    if (hugeEvent?.type !== 'tool/result') throw new Error('expected the recent result')
    expect(hugeEvent.data.message.content[0]!.content).toEqual([
      { type: 'text', text: 'h'.repeat(HARD_LIMIT + 200) },
    ])
  })
})
