import { describe, expect, it } from 'vitest'
import { ToolCallId, createAssistantMessage, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import type { ToolGroup } from '../src/internal/compaction/tool-groups.ts'
import { replaceToolGroup } from '../src/internal/compaction/tool-group-replacement.ts'
import type { ToolGroupSummary } from '../src/internal/compaction/tool-group-summary.ts'
import { buildSurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'

const SURFACE = { surfaceOp: 'append' as const }

function toolStep(session: Session, turn: number, step: number, id: string, text: string): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(id), name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
  session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(id),
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, SURFACE)
}

function userPrompt(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: { kind: 'user' },
  }), SURFACE)
}

function parallelToolStep(session: Session, turn: number, step: number, ids: readonly string[], text: string): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: ids.map(id => ({ type: 'tool-call' as const, id: ToolCallId(id), name: 'bash', arguments: '{}' })),
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
  for (const id of ids) {
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({
        callId: ToolCallId(id),
        content: [{ type: 'text', text }],
        isError: false,
      }),
    }, SURFACE)
  }
}

function summaryFor(group: ToolGroup): ToolGroupSummary {
  return {
    version: 1,
    groupSummary: 'done',
    items: group.toolResultSeqs.map(sourceSeq => ({
      sourceSeq, summary: 'done', facts: [], files: [], identifiers: [], errors: [], unresolved: [],
    })),
    groupErrors: [],
    unresolved: [],
  }
}

function assistantReply(session: Session, turn: number, step: number): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'interruption' }],
      source: { provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
}

describe('tool group selection', () => {
  it('selects only complete groups inside the older surface range', () => {
    const session = Session.create(SessionId('groups-older-range'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', 'a'.repeat(7_000))
    assistantReply(session, 1, 2)
    toolStep(session, 1, 3, 'b', 'b'.repeat(7_000))
    const nodes = [...session.surface.nodes]
    const groups = selectToolGroups(session, {
      olderRange: { start: nodes[0]!, end: nodes[2]! },
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 100_000,
      estimateTokens: () => 1_500,
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.toolResultSeqs).toHaveLength(1)
    expect(groups[0]!.endSeq).toBe(nodes[2])
  })

  it('uses surface positions rather than numeric seq ordering', () => {
    const session = Session.create(SessionId('groups-non-monotonic'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', 'a'.repeat(7_000))
    const firstRange = [...session.surface.nodes]
    assistantReply(session, 1, 2)
    toolStep(session, 1, 3, 'b', 'b'.repeat(7_000))
    const nodes = [...session.surface.nodes]
    const groups = selectToolGroups(session, {
      olderRange: { start: firstRange[1]!, end: firstRange[2]! },
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 100_000,
      estimateTokens: () => 1_500,
    })
    expect(groups[0]!.startPosition).toBe(1)
    expect(groups[0]!.endPosition).toBe(2)
    expect(nodes.indexOf(groups[0]!.startSeq)).toBe(1)
  })

  it('does not select a small group or a group above the token cap', () => {
    const session = Session.create(SessionId('groups-thresholds'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', 'small')
    toolStep(session, 1, 2, 'b', 'small')
    expect(selectToolGroups(session, { minGroupChars: 100, minGroupTokens: 1, maxGroupTokens: 10, estimateTokens: () => 6 })).toEqual([])
  })

  it('splits an oversized related run at safe step boundaries instead of dropping it', () => {
    const session = Session.create(SessionId('groups-oversized-split'))
    userPrompt(session)
    for (const [index, id] of ['a', 'b', 'c'].entries()) toolStep(session, 1, index + 1, id, 'x'.repeat(5_000))
    const groups = selectToolGroups(session, {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 12_000,
      maxGroups: 5,
      estimateTokens: () => 6_000,
    })
    // The run is 6 nodes / 36k tokens, far above the 12k cap. It must split into
    // one step-aligned chunk per tool step, each keeping its call with its
    // result, instead of the whole run being dropped as un-summarizable.
    expect(groups).toHaveLength(3)
    expect(groups.every(group => group.estimatedTokens === 12_000)).toBe(true)
    expect(groups.every(group => group.sourceSeqs.length === 2)).toBe(true)
    expect(groups.every(group => group.toolResultSeqs.length === 1)).toBe(true)
    const nodes = [...session.surface.nodes]
    expect(groups.map(group => nodes.indexOf(group.startSeq))).toEqual([1, 3, 5])
    expect(groups.map(group => nodes.indexOf(group.endSeq))).toEqual([2, 4, 6])
  })

  it('keeps an over-cap chunk raw when no safe step cut exists', () => {
    const session = Session.create(SessionId('groups-oversized-unsplittable'))
    userPrompt(session)
    // One step with a single call/result pair: the only interior cut would split
    // the pair, so the run stays one over-cap chunk and is rejected.
    toolStep(session, 1, 1, 'a', 'x'.repeat(20_000))
    expect(selectToolGroups(session, {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 5_000,
      maxGroups: 5,
      estimateTokens: () => 6_000,
    })).toEqual([])
  })

  it('keeps a fittable prefix when the cap overflow lands inside a later step', () => {
    const session = Session.create(SessionId('groups-oversized-prefix'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', 'x'.repeat(5_000))
    toolStep(session, 1, 2, 'b', 'x'.repeat(5_000))
    const groups = selectToolGroups(session, {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 12_000,
      maxGroups: 5,
      estimateTokens: event => event.type === 'tool/result' ? 11_000 : 100,
    })
    // Each step costs 100 + 11_000 = 11_100 and fits the 12_000 cap, but the run
    // costs 22_200 and must split. A running accumulator only looks for a cut
    // when the SECOND step's result arrives, where no safe cut exists (its call
    // is open), so it emitted one 22_200-token chunk that was rejected and lost
    // the fittable first step entirely. Both steps must be selected instead,
    // each keeping its call with its result.
    expect(groups).toHaveLength(2)
    expect(groups.map(group => group.estimatedTokens)).toEqual([11_100, 11_100])
    expect(groups.every(group => group.sourceSeqs.length === 2)).toBe(true)
    expect(groups.every(group => group.toolResultSeqs.length === 1)).toBe(true)
    const nodes = [...session.surface.nodes]
    expect(groups.map(group => nodes.indexOf(group.startSeq))).toEqual([1, 3])
    expect(groups.map(group => nodes.indexOf(group.endSeq))).toEqual([2, 4])
  })

  it('keeps fittable siblings selectable around an over-cap step', () => {
    const session = Session.create(SessionId('groups-oversized-middle-step'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', 'x'.repeat(5_000))
    parallelToolStep(session, 1, 2, ['b', 'c'], 'x'.repeat(5_000))
    toolStep(session, 1, 3, 'd', 'x'.repeat(5_000))
    const groups = selectToolGroups(session, {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 12_000,
      maxGroups: 5,
      estimateTokens: event => event.type === 'tool/result' ? 11_000 : 100,
    })
    // Step 2 alone costs 100 + 2 x 11_000 = 22_100, over the cap and impossible
    // to cut (one step, parallel results stay together). It must stay raw
    // WITHOUT swallowing the fittable steps on either side of it.
    expect(groups).toHaveLength(2)
    expect(groups.map(group => group.estimatedTokens)).toEqual([11_100, 11_100])
    const nodes = [...session.surface.nodes]
    expect(groups.map(group => nodes.indexOf(group.startSeq))).toEqual([1, 6])
    expect(groups.map(group => nodes.indexOf(group.endSeq))).toEqual([2, 7])
    expect(groups.some(group => group.sourceSeqs.includes(nodes[3]!))).toBe(false)
  })

  it('keeps raw siblings selectable when a partial summary leaves a mixed run', () => {
    const session = Session.create(SessionId('groups-mixed-partial-summary'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', 'x'.repeat(5_000))
    toolStep(session, 1, 2, 'b', 'x'.repeat(5_000))
    // Each step costs 2_100, so the whole run stays under the 12_000 cap and is
    // always one span: selection never reaches the oversized-split path here.
    const options = {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 12_000,
      maxGroups: 5,
      estimateTokens: (event: SessionEvent) => event.type === 'tool/result' ? 2_000 : 100,
    }
    const firstPass = selectToolGroups(session, options)
    expect(firstPass).toHaveLength(1)
    const shrinkPrice = {
      estimateTokens: (message: any) => {
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        return text.includes('[tool group summary]') ? 1 : 10
      },
    }
    const replacement = replaceToolGroup(session, firstPass[0]!, summaryFor(firstPass[0]!), shrinkPrice)
    expect(replacement.replacementSeqs).toHaveLength(2)
    // Steps 3-4 join the SAME turn after that summary, so one run now holds two
    // replaced results followed by two raw ones. Offering that mixed run as one
    // group makes the caller skip it (it is not all-original) and strands steps
    // 3-4 forever; the raw steps must stay selectable on their own.
    toolStep(session, 1, 3, 'c', 'x'.repeat(5_000))
    toolStep(session, 1, 4, 'd', 'x'.repeat(5_000))
    const sources = buildSurfaceSourceIndex(session, replacement.replacementSeqs)
    const groups = selectToolGroups(session, {
      ...options,
      isEligibleResult: seq => sources.isOriginalToolResult(seq),
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.toolResultSeqs).toHaveLength(2)
    expect(groups[0]!.toolResultSeqs.every(seq => sources.isOriginalToolResult(seq))).toBe(true)
    expect(groups[0]!.sourceSeqs).not.toContain(replacement.replacementSeqs[0]!)
    expect(groups[0]!.estimatedTokens).toBe(4_200)
    const nodes = [...session.surface.nodes]
    expect(nodes.indexOf(groups[0]!.startSeq)).toBe(5)
    expect(nodes.indexOf(groups[0]!.endSeq)).toBe(8)
  })

  it('filters an all-replaced chunk out of an oversized partially summarized run', () => {
    const session = Session.create(SessionId('groups-mixed-oversized'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', 'x'.repeat(5_000))
    toolStep(session, 1, 2, 'b', 'x'.repeat(5_000))
    const options = {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 12_000,
      maxGroups: 5,
      estimateTokens: (event: SessionEvent) => event.type === 'tool/result' ? 4_000 : 100,
    }
    const firstPass = selectToolGroups(session, options)
    expect(firstPass).toHaveLength(1)
    const shrinkPrice = {
      estimateTokens: (message: any) => {
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        return text.includes('[tool group summary]') ? 1 : 10
      },
    }
    const replacement = replaceToolGroup(session, firstPass[0]!, summaryFor(firstPass[0]!), shrinkPrice)
    // Steps 3-4 push the run to 16_400, over the cap, so the oversized split now
    // yields an all-replaced 8_200-token chunk and an all-raw 8_200-token chunk.
    // The replaced chunk must be filtered out instead of consuming a selection
    // slot, and the raw chunk must still be selected.
    toolStep(session, 1, 3, 'c', 'x'.repeat(5_000))
    toolStep(session, 1, 4, 'd', 'x'.repeat(5_000))
    const sources = buildSurfaceSourceIndex(session, replacement.replacementSeqs)
    const groups = selectToolGroups(session, {
      ...options,
      isEligibleResult: seq => sources.isOriginalToolResult(seq),
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.estimatedTokens).toBe(8_200)
    expect(groups[0]!.toolResultSeqs.every(seq => sources.isOriginalToolResult(seq))).toBe(true)
    expect(groups[0]!.sourceSeqs).not.toContain(replacement.replacementSeqs[0]!)
    const nodes = [...session.surface.nodes]
    expect(nodes.indexOf(groups[0]!.startSeq)).toBe(5)
    expect(nodes.indexOf(groups[0]!.endSeq)).toBe(8)
  })
})
