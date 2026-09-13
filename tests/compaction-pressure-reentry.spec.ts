import { describe, expect, it } from 'vitest'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../src/internal/compaction/config.ts'
import { buildSurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import type { SurfaceZones } from '../src/internal/compaction/zones.ts'

const SURFACE = { surfaceOp: 'append' as const }

function addAssistantText(session: Session, turn: number): SessionSeq {
  return session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `turn-${turn}` }],
      source: { kind: 'model', provider: 'mock', model: 'model' },
    }),
  }, SURFACE).seq
}

interface LedgerView {
  readonly batches: readonly {
    readonly spanTokens: number
    readonly spanStartIndex: number
    readonly spanEndIndex: number
    readonly netReleaseTokens: number
    readonly reasons: readonly string[]
  }[]
  readonly terminalReason: string | null
  readonly stopReasons: readonly string[]
}

/**
 * B3 reentry / round isolation contract.
 *
 * A pressure span may fold a checkpoint an EARLIER invocation produced — that
 * is what makes cross-step progress possible — but never the replacements of
 * its OWN invocation, and never a span whose entire content is already covered
 * by the checkpoint it would re-summarize. Permanent suppression of historical
 * summaries is explicitly not the mechanism: `reentry-deferred` is a plan
 * verdict over one candidate span, not a session-wide ban.
 */
function reentryHarness(session: Session, options: {
  /** Replacement price of each paid batch. */
  readonly replacementPrices?: readonly number[]
  readonly maxPressureBatches?: number
} = {}) {
  const prices = new Map<SessionSeq, number>()
  const compacted: Array<{ start: SessionSeq; end: SessionSeq }> = []
  const stops: string[] = []
  const replacementPrices = options.replacementPrices ?? []
  let batchIndex = 0

  const measure = (): TokenMeasurement => {
    const nodes = session.surface.nodes.map(seq => ({
      seq,
      tokens: prices.get(seq) ?? 100,
      heuristicTokens: prices.get(seq) ?? 100,
    }))
    const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
    return {
      totalTokens: surfaceTokens,
      surfaceTokens,
      nodes,
      logRevision: 0,
      baseline: { kind: 'estimated', tokens: 0 },
      surfaceDeltaTokens: surfaceTokens,
    } as unknown as TokenMeasurement
  }

  const config = resolveConfig({
    toolGroupSummarizer: { enabled: false },
    maxMaintenanceBatches: 1,
    maxPressureBatches: options.maxPressureBatches ?? 1,
    responseReserveTokens: 200,
    safetyMarginTokens: 50,
    maxTokens: 100,
  })
  const spec = resolveCompactSpec(resolveTargetPolicy(config, { provider: 'mock', model: 'model' }), 1_000)

  const fake = {
    config,
    ctx: {
      tokenMeter: { measure, estimateMessage: () => 100 },
      llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_000 } }) },
      get: () => undefined,
      logger: { warn: (message: string) => { stops.push(message) }, info: () => undefined, error: () => undefined },
    },
    summarizeToolGroups: async () => undefined,
    sourceIndex: (current: Session) => buildSurfaceSourceIndex(current),
    hasPendingToolIntermediateWork: () => 'none' as const,
    internalFindFirstToolStageDebtIndex: () => null,
    pressureStops: new WeakMap(),
    pressureLedgers: new WeakMap(),
    compactRegion: async (start: SessionSeq, end: SessionSeq): Promise<CompactionResult> => {
      compacted.push({ start, end })
      const nodes = session.surface.nodes
      const shadowedSeqs = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1)
      const compactionId = CompactionId(`reentry-${compacted.length}`)
      const replacement = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'checkpoint' }],
        source: compactCheckpointSource(compactionId),
      }), { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [...shadowedSeqs] })
      prices.set(replacement.seq, replacementPrices[batchIndex] ?? 100)
      batchIndex += 1
      return {
        compactionId,
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

  const prototype = BasicCompactionEngine.prototype as unknown as {
    zones: (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) => SurfaceZones
    envelopeBudget: (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) => unknown
    envelopeZoneBudget: (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) => unknown
    pressurePassTerminated: (current: Session, totalTokens: number) => boolean
    stopEnvelopeBudgetPass: (current: Session, reason: string, totalTokens: number, thresholdTokens: number) => void
    pressureLedger: (current: Session) => LedgerView | undefined
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
  const agent = { session, options: { provider: 'mock', model: 'model' } } as unknown as Agent

  return {
    engine,
    agent,
    compacted,
    stops,
    spec,
    totalTokens: () => measure().totalTokens,
    ledger: (): LedgerView | undefined => prototype.pressureLedger.call(engine, session),
    run: () => BasicCompactionEngine.prototype.compactIfNeeded.call(
      engine, agent, 'pressure', new AbortController().signal,
    ),
  }
}

function sessionWithTurns(id: string, turns: number): Session {
  const session = Session.create(SessionId(id))
  session.append('request/header', {
    header: { config: { provider: 'mock', model: 'model' } },
    reason: 'initial',
  })
  for (let turn = 1; turn <= turns; turn += 1) addAssistantText(session, turn)
  return session
}

describe('pressure reentry and round isolation', () => {
  it('never folds the replacements its OWN invocation just produced', async () => {
    // With maxPressureBatches 2 the same invocation produces a checkpoint in
    // batch 1. Batch 2 re-partitions from the fresh surface; the round-local
    // exclusion set must keep that fresh checkpoint out of every candidate.
    const session = sessionWithTurns('b3-round-isolation', 96)
    const h = reentryHarness(session, { maxPressureBatches: 2, replacementPrices: [100, 100] })
    await h.run()
    const ledger = h.ledger()!
    expect(ledger.batches.length).toBeGreaterThanOrEqual(1)
    for (const batch of ledger.batches.slice(1)) {
      // The second batch starts strictly after the first batch's span, so it
      // cannot contain the checkpoint batch 1 landed at the head.
      expect(batch.spanStartIndex).toBeGreaterThanOrEqual(1)
      expect(batch.reasons).not.toContain('same-pass-tool-replacement')
    }
    for (const entry of h.compacted.slice(1)) {
      expect(entry.start).not.toBe(session.surface.nodes[0])
    }
  })

  it('re-enters an earlier invocation checkpoint once new surface content grew past it', async () => {
    // Invocation 1 releases the head to a 100-token checkpoint, deliberately
    // landing the session still above the exit target so a second invocation is
    // needed. Appending fresh turn nodes then gives that checkpoint new
    // coverable content, so invocation 2 must be allowed to fold it.
    const session = sessionWithTurns('b3-reentry-allowed', 96)
    const h = reentryHarness(session, { maxPressureBatches: 1, replacementPrices: [100] })
    await h.run()
    expect(h.compacted).toHaveLength(1)
    expect(h.totalTokens()).toBeGreaterThan(h.spec.pressureExitTokens)
    const checkpointSeq = session.surface.nodes[0]!

    for (let turn = 97; turn <= 140; turn += 1) addAssistantText(session, turn)
    expect(session.surface.nodes[0]).toBe(checkpointSeq)

    const second = reentryHarness(session, { maxPressureBatches: 1, replacementPrices: [100] })
    await second.run()
    expect(second.compacted).toHaveLength(1)
    // The span starts at the checkpoint that invocation 1 landed: a historical
    // replacement is NOT permanently suppressed.
    expect(second.compacted[0]!.start).toBe(checkpointSeq)
    expect(second.ledger()!.stopReasons).not.toContain('reentry-deferred')
  })

  it('defers a candidate span whose entire content is one prior checkpoint', async () => {
    // Invocation 1 lands a checkpoint covering the whole older head while the
    // session stays above the exit target but with no new content, so the only
    // possible span invocation 2 could take is the checkpoint itself. Folding it
    // would re-summarize already-condensed text, so the plan is refused with the
    // typed reason — and that verdict is a PLAN verdict, not a session ban.
    const session = sessionWithTurns('b3-reentry-refused', 96)
    const h = reentryHarness(session, { maxPressureBatches: 1, replacementPrices: [100] })
    await h.run()
    expect(h.compacted).toHaveLength(1)
    const surfaceAfterFirst = [...session.surface.nodes]

    // Re-run on the unchanged surface: the head is now the checkpoint, whose
    // coverage already holds the whole span, and the checkpoint is also too
    // small to clear the span floor.
    const again = reentryHarness(session, { maxPressureBatches: 1, replacementPrices: [100] })
    await again.run()
    expect(again.compacted).toHaveLength(0)
    const reasons = [
      ...(again.ledger()?.stopReasons ?? []),
      ...again.stops,
    ]
    expect(reasons.some(reason => reason.includes('reentry-deferred') || reason.includes('span-below-minimum'))).toBe(true)
    expect([...session.surface.nodes]).toEqual(surfaceAfterFirst)
  })

  it('keeps the tool-stage and retained-tail protections while folding a history checkpoint', async () => {
    const session = sessionWithTurns('b3-reentry-protections', 96)
    const h = reentryHarness(session, { maxPressureBatches: 2, replacementPrices: [100, 100] })
    const tailBefore = session.surface.nodes.slice(-2)
    await h.run()
    for (const seq of tailBefore) expect(session.surface.nodes).toContain(seq)
    const ledger = h.ledger()!
    for (const batch of ledger.batches) {
      expect(batch.netReleaseTokens).toBeGreaterThan(-1_000)
    }
  })
})
