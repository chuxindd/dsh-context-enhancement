import { describe, expect, it } from 'vitest'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import type { ToolGroup } from '../src/internal/compaction/tool-groups.ts'
import { replaceToolGroup } from '../src/internal/compaction/tool-group-replacement.ts'
import type { ToolGroupSummary } from '../src/internal/compaction/tool-group-summary.ts'

const SURFACE = { surfaceOp: 'append' as const }
const SHRINK_PRICE = {
  estimateTokens: (message: any) => {
    const block = message.content[0]
    const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
    return text.includes('[tool group summary]') ? 1 : 10
  },
}

function groupSession(id: string): { session: Session; sourceSeqs: SessionSeq[]; group: ToolGroup } {
  const session = Session.create(SessionId(id))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
  const sourceSeqs: SessionSeq[] = []
  for (const [step, callId] of [[1, 'a'], [2, 'b']] as const) {
    session.append('assistant/message', { turn: 1, step, message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: '{}' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, SURFACE)
    sourceSeqs.push(session.append('tool/result', { turn: 1, step, message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: `large ${callId}` }], isError: false }) }, SURFACE).seq)
  }
  const group = selectToolGroups(session, { minGroupResults: 1, minGroupChars: 1, minGroupTokens: 1, maxGroupTokens: 100, estimateTokens: () => 1 })[0]!
  return { session, sourceSeqs, group }
}

function summaryFor(group: ToolGroup): ToolGroupSummary {
  return {
    version: 1,
    groupSummary: 'done',
    items: group.toolResultSeqs.map(sourceSeq => ({ sourceSeq, callId: 'a', summary: 'done', facts: [], files: [], identifiers: [], errors: [], unresolved: [] })),
    groupErrors: [],
    unresolved: [],
  }
}

describe('tool group replacement', () => {
  it('validates every target before appending replacements', () => {
    const { session, group } = groupSession('group-replacement-preflight')
    const before = session.seq
    expect(() => replaceToolGroup(session, { ...group, toolResultSeqs: [group.toolResultSeqs[0]!, 999 as never] }, summaryFor(group), SHRINK_PRICE)).toThrow(/no longer a tool result/)
    // No replacement and no shadow-price event may land on a rejected pass.
    expect(session.seq).toBe(before)
  })

  it('replaces each result while preserving pairing and source events', () => {
    const { session, sourceSeqs, group } = groupSession('group-replacement')
    const result = replaceToolGroup(session, group, summaryFor(group), SHRINK_PRICE)
    expect(result.replacementSeqs).toHaveLength(2)
    expect(session.surface.nodes.some(seq => result.replacementSeqs.includes(seq))).toBe(true)
    expect(session.eventAt(sourceSeqs[0]!)?.type).toBe('tool/result')
    expect(session.eventAt(result.replacementSeqs[0]!)?.type).toBe('tool/result')
    expect(session.surface.replaceGeneration).toBeGreaterThan(0)
  })

  it('logs one priced shadow-price event immediately before each replacement', () => {
    const { session, sourceSeqs, group } = groupSession('group-replacement-shadow-price')
    const priced: string[] = []
    const result = replaceToolGroup(session, group, summaryFor(group), {
      estimateTokens: message => {
        const callId = String(message.source.callId)
        priced.push(callId)
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        const isSummary = text.includes('[tool group summary]')
        if (callId === 'a') return isSummary ? 5 : 11
        return isSummary ? 10 : 22
      },
    })
    // The logged price describes the SHADOWED node, so the estimator is applied
    // to the original tool result before it is replaced. The per-node shrink
    // guard then prices the candidate replacement too — it preserves the node's
    // source, so each node is priced twice under the same callId, and a
    // candidate priced above its original never lands.
    expect(priced).toEqual(['a', 'a', 'b', 'b'])
    expect(result.replacementSeqs).toHaveLength(2)
    result.replacementSeqs.forEach((replacementSeq, index) => {
      const price = session.eventAt((replacementSeq - 1) as SessionSeq)
      if (price?.type !== 'compaction/prune') throw new Error('expected a shadow-price event before the replacement')
      // The official shadow-price fields are exactly what the shared protocol
      // requires; the reduction's own durable provenance is one ADDITIVE key
      // beside them (see `compaction-tool-provenance-replay.spec.ts` for why the
      // replacement itself cannot carry it).
      expect(price.data.shadowedRange).toEqual({ start: sourceSeqs[index], end: sourceSeqs[index] })
      expect(price.data.shadowedSeqs).toEqual([sourceSeqs[index]])
      expect(price.data.shadowedTokenCount).toBe(index === 0 ? 11 : 22)
      expect(Object.keys(price.data).sort())
        .toEqual(['provenance', 'shadowedRange', 'shadowedSeqs', 'shadowedTokenCount'])
      const provenance = (price.data as unknown as { provenance: { kind: string; coveredSeqs: readonly SessionSeq[] } }).provenance
      expect(provenance.kind).toBe('tool-summary')
      expect(provenance.coveredSeqs).toEqual([sourceSeqs[index]])
      const landed = session.eventAt(replacementSeq)
      if (landed === undefined || !isReplacementSurfaceEvent(landed)) throw new Error('expected a surface replacement')
      expect(landed.sourceEventSeqs).toEqual([sourceSeqs[index]])
    })
  })

  it('does not land equal-price replacements and never writes events or calls onLanded', () => {
    const { session, group } = groupSession('group-replacement-equal')
    const beforeSeq = session.seq
    const landed: SessionSeq[] = []
    const result = replaceToolGroup(session, group, summaryFor(group), {
      estimateTokens: () => 5, // Equal price for original and replacement
      onLanded: seq => landed.push(seq),
    })
    expect(result.replacementSeqs).toEqual([])
    expect(landed).toEqual([])
    // No compaction/prune and no replacement landed
    expect(session.seq).toBe(beforeSeq)
  })

  it('does not land greater-than priced replacements and never writes events or calls onLanded', () => {
    const { session, group } = groupSession('group-replacement-greater')
    const beforeSeq = session.seq
    const landed: SessionSeq[] = []
    const result = replaceToolGroup(session, group, summaryFor(group), {
      estimateTokens: message => {
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        return text.includes('[tool group summary]') ? 20 : 10 // Replacement is MORE expensive
      },
      onLanded: seq => landed.push(seq),
    })
    expect(result.replacementSeqs).toEqual([])
    expect(landed).toEqual([])
    expect(session.seq).toBe(beforeSeq)
  })

  it('lands strictly smaller replacements with shadow-price and calls onLanded', () => {
    const { session, group } = groupSession('group-replacement-smaller')
    const landed: SessionSeq[] = []
    const result = replaceToolGroup(session, group, summaryFor(group), {
      estimateTokens: message => {
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        return text.includes('[tool group summary]') ? 3 : 10 // Replacement is strictly smaller
      },
      onLanded: seq => landed.push(seq),
    })
    expect(result.replacementSeqs).toHaveLength(2)
    expect(landed).toEqual([...result.replacementSeqs])
  })
})
