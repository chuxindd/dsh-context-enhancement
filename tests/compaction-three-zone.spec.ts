import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../src/internal/compaction/config.ts'
import { buildSurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import { partitionSurfaceZones, selectForgetBatch } from '../src/internal/compaction/zones.ts'

const SURFACE = { surfaceOp: 'append' as const }

function addToolStep(session: Session, turn: number, step: number, id: string): void {
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
    message: createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text: `${id} result` }], isError: false }),
  }, SURFACE)
}

function measurement(session: Session, each = 10): TokenMeasurement {
  const nodes = session.surface.nodes.map(seq => ({ seq, tokens: each, heuristicTokens: each }))
  return {
    totalTokens: nodes.length * each,
    surfaceTokens: nodes.length * each,
    nodes,
    logRevision: 0,
    baseline: 0,
    surfaceDeltaTokens: 0,
  } as unknown as TokenMeasurement
}

describe('three-zone positional planning', () => {
  it('uses current surface position rather than numeric sequence order and keeps tool pairs whole', () => {
    const session = Session.create(SessionId('zones-non-monotonic'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'old-tool')
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'middle' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 2, 1, 'recent-tool')

    // Move the old result to a newly appended log sequence while retaining its
    // original surface position. Numeric sort would put it at the newest end.
    const oldResult = session.surface.nodes[2]!
    const event = session.eventAt(oldResult)!
    session.append('tool/result', event.data as never, {
      surfaceOp: { op: 'replace', start: oldResult, end: oldResult },
      sourceEventSeqs: [oldResult],
    })
    const priced = measurement(session)
    const zones = partitionSurfaceZones(session, priced, {
      recentRatio: 0.20,
      forgetBoundaryRatio: 0.50,
      contextWindow: 100,
    })

    expect(zones.recent?.startIndex).toBe(4)
    expect(zones.tool?.startIndex).toBe(1)
    expect(zones.tool?.endIndex).toBe(3)
    expect(zones.forget?.endIndex).toBe(0)
  })

  it('selects one oldest bounded safe forget batch', () => {
    const session = Session.create(SessionId('zones-batch'))
    for (let turn = 1; turn <= 4; turn += 1) {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `u${turn}` }], source: { kind: 'user' } }), SURFACE)
      addToolStep(session, turn, 1, `c${turn}`)
    }
    const priced = measurement(session, 8)
    const zones = partitionSurfaceZones(session, priced, { recentRatio: 0.20, forgetBoundaryRatio: 0.50, contextWindow: 120 })
    const batch = selectForgetBatch(session, priced, zones, { targetBatchTokens: 20, maxBatchTokens: 32 })
    expect(batch).not.toBeNull()
    expect(batch!.startIndex).toBe(0)
    expect(batch!.tokens).toBeLessThanOrEqual(32)
    expect(batch!.endIndex).toBeLessThanOrEqual(zones.forget!.endIndex)
  })
})

describe('three-zone engine scheduling', () => {
  function sessionWithNodes(count: number): Session {
    const session = Session.create(SessionId(`engine-${count}`))
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    for (let index = 0; index < count; index += 1) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `message-${index}` }],
        source: { kind: 'user' },
      }), SURFACE)
    }
    return session
  }

  function engineHarness(session: Session): {
    engine: BasicCompactionEngine
    agent: Agent
    compacted: Array<{ start: SessionSeq; end: SessionSeq }>
  } {
    const compacted: Array<{ start: SessionSeq; end: SessionSeq }> = []
    const tokenMeter = {
      measure(current: Session): TokenMeasurement {
        const nodes = current.surface.nodes.map(seq => ({ seq, tokens: 10, heuristicTokens: 10 }))
        return {
          totalTokens: nodes.length * 10,
          surfaceTokens: nodes.length * 10,
          nodes,
          logRevision: 0,
          baseline: { kind: 'none', tokens: 0 },
          surfaceDeltaTokens: 0,
        } as unknown as TokenMeasurement
      },
      estimateMessage: () => 10,
    }
    const config = resolveConfig({
      recentRatio: 0.2,
      forgetBoundaryRatio: 0.5,
      toolMaintenanceRatio: 0.4,
      forgetMaintenanceRatio: 0.7,
      pressureRatio: 0.8,
      targetBatchTokens: 20,
      maxBatchTokens: 30,
      maxMaintenanceBatches: 1,
      maxPressureBatches: 2,
      toolGroupSummarizer: { enabled: false },
    })
    const fake = {
      config,
      ctx: {
        tokenMeter,
        llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100 } }) },
        get: () => undefined,
      },
      zones: (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) => partitionSurfaceZones(current, priced, {
        recentRatio: spec.retainTokens / spec.contextWindow,
        forgetBoundaryRatio: spec.forgetBoundaryRatio,
        contextWindow: spec.contextWindow,
      }),
      summarizeToolGroups: async () => undefined,
      sourceIndex: (current: Session) => buildSurfaceSourceIndex(current),
      hasPendingToolIntermediateWork: () => false,
      compactRegion: async (start: SessionSeq, end: SessionSeq): Promise<CompactionResult> => {
        compacted.push({ start, end })
        const replacement = session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'summary' }],
          source: { kind: 'user' },
        }), { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [start, end] })
        return {
          compactionId: `test-${compacted.length}` as CompactionResult['compactionId'],
          startSeq: replacement.seq,
          summarySeq: replacement.seq,
          endSeq: replacement.seq,
          summary: [{ type: 'text', text: 'summary' }],
          shadowedRange: { start, end },
          shadowedSeqs: [start, end],
          shadowedTokenCount: 20,
        }
      },
    }
    const agent = { session, options: { provider: 'mock', model: 'model' } } as Agent
    return { engine: fake as unknown as BasicCompactionEngine, agent, compacted }
  }

  it('runs no semantic batch at the 40% tool-maintenance waterline', async () => {
    const session = sessionWithNodes(4)
    const { engine, agent, compacted } = engineHarness(session)
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toEqual([])
  })

  it('runs one oldest forget batch at 70%', async () => {
    const session = sessionWithNodes(7)
    const { engine, agent, compacted } = engineHarness(session)
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toHaveLength(1)
  })

  it('remeasures and selects a fresh second forget range while pressure remains', async () => {
    const session = sessionWithNodes(9)
    const { engine, agent, compacted } = engineHarness(session)
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toHaveLength(2)
    expect(compacted[1]).not.toEqual(compacted[0])
    expect(session.surface.nodes).toHaveLength(7)
  })
})

describe('durable source classification and compatibility', () => {
  it('classifies only audit-confirmed replacements as tool summaries', () => {
    const session = Session.create(SessionId('source-rebuild'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'summary-source')
    const original = session.surface.nodes.at(-1)!
    const event = session.eventAt(original)!
    const replacement = session.append('tool/result', event.data as never, {
      surfaceOp: { op: 'replace', start: original, end: original },
      sourceEventSeqs: [original],
    })
    expect(buildSurfaceSourceIndex(session).entry(replacement.seq).kind).toBe('unknown-replacement')
    expect(buildSurfaceSourceIndex(session, [replacement.seq]).entry(replacement.seq).kind).toBe('tool-summary')
    expect(buildSurfaceSourceIndex(session).isOriginalToolResult(replacement.seq)).toBe(false)
  })

  it('holds tool-summary replacements until a later completed turn', () => {
    const session = Session.create(SessionId('source-reentry'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'summary-source')
    const original = session.surface.nodes.at(-1)!
    const event = session.eventAt(original)!
    const replacement = session.append('tool/result', event.data as never, { surfaceOp: { op: 'replace', start: original, end: original }, sourceEventSeqs: [original] })
    expect(buildSurfaceSourceIndex(session, [replacement.seq]).canCompactHistory(replacement.seq, 1)).toBe(false)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    expect(buildSurfaceSourceIndex(session, [replacement.seq]).canCompactHistory(replacement.seq, 1)).toBe(true)
  })

  it('maps legacy thresholds to pressure and rejects ambiguous legacy/new pairs', () => {
    const config = resolveConfig({ thresholdRatio: 0.81, retainRatio: 0.19 })
    const policy = resolveTargetPolicy(config, { provider: 'mock', model: 'm' })
    const spec = resolveCompactSpec(policy, 1000)
    expect(spec.thresholdTokens).toBe(810)
    expect(spec.retainTokens).toBe(190)
    expect(() => resolveConfig({ thresholdRatio: 0.8, pressureRatio: 0.81 })).toThrow(/conflicts/)
    expect(() => resolveConfig({ retainRatio: 0.2, recentRatio: 0.21 })).toThrow(/conflicts/)
    expect(() => resolveConfig({ retainTokens: 100, recentRatio: 0.2 })).toThrow(/mutually exclusive/)
  })
})
