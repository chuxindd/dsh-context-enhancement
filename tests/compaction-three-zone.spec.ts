import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { ToolResultPruner } from '../src/tool-result-pruner.ts'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../src/internal/compaction/config.ts'
import { resolveConfig as resolvePrunerConfig } from '../src/internal/compaction/pruner-config.ts'
import { buildSurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import { replaceToolGroup } from '../src/internal/compaction/tool-group-replacement.ts'
import { buildToolGroupSummaryInput } from '../src/internal/compaction/tool-group-summary.ts'
import { partitionSurfaceZones, planForgetBatch, planPressureSpan, selectForgetBatch } from '../src/internal/compaction/zones.ts'
import type { SurfaceZones } from '../src/internal/compaction/zones.ts'

const SURFACE = { surfaceOp: 'append' as const }

function addToolStep(session: Session, turn: number, step: number, id: string, text = `${id} result`): void {
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
    message: createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text }], isError: false }),
  }, SURFACE)
}

/**
 * Price one replacement message the way the producers' pricing seam does: a
 * formatted tool-group summary prices below the node it shadows, a raw result
 * above it, so the per-node shrink guard lets the summary land.
 */
function reductionPricing(message: { readonly content: readonly ContentBlock[] }): number {
  const block = message.content[0]
  const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
  return text.includes('[tool group summary]') ? 1 : 100
}

/**
 * Land a REAL semantic tool-group summary over one tool step, exactly the way the
 * engine does: select the step's own group, then replace it through the real
 * `replaceToolGroup`. The Session log then carries the reduction's durable
 * provenance, which is what every classification in this file reads.
 */
function summarizedReplacement(session: Session, resultSeq: SessionSeq): SessionSeq {
  const group = selectToolGroups(session, {
    minGroupResults: 1,
    minGroupChars: 1,
    minGroupTokens: 1,
    maxGroupTokens: 1_000_000,
    maxGroups: 1,
    estimateTokens: () => 1,
  })[0]
  if (group === undefined) throw new Error('fixture: no tool group selected')
  if (!group.toolResultSeqs.includes(resultSeq)) throw new Error('fixture: the selected group is not the expected tool step')
  const input = buildToolGroupSummaryInput(session, group)
  const landed = replaceToolGroup(session, group, {
    version: 1,
    groupSummary: 'done',
    items: input.items.map(item => ({
      sourceSeq: item.sourceSeq,
      ...(item.callId === undefined ? {} : { callId: item.callId }),
      summary: 'done',
      facts: [],
      files: [],
      identifiers: [],
      errors: [],
      unresolved: [],
    })),
    groupErrors: [],
    unresolved: [],
  }, { estimateTokens: reductionPricing })
  const replacementSeq = landed.replacementSeqs[0]
  if (replacementSeq === undefined) throw new Error('fixture: the summary did not land')
  return replacementSeq
}

/** Land a REAL deterministic prune of one over-budget tool result. */
function prunedReplacement(session: Session, resultSeq: SessionSeq): SessionSeq {
  const pruner = Object.assign(Object.create(ToolResultPruner.prototype) as ToolResultPruner, {
    config: resolvePrunerConfig({ thresholdChars: 64, headChars: 8, tailChars: 8 }),
    ctx: { tokenMeter: { estimateMessage: () => 10 } },
  })
  const result = pruner.pruneSession(session, { candidateSeqs: [resultSeq] })
  const entry = result.pruned[0]
  if (entry === undefined) throw new Error('fixture: the pruner landed no replacement')
  return entry.replacementSeq
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

/**
 * One turn-carrying surface node. The engine's guaranteed retained-tail floor
 * prices the two newest distinct turns, so engine-scheduling sessions must be
 * built from turn-carrying nodes for the two-turn tail to be a bounded price.
 */
function addTurnNode(session: Session, turn: number): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `assistant-${turn}` }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
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

describe('pressure span planning', () => {
  const RATIOS = { recentRatio: 0.2, forgetBoundaryRatio: 0.5, contextWindow: 100 }

  function options(over: Partial<Parameters<typeof planPressureSpan>[3]> = {}): Parameters<typeof planPressureSpan>[3] {
    return { reclaimTokens: 20, inputCapTokens: 200, minSpanTokens: 10, ...over }
  }

  function addUser(session: Session, index: number): void {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `message-${index}` }],
      source: { kind: 'user' },
    }), SURFACE)
  }

  function addAssistantText(session: Session, turn: number, step: number, index: number): void {
    session.append('assistant/message', {
      turn,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `assistant-${index}` }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, SURFACE)
  }

  it('selects the deficit-sized prefix: the smallest span that can end pressure', () => {
    const session = Session.create(SessionId('pressure-span-deficit'))
    for (let index = 0; index < 12; index += 1) addUser(session, index)
    const priced = measurement(session)
    const zones = partitionSurfaceZones(session, priced, RATIOS)
    // 12 nodes / 120 tokens; reclaim 20 + minSpan 10 + 1 = 31, so the first
    // safe prefix priced >= 31 is the 4-node / 40-token prefix — well before
    // the retained tail (recent.startIndex 10), which is never touched.
    const plan = planPressureSpan(session, priced, zones, options({ reclaimTokens: 20 }))
    expect(plan.kind).toBe('selected')
    if (plan.kind !== 'selected') return
    expect(plan.range.startIndex).toBe(0)
    expect(plan.range.endIndex).toBe(3)
    expect(plan.range.tokens).toBe(40)
    expect(plan.range.endIndex).toBeLessThan(zones.recent!.startIndex)
  })

  it('promises progress potential, not one-pass deficit clearance', () => {
    // 12 nodes / 120 tokens; reclaim 20 puts the threshold at 100. The planner
    // answers with the 4-node / 40-token deficit-sized prefix. The BEST legal
    // replacement — priced at the 10-token checkpoint floor — ends pressure
    // (120 - 40 + 10 = 90 < 100), but the WORST legal replacement — one token
    // under the span, which the region shrink assertion accepts — reclaims a
    // single token and leaves the request above threshold. The planner only
    // guarantees a safe, shrink-capable span; ending pressure is the engine's
    // re-measure/re-plan responsibility, never a planner claim.
    const session = Session.create(SessionId('pressure-span-progress-only'))
    for (let index = 0; index < 12; index += 1) addUser(session, index)
    const priced = measurement(session)
    const totalTokens = 120
    const thresholdTokens = 100
    const zones = partitionSurfaceZones(session, priced, RATIOS)
    const plan = planPressureSpan(session, priced, zones, options({ reclaimTokens: 20 }))
    expect(plan.kind).toBe('selected')
    if (plan.kind !== 'selected') return
    const span = plan.range
    expect(span.tokens).toBe(40)
    const floor = options().minSpanTokens
    // Progress potential: the span prices above the checkpoint floor, so a
    // strict-shrink replacement exists (floor <= replacement < span.tokens).
    expect(span.tokens).toBeGreaterThan(floor)
    // Best case — replacement priced at the floor — ends pressure...
    expect(totalTokens - (span.tokens - floor)).toBeLessThan(thresholdTokens)
    // ...while the worst legal replacement (span - 1) does not.
    expect(totalTokens - 1).toBeGreaterThanOrEqual(thresholdTokens)
  })

  it('falls back to the widest safe prefix under the cap when the deficit is unreachable', () => {
    const session = Session.create(SessionId('pressure-span-widest'))
    for (let index = 0; index < 12; index += 1) addUser(session, index)
    const priced = measurement(session)
    const zones = partitionSurfaceZones(session, priced, RATIOS)
    // reclaim 1000 is unreachable under cap 60, but head and deficit grow
    // together, so the widest safe prefix under the cap still wins: the
    // 6-node / 60-token prefix.
    const plan = planPressureSpan(session, priced, zones, options({ reclaimTokens: 1000, inputCapTokens: 60 }))
    expect(plan.kind).toBe('selected')
    if (plan.kind !== 'selected') return
    expect(plan.range.endIndex).toBe(5)
    expect(plan.range.tokens).toBe(60)
    expect(plan.range.endIndex).toBeLessThan(zones.recent!.startIndex)
  })

  it('keeps a tool pair whole even when the deficit ends inside it', () => {
    const session = Session.create(SessionId('pressure-span-pair'))
    addUser(session, 0)
    addToolStep(session, 1, 1, 'span-tool')
    addUser(session, 3)
    addUser(session, 4)
    addUser(session, 5)
    const priced = measurement(session)
    const zones = partitionSurfaceZones(session, priced, RATIOS)
    // Nodes: user, call, result, user, user, user (6 nodes / 60 tokens);
    // recent.startIndex 4. reclaim 15 + minSpan 10 + 1 = 26: the 2-node
    // prefix (20) is under the target AND ends inside the open pair, so the
    // deficit-sized answer is the 3-node / 30-token prefix closing the pair.
    const plan = planPressureSpan(session, priced, zones, options({ reclaimTokens: 15 }))
    expect(plan.kind).toBe('selected')
    if (plan.kind !== 'selected') return
    expect(plan.range.endIndex).toBe(2)
    expect(plan.range.tokens).toBe(30)
  })

  it('blocks with envelope-dominated when no auxiliary call fits the window', () => {
    const session = Session.create(SessionId('pressure-span-dominated'))
    for (let index = 0; index < 12; index += 1) addUser(session, index)
    const priced = measurement(session)
    const zones = partitionSurfaceZones(session, priced, RATIOS)
    expect(planPressureSpan(session, priced, zones, options({ inputCapTokens: 0 })))
      .toEqual({ kind: 'blocked', reason: 'envelope-dominated' })
  })

  it('blocks with span-below-minimum when every safe prefix cannot satisfy the shrink assertion', () => {
    const session = Session.create(SessionId('pressure-span-below-min'))
    for (let index = 0; index < 5; index += 1) addUser(session, index)
    const priced = measurement(session)
    const zones = partitionSurfaceZones(session, priced, RATIOS)
    // The widest safe prefix is 40 tokens (recent.startIndex 3); a minSpan of
    // 100 shadows it with a summary as expensive as itself.
    expect(planPressureSpan(session, priced, zones, options({ minSpanTokens: 100 })))
      .toEqual({ kind: 'blocked', reason: 'span-below-minimum' })
  })

  it('blocks with no-safe-prefix when no node sits outside the retained tail', () => {
    const session = Session.create(SessionId('pressure-span-no-head'))
    for (let index = 0; index < 5; index += 1) addUser(session, index)
    const priced = measurement(session)
    // A 50-token retained-tail budget covers the whole 50-token surface, so the
    // partition leaves every node inside the tail and the planner has no head
    // to shadow.
    const zones = partitionSurfaceZones(session, priced, {
      recentRatio: 0.2,
      forgetBoundaryRatio: 0.5,
      contextWindow: 100,
      recentBoundaryTokens: 50,
      forgetBoundaryTokens: 50,
    })
    expect(zones.recent!.startIndex).toBe(0)
    expect(planPressureSpan(session, priced, zones, options()))
      .toEqual({ kind: 'blocked', reason: 'no-safe-prefix' })
  })

  it('blocks with no-safe-prefix when every prefix over-caps before a safe end', () => {
    const session = Session.create(SessionId('pressure-span-unsafe'))
    // One step covers the whole head, so no prefix boundary is a step boundary
    // and the walk cannot record a safe end before the cap (25) is exceeded.
    for (let index = 0; index < 3; index += 1) addAssistantText(session, 1, 1, index)
    const priced = measurement(session)
    const zones = partitionSurfaceZones(session, priced, RATIOS)
    expect(planPressureSpan(session, priced, zones, options({ inputCapTokens: 25 })))
      .toEqual({ kind: 'blocked', reason: 'no-safe-prefix' })
  })
})

describe('three-zone engine scheduling', () => {
  function sessionWithNodes(count: number): Session {
    const session = Session.create(SessionId(`engine-${count}`))
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    for (let index = 0; index < count; index += 1) addTurnNode(session, index + 1)
    return session
  }

  function engineHarness(
    session: Session,
    overrides: Partial<Parameters<typeof resolveConfig>[0]> = {},
    envelopeTokens = 0,
  ): {
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
        const surfaceTokens = nodes.length * 10
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
      recentRatio: 0.2,
      forgetBoundaryRatio: 0.5,
      toolMaintenanceRatio: 0.4,
      forgetMaintenanceRatio: 0.7,
      pressureRatio: 0.8,
      targetBatchTokens: 20,
      maxBatchTokens: 30,
      maxMaintenanceBatches: 1,
      maxPressureBatches: 2,
      // Reserve/margin validation is unconditional: a 100-token harness window
      // must size the held-free budgets and the summary cap explicitly, or the
      // defaults (8192 + 2048) refuse the configuration outright.
      responseReserveTokens: 5,
      safetyMarginTokens: 5,
      maxTokens: 10,
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
      summarizeToolGroups: async () => undefined,
      sourceIndex: (current: Session) => buildSurfaceSourceIndex(current),
      hasPendingToolIntermediateWork: () => 'none',
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
    // Exercise the real unified seams — the envelope-aware partition, both
    // envelope budgets, and the stop memo are production code; only I/O is
    // faked.
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
    return { engine, agent, compacted, stops }
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

  it('compacts the deficit-sized span in ONE call when pressure is reached, ignoring the batch cap', async () => {
    const session = sessionWithNodes(12)
    const { engine, agent, compacted } = engineHarness(session)
    // 12 * 10 = 120 >= pressure 80, and the exit line is floor(100 x 0.70) = 70,
    // so reclaim = 120 - 70 = 50 against Bcap = 70: the strict target
    // 50 + 10 + 1 = 61 is first reached by the 7-node / 70-token prefix, which is
    // exactly the whole older head (positions 0..6) — well past the 30-token
    // maintenance batch cap, and NOT the forget zone the fraction partition
    // reported (0..6 by coincidence here, but chosen by deficit, not by zone).
    // The pressure tier pays for that one span in a single semantic call and
    // never touches the retained tail (positions 10..11). The harness
    // replacement is priced at the 10-token checkpoint floor — the BEST legal
    // replacement — which is why this one pass reaches 60 <= 70 and the
    // invocation ends there; the worst legal case (a replacement one token under
    // the span) is the counterexample regression in
    // compaction-envelope-budget.spec.ts.
    const beforeNodes = [...session.surface.nodes]
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    expect(compacted).toHaveLength(1)
    expect(compacted[0]!.start).toBe(beforeNodes[0])
    expect(compacted[0]!.end).toBe(beforeNodes[6])
    // One replacement collapsed 7 nodes into 1: 6 nodes remain, below the
    // 8-node pressure threshold.
    expect(session.surface.nodes).toHaveLength(6)
    expect(session.surface.nodes).toContain(beforeNodes[10])
    expect(session.surface.nodes).toContain(beforeNodes[11])
  })

  it('pressure span folds a tool summary produced by an EARLIER invocation once new dialogue grew past it', async () => {
    // Product timeline: an earlier 70% tool-governance pass replaced the raw
    // tool result with a durable tool summary while that head sat inside ITS
    // forget zone. More dialogue then accumulated in the same turn (no turn/end
    // after the replacement yet), pushing the surface to 80%. This LATER pressure
    // invocation must fold that now-historical summary into the one semantic
    // compact. The completed-turn deferral exists to
    // keep a replacement younger than the newest request; a replacement inside
    // the current forget zone necessarily has newer surface content after it and
    // is therefore historical, regardless of turn/end boundaries.
    const session = Session.create(SessionId('engine-reentry-aged'))
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    // Surface order: one turn node (0), one tool step (call at 1, result at 2),
    // then nine more turn nodes (3..11) => 12 nodes / 120 tokens >= pressure 80.
    // The guaranteed 2-node tail (10..11) leaves the planner's older head at
    // positions 0..9, which includes the (now replaced) tool result at 2.
    addTurnNode(session, 1)
    addToolStep(session, 2, 1, 'guard-tool')
    for (let turn = 3; turn <= 11; turn += 1) addTurnNode(session, turn)
    const toolResultSeq = session.surface.nodes[2]!
    // Land the durable outcome of the earlier 70% governance pass through the
    // REAL summary producer: the raw result is replaced by a tool summary whose
    // provenance the Session log itself carries, so the classification below
    // needs no audit document at all. It has 0 completed turns after it (the
    // growth happened inside the same turn), so the old completed-turn deferral
    // would have blocked it.
    const replacementSeq = summarizedReplacement(session, toolResultSeq)
    const harness = engineHarness(session)
    const engine = harness.engine as unknown as {
      logPressureStop: (reason: string) => void
    }
    const originalLog = engine.logPressureStop
    engine.logPressureStop = (reason: string) => { harness.stops.push(reason); originalLog(reason) }
    const beforeNodes = [...session.surface.nodes]
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, harness.agent, 'pressure', new AbortController().signal)
    // ONE deficit-sized compact over the older head including the aged tool
    // summary: the exit line is 70, so reclaim = 50 makes the strict target
    // 50 + 10 + 1 = 61, first reached by the 7-node / 70-token prefix 0..6 — the
    // replacement is not excluded just because it was once a tool summary, and no
    // re-entry/same-pass deferral fires.
    expect(harness.compacted).toHaveLength(1)
    expect(harness.compacted[0]!.start).toBe(beforeNodes[0])
    expect(harness.compacted[0]!.end).toBe(beforeNodes[6])
    expect(beforeNodes).toContain(replacementSeq)
    expect(harness.stops).not.toContain('reentry-deferred')
    expect(harness.stops).not.toContain('same-pass-tool-replacement')
  })

  it('blocks the pressure span when THIS same invocation just produced the tool summary', async () => {
    // Same 80% surface as above, but the durable tool summary is created by the
    // very invocation that then reaches the span guard. The round-local
    // exclusion set is what must stop the pass: the fresh intermediate has not
    // been served by a single request yet, so it cannot be folded into the same
    // call's semantic compact even though a source index would call it known.
    const session = Session.create(SessionId('engine-same-pass'))
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    addTurnNode(session, 1)
    addToolStep(session, 2, 1, 'same-pass-tool')
    for (let turn = 3; turn <= 11; turn += 1) addTurnNode(session, turn)
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

  it('extends the pressure span over the older head the envelope-clamped partition carves out', async () => {
    // 4 nodes / 40 surface tokens sit below the legacy 50-token forget
    // boundary, but a 40-token request envelope (system prompt, tool schemas,
    // provider anchor) pushes total pressure to exactly the 80% threshold.
    // The envelope-aware partition clamps the forget boundary to the
    // affordable grant (min(50, 70-40) = 30), so the head outside the
    // guaranteed 2-node tail IS the forget zone and the unified planner
    // releases the 2-node / 20-token deficit-sized span (reclaim 0 +
    // minSpan 10 + 1 = 11, first reached by 20 tokens). Under the legacy
    // partition this pass stopped with `no-forget-range` on every step.
    const session = sessionWithNodes(4)
    const harness = engineHarness(session, {}, 40)
    const beforeNodes = [...session.surface.nodes]
    await BasicCompactionEngine.prototype.compactIfNeeded.call(harness.engine, harness.agent, 'pressure', new AbortController().signal)
    expect(harness.compacted).toHaveLength(1)
    expect(harness.compacted[0]!.start).toBe(beforeNodes[0])
    expect(harness.compacted[0]!.end).toBe(beforeNodes[1])
    expect(harness.stops).not.toContain('no-forget-range')
    expect(harness.stops).not.toContain('envelope-dominated')
    expect(harness.stops).not.toContain('no-safe-prefix')
    // The 2-node older head collapsed into one node; the 2 newest nodes are the
    // retained tail and stay verbatim.
    expect(session.surface.nodes).toHaveLength(3)
    expect(session.surface.nodes.slice(1)).toEqual([beforeNodes[2], beforeNodes[3]])
  })

  it('still defers the pressure span when THIS invocation replaced content inside it', async () => {
    const session = sessionWithNodes(5)
    const harness = engineHarness(session, {}, 40)
    const engine = harness.engine as unknown as {
      summarizeToolGroups: (
        agent: Agent,
        target: { provider: string; model: string },
        policy: ReturnType<typeof resolveTargetPolicy>,
        olderRange: { startSeq: SessionSeq; endSeq: SessionSeq } | null,
        signal: AbortSignal,
        roundReplacements: Set<SessionSeq>,
      ) => Promise<void>
    }
    engine.summarizeToolGroups = async (_agent, _target, _policy, olderRange, _signal, roundReplacements) => {
      if (olderRange === null) return
      const nodes = [...session.surface.nodes]
      const startIdx = nodes.indexOf(olderRange.startSeq)
      const endIdx = nodes.indexOf(olderRange.endSeq)
      if (startIdx < 0 || endIdx < startIdx) return
      const target = nodes[startIdx]!
      const event = session.eventAt(target)!
      // Replace in place with the SAME event type: the surface nodes are
      // turn-carrying assistant messages, and re-appending their data as a
      // user/message would carry no `source` for the source index to read.
      const landed = session.append(event.type as 'assistant/message', event.data as never, {
        surfaceOp: { op: 'replace', start: target, end: target },
        sourceEventSeqs: [target],
      })
      roundReplacements.add(landed.seq)
    }
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine as unknown as BasicCompactionEngine, harness.agent, 'pressure', new AbortController().signal)
    expect(harness.compacted).toEqual([])
    expect(harness.stops).toContain('same-pass-tool-replacement')
  })

  it('folds an earlier-invocation replacement the pressure span contains', async () => {
    // Product timeline: an earlier governance pass replaced the raw head tool
    // result with a durable tool summary. No turn ended since, so the
    // completed-turn deferral alone would block it — but the span now
    // contains it while newer surface content (the retained tail) exists after
    // it, so the re-entry relaxation must apply to the planner span too.
    const session = Session.create(SessionId('engine-head-reentry-aged'))
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    // Surface order: one turn node (0), one tool step (call at 1, result at 2),
    // then two more turn nodes (3, 4) => 5 nodes / 50 tokens. The 40-token
    // envelope clamps the forget boundary to 30 tokens, so forget = [0, 1],
    // tool = [2, 2] and the planner's older head is positions 0..2, containing
    // the (now replaced) tool result at position 2.
    addTurnNode(session, 1)
    addToolStep(session, 2, 1, 'head-tool')
    addTurnNode(session, 3)
    addTurnNode(session, 4)
    const toolResultSeq = session.surface.nodes[2]!
    // The durable provenance the Session log itself carries is what classifies
    // this node: no audit document takes part in this test at all.
    const replacementSeq = summarizedReplacement(session, toolResultSeq)
    const harness = engineHarness(session, {}, 40)
    const beforeNodes = [...session.surface.nodes]
    await BasicCompactionEngine.prototype.compactIfNeeded.call(harness.engine, harness.agent, 'pressure', new AbortController().signal)
    expect(harness.compacted).toHaveLength(1)
    expect(harness.compacted[0]!.start).toBe(beforeNodes[0])
    expect(harness.compacted[0]!.end).toBe(beforeNodes[2])
    expect(beforeNodes).toContain(replacementSeq)
    expect(harness.stops).not.toContain('reentry-deferred')
    expect(harness.stops).not.toContain('same-pass-tool-replacement')
  })

  it('extends the pressure span past a sliver forget zone the bounded batch cannot release', async () => {
    // 6 nodes / 60 surface tokens with a 25-token envelope: the affordable
    // grant clamps the forget boundary to min(50, 70-25) = 45 tokens, leaving
    // a 1-node / 10-token sliver forget zone [0, 0] with the 2-node guaranteed
    // tail behind it. T = 85 against the exit line 70 leaves a 15-token deficit,
    // so compacting that sliver alone could not end pressure; the unified planner
    // reaches across it and selects the deficit-sized 3-node / 30-token span
    // (reclaim 15 + minSpan 10 + 1 = 26, first reached by 30 tokens, under
    // Bcap 45) in ONE call, landing 65 <= 70; the retained tail stays.
    const session = sessionWithNodes(6)
    const harness = engineHarness(session, {}, 25)
    const beforeNodes = [...session.surface.nodes]
    await BasicCompactionEngine.prototype.compactIfNeeded.call(harness.engine, harness.agent, 'pressure', new AbortController().signal)
    expect(harness.compacted).toHaveLength(1)
    expect(harness.compacted[0]!.start).toBe(beforeNodes[0])
    expect(harness.compacted[0]!.end).toBe(beforeNodes[2])
    expect(harness.stops).not.toContain('no-forget-range')
    expect(session.surface.nodes).toHaveLength(4)
    expect(session.surface.nodes.slice(1)).toEqual([beforeNodes[3], beforeNodes[4], beforeNodes[5]])
  })

  it('stops when THIS invocation replaced content inside the span even though the sliver forget zone excludes it', async () => {
    // Same sliver geometry, and the fresh replacement lands on node 1 (the
    // tool zone) OUTSIDE the 1-node sliver forget zone [0, 0]. The unified
    // contract plans exactly one span whose own sizing is the only retry a
    // vetoed wider plan could have had: the deficit-sized span [0, 1] contains
    // the fresh replacement, so the same-pass guard stops the pass and nothing
    // compacts — the guard is span-wide, not zone-scoped.
    const session = sessionWithNodes(6)
    const harness = engineHarness(session, {}, 25)
    const engine = harness.engine as unknown as {
      summarizeToolGroups: (
        agent: Agent,
        target: { provider: string; model: string },
        policy: ReturnType<typeof resolveTargetPolicy>,
        olderRange: { startSeq: SessionSeq; endSeq: SessionSeq } | null,
        signal: AbortSignal,
        roundReplacements: Set<SessionSeq>,
      ) => Promise<void>
    }
    engine.summarizeToolGroups = async (_agent, _target, _policy, olderRange, _signal, roundReplacements) => {
      if (olderRange === null) return
      const nodes = [...session.surface.nodes]
      const startIndex = nodes.indexOf(olderRange.startSeq)
      // Tool zone only (starts at index 1): the sliver forget zone is [0, 0].
      if (startIndex !== 1) return
      const target = nodes[startIndex]!
      const event = session.eventAt(target)!
      // Replace in place with the SAME event type: the surface nodes are
      // turn-carrying assistant messages, and re-appending their data as a
      // user/message would carry no `source` for the source index to read.
      const landed = session.append(event.type as 'assistant/message', event.data as never, {
        surfaceOp: { op: 'replace', start: target, end: target },
        sourceEventSeqs: [target],
      })
      roundReplacements.add(landed.seq)
    }
    await BasicCompactionEngine.prototype.compactIfNeeded.call(
      engine as unknown as BasicCompactionEngine,
      harness.agent,
      'pressure',
      new AbortController().signal,
    )
    expect(harness.compacted).toEqual([])
    expect(harness.stops).toContain('same-pass-tool-replacement')
  })

  it('stops when THIS invocation replaced content inside the sliver forget zone', async () => {
    // Same sliver geometry, but the fresh replacement lands on the sliver itself:
    // it is inside the planner's deficit-sized span too, so the same-pass guard
    // fires exactly as it does for a replacement on the younger side of the
    // span — one span, one answer, no narrower-zone retry.
    const session = sessionWithNodes(6)
    const harness = engineHarness(session, {}, 25)
    const engine = harness.engine as unknown as {
      summarizeToolGroups: (
        agent: Agent,
        target: { provider: string; model: string },
        policy: ReturnType<typeof resolveTargetPolicy>,
        olderRange: { startSeq: SessionSeq; endSeq: SessionSeq } | null,
        signal: AbortSignal,
        roundReplacements: Set<SessionSeq>,
      ) => Promise<void>
    }
    engine.summarizeToolGroups = async (_agent, _target, _policy, olderRange, _signal, roundReplacements) => {
      if (olderRange === null) return
      const nodes = [...session.surface.nodes]
      const startIndex = nodes.indexOf(olderRange.startSeq)
      // Sliver forget zone only: it starts at the surface head.
      if (startIndex !== 0) return
      const target = nodes[startIndex]!
      const event = session.eventAt(target)!
      // Replace in place with the SAME event type: the surface nodes are
      // turn-carrying assistant messages, and re-appending their data as a
      // user/message would carry no `source` for the source index to read.
      const landed = session.append(event.type as 'assistant/message', event.data as never, {
        surfaceOp: { op: 'replace', start: target, end: target },
        sourceEventSeqs: [target],
      })
      roundReplacements.add(landed.seq)
    }
    await BasicCompactionEngine.prototype.compactIfNeeded.call(
      engine as unknown as BasicCompactionEngine,
      harness.agent,
      'pressure',
      new AbortController().signal,
    )
    expect(harness.compacted).toEqual([])
    expect(harness.stops).toContain('same-pass-tool-replacement')
  })

  it('folds an earlier-invocation replacement the sliver-crossing span contains', async () => {
    // Product timeline: an earlier governance pass replaced the raw tool result
    // at surface position 2 with a durable tool summary. The 25-token envelope
    // clamps the forget boundary to 45 tokens, so the forget zone is the
    // 10-token sliver [0, 0] and the planner's deficit-sized span [0, 2]
    // (reclaim 5 + minSpan 10 + 1 = 16, first reached by 30 tokens) contains
    // that aged summary with newer dialogue after it. The re-entry relaxation
    // must apply to the sliver-crossing span exactly as it does to any other
    // pressure span.
    const session = Session.create(SessionId('engine-sliver-reentry-aged'))
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    // Surface order: one turn node (0), one tool step (call at 1, result at 2),
    // then three more turn nodes (3, 4, 5) => 6 nodes / 60 surface tokens.
    addTurnNode(session, 1)
    addToolStep(session, 2, 1, 'sliver-head-tool')
    for (let turn = 3; turn <= 5; turn += 1) addTurnNode(session, turn)
    const toolResultSeq = session.surface.nodes[2]!
    // Landed through the real summary producer, so the Session log alone proves
    // what this node is.
    const replacementSeq = summarizedReplacement(session, toolResultSeq)
    const harness = engineHarness(session, {}, 25)
    const beforeNodes = [...session.surface.nodes]
    await BasicCompactionEngine.prototype.compactIfNeeded.call(
      harness.engine,
      harness.agent,
      'pressure',
      new AbortController().signal,
    )
    expect(harness.compacted).toHaveLength(1)
    expect(harness.compacted[0]!.start).toBe(beforeNodes[0])
    expect(harness.compacted[0]!.end).toBe(beforeNodes[2])
    expect(beforeNodes).toContain(replacementSeq)
    expect(harness.stops).not.toContain('reentry-deferred')
    expect(harness.stops).not.toContain('same-pass-tool-replacement')
  })
})

describe('durable source classification and compatibility', () => {
  it('classifies this package\'s own reduction from its durable Session provenance', () => {
    const session = Session.create(SessionId('source-rebuild'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'summary-source')
    const original = session.surface.nodes.at(-1)!
    const replacement = summarizedReplacement(session, original)
    // The Session log alone classifies it; a serving audit that AGREES changes
    // nothing, because the audit is a diagnostic and never the type authority.
    expect(buildSurfaceSourceIndex(session).entry(replacement).kind).toBe('tool-summary')
    expect(buildSurfaceSourceIndex(session, [replacement]).entry(replacement).kind).toBe('tool-summary')
    expect(buildSurfaceSourceIndex(session).isOriginalToolResult(replacement)).toBe(false)
  })

  it.each(['aborted', 'error', 'blocked', 'max-tokens', 'interrupted'] as const)('does not re-enter after non-completed %s turn', reason => {
    const session = Session.create(SessionId(`source-${reason}`))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, `summary-${reason}`)
    const original = session.surface.nodes.at(-1)!
    const replacement = summarizedReplacement(session, original)
    session.append('turn/end', { turn: 1, reason: { kind: reason } } as never)
    const index = buildSurfaceSourceIndex(session)
    expect(index.entry(replacement).kind).toBe('tool-summary')
    expect(index.canCompactHistory(replacement, 1)).toBe(false)
    // The refusal comes from the age rule, not from an unknown classification:
    // the pressure flag still relaxes this same known reduction.
    expect(index.canCompactHistory(replacement, 1, true)).toBe(true)
  })

  it('holds tool-summary replacements until a later completed turn', () => {
    const session = Session.create(SessionId('source-reentry'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'summary-source')
    const original = session.surface.nodes.at(-1)!
    const replacement = summarizedReplacement(session, original)
    expect(buildSurfaceSourceIndex(session).canCompactHistory(replacement, 1)).toBe(false)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    expect(buildSurfaceSourceIndex(session).canCompactHistory(replacement, 1)).toBe(true)
  })

  it('relaxes a known tool summary for the whole-zone pressure pass even with zero completed turns', () => {
    // A 70% governance tool summary that aged behind newer dialogue inside the
    // current forget zone is historical: the whole-zone pressure pass passes
    // allowImmediateReentry and must fold it in without waiting for a turn/end.
    const session = Session.create(SessionId('source-relax-tool-summary'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'relaxed-summary')
    const original = session.surface.nodes.at(-1)!
    const replacement = summarizedReplacement(session, original)
    const index = buildSurfaceSourceIndex(session)
    expect(index.entry(replacement).kind).toBe('tool-summary')
    expect(index.canCompactHistory(replacement, 1, true)).toBe(true)
    // The maintenance/overflow path (no flag) still defers until a completed turn.
    expect(index.canCompactHistory(replacement, 1)).toBe(false)
  })

  it('relaxes a pruned tool result for the whole-zone pressure pass', () => {
    const session = Session.create(SessionId('source-relax-pruned'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'relaxed-prune', `${'p'.repeat(200)}`)
    const original = session.surface.nodes.at(-1)!
    // Landed through the real pruner, which logs the shadow-price event with the
    // reduction's durable provenance immediately before the replacement.
    const replacement = prunedReplacement(session, original)
    const index = buildSurfaceSourceIndex(session)
    expect(index.entry(replacement).kind).toBe('tool-pruned')
    expect(index.canCompactHistory(replacement, 1, true)).toBe(true)
    expect(index.canCompactHistory(replacement, 1)).toBe(false)
  })

  it('keeps a durable tool summary classified as a summary when it logs a shadow price', () => {
    // A semantic group summary logs the same `compaction/prune` metering event a
    // model-free prune does. The provenance written beside that event — not the
    // event's mere presence, and not an audit document — is what distinguishes
    // them, so losing the audit cannot downgrade a committed summary to a prune.
    const session = Session.create(SessionId('source-summary-with-price'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 1, 'summary-priced')
    const original = session.surface.nodes.at(-1)!
    const replacement = summarizedReplacement(session, original)
    const price = session.eventAt((replacement - 1) as SessionSeq)
    expect(price?.type).toBe('compaction/prune')
    expect(buildSurfaceSourceIndex(session).entry(replacement).kind).toBe('tool-summary')
    expect(buildSurfaceSourceIndex(session, [replacement]).entry(replacement).kind).toBe('tool-summary')
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
    // A replacement with no durable provenance of this package's own stays
    // protected in every path, and an audit row claiming it as a served summary
    // cannot promote it: the audit is a diagnostic, never a type authority. The
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
    expect(buildSurfaceSourceIndex(session, [replacement.seq]).entry(replacement.seq).kind).toBe('unknown-replacement')
    // Even many completed turns do not classify it: unknown stays unknown.
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    expect(buildSurfaceSourceIndex(session).canCompactHistory(replacement.seq, 1, true)).toBe(false)
  })

  it('maps legacy thresholds to pressure and rejects ambiguous legacy/new pairs', () => {
    // Reserve/margin validation is unconditional, so the 1000-token window
    // needs explicit held-free budgets below it; the ratio assertions are
    // unaffected.
    const config = resolveConfig({
      thresholdRatio: 0.81,
      retainRatio: 0.19,
      responseReserveTokens: 100,
      safetyMarginTokens: 50,
      maxTokens: 100,
    })
    const policy = resolveTargetPolicy(config, { provider: 'mock', model: 'm' })
    const spec = resolveCompactSpec(policy, 1000)
    expect(spec.thresholdTokens).toBe(810)
    expect(spec.retainTokens).toBe(190)
    expect(() => resolveConfig({ thresholdRatio: 0.8, pressureRatio: 0.81 })).toThrow(/conflicts/)
    expect(() => resolveConfig({ retainRatio: 0.2, recentRatio: 0.21 })).toThrow(/conflicts/)
    expect(() => resolveConfig({ retainTokens: 100, recentRatio: 0.2 })).toThrow(/mutually exclusive/)
  })
})
