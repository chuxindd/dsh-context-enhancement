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
import { resolveCompactSpec, resolveConfig } from '../src/internal/compaction/config.ts'
import { partitionSurfaceZones, planPressureSpan } from '../src/internal/compaction/zones.ts'
import type { SurfaceZones } from '../src/internal/compaction/zones.ts'

const SURFACE = { surfaceOp: 'append' as const }

function addAssistantText(session: Session, turn: number, text: string): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
}

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
    message: createToolResultMessage({
      callId: ToolCallId(id),
      content: [{ type: 'text', text: `${id} result` }],
      isError: false,
    }),
  }, SURFACE)
}

describe('compaction reentry liveness contract', () => {
  const BUDGET_OVERRIDES = {
    responseReserveTokens: 20,
    safetyMarginTokens: 10,
    maxTokens: 10,
    toolGroupSummarizer: { enabled: false },
  }

  const WIDE_PLAN = {
    envelopeTokens: 440,
    nodeTokens: 20,
    contextWindow: 1_000,
    overrides: { ...BUDGET_OVERRIDES, responseReserveTokens: 200, safetyMarginTokens: 100 },
  }

  interface HarnessOptions {
    envelopeTokens?: number
    nodeTokens?: number
    contextWindow?: number
    overrides?: Record<string, unknown>
    canCompactHistory?: (seq: SessionSeq) => boolean
    pendingToolWork?: (start: SessionSeq, end: SessionSeq) => boolean | 'inert'
  }

  function harness(session: Session, options: HarnessOptions = {}) {
    const compacted: Array<{ start: SessionSeq; end: SessionSeq }> = []
    const stops: string[] = []
    const warns: string[] = []
    const prices = new Map<SessionSeq, number>()
    const defaultNodeTokens = options.nodeTokens ?? 10
    const priceOf = (seq: SessionSeq): number => prices.get(seq) ?? defaultNodeTokens

    const tokenMeter = {
      measure: (current: Session): TokenMeasurement => {
        const nodes = current.surface.nodes.map(seq => {
          const tokens = priceOf(seq)
          return { seq, tokens, heuristicTokens: tokens }
        })
        const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
        const envelopeTokens = options.envelopeTokens ?? 0
        return {
          totalTokens: surfaceTokens + envelopeTokens,
          surfaceTokens,
          nodes,
          logRevision: 0,
          baseline: { kind: 'estimated', tokens: envelopeTokens },
          surfaceDeltaTokens: surfaceTokens,
        } as unknown as TokenMeasurement
      },
      estimateMessage: () => 10,
    }

    const config = resolveConfig({
      toolGroupSummarizer: { enabled: false },
      ...options.overrides,
    })

    const fake = {
      config,
      ctx: {
        tokenMeter,
        llm: { resolveModelInfo: async () => ({ context: { contextWindow: options.contextWindow ?? 100 } }) },
        get: () => undefined,
        logger: { warn: (message: string) => { warns.push(message) } },
      },
      summarizeToolGroups: async () => undefined,
      sourceIndex: () => ({
        entry: (seq: SessionSeq) => ({ seq, kind: 'original' as const, sourceEventSeqs: [], completedTurnsAfter: 0 }),
        isOriginalToolResult: () => false,
        canCompactHistory: (seq: SessionSeq) => options.canCompactHistory?.(seq) ?? true,
        entries: new Map(),
      }),
      hasPendingToolIntermediateWork: (_current: Session, start: SessionSeq, end: SessionSeq) => {
        const verdict = options.pendingToolWork?.(start, end)
        return verdict === true ? 'actionable' as const : verdict === 'inert' ? 'inert' as const : 'none' as const
      },
      logPressureStop: (reason: string) => { stops.push(reason) },
      compactRegion: async (start: SessionSeq, end: SessionSeq): Promise<CompactionResult> => {
        compacted.push({ start, end })
        const nodes = session.surface.nodes
        const shadowedSeqs = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1)
        const spanTokens = shadowedSeqs.reduce((total, seq) => total + priceOf(seq), 0)
        const replacement = session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'checkpoint-summary' }],
          source: { kind: 'user' },
        }), { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [...shadowedSeqs] })
        prices.set(replacement.seq, 10)
        return {
          compactionId: `liveness-${compacted.length}` as CompactionResult['compactionId'],
          startSeq: replacement.seq,
          summarySeq: replacement.seq,
          endSeq: replacement.seq,
          summary: [{ type: 'text', text: 'summary' }],
          shadowedRange: { start, end },
          shadowedSeqs,
          shadowedTokenCount: spanTokens,
        }
      },
    }

    const prototype = BasicCompactionEngine.prototype as unknown as {
      zones: (
        current: Session,
        priced: TokenMeasurement,
        spec: ReturnType<typeof resolveCompactSpec>,
      ) => SurfaceZones
      envelopeBudget: (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) => unknown
      envelopeZoneBudget: (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) => unknown
      pressurePassTerminated: (current: Session, totalTokens: number) => boolean
      stopEnvelopeBudgetPass: (current: Session, reason: string, totalTokens: number, thresholdTokens: number) => void
    }
    const engine = fake as unknown as BasicCompactionEngine
    const seams = engine as unknown as Record<string, unknown>
    seams.zones = (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) =>
      prototype.zones.call(engine, current, priced, spec)
    seams.envelopeBudget = (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) =>
      prototype.envelopeBudget.call(engine, current, priced, spec)
    seams.envelopeZoneBudget = (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) =>
      prototype.envelopeZoneBudget.call(engine, current, priced, spec)
    seams.pressurePassTerminated = (current: Session, totalTokens: number) =>
      prototype.pressurePassTerminated.call(engine, current, totalTokens)
    seams.stopEnvelopeBudgetPass =
      (current: Session, reason: string, totalTokens: number, thresholdTokens: number) =>
        prototype.stopEnvelopeBudgetPass.call(engine, current, reason, totalTokens, thresholdTokens)
    seams.pressureStops = new WeakMap()
    const agent = { session, options: { provider: 'mock', model: 'model' } } as Agent

    return {
      engine,
      agent,
      compacted,
      stops,
      warns,
      measureTotal: (): number => tokenMeter.measure(session).totalTokens,
    }
  }

  function sessionWithNodes(count: number): Session {
    const session = Session.create(SessionId(`reentry-liveness-${count}`))
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    for (let index = 0; index < count; index += 1) addAssistantText(session, index + 1, `msg-${index}`)
    return session
  }

  it('selects the largest admissible prefix before a permanent unknown replacement and makes progress across repeated steps', async () => {
    // 30 nodes x 20 tokens = 600 surface tokens. E = 440 -> total = 1040 > threshold 800.
    // Node 5 is a permanent unknown replacement.
    const session = sessionWithNodes(30)
    const beforeNodes = [...session.surface.nodes]
    const blockerSeq = beforeNodes[5]!

    const h = harness(session, {
      ...WIDE_PLAN,
      canCompactHistory: seq => seq !== blockerSeq,
    })

    // Step 1: the wide span is [0..11] (the 240-token Bcap prefix) and the
    // reentry blocker at node 5 vetoes it. The planner backs off to the prefix
    // [0..4] (5 nodes x 20 = 100 tokens > minSpan 10) and PAYS for it — the veto
    // narrows the span, it does not deadlock the pass.
    await BasicCompactionEngine.prototype.compactIfNeeded.call(h.engine, h.agent, 'pressure', new AbortController().signal)
    expect(h.compacted).toEqual([{ start: beforeNodes[0]!, end: beforeNodes[4]! }])
    // After that paid batch the pass STOPS. Its next plan starts past the
    // round-local replacement it just made (`minStartIndex` skips the checkpoint
    // and the original it shadowed), and its start position is then the unknown
    // replacement itself, so this surface state admits no prefix at all — neither
    // a wider one nor a 1-node one. The terminal reason is therefore the veto
    // that actually stopped the pass, reported exactly once: the reason is
    // recorded through the single stop funnel rather than by the loop as well.
    expect(h.stops).toEqual(['reentry-deferred'])

    // After Step 1: nodes 0..4 were replaced by a 10-token checkpoint summary.
    // Total tokens decreased from 1040 to 950 (100 - 10 = 90 tokens saved), but still > threshold 800.
    expect(h.measureTotal()).toBe(950)

    // Step 2: the surface still starts with [summaryCheckpoint, blockerSeq, node6, ...].
    // It must NOT deadlock or make a paid model call, and it must report the same
    // stable verdict once — 950 tokens and 26 nodes is the state it was derived
    // from, so the funnel's record stays deduplicated.
    await BasicCompactionEngine.prototype.compactIfNeeded.call(h.engine, h.agent, 'pressure', new AbortController().signal)
    expect(h.compacted).toHaveLength(1) // No new compaction in Step 2
    expect(h.stops).toEqual(['reentry-deferred'])
    expect(h.measureTotal()).toBe(950)
  })

  it('makes 0 model calls and returns a stable stop when no safe prefix exists before the blocker', async () => {
    // Blocker at position 0 (head of session).
    const session = sessionWithNodes(30)
    const beforeNodes = [...session.surface.nodes]
    const h = harness(session, {
      ...WIDE_PLAN,
      canCompactHistory: seq => seq !== beforeNodes[0]!,
    })

    await BasicCompactionEngine.prototype.compactIfNeeded.call(h.engine, h.agent, 'pressure', new AbortController().signal)
    expect(h.compacted).toEqual([])
    expect(h.stops).toEqual(['reentry-deferred'])
  })

  it('does not carry over actionable tool debt veto to a clean narrowed prefix', async () => {
    // Suppose wide span [0..11] contains actionable tool debt that only appears at or after node 5,
    // while nodes 0..4 have no pending debt.
    const session = sessionWithNodes(30)
    const beforeNodes = [...session.surface.nodes]
    const debtSeq = beforeNodes[5]!

    const h = harness(session, {
      ...WIDE_PLAN,
      pendingToolWork: (start, end) => {
        const nodes = session.surface.nodes
        const startIdx = nodes.indexOf(start)
        const endIdx = nodes.indexOf(end)
        const debtIdx = nodes.indexOf(debtSeq)
        return debtIdx >= startIdx && debtIdx <= endIdx
      },
    })

    await BasicCompactionEngine.prototype.compactIfNeeded.call(h.engine, h.agent, 'pressure', new AbortController().signal)
    // The wide span [0..11] owes tool work at node 5, so the planner back offs
    // and the narrowed prefix [0..4] is re-evaluated FRESH and paid: the tool
    // debt veto is not carried over onto a prefix that does not owe it.
    expect(h.compacted).toEqual([{ start: beforeNodes[0]!, end: beforeNodes[4]! }])
    // The pass ends after that one paid batch on the debt it cannot avoid. In
    // this harness the fake supplies no exact debt INDEX (only the span-level
    // verdict), so the fallback narrows to just before the plan's own end; the
    // fresh plan then starts past the batch-1 replacement — which lands its start
    // position inside the same debt — and no admissible prefix is left. That
    // remaining verdict is the one the pass reports, exactly once.
    expect(h.stops).toEqual(['tool-stage-deferred'])
    expect(h.measureTotal()).toBe(950)
  })

  it('respects tool-pairing and step boundaries when selecting safe prefix before blocker', () => {
    // Construct session with tool step:
    // 0: user/turn 1
    // 1: assistant tool-call
    // 2: tool result
    // 3: assistant tool-call
    // 4: tool result
    // 5: assistant text (blocker)
    const session = Session.create(SessionId('reentry-liveness-pairing'))
    addAssistantText(session, 1, 'turn 1')
    addToolStep(session, 2, 1, 'call-1') // nodes 1 and 2
    addToolStep(session, 2, 2, 'call-2') // nodes 3 and 4
    addAssistantText(session, 3, 'turn 3') // node 5 (blocker)
    for (let turn = 4; turn <= 10; turn += 1) addAssistantText(session, turn, `turn ${turn}`)

    const nodes = [...session.surface.nodes]
    const tokenMeter = {
      measure: (current: Session): TokenMeasurement => {
        const n = current.surface.nodes.map(seq => ({ seq, tokens: 20, heuristicTokens: 20 }))
        return {
          totalTokens: n.length * 20 + 200,
          surfaceTokens: n.length * 20,
          nodes: n,
          logRevision: 0,
          baseline: { kind: 'estimated', tokens: 200 },
          surfaceDeltaTokens: n.length * 20,
        } as unknown as TokenMeasurement
      },
    }
    const priced = tokenMeter.measure(session)
    const zones = partitionSurfaceZones(session, priced, {
      contextWindow: 1000,
      recentRatio: 0.2,
      forgetBoundaryRatio: 0.5,
    })

    // Back off before node 4 (the tool-result of call-2): maxEndIndex = 3 (the tool-call of call-2).
    // The planner must NOT cut at node 3 because tool pairing is open!
    // It must back off to node 2 (balanced tool result of call-1).
    const plan = planPressureSpan(session, priced, zones, {
      reclaimTokens: 100,
      inputCapTokens: 500,
      minSpanTokens: 10,
      maxEndIndex: 3,
    })
    expect(plan.kind).toBe('selected')
    if (plan.kind === 'selected') {
      expect(plan.range.endIndex).toBe(2) // Balanced after call-1 result, does not split call-2!
      expect(plan.range.endSeq).toBe(nodes[2])
    }
  })
})
