import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../src/internal/compaction/config.ts'
import { buildSurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import { partitionSurfaceZones, planForgetBatch, selectForgetBatch } from '../src/internal/compaction/zones.ts'

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

  it('reports an oversized oldest complete unit instead of silently returning no range', () => {
    const session = Session.create(SessionId('zones-oversized'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'oversized' }], source: { kind: 'user' } }), SURFACE)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'middle' }], source: { kind: 'user' } }), SURFACE)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'recent' }], source: { kind: 'user' } }), SURFACE)
    const priced = measurement(session, 30)
    const zones = partitionSurfaceZones(session, priced, { recentRatio: 0.20, forgetBoundaryRatio: 0.50, contextWindow: 100 })
    expect(planForgetBatch(session, priced, zones, { targetBatchTokens: 20, maxBatchTokens: 24 })).toEqual({
      kind: 'blocked',
      reason: 'oldest-unit-too-large',
    })
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

  function engineHarness(session: Session, overrides: Partial<Parameters<typeof resolveConfig>[0]> = {}): {
    engine: BasicCompactionEngine
    agent: Agent
    compacted: Array<{ start: SessionSeq; end: SessionSeq }>
    stops: string[]
  } {
    const compacted: Array<{ start: SessionSeq; end: SessionSeq }> = []
    const stops: string[] = []
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
      ...overrides,
    })
    const fake = {
      config,
      ctx: {
        tokenMeter,
        llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100 } }) },
        get: () => undefined,
        logger: { warn: () => undefined },
      },
      zones: (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) => partitionSurfaceZones(current, priced, {
        recentRatio: spec.retainTokens / spec.contextWindow,
        forgetBoundaryRatio: spec.forgetBoundaryRatio,
        contextWindow: spec.contextWindow,
      }),
      summarizeToolGroups: async () => undefined,
      sourceIndex: (current: Session) => buildSurfaceSourceIndex(current),
      hasPendingToolIntermediateWork: () => false,
      logPressureStop: (reason: string) => { stops.push(reason) },
      compactRegion: async (start: SessionSeq, end: SessionSeq): Promise<CompactionResult> => {
        compacted.push({ start, end })
        const nodes = session.surface.nodes
        const shadowedSeqs = nodes.slice(
          nodes.indexOf(start),
          nodes.indexOf(end) + 1,
        )
        const replacement = session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'summary' }],
          source: { kind: 'user' },
        }), { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [...shadowedSeqs] })
        return {
          compactionId: `test-${compacted.length}` as CompactionResult['compactionId'],
          startSeq: replacement.seq,
          summarySeq: replacement.seq,
          endSeq: replacement.seq,
          summary: [{ type: 'text', text: 'summary' }],
          shadowedRange: { start, end },
          shadowedSeqs,
          shadowedTokenCount: shadowedSeqs.length * 10,
        }
      },
    }
    const agent = { session, options: { provider: 'mock', model: 'model' } } as Agent
    return { engine: fake as unknown as BasicCompactionEngine, agent, compacted, stops }
  }

  it('runs no semantic batch at the 40% tool-maintenance waterline', async () => {
    const session = sessionWithNodes(4)
    const { engine, agent, compacted } = engineHarness(session)
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toEqual([])
  })

  it('runs one maintenance forget batch at the 70% waterline', async () => {
    const session = sessionWithNodes(7)
    const { engine, agent, compacted } = engineHarness(session)
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // 7 * 10 = 70 tokens, forgetWatermark = floor(100 * 0.70) = 70, below
    // pressure (80): the bounded maintenance tier runs at most
    // maxMaintenanceBatches (1) batch and returns.
    expect(compacted).toHaveLength(1)
    expect(session.surface.nodes.length).toBe(6)
  })

  it('keeps the 70% maintenance tier bounded by the batch planner when the forget zone exceeds the budget', async () => {
    const session = sessionWithNodes(7)
    const { engine, agent, compacted } = engineHarness(session, {
      targetBatchTokens: 10,
      maxBatchTokens: 10,
    })
    const beforeNodes = [...session.surface.nodes]
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // Forget zone = tokens [0, forgetStart): forgetBoundaryTokens = 50 with the
    // 5 newest nodes retained, so the oldest 2 nodes (20 tokens) form the forget
    // zone — larger than the 10-token batch cap. Maintenance still selects only
    // the oldest bounded batch (one 10-token node), never the whole zone.
    expect(compacted).toHaveLength(1)
    expect(compacted[0]!.start).toBe(beforeNodes[0])
    expect(compacted[0]!.end).toBe(beforeNodes[0])
  })

  it('stops overflow at the forget guard instead of entering younger zones', async () => {
    const session = sessionWithNodes(12)
    const { engine, agent, compacted } = engineHarness(session)
    await (BasicCompactionEngine.prototype as unknown as { recoverOverflow: Function }).recoverOverflow.call(engine, agent, undefined, new AbortController().signal)
    expect(compacted.length).toBeLessThanOrEqual(2)
    expect(compacted.every(entry => session.surface.nodes.indexOf(entry.start) < 6)).toBe(true)
  })

  it('compacts the complete forget zone in ONE call when pressure is reached, ignoring the batch cap', async () => {
    const session = sessionWithNodes(12)
    const { engine, agent, compacted } = engineHarness(session)
    // 12 * 10 = 120 >= pressure 80. forgetBoundaryTokens = floor(100*0.5) = 50;
    // the 5 newest nodes hold the 50-token boundary so forget = the oldest 7
    // nodes (70 tokens), which far exceeds maxBatchTokens (30). Pressure must
    // still select that complete zone once instead of chopping it into batches.
    const beforeNodes = [...session.surface.nodes]
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toHaveLength(1)
    expect(compacted[0]!.start).toBe(beforeNodes[0])
    expect(compacted[0]!.end).toBe(beforeNodes[6])
    // One replacement collapsed 7 nodes into 1: 6 nodes remain, comfortably
    // below the 8-node pressure threshold and well under the old "60%" regret.
    expect(session.surface.nodes.length).toBe(6)
  })

  it('whole-zone pressure folds a tool summary produced by an EARLIER invocation once new dialogue grew past it', async () => {
    // Product timeline: an earlier 70% tool-governance pass replaced the raw
    // tool result with a durable audit-confirmed tool summary while that head
    // sat inside ITS forget zone. More dialogue then accumulated in the same
    // turn (no turn/end after the replacement yet), pushing the surface to 80%.
    // This LATER pressure invocation must fold that now-historical summary into
    // the one whole-zone semantic compact. The completed-turn deferral exists to
    // keep a replacement younger than the newest request; a replacement inside
    // the current forget zone necessarily has newer surface content after it and
    // is therefore historical, regardless of turn/end boundaries.
    const session = Session.create(SessionId('engine-reentry-aged'))
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    // Surface order: user(0), then one tool step (call at 1, result at 2), then
    // 9 more user messages => 12 nodes / 120 tokens >= pressure 80. The newest 5
    // nodes are retained, so the forget zone covers positions 0..6 and includes
    // the (now replaced) tool result at position 2.
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'message-0' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'guard-tool')
    for (let index = 1; index <= 9; index += 1) {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `message-${index}` }], source: { kind: 'user' } }), SURFACE)
    }
    const toolResultSeq = session.surface.nodes[2]!
    const toolResultEvent = session.eventAt(toolResultSeq)!
    // Land the durable outcome of the earlier 70% governance pass: the raw
    // result is replaced by a tool summary whose provenance the successful audit
    // confirms. It has 0 completed turns after it (the growth happened inside the
    // same turn), so the old completed-turn deferral would have blocked it.
    const replacement = session.append('tool/result', toolResultEvent.data as never, {
      surfaceOp: { op: 'replace', start: toolResultSeq, end: toolResultSeq },
      sourceEventSeqs: [toolResultSeq],
    })
    const harness = engineHarness(session)
    const engine = harness.engine as unknown as {
      sourceIndex: (current: Session) => ReturnType<typeof buildSurfaceSourceIndex>
      logPressureStop: (reason: string) => void
    }
    engine.sourceIndex = (current: Session) => buildSurfaceSourceIndex(current, [replacement.seq])
    const originalLog = engine.logPressureStop
    engine.logPressureStop = (reason: string) => { harness.stops.push(reason); originalLog(reason) }
    const beforeNodes = [...session.surface.nodes]
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, harness.agent, 'pressure', new AbortController().signal)
    // ONE whole-zone compact over the complete forget zone including the aged
    // tool summary — the replacement is not excluded just because it was once a
    // tool summary, and no re-entry/same-pass deferral fires.
    expect(harness.compacted).toHaveLength(1)
    expect(harness.compacted[0]!.start).toBe(beforeNodes[0])
    expect(harness.compacted[0]!.end).toBe(beforeNodes[6])
    expect(harness.stops).not.toContain('reentry-deferred')
    expect(harness.stops).not.toContain('same-pass-tool-replacement')
  })

  it('blocks whole-zone pressure when THIS same invocation just produced the tool summary', async () => {
    // Same 80% surface as above, but the durable tool summary is created by the
    // very invocation that then reaches the whole-zone guard. The round-local
    // exclusion set is what must stop the pass: the fresh intermediate has not
    // been served by a single request yet, so it cannot be folded into the same
    // call's semantic compact even though a source index would call it known.
    const session = Session.create(SessionId('engine-same-pass'))
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'message-0' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'same-pass-tool')
    for (let index = 1; index <= 9; index += 1) {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `message-${index}` }], source: { kind: 'user' } }), SURFACE)
    }
    const harness = engineHarness(session)
    const engine = harness.engine as unknown as {
      summarizeToolGroups: (
        agent: Agent,
        target: { provider: string; model: string },
        policy: ReturnType<typeof resolveTargetPolicy>,
        olderRange: { startSeq: SessionSeq; endSeq: SessionSeq } | null,
        signal: AbortSignal,
        roundReplacements: Set<SessionSeq>,
      ) => Promise<void>
      logPressureStop: (reason: string) => void
    }
    // Governance runs on the tool zone (no tool results) and then on the forget
    // zone, where it replaces the raw tool result with a durable summary and
    // records it in the round-local exclusion set — exactly what the real
    // `replaceToolGroup` path does after a successful audit commit.
    engine.summarizeToolGroups = async (_agent, _target, _policy, olderRange, _signal, roundReplacements) => {
      if (olderRange === null) return
      const nodes = [...session.surface.nodes]
      const startIdx = nodes.indexOf(olderRange.startSeq)
      const endIdx = nodes.indexOf(olderRange.endSeq)
      if (startIdx < 0 || endIdx < startIdx) return
      for (const seq of nodes.slice(startIdx, endIdx + 1)) {
        const event = session.eventAt(seq)
        if (event?.type !== 'tool/result') continue
        const landed = session.append('tool/result', event.data as never, {
          surfaceOp: { op: 'replace', start: seq, end: seq },
          sourceEventSeqs: [seq],
        })
        roundReplacements.add(landed.seq)
        return
      }
    }
    const originalLog = engine.logPressureStop
    engine.logPressureStop = (reason: string) => { harness.stops.push(reason); originalLog(reason) }
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, harness.agent, 'pressure', new AbortController().signal)
    expect(harness.compacted).toEqual([])
    expect(harness.stops).toContain('same-pass-tool-replacement')
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

  it.each(['aborted', 'error', 'blocked', 'max-tokens', 'interrupted'] as const)('does not re-enter after non-completed %s turn', reason => {
    const session = Session.create(SessionId(`source-${reason}`))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, `summary-${reason}`)
    const original = session.surface.nodes.at(-1)!
    const event = session.eventAt(original)!
    const replacement = session.append('tool/result', event!.data as never, { surfaceOp: { op: 'replace', start: original, end: original }, sourceEventSeqs: [original] })
    session.append('turn/end', { turn: 1, reason: { kind: reason } } as never)
    expect(buildSurfaceSourceIndex(session, [replacement.seq]).canCompactHistory(replacement.seq, 1)).toBe(false)
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

  it('relaxes a known tool summary for the whole-zone pressure pass even with zero completed turns', () => {
    // A 70% governance tool summary that aged behind newer dialogue inside the
    // current forget zone is historical: the whole-zone pressure pass passes
    // allowImmediateReentry and must fold it in without waiting for a turn/end.
    const session = Session.create(SessionId('source-relax-tool-summary'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'relaxed-summary')
    const original = session.surface.nodes.at(-1)!
    const event = session.eventAt(original)!
    const replacement = session.append('tool/result', event.data as never, { surfaceOp: { op: 'replace', start: original, end: original }, sourceEventSeqs: [original] })
    const index = buildSurfaceSourceIndex(session, [replacement.seq])
    expect(index.entry(replacement.seq).kind).toBe('tool-summary')
    expect(index.canCompactHistory(replacement.seq, 1, true)).toBe(true)
    // The maintenance/overflow path (no flag) still defers until a completed turn.
    expect(index.canCompactHistory(replacement.seq, 1)).toBe(false)
  })

  it('relaxes a pruned tool result for the whole-zone pressure pass', () => {
    const session = Session.create(SessionId('source-relax-pruned'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'relaxed-prune')
    const original = session.surface.nodes.at(-1)!
    // The pruner replacement protocol: a compaction/prune shadow-price event
    // immediately precedes the replacement citing the single shadowed node.
    session.append('compaction/prune', {
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
      shadowedTokenCount: 10,
    })
    const event = session.eventAt(original)!
    const replacement = session.append('tool/result', event.data as never, { surfaceOp: { op: 'replace', start: original, end: original }, sourceEventSeqs: [original] })
    const index = buildSurfaceSourceIndex(session, [replacement.seq])
    expect(index.entry(replacement.seq).kind).toBe('tool-pruned')
    expect(index.canCompactHistory(replacement.seq, 1, true)).toBe(true)
    expect(index.canCompactHistory(replacement.seq, 1)).toBe(false)
  })

  it('relaxes a prior history-summary checkpoint for the whole-zone pressure pass', () => {
    const session = Session.create(SessionId('source-relax-checkpoint'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'relaxed-checkpoint')
    const original = session.surface.nodes.at(-1)!
    const replacement = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(CompactionId('relaxed-cp')),
    }), { surfaceOp: { op: 'replace', start: original, end: original }, sourceEventSeqs: [original] })
    const index = buildSurfaceSourceIndex(session)
    expect(index.entry(replacement.seq).kind).toBe('history-summary')
    expect(index.canCompactHistory(replacement.seq, 1, true)).toBe(true)
    expect(index.canCompactHistory(replacement.seq, 1)).toBe(false)
  })

  it('never relaxes an unknown third-party replacement even for the whole-zone pressure pass', () => {
    // Session replacement metadata carries no producer field, so a replacement
    // not confirmed by this package's audit stays protected in every path: the
    // whole-zone relaxation must not let a foreign producer's live replacement
    // be consumed before the completed-turn rule releases it.
    const session = Session.create(SessionId('source-unknown-protected'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'foreign-source')
    const original = session.surface.nodes.at(-1)!
    const event = session.eventAt(original)!
    const replacement = session.append('tool/result', event.data as never, { surfaceOp: { op: 'replace', start: original, end: original }, sourceEventSeqs: [original] })
    const index = buildSurfaceSourceIndex(session)
    expect(index.entry(replacement.seq).kind).toBe('unknown-replacement')
    expect(index.canCompactHistory(replacement.seq, 1, true)).toBe(false)
    // Even many completed turns do not classify it: unknown stays unknown.
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    expect(buildSurfaceSourceIndex(session).canCompactHistory(replacement.seq, 1, true)).toBe(false)
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
