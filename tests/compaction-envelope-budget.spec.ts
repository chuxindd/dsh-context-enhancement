import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from '../src/internal/compaction/config.ts'
import { resolveEnvelopeBudget, resolveEnvelopeZoneBudget, retainedTailFloorTokens } from '../src/internal/compaction/envelope-budget.ts'
import { partitionSurfaceZones, planPressureSpan } from '../src/internal/compaction/zones.ts'
import type { SurfaceZones } from '../src/internal/compaction/zones.ts'

const SURFACE = { surfaceOp: 'append' as const }

/** One turn-carrying surface node, so the guaranteed two-turn tail is priceable. */
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

function measurement(session: Session, each = 10, envelope = 0): TokenMeasurement {
  const nodes = session.surface.nodes.map(seq => ({ seq, tokens: each, heuristicTokens: each }))
  const surfaceTokens = nodes.length * each
  return {
    totalTokens: surfaceTokens + envelope,
    surfaceTokens,
    nodes,
    logRevision: 0,
    baseline: { kind: 'estimated', tokens: envelope },
    surfaceDeltaTokens: surfaceTokens,
  } as unknown as TokenMeasurement
}

describe('envelope budget arithmetic', () => {
  const BASE = {
    contextWindow: 100,
    responseReserveTokens: 20,
    safetyMarginTokens: 10,
    instructionTokens: 10,
    summaryMaxTokens: 10,
    retainTokens: 20,
    minRetainTokens: 15,
  }

  it('derives E and grants the surface that keeps the reserve and margin free', () => {
    const budget = resolveEnvelopeBudget({ totalTokens: 130, surfaceTokens: 90 }, BASE)
    expect(budget.envelopeTokens).toBe(40)
    expect(budget.surfaceGrantTokens).toBe(30)
    expect(budget.retainedTailTokens).toBe(20)
    expect(budget.summarizerInputCapTokens).toBe(10)
    expect(budget.envelopeDominated).toBe(false)
  })

  it('floors the retained tail at the guaranteed turn tail and vetoes a dominating envelope', () => {
    const budget = resolveEnvelopeBudget({ totalTokens: 100, surfaceTokens: 40 }, BASE)
    expect(budget.envelopeTokens).toBe(60)
    expect(budget.surfaceGrantTokens).toBe(10)
    expect(budget.retainedTailTokens).toBe(15)
    expect(budget.summarizerInputCapTokens).toBe(0)
    expect(budget.envelopeDominated).toBe(true)
  })

  it('never reports a negative envelope when the surface is priced above total pressure', () => {
    const budget = resolveEnvelopeBudget({ totalTokens: 50, surfaceTokens: 90 }, BASE)
    expect(budget.envelopeTokens).toBe(0)
    expect(budget.surfaceGrantTokens).toBe(70)
  })

  it('prices the guaranteed tail from the two newest surface turns', () => {
    const session = Session.create(SessionId('budget-tail-floor'))
    addAssistantText(session, 1, 'turn-1')
    addAssistantText(session, 2, 'turn-2a')
    addAssistantText(session, 2, 'turn-2b')
    addAssistantText(session, 3, 'turn-3')
    // A user prompt carries no turn, so it is absorbed into the newest turn.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'open prompt' }],
      source: { kind: 'user' },
    }), SURFACE)
    // Tail = prompt + turn 3 + both turn-2 nodes; turn 1 falls outside.
    expect(retainedTailFloorTokens(session, measurement(session))).toBe(40)
  })
})

describe('envelope-budget span planning', () => {
  const RATIOS = { recentRatio: 0.20, forgetBoundaryRatio: 0.50, contextWindow: 100 }

  function sessionWithNodes(count: number): Session {
    const session = Session.create(SessionId(`budget-span-${count}`))
    for (let index = 0; index < count; index += 1) addAssistantText(session, index + 1, `message-${index}`)
    return session
  }

  function zonesOf(session: Session, priced: TokenMeasurement): SurfaceZones {
    return partitionSurfaceZones(session, priced, RATIOS)
  }

  it('keeps the whole forget zone when it releases the retained tail and fits the cap', () => {
    const session = sessionWithNodes(12)
    const priced = measurement(session)
    const zones = zonesOf(session, priced)
    // recentStart = 10, so the forget zone is positions 0..6 (70 tokens).
    expect(zones.recent?.startIndex).toBe(10)
    expect(zones.forget?.tokens).toBe(70)
    const plan = planPressureSpan(session, priced, zones, {
      reclaimTokens: 40,
      inputCapTokens: 80,
      minSpanTokens: 10,
    })
    expect(plan.kind).toBe('selected')
    if (plan.kind !== 'selected') return
    expect(plan.range.startIndex).toBe(0)
    // T = 120, threshold 80 -> reclaim 40; the strict target 40 + 10 + 1 = 51
    // is first reached by the 6-node / 60-token prefix.
    expect(plan.range.endIndex).toBe(5)
    expect(plan.range.tokens).toBe(60)
    expect(plan.range.endIndex).toBeLessThan(zones.recent!.startIndex)
  })

  it('falls back to the maximal safe prefix when the head exceeds the auxiliary input cap', () => {
    const session = sessionWithNodes(12)
    const priced = measurement(session)
    const zones = zonesOf(session, priced)
    const plan = planPressureSpan(session, priced, zones, {
      reclaimTokens: 1_000,
      inputCapTokens: 50,
      minSpanTokens: 10,
    })
    expect(plan.kind).toBe('selected')
    if (plan.kind !== 'selected') return
    // The oldest 5 nodes are exactly 50 tokens; the sixth would exceed the cap.
    expect(plan.range.startIndex).toBe(0)
    expect(plan.range.endIndex).toBe(4)
    expect(plan.range.tokens).toBe(50)
    // The retained tail is untouched by construction.
    expect(plan.range.endIndex).toBeLessThan(zones.recent!.startIndex)
  })

  it('vetoes the pass locally when no span can be sent', () => {
    const session = sessionWithNodes(12)
    const priced = measurement(session)
    const zones = zonesOf(session, priced)
    expect(planPressureSpan(session, priced, zones, {
      reclaimTokens: 40,
      inputCapTokens: 0,
      minSpanTokens: 10,
    })).toEqual({ kind: 'blocked', reason: 'envelope-dominated' })
  })

  it('refuses a span that could never shrink below the checkpoint frame', () => {
    const session = sessionWithNodes(12)
    const priced = measurement(session)
    const zones = zonesOf(session, priced)
    expect(planPressureSpan(session, priced, zones, {
      reclaimTokens: 40,
      inputCapTokens: 50,
      minSpanTokens: 50,
    })).toEqual({ kind: 'blocked', reason: 'span-below-minimum' })
  })
})

describe('envelope-budget engine pass', () => {
  interface HarnessOptions {
    envelopeTokens?: number
    nodeTokens?: number
    estimateMessage?: number
    noProgress?: boolean
    /** Land the replacement one token under the shadowed span: the legal worst case the shrink assertion still accepts. */
    barelySmaller?: boolean
    overrides?: Partial<Parameters<typeof resolveConfig>[0]>
    /** Per-node re-entry verdict; defaults to "every node may re-enter". */
    canCompactHistory?: (seq: SessionSeq) => boolean
    /** Whether the tool stage still owes work for a span; `true` defers, `'inert'` must not. */
    pendingToolWork?: (start: SessionSeq, end: SessionSeq) => boolean | 'inert'
    /** Routed model capacity; defaults to 100. */
    contextWindow?: number
  }

  const BUDGET_OVERRIDES = {
    responseReserveTokens: 20,
    safetyMarginTokens: 10,
    maxTokens: 10,
    toolGroupSummarizer: { enabled: false },
  } satisfies Partial<Parameters<typeof resolveConfig>[0]>

  function sessionWithNodes(count: number): Session {
    const session = Session.create(SessionId(`budget-engine-${count}`))
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    for (let index = 0; index < count; index += 1) addAssistantText(session, index + 1, `message-${index}`)
    return session
  }

  function harness(session: Session, options: HarnessOptions = {}): {
    engine: BasicCompactionEngine
    agent: Agent
    compacted: Array<{ start: SessionSeq; end: SessionSeq }>
    stops: string[]
    warns: string[]
    /** The engine's own meter reading of the live session surface. */
    measureTotal: () => number
  } {
    const envelopeTokens = options.envelopeTokens ?? 0
    const nodeTokens = options.nodeTokens ?? 10
    const compacted: Array<{ start: SessionSeq; end: SessionSeq }> = []
    const stops: string[] = []
    const warns: string[] = []
    const prices = new Map<SessionSeq, number>()
    const priceOf = (seq: SessionSeq): number => prices.get(seq) ?? nodeTokens
    const tokenMeter = {
      measure(current: Session): TokenMeasurement {
        const nodes = current.surface.nodes.map(seq => ({ seq, tokens: priceOf(seq), heuristicTokens: priceOf(seq) }))
        const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0)
        return {
          totalTokens: surfaceTokens + envelopeTokens,
          surfaceTokens,
          nodes,
          logRevision: 0,
          baseline: { kind: 'estimated', tokens: envelopeTokens },
          surfaceDeltaTokens: surfaceTokens,
        } as unknown as TokenMeasurement
      },
      estimateMessage: () => options.estimateMessage ?? 10,
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
      sourceIndex: (current: Session) => ({
        entry: () => ({ seq: current.surface.nodes[0]!, kind: 'original' as const, sourceEventSeqs: [], completedTurnsAfter: 0 }),
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
          content: [{ type: 'text', text: 'summary' }],
          source: { kind: 'user' },
        }), { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [...shadowedSeqs] })
        // A no-progress pass lands a replacement priced exactly like the span it
        // shadowed, so total pressure does not drop and the pass must terminate.
        // A barely-smaller pass lands the legal worst case — one token under the
        // shadowed span, the most the shrink assertion still accepts — so a
        // deficit-sized span reclaims a single token.
        prices.set(
          replacement.seq,
          options.barelySmaller === true
            ? spanTokens - 1
            : options.noProgress === true ? spanTokens : nodeTokens,
        )
        return {
          compactionId: `budget-${compacted.length}` as CompactionResult['compactionId'],
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
    // Exercise the real partition, budget, and stop-memo seams so the pass
    // under test is the production one: only I/O is faked.
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
    // The real partition, budget, and stop-memo seams are always under test;
    // only I/O is faked.
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

  it('vetoes an envelope-dominated pass once per pressure/surface state', async () => {
    const session = sessionWithNodes(12)
    const { engine, agent, compacted, stops } = harness(session, {
      envelopeTokens: 90,
      overrides: BUDGET_OVERRIDES,
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // G = 100 - 90 - 20 - 10 = 0, so Bcap = 0 and no auxiliary call is possible.
    expect(compacted).toEqual([])
    expect(stops).toEqual(['envelope-dominated'])
  })

  it('compacts the maximal safe prefix and leaves the retained tail verbatim', async () => {
    const session = sessionWithNodes(12)
    const { engine, agent, compacted } = harness(session, { overrides: BUDGET_OVERRIDES })
    const beforeNodes = [...session.surface.nodes]
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // G = 100 - 0 - 20 - 10 = 70, Bcap = 70 - 10 - 10 = 50. The exit line is
    // floor(100 x 0.70) = 70 (NOT the 80-token trigger), so the deficit is
    // 120 - 70 = 50, the strict target 50 + minSpan + 1 is unreachable inside the
    // 50-token cap, and batch 1 is the WIDEST safe prefix under that cap: the
    // oldest 5 nodes (positions 0..4, 50 tokens). That lands the request at 80,
    // still above the exit line, so the bounded loop pays a second batch:
    // positions 5..7 (30 tokens) take it to 60 <= 70 and the pass ends at the
    // exit line. Two paid batches, never a whole-zone selection.
    expect(compacted).toHaveLength(2)
    expect(compacted[0]!.start).toBe(beforeNodes[0])
    expect(compacted[0]!.end).toBe(beforeNodes[4])
    expect(compacted[1]!.start).toBe(beforeNodes[5])
    expect(compacted[1]!.end).toBe(beforeNodes[7])
    // The two newest nodes are the retained tail and stay verbatim.
    expect(session.surface.nodes).toContain(beforeNodes[10])
    expect(session.surface.nodes).toContain(beforeNodes[11])
  })

  it('terminates a repeated no-progress pass within one surface generation', async () => {
    const session = sessionWithNodes(12)
    const { engine, agent, compacted, stops } = harness(session, {
      noProgress: true,
      overrides: BUDGET_OVERRIDES,
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toHaveLength(1)
    expect(stops).toEqual(['no-progress'])
  })

  it('does not clear the deficit in one pass when the replacement is barely smaller', async () => {
    // Counterexample to the retired one-shot claim: the region shrink assertion
    // accepts any replacement priced between the checkpoint floor and one token
    // under the span, so a deficit-sized span carries no one-pass clearing
    // guarantee. Reserve 5 + margin 5 leave Bcap = 70 against the exit line
    // floor(100 x 0.70) = 70, so reclaim = 120 - 70 = 50 makes the strict target
    // 50 + floor + 1 unreachable under the cap and the planner answers with the
    // WIDEST safe prefix, the 7-node / 70-token span 0..6 — exactly Bcap. This
    // summarizer then lands the legal worst case — 69 tokens for that 70-token
    // span — and the pass must end with the request still above threshold and the
    // next step free to re-plan from the fresh surface.
    const session = sessionWithNodes(12)
    const beforeNodes = [...session.surface.nodes]
    const { engine, agent, compacted, stops, measureTotal } = harness(session, {
      barelySmaller: true,
      overrides: { ...BUDGET_OVERRIDES, responseReserveTokens: 5, safetyMarginTokens: 5 },
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // One paid call over the widest safe prefix; the retained tail (the two
    // newest nodes) stays verbatim.
    expect(compacted).toEqual([{ start: beforeNodes[0], end: beforeNodes[6] }])
    expect(session.surface.nodes).toHaveLength(6)
    expect(session.surface.nodes).toContain(beforeNodes[10])
    expect(session.surface.nodes).toContain(beforeNodes[11])
    // The span-minus-one replacement reclaims exactly one token: the request
    // stays 49 tokens above the 70-token exit line.
    expect(measureTotal()).toBe(119)
    // That one reclaimed token misses BOTH net-release floors (1 < 1 024 and
    // 1/70 < 0.15), so the pass records the honest `low-yield` verdict and stops
    // paying instead of re-planning in the same pressure state.
    expect(stops).toEqual(['low-yield'])
  })

  it('bounds repeated barely-smaller steps to strictly decreasing paid passes', async () => {
    // 120 total against a 70-token exit line leaves a 50-token deficit. A
    // summarizer that always lands the worst legal replacement (span - 1) must
    // still terminate: every paid pass strictly reduces the measured total, so
    // the cross-step re-plan loop is bounded by the deficit (one reclaimed token
    // per pass), and a pass that reclaimed nothing would have been stopped by the
    // memoized no-progress verdict instead.
    //
    // Each of those passes realises exactly one token of release against a
    // 50-token-or-smaller span, so it ALSO misses both net-release floors
    // (1 < 1 024 tokens and 1/span < 0.15) and the pass records `low-yield`
    // before it ends. That is the honest per-batch accounting of a legal but
    // worthless replacement: the stop ends the PAID pass, it does not ban the
    // next step, which is why the loop below still converges.
    const session = sessionWithNodes(12)
    const { engine, agent, compacted, stops, measureTotal } = harness(session, {
      barelySmaller: true,
      overrides: BUDGET_OVERRIDES,
    })
    const maxPasses = 51
    // The cross-step loop is bounded by the TRIGGER, not by the exit line: the
    // caller re-enters whenever the request is at or above the 80-token pressure
    // trigger, and one pass may end above it (here every pass does, because each
    // invocation pays exactly once and stops on `low-yield`).
    const trigger = 80
    let previousTotal = measureTotal()
    let paidPasses = 0
    while (measureTotal() >= trigger) {
      await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
      paidPasses += 1
      expect(paidPasses).toBeLessThanOrEqual(maxPasses)
      // Every paid pass strictly reduces the measured total: no stall, no
      // silent veto, no unbounded paid loop.
      expect(measureTotal()).toBeLessThan(previousTotal)
      previousTotal = measureTotal()
    }
    expect(paidPasses).toBeGreaterThan(0)
    // The loop ended BELOW the trigger: 120 - 41 reclaimed tokens = 79.
    expect(measureTotal()).toBeLessThan(trigger)
    // Every invocation paid exactly once: the pass ends on `low-yield` (one
    // realised token per batch), and that verdict is deliberately NOT terminal,
    // so each next above-threshold step was free to re-plan.
    //
    // `compacted` is the direct evidence of "once per invocation": it has exactly
    // one entry per paid pass. `stops` can be SHORTER than that — the funnel
    // reports a reason once per distinct (reason, pressure/surface) state, and
    // consecutive passes at the same total/nodes collapse — but it is never
    // empty, never longer, and never anything but `low-yield`: a batch that
    // reclaimed nothing would have ended its pass on `no-progress` instead.
    expect(compacted).toHaveLength(paidPasses)
    expect(stops.length).toBeGreaterThan(0)
    expect(stops.length).toBeLessThanOrEqual(paidPasses)
    expect(stops.every(reason => reason === 'low-yield')).toBe(true)
  })

  it('caps a bounded maintenance batch by the auxiliary input budget', async () => {
    const session = sessionWithNodes(7)
    const { engine, agent, compacted } = harness(session, {
      overrides: { ...BUDGET_OVERRIDES, safetyMarginTokens: 50 },
    })
    const beforeNodes = [...session.surface.nodes]
    // 70 tokens sits exactly at the 70% maintenance waterline and below 80%
    // pressure. G = W - E - R - M = 30 and Bcap = 30 - 10 - 10 = 10, so the
    // oldest batch is the single node that fits instead of the whole 20-token
    // forget zone an uncapped pass would take.
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toHaveLength(1)
    expect(compacted[0]!.start).toBe(beforeNodes[0])
    expect(compacted[0]!.end).toBe(beforeNodes[0])
  })

  // W = 1000, R0 = 200, F_b = 500, R = 200, M = 100, maxTokens = 10, and a
  // 10-token instruction. 30 nodes x 20 = 600 surface tokens with E = 440:
  // T = 1040 against the exit line floor(1000 x 0.70) = 700, so the deficit is
  // 340 while Bcap = (1000 - 440 - 300) - 20 = 240; the deficit target is
  // unreachable under the cap, so the widest safe prefix (240 tokens, positions
  // 0..11) is the span, and it contains node 5.
  const WIDE_PLAN = {
    envelopeTokens: 440,
    nodeTokens: 20,
    contextWindow: 1_000,
    overrides: { ...BUDGET_OVERRIDES, responseReserveTokens: 200, safetyMarginTokens: 100 },
  } satisfies HarnessOptions

  function wideSession(): Session {
    return sessionWithNodes(30)
  }

  it('pays for the widest safe prefix and then the next affordable prefix', async () => {
    const session = wideSession()
    const beforeNodes = [...session.surface.nodes]
    const { engine, agent, compacted, stops } = harness(session, WIDE_PLAN)
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // The cap-bounded span is only 240 of the 340-token deficit, so batch 1
    // (positions 0..11, 240 tokens) leaves the request at 820 — still above the
    // 700-token exit line — and the bounded loop pays a second batch: the fresh
    // plan starts past the replacement it just made (positions 12..18, 140
    // tokens), which lands 700 and ends the pass AT the exit line.
    expect(compacted).toEqual([
      { start: beforeNodes[0], end: beforeNodes[11] },
      { start: beforeNodes[12], end: beforeNodes[18] },
    ])
    // The exit line is reached exactly, so no veto and no batch-limit stop fired.
    expect(stops).toEqual([])
  })

  it('compacts the safe prefix before a reentry blocker instead of deadlocking', async () => {
    const session = wideSession()
    const beforeNodes = [...session.surface.nodes]
    const { engine, agent, compacted, stops } = harness(session, {
      ...WIDE_PLAN,
      canCompactHistory: seq => seq !== beforeNodes[5],
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // Liveness contract, in the two parts that must both hold:
    //
    // 1. The wide span is vetoed by a reentry blocker at node 5, and the planner
    //    backs off to the largest pairing- and step-safe admissible prefix before
    //    it (positions 0..4, 100 tokens > minSpan 10). That prefix is PAID: the
    //    veto did not deadlock the pass, and because a batch was paid the
    //    narrowing is not itself reported as the pass stop.
    // 2. The pass then ends there. Its next fresh plan starts past the batch-1
    //    replacement (`minStartIndex` skips the round-local replacement and the
    //    original it shadowed), which puts the plan's own start position on the
    //    blocker, so this surface state admits NO prefix at all — narrow or wide.
    //    The terminal reason is therefore the veto that actually stopped the
    //    pass, and it is recorded exactly once.
    expect(compacted).toEqual([{ start: beforeNodes[0], end: beforeNodes[4] }])
    expect(stops).toEqual(['reentry-deferred'])
  })

  it('stops with reentry-deferred when no safe prefix exists before the reentry blocker', async () => {
    const session = wideSession()
    const beforeNodes = [...session.surface.nodes]
    const { engine, agent, compacted, stops } = harness(session, {
      ...WIDE_PLAN,
      canCompactHistory: seq => seq !== beforeNodes[0],
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // Blocker at the very head leaves zero admissible prefix: 0 model calls,
    // logged typed stop.
    expect(compacted).toEqual([])
    expect(stops).toEqual(['reentry-deferred'])
  })

  it('stops with tool-stage-deferred when the selected span still owes tool work', async () => {
    const session = wideSession()
    const { engine, agent, compacted, stops } = harness(session, {
      ...WIDE_PLAN,
      pendingToolWork: () => true,
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toEqual([])
    expect(stops).toEqual(['tool-stage-deferred'])
  })

  it('proceeds past inert tool-stage debt with a non-blocking reason', async () => {
    // Pending-SHAPED debt that no actor can act on (an unresolvable span, or
    // groups the audit already refuses) must not defer the pass forever: the
    // history pressure compaction runs and the non-blocking reason is reported.
    const session = wideSession()
    const beforeNodes = [...session.surface.nodes]
    const { engine, agent, compacted, stops, warns } = harness(session, {
      ...WIDE_PLAN,
      pendingToolWork: () => 'inert',
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // Same two cap-bounded batches as the undeffered case: batch 1 (0..11, 240
    // tokens) leaves 820, batch 2 (12..18, 140 tokens) reaches 700 and ends the
    // pass at the exit line. Inert debt is not a veto, so both batches are paid
    // and no typed stop is reported.
    expect(compacted).toEqual([
      { start: beforeNodes[0], end: beforeNodes[11] },
      { start: beforeNodes[12], end: beforeNodes[18] },
    ])
    expect(stops).toEqual([])
    // One non-blocking warning per above-threshold re-plan: 1040 and 820.
    expect(warns.filter(message => message.includes('inert tool-stage debt'))).toHaveLength(2)
  })

  it('logs the first veto when several vetoes apply to the span', async () => {
    const session = wideSession()
    const beforeNodes = [...session.surface.nodes]
    const { engine, agent, compacted, stops } = harness(session, {
      ...WIDE_PLAN,
      canCompactHistory: seq => seq !== beforeNodes[0],
      pendingToolWork: () => true,
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toEqual([])
    expect(stops).toEqual(['reentry-deferred'])
  })

  it('pays for the deficit-sized span before the widest one', async () => {
    // E = 450 on 18 nodes x 20 = 360: T = 810 against the exit line 700 leaves a
    // 110-token deficit. The head outside the 200-token retained tail is
    // positions 0..8 (180 tokens) and Bcap = (1000 - 450 - 300) - 20 = 230, so
    // neither the cap nor the head is binding — and the planner still answers
    // with the DEFICIT-SIZED span: the strict target 110 + minSpan + 1 is first
    // reached by positions 0..5 (120 tokens), and because head and deficit grow
    // together a prefix that reaches the target is preferred over a wider one.
    // Paying those 120 tokens replaces them with a 20-token checkpoint, landing
    // 710, so the next iteration sees 710 > 700 and pays the remainder: the
    // fresh plan starts past the replacement, reaches positions 6..... and lands
    // the request at 690 <= 700 in two batches, stopping AT the exit line.
    const session = sessionWithNodes(18)
    const beforeNodes = [...session.surface.nodes]
    const { engine, agent, compacted, stops, measureTotal } = harness(session, {
      envelopeTokens: 450,
      nodeTokens: 20,
      contextWindow: 1_000,
      overrides: { ...BUDGET_OVERRIDES, responseReserveTokens: 200, safetyMarginTokens: 100 },
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // One paid call: the deficit-sized span covers positions 0..6, which is the
    // first prefix at or above the 110-token target that the planner can hand to
    // the summarizer.
    expect(compacted).toEqual([{ start: beforeNodes[0], end: beforeNodes[6] }])
    expect(stops).toEqual([])
    // 810 - (140 - 20) = 690, at or below the 700-token exit line.
    expect(measureTotal()).toBe(690)
  })

  it('compacts the affordable head a window-fraction partition cannot reach', async () => {
    // S = 200 <= R0 = 200, so a ratio partition would leave both forget and
    // tool zones null. The envelope grant is 50 and the retained tail floors
    // at the two-turn price 40, so the head outside that tail is a real span.
    const session = sessionWithNodes(10)
    const beforeNodes = [...session.surface.nodes]
    const { engine, agent, compacted } = harness(session, {
      envelopeTokens: 650,
      nodeTokens: 20,
      contextWindow: 1_000,
      overrides: { ...BUDGET_OVERRIDES, responseReserveTokens: 20, safetyMarginTokens: 10 },
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    // T = 850 on a 200-token surface with E = 650 against the exit line 700
    // leaves a 150-token deficit; the head outside the 200-token retained tail is
    // positions 0..6 (140 tokens, Bcap 300 is not binding) and it is the widest
    // safe prefix, so the pass pays 140 and lands 730 — still above the exit
    // line, but the surface now holds only 4 nodes and the next plan finds no
    // head of its own, so this invocation ends after the one batch.
    expect(compacted).toEqual([{ start: beforeNodes[0], end: beforeNodes[6] }])
  })

  it('stops with the typed reason when only the live tail plus the envelope can remain', async () => {
    // Three 45-token turns: the guaranteed two-turn tail is 90, so even after
    // the whole 45-token forget zone is shadowed the request stays at 90 >= 80.
    // Bcap is 70 > 0, so this is the zone-budget verdict, not the call cap.
    const session = sessionWithNodes(3)
    const { engine, agent, compacted, stops } = harness(session, {
      nodeTokens: 45,
      overrides: { ...BUDGET_OVERRIDES, responseReserveTokens: 5, safetyMarginTokens: 5 },
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toEqual([])
    expect(stops).toEqual(['envelope-dominated'])
    // The memo suppresses a repeat stop inside the same pressure/surface state.
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(stops).toEqual(['envelope-dominated'])
  })

  it('spans the whole head when the envelope is negligible', async () => {
    const session = sessionWithNodes(12)
    const beforeNodes = [...session.surface.nodes]
    const { engine, agent, compacted } = harness(session, {
      // Reserve plus margin leave Bcap = 70, exactly the forget zone price.
      // T = 120 against the exit line 70 gives reclaim 50; the strict target
      // 50 + minSpan + 1 is unreachable under the 70-token cap, so the planner
      // answers with the widest safe prefix — the whole 70-token head, positions
      // 0..6, which is exactly Bcap. Paying it lands 60 <= 70 in ONE batch.
      overrides: { ...BUDGET_OVERRIDES, responseReserveTokens: 5, safetyMarginTokens: 5 },
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toEqual([{ start: beforeNodes[0], end: beforeNodes[6] }])
  })

  it('reopens the envelope-dominated veto when new surface state arrives', async () => {
    const session = sessionWithNodes(12)
    const { engine, agent, compacted, stops } = harness(session, {
      envelopeTokens: 90,
      overrides: BUDGET_OVERRIDES,
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(stops).toEqual(['envelope-dominated'])
    // New turns append surface nodes without landing a replacement, so the
    // generation is unchanged — the memo must still reopen because the state
    // it was derived from no longer describes the session.
    addAssistantText(session, 13, 'late-1')
    addAssistantText(session, 14, 'late-2')
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toEqual([])
    expect(stops).toEqual(['envelope-dominated', 'envelope-dominated'])
  })

  it('reopens the no-progress memo when new surface state arrives', async () => {
    const session = sessionWithNodes(12)
    const { engine, agent, compacted, stops } = harness(session, {
      noProgress: true,
      overrides: BUDGET_OVERRIDES,
    })
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toHaveLength(1)
    expect(stops).toEqual(['no-progress'])
    // New turns arrive: the pass is allowed to pay again, and a fresh
    // no-progress verdict is recorded for the new state.
    addAssistantText(session, 13, 'late-1')
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toHaveLength(2)
    expect(stops).toEqual(['no-progress', 'no-progress'])
  })
})

describe('envelope-budget configuration', () => {
  it('resolves the default reserve and margin into the policy and spec', () => {
    const policy = resolveTargetPolicy(resolveConfig({}), { provider: 'mock', model: 'm' })
    expect(policy.responseReserveTokens).toBe(8_192)
    expect(policy.safetyMarginTokens).toBe(2_048)
    const spec = resolveCompactSpec(policy, 100_000)
    expect(spec.responseReserveTokens).toBe(8_192)
    expect(spec.safetyMarginTokens).toBe(2_048)
  })

  it('refuses a reserve plus margin that alone fills the window', () => {
    const tight = resolveTargetPolicy(resolveConfig({
      responseReserveTokens: 600,
      safetyMarginTokens: 500,
    }), { provider: 'mock', model: 'm' })
    expect(() => resolveCompactSpec(tight, 1_000)).toThrow(TargetPressureConfigError)
  })

  it('rejects malformed envelope-budget values', () => {
    expect(() => resolveConfig({ responseReserveTokens: -1 })).toThrow(/responseReserveTokens.*non-negative integer/)
    expect(() => resolveConfig({ safetyMarginTokens: 1.5 })).toThrow(/safetyMarginTokens.*non-negative integer/)
  })

  it('inherits the budgets through an exact model override', () => {
    const config = resolveConfig({
      responseReserveTokens: 30,
      safetyMarginTokens: 20,
      modelPolicies: [{ provider: 'mock', model: 'm', safetyMarginTokens: 40 }],
    })
    const inherited = resolveTargetPolicy(config, { provider: 'mock', model: 'other' })
    expect([inherited.responseReserveTokens, inherited.safetyMarginTokens]).toEqual([30, 20])
    const overridden = resolveTargetPolicy(config, { provider: 'mock', model: 'm' })
    expect([overridden.responseReserveTokens, overridden.safetyMarginTokens]).toEqual([30, 40])
  })
})

describe('envelope zone boundaries', () => {
  const INPUT = {
    pressureTokens: 80,
    forgetWatermarkTokens: 70,
    forgetBoundaryTokens: 50,
    retainTokens: 20,
    minRetainTokens: 12,
  }

  it('derives the waterline grant and clamps the forget boundary to it', () => {
    // E = 40 -> G = 30; the forget boundary narrows to G and the tail is
    // max(12, min(30, 20)) = 20.
    const budget = resolveEnvelopeZoneBudget({ totalTokens: 70, surfaceTokens: 30 }, INPUT)
    expect(budget.envelopeTokens).toBe(40)
    expect(budget.waterlineGrantTokens).toBe(30)
    expect(budget.forgetBoundaryTokens).toBe(30)
    expect(budget.retainedTailTokens).toBe(20)
    expect(budget.deficitTokens).toBe(0)
    expect(budget.envelopeDominated).toBe(false)
  })

  it('floors the retained tail at the live working tail and never widens the legacy boundary', () => {
    // E = 65 -> G = 5: the tail keeps its live floor and the boundary is G.
    const tight = resolveEnvelopeZoneBudget({ totalTokens: 90, surfaceTokens: 25 }, INPUT)
    expect(tight.waterlineGrantTokens).toBe(5)
    expect(tight.forgetBoundaryTokens).toBe(5)
    expect(tight.retainedTailTokens).toBe(12)
    expect(tight.deficitTokens).toBe(20)
    // A healthy envelope leaves the legacy boundary and tail untouched.
    const healthy = resolveEnvelopeZoneBudget({ totalTokens: 30, surfaceTokens: 30 }, INPUT)
    expect(healthy.waterlineGrantTokens).toBe(70)
    expect(healthy.forgetBoundaryTokens).toBe(50)
    expect(healthy.retainedTailTokens).toBe(20)
  })

  it('reports domination only when even the floored tail cannot end pressure', () => {
    // E + floored tail = 68 + 12 = 80 >= 80: no span can bring T below 80.
    expect(resolveEnvelopeZoneBudget({ totalTokens: 80, surfaceTokens: 12 }, INPUT).envelopeDominated).toBe(true)
    // E + tail = 66 + 12 = 78 < 80: a full reduction still ends the state.
    expect(resolveEnvelopeZoneBudget({ totalTokens: 79, surfaceTokens: 13 }, INPUT).envelopeDominated).toBe(false)
  })

  it('agrees with the auxiliary-call budget on the affordable retained tail', () => {
    const callInput = {
      contextWindow: 100,
      responseReserveTokens: 20,
      safetyMarginTokens: 10,
      instructionTokens: 10,
      summaryMaxTokens: 10,
      retainTokens: 20,
      minRetainTokens: 12,
    }
    for (const [totalTokens, surfaceTokens] of [[70, 30], [90, 25], [30, 30]] as const) {
      const call = resolveEnvelopeBudget({ totalTokens, surfaceTokens }, callInput)
      const zone = resolveEnvelopeZoneBudget({ totalTokens, surfaceTokens }, INPUT)
      expect(zone.retainedTailTokens).toBe(call.retainedTailTokens)
    }
  })
})

describe('absolute zone boundaries', () => {
  const RATIOS = { recentRatio: 0.20, forgetBoundaryRatio: 0.50, contextWindow: 100 }
  const DRIFT_WINDOW = 40_217
  const DRIFT_BOUNDARY = 25_181

  /** One snapshot with explicit per-node prices in surface order. */
  function priced(session: Session, prices: readonly number[]): TokenMeasurement {
    const nodes = session.surface.nodes.map((seq, index) => ({
      seq,
      tokens: prices[index] ?? 0,
      heuristicTokens: prices[index] ?? 0,
    }))
    const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0)
    return {
      totalTokens: surfaceTokens,
      surfaceTokens,
      nodes,
      logRevision: 0,
      baseline: { kind: 'estimated', tokens: 0 },
      surfaceDeltaTokens: surfaceTokens,
    } as unknown as TokenMeasurement
  }

  it('applies an absolute boundary exactly instead of round-tripping it through a ratio', () => {
    // This window/boundary pair drifts one token below the exact budget when it
    // is expressed as `floor(capacity * (tokens / capacity))`.
    expect(Math.floor(DRIFT_WINDOW * (DRIFT_BOUNDARY / DRIFT_WINDOW))).toBe(DRIFT_BOUNDARY - 1)
    const session = Session.create(SessionId('absolute-boundary'))
    addAssistantText(session, 1, 'a')
    addAssistantText(session, 2, 'b')
    addAssistantText(session, 3, 'c')
    const priced_ = priced(session, [10, 10, 25_180])
    const ratio = DRIFT_BOUNDARY / DRIFT_WINDOW

    const absolute = partitionSurfaceZones(session, priced_, {
      recentRatio: ratio,
      forgetBoundaryRatio: 0.5,
      contextWindow: DRIFT_WINDOW,
      recentBoundaryTokens: DRIFT_BOUNDARY,
      forgetBoundaryTokens: DRIFT_BOUNDARY,
    })
    expect(absolute.recentBoundaryTokens).toBe(DRIFT_BOUNDARY)
    expect(absolute.forgetBoundaryTokens).toBe(DRIFT_BOUNDARY)
    // The exact budget needs the last two nodes; the drifted one stops one node
    // later, which is where a tool pair or step would have been split.
    expect(absolute.recent?.startIndex).toBe(1)

    const drifted = partitionSurfaceZones(session, priced_, {
      recentRatio: ratio,
      forgetBoundaryRatio: 0.5,
      contextWindow: DRIFT_WINDOW,
    })
    expect(drifted.recentBoundaryTokens).toBe(DRIFT_BOUNDARY - 1)
    expect(drifted.recent?.startIndex).toBe(2)
  })

  it('keeps the ratio arithmetic exactly when no absolute boundary is supplied', () => {
    const session = Session.create(SessionId('ratio-boundary'))
    for (let turn = 1; turn <= 12; turn += 1) addAssistantText(session, turn, `t${turn}`)
    const zones = partitionSurfaceZones(session, measurement(session), RATIOS)
    expect(zones.recentBoundaryTokens).toBe(20)
    expect(zones.forgetBoundaryTokens).toBe(50)
    expect(zones.recent?.startIndex).toBe(10)
    expect(zones.forget?.tokens).toBe(70)
    expect(zones.tool?.tokens).toBe(30)
  })
})

describe('envelope-budget partition dead zone', () => {
  const RATIOS = { recentRatio: 0.20, forgetBoundaryRatio: 0.50, contextWindow: 100 }
  const INPUT = {
    pressureTokens: 80,
    forgetWatermarkTokens: 70,
    forgetBoundaryTokens: 50,
    retainTokens: 20,
    minRetainTokens: 12,
  }

  it('partitions a forget zone the legacy fraction cannot reach', () => {
    const session = Session.create(SessionId('partition-dead-zone'))
    for (let turn = 1; turn <= 3; turn += 1) addAssistantText(session, turn, `t${turn}`)
    const priced = measurement(session, 6, 62)
    // S = 18 <= R0 = 20 and S < F_b = 50: legacy leaves every reduction path
    // empty (the F6/F7 dead zone).
    const legacy = partitionSurfaceZones(session, priced, RATIOS)
    expect(legacy.forget).toBeNull()
    expect(legacy.tool).toBeNull()

    // E = 62 -> G = 8 and the two-turn tail floors at 12, so the head outside
    // the affordable tail becomes the forget zone.
    const zoneBudget = resolveEnvelopeZoneBudget(priced, INPUT)
    expect(zoneBudget.waterlineGrantTokens).toBe(8)
    expect(zoneBudget.forgetBoundaryTokens).toBe(8)
    expect(zoneBudget.retainedTailTokens).toBe(12)
    const envelope = partitionSurfaceZones(session, priced, {
      ...RATIOS,
      recentBoundaryTokens: zoneBudget.retainedTailTokens,
      forgetBoundaryTokens: zoneBudget.forgetBoundaryTokens,
    })
    expect(envelope.forget?.tokens).toBe(6)
    expect(envelope.recent?.tokens).toBe(12)
  })

  it('clamps a mid-range envelope boundary without disturbing a healthy one', () => {
    const session = Session.create(SessionId('partition-clamp'))
    for (let turn = 1; turn <= 11; turn += 1) addAssistantText(session, turn, `t${turn}`)
    // E = 25 -> G = 45 < F_b = 50: the forget zone ends at the affordable tail
    // distance instead of the window fraction.
    const priced = measurement(session, 5, 25)
    const tight = resolveEnvelopeZoneBudget(priced, INPUT)
    expect(tight.forgetBoundaryTokens).toBe(45)
    const clamped = partitionSurfaceZones(session, priced, {
      ...RATIOS,
      recentBoundaryTokens: tight.retainedTailTokens,
      forgetBoundaryTokens: tight.forgetBoundaryTokens,
    })
    expect(clamped.forgetBoundaryTokens).toBe(45)
    expect(clamped.forget?.tokens).toBe(10)
    // E = 0 keeps the legacy boundary: min(F_b, G) = F_b.
    const healthy = resolveEnvelopeZoneBudget(measurement(session, 5, 0), INPUT)
    expect(healthy.forgetBoundaryTokens).toBe(50)
  })
})
