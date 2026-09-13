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

/** Fixture pricing rule: 4 characters per token, exactly like the harness. */
const CHARS_PER_TOKEN = 4

function priceText(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}

function priceMessage(message: { readonly content: readonly unknown[] }): number {
  let chars = 0
  for (const block of message.content) {
    const record = block as { type?: string; text?: string }
    if (record.type === 'text' && typeof record.text === 'string') chars += record.text.length
  }
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN))
}

/** One turn-carrying surface node, so the guaranteed two-turn tail is priceable. */
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

interface HarnessOptions {
  readonly nodeTokens?: number
  readonly turnCount?: number
  /**
   * Explicit price, in surface tokens, of each paid batch's checkpoint. When
   * omitted the checkpoint is priced from its own body with the same
   * characters/4 rule the fixture uses, so a replacement that is nearly as large
   * as the span it shadows is representable — that is the shape the net-release
   * floors exist to catch.
   */
  readonly replacementPrices?: readonly number[]
  /** Characters of filler in each checkpoint body (4 characters = 1 token). */
  readonly replacementChars?: number
}

const CONTEXT_WINDOW = 10_000

/**
 * Shared pending-work verdicts, exposed so a spec can read the per-batch and
 * terminal accounting the production pressure loop records.
 */
interface PressureLedgerView {
  readonly batches: readonly {
    readonly spanTokens: number
    /** First surface index the batch paid for; the pass's skip-forward witness. */
    readonly spanStartIndex: number
    readonly spanEndIndex: number
    readonly netReleaseTokens: number
    readonly netReleaseRatio: number
    readonly reasons: readonly string[]
  }[]
  readonly terminalReason: string | null
  readonly stopReasons: readonly string[]
  readonly exitTokens: number
  readonly thresholdTokens: number
  readonly batchesRun: number
  readonly exitReached: boolean
}

/**
 * B3 low-yield, bounded-batch, and reentry contract.
 *
 * `before - after` on the fake meter is an UPPER bound of the real net release
 * (the checkpoint it lands is priced by the fixture, not by a provider), so
 * every number here is a fixture token and every ratio is
 * `netRelease / selected span`, exactly as the implementation defines it.
 */
function pressureHarness(session: Session, options: HarnessOptions = {}) {
  const nodeTokens = options.nodeTokens ?? 1_000
  const prices = new Map<SessionSeq, number>()
  const compacted: Array<{ start: SessionSeq; end: SessionSeq }> = []
  const stops: string[] = []
  const warns: string[] = []
  const replacementPrices = options.replacementPrices ?? []
  let batchIndex = 0

  const measure = (): TokenMeasurement => {
    const nodes = session.surface.nodes.map(seq => ({
      seq,
      tokens: prices.get(seq) ?? nodeTokens,
      heuristicTokens: prices.get(seq) ?? nodeTokens,
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
    maxPressureBatches: 2,
    // This harness's window is small on purpose, so the held-free budgets and the
    // summary generation cap must be sized explicitly: the production defaults
    // (8 192 + 2 048) are refused outright against a 10 000-token window only
    // when they exceed it, and the instruction/checkpoint floor must stay small
    // enough for a prefix planner to be meaningful.
    responseReserveTokens: 1_000,
    safetyMarginTokens: 500,
    maxTokens: 1_000,
    forgetBoundaryRatio: 0.50,
  })
  const spec = resolveCompactSpec(resolveTargetPolicy(config, { provider: 'mock', model: 'model' }), CONTEXT_WINDOW)

  const fake = {
    config,
    ctx: {
      tokenMeter: { measure, estimateMessage: priceMessage },
      llm: { resolveModelInfo: async () => ({ context: { contextWindow: CONTEXT_WINDOW } }) },
      get: () => undefined,
      logger: { warn: (message: string) => { warns.push(message) }, info: () => undefined, error: () => undefined },
    },
    summarizeToolGroups: async () => undefined,
    sourceIndex: (current: Session) => buildSurfaceSourceIndex(current),
    hasPendingToolIntermediateWork: () => 'none' as const,
    internalFindFirstToolStageDebtIndex: () => null,
    pressureStops: new WeakMap(),
    pressureLedgers: new WeakMap(),
    logPressureStop: (reason: string) => { stops.push(reason) },
    compactRegion: async (start: SessionSeq, end: SessionSeq): Promise<CompactionResult> => {
      compacted.push({ start, end })
      const nodes = session.surface.nodes
      const startIdx = nodes.indexOf(start)
      const endIdx = nodes.indexOf(end)
      const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
      const compactionId = CompactionId(`low-yield-${compacted.length}`)
      const text = 's'.repeat(options.replacementChars ?? 4_000)
      const replacement = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }],
        source: compactCheckpointSource(compactionId),
      }), { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [...shadowedSeqs] })
      prices.set(replacement.seq, replacementPrices[batchIndex] ?? priceText(text))
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
    pressureLedger: (current: Session) => PressureLedgerView | undefined
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
    warns,
    spec,
    totalTokens: () => measure().totalTokens,
    ledger: (): PressureLedgerView | undefined => prototype.pressureLedger.call(engine, session),
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

describe('bounded pressure batches and low yield', () => {
  // Fixture geometry, measured on the fixture itself: `sessionWithTurns(id, n)`
  // appends a request/header (one turn-carrying node) plus `n` 1 000-token
  // assistant turns, so `n = 10` is 11 000 tokens against a 10 000-token window:
  //   trigger 8 000, exit 7 000, guaranteed tail 2 000, affordable tail 2 000,
  //   summarizer input cap 7 049, head = positions 0..6, recent zone 8..10.
  // The planner therefore selects a 4 000-token prefix (positions 0..3) for these
  // sessions, which is the unit every case below reasons about.
  it('reports an exit target one batch cannot reach instead of a fabricated pressure-exit verdict', async () => {
    // Fixture arithmetic, not a target to wish for: a 4 000-token deficit-sized
    // span whose checkpoint prices at 4 900 characters = 1 225 tokens releases
    // 2 775 (ratio 0.69) and lands at 10 000 - 2 775 = 7 225 — 225 tokens ABOVE
    // the 7 000 exit target. The pass therefore cannot report `pressure-exit`
    // here, and the ledger must carry the real number and the real typed verdict
    // instead of an exact 7 000 that the plan cannot deliver.
    const session = sessionWithTurns('b3-exit-target', 10)
    const h = pressureHarness(session, { replacementChars: 4_900 })
    await h.run()
    expect(h.totalTokens()).toBeGreaterThan(h.spec.pressureExitTokens)
    expect(h.totalTokens()).toBe(7_450)
    const ledger = h.ledger()!
    expect(ledger.exitReached).toBe(false)
    expect(ledger.stopReasons).not.toContain('pressure-exit')
    // The pass does NOT fall back to a single batch: it re-measures,
    // re-partitions and pays its second (bounded) batch before it stops.
    expect(ledger.batchesRun).toBe(2)
    expect(h.compacted).toHaveLength(2)
    // Batch 2 skips forward past batch 1's replacement at index 0 and selects the
    // next fresh 1 000-token node at index 1. Sizing at 1 225 tokens yields -225,
    // landing at 7 450 tokens. The pass ends on the typed, memoized
    // `no-progress` verdict instead of paying a third time, and the ledger
    // reports the non-positive release rather than hiding it.
    expect(ledger.batches[1]!.spanTokens).toBe(1_000)
    expect(ledger.batches[1]!.spanStartIndex).toBe(1)
    expect(ledger.batches[1]!.netReleaseTokens).toBe(-225)
    expect(ledger.terminalReason).toBe('no-progress')
    // Ending above the exit line is never reported as low yield: the floors
    // describe ONE batch's realised release, not the pass running out of road.
    expect(ledger.stopReasons).not.toContain('low-yield')
  })

  it('runs at most maxPressureBatches paid batches inside ONE invocation', async () => {
    // A 7 200-character checkpoint (1 800 tokens) keeps the session above the
    // exit line after the first batch: 10 000 - (4 000 - 1 800) = 7 800 > 7 000,
    // so the loop re-plans instead of returning after a single call, and the
    // configured batch budget — not the trigger — is what bounds the pass.
    const session = sessionWithTurns('b3-batch-guard', 10)
    const h = pressureHarness(session, { replacementChars: 7_200 })
    await h.run()
    expect(h.engine.config.maxPressureBatches).toBe(2)
    expect(h.compacted).toHaveLength(2)
    const ledger = h.ledger()!
    expect(ledger.batchesRun).toBe(2)
    expect(ledger.batchesRun).toBeLessThanOrEqual(h.engine.config.maxPressureBatches)
    expect(ledger.exitReached).toBe(false)
    // Batch 1 paid for the 4 000-token deficit-sized span and released 2 200.
    expect(ledger.batches[0]!.spanTokens).toBe(4_000)
    expect(ledger.batches[0]!.netReleaseTokens).toBe(2_200)
    // Batch 2 re-plans from the fresh surface, skipping forward past the
    // checkpoint batch 1 landed at index 0. It selects the next fresh 1 000-token
    // node at index 1. With replacement 1 800 tokens, net release is -800, so
    // the typed `no-progress` verdict ends the pass: 2 paid batches, never 3.
    expect(ledger.batches[1]!.spanTokens).toBe(1_000)
    expect(ledger.batches[1]!.spanStartIndex).toBe(1)
    expect(ledger.batches[1]!.netReleaseTokens).toBe(-800)
    expect(ledger.terminalReason).toBe('no-progress')
    expect(ledger.stopReasons).toEqual(['no-progress'])
  })

  it('records a low-yield batch and stops re-paying for the same range', async () => {
    // A 17 000-character checkpoint (4 250 tokens) inside the 4 000-token span is
    // not representable as a reduction — the shrink assertion would refuse it
    // outright — so the fixture's smallest honest low-yield shape is used
    // instead: a span that shrinks only marginally. See the assertion below for
    // the invariant that matters.
    const session = sessionWithTurns('b3-low-yield', 10)
    const h = pressureHarness(session, { replacementChars: 15_000 })
    await h.run()
    const ledger = h.ledger()!
    const lowYield = ledger.batches.filter(batch => batch.reasons.includes('low-yield'))
    expect(lowYield).toHaveLength(1)
    expect(lowYield[0]!.netReleaseRatio).toBeLessThan(0.15)
    expect(lowYield[0]!.netReleaseTokens).toBeLessThan(1_024)
    expect(ledger.stopReasons).toContain('low-yield')
    expect(ledger.exitReached).toBe(false)
    // The invocation ended on the FIRST low-yield batch: it never returned for a
    // second paid range in the same pressure state.
    expect(ledger.batchesRun).toBe(1)
    expect(h.compacted).toHaveLength(1)
  })

  it('never marks the pressure tier from a session below the trigger', async () => {
    // 7 x 1 000 = 7 000 token turns: below the 8 000 trigger, so this is the
    // bounded maintenance tier. The tier never writes a pressure ledger entry.
    const session = sessionWithTurns('b3-below-trigger', 7)
    const h = pressureHarness(session)
    expect(h.totalTokens()).toBe(7_000)
    await h.run()
    expect(h.totalTokens()).toBeLessThan(h.spec.thresholdTokens)
    expect(h.ledger()).toBeUndefined()
    expect(h.stops).not.toContain('pressure-exit')
  })
})
