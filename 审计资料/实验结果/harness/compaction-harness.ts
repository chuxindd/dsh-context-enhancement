/**
 * E01–E03 experiment fixture: a compaction harness with a fake token meter, a
 * fake LLM adapter, and a temporary Session — and NO production-code change.
 *
 * Design follows the workspace's own `tests/compaction-three-zone.spec.ts`
 * seam precedent: the engine instance is a plain object holding the production
 * `config` and a fake `ctx`, and every production seam (`zones`,
 * `envelopeBudget`, `envelopeZoneBudget`, `pressurePassTerminated`,
 * `stopEnvelopeBudgetPass`, `logPressureStop`, `compactIfNeeded`) is called
 * through `BasicCompactionEngine.prototype`. Nothing in `src/` is modified or
 * monkey-patched globally: only this instance carries the seams.
 *
 * REAL in this harness
 * --------------------
 * - `resolveConfig` / `resolveCompactSpec` / `resolveTargetPolicy` (production
 *   config resolution and validation) for every policy number;
 * - `partitionSurfaceZones` / `planForgetBatch` / `planPressureSpan` through the
 *   engine's own `zones()` and its plan calls;
 * - `compactSurfaceRegion` (production commit path: prepare, summarize, shrink
 *   assertion, bracket markers, surface generation bump) with the REAL
 *   `summarize` → `summarizeWithLlm` call against a scripted adapter;
 * - `retainedTailFloorTokens`, `resolveEnvelopeBudget`,
 *   `resolveEnvelopeZoneBudget`, `buildSurfaceSourceIndex`.
 *
 * FAKE in this harness
 * --------------------
 * - the token meter: every price is a fixture unit chosen by this harness, so a
 *   "token" here is NOT a provider token (recorded in each experiment's
 *   limitations);
 * - the LLM: a scripted adapter, so summary QUALITY is out of scope;
 * - the storage hub: absent, so `toolGroupAuditStore` is undefined and the real
 *   `summarizeToolGroups` cannot run (see E01's limitations).
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '../../../src/compaction-basic.ts'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
} from '../../../src/internal/compaction/config.ts'
import { compactSurfaceRegion } from '../../../src/internal/compaction/region.ts'
import { buildSurfaceSourceIndex } from '../../../src/internal/compaction/source-index.ts'
import { summarizeWithLlm } from '../../../src/internal/compaction/summarizer.ts'
import { retainedTailFloorTokens } from '../../../src/internal/compaction/envelope-budget.ts'
import type { SurfaceZones } from '../../../src/internal/compaction/zones.ts'

/** Surface operation used by every fixture append: plain append. */
export const SURFACE = { surfaceOp: 'append' as const }

/** The fixture's character-per-token rule. */
export const CHARS_PER_TOKEN = 4

/** Kinds a fixture surface node can have. */
export type FixtureNodeKind = 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'checkpoint'

/** Ledger row captured for one `compactIfNeeded` invocation. */
export interface CompactionLedgerEntry {
  /** Fake-meter totals before the call. */
  readonly beforeTotalTokens: number
  readonly beforeSurfaceTokens: number
  readonly beforeEnvelopeTokens: number
  /** Zone geometry before the call. */
  readonly zonesBefore: ZoneLedger
  /** Surface-generation counters before/after the call. */
  readonly surfaceGenerationBefore: number
  readonly surfaceGenerationAfter: number
  /** The span the production pass actually committed (from the durable bracket). */
  readonly selected: {
    readonly startIndex: number
    readonly endIndex: number
    readonly tokens: number
    readonly sourceKinds: readonly string[]
    readonly sourceSeqs: readonly number[]
  } | null
  /** Auxiliary summarization calls this invocation made. */
  readonly summary: {
    readonly requests: number
    readonly inputChars: number
    readonly outputChars: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly outputText: string | null
  }
  /** Fake-meter totals after the call. */
  readonly afterTotalTokens: number
  readonly afterSurfaceTokens: number
  /** `before - after` on total tokens; negative means the request grew. */
  readonly netReleasedTokens: number
  /** `netReleasedTokens / beforeTotalTokens`. */
  readonly netReleaseRatio: number
  /** Shadowed node count reported by the production result. */
  readonly shadowedNodes: number
  /** Typed stop reasons the pass recorded (production `stops` seam). */
  readonly stopReasons: readonly string[]
  /** Entry-point trigger used for this call. */
  readonly trigger: string
  /** Whether the request sits below the 80% threshold after the call. */
  readonly belowThresholdAfter: boolean
  /** Surface node kinds after the call, in order. */
  readonly kindsAfter: readonly FixtureNodeKind[]
}

/** Zone geometry in ledger form. */
export interface ZoneLedger {
  readonly forgetStart: number
  readonly forgetEnd: number
  readonly forgetTokens: number
  readonly toolStart: number
  readonly toolEnd: number
  readonly toolTokens: number
  readonly recentStart: number
  readonly recentTokens: number
  readonly retainedTailTokens: number
}

/** Scripted compaction adapter: answers every summarization call. */
export class ScriptedSummaryAdapter extends LlmAdapter {
  /** Every request served, in order. */
  readonly requests: GenerateOptions[] = []
  /** Character length of each request's replayed messages. */
  readonly inputChars: number[] = []
  /** Character length of each produced summary text. */
  readonly outputChars: number[] = []
  /** Char length of the LAST summary this adapter produced. */
  outputText: string | null = null

  constructor(private readonly outputCharsFor: (inputChars: number) => number) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const inputChars = countTextChars(options.messages)
    this.inputChars.push(inputChars)
    const size = Math.max(24, this.outputCharsFor(inputChars))
    this.outputChars.push(size)
    const body = '## Primary Request and Intent\n- ' + 'x'.repeat(Math.max(0, size - 33))
    this.outputText = body
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Total characters of the text blocks in a replayed request. */
function countTextChars(messages: readonly { readonly content: unknown }[]): number {
  let total = 0
  for (const message of messages) {
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = block as { type?: string; text?: string }
      if (record.type === 'text' && typeof record.text === 'string') total += record.text.length
    }
  }
  return total
}

/** Price one text block content array with the harness rule. */
export function priceContent(content: readonly unknown[]): number {
  let chars = 0
  for (const block of content) {
    const record = block as { type?: string; text?: string }
    if (record.type === 'text' && typeof record.text === 'string') chars += record.text.length
  }
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN))
}

/** The fixture handle a spec drives. */
export interface CompactionFixture {
  readonly session: Session
  readonly adapter: ScriptedSummaryAdapter
  /** Every invocation's ledger row, in order. */
  readonly ledger: CompactionLedgerEntry[]
  /** Append one priced node; `tokens` overrides the chars-derived price. */
  append(kind: FixtureNodeKind, options: {
    readonly chars?: number
    readonly tokens?: number
    readonly turn: number
    readonly step: number
    readonly callId?: string
  }): { index: number; seq: SessionSeq }
  /**
   * Open the NEXT turn. A turn must be closed with `endTurn` before the next one
   * opens: `retainedTailFloorTokens` protects the OPEN turn plus the last
   * COMPLETED turn, so a fixture that never closes a turn retains the whole
   * surface and measures nothing.
   */
  beginTurn(turn?: number): number
  /** Close the open turn. `reason` defaults to `{kind:'completed'}`. */
  endTurn(reason?: 'completed' | 'interrupted'): void
  /** Fake-meter snapshot of the current surface. */
  measure(): TokenMeasurement
  /** Surface replace generation. */
  generation(): number
  /** Node kinds currently on the surface, in order. */
  kinds(): readonly FixtureNodeKind[]
  /** Zone geometry for the current snapshot. */
  zones(): SurfaceZones
  /** One real `compactIfNeeded` call, captured. */
  run(trigger?: 'pressure' | 'context-overflow'): Promise<CompactionLedgerEntry>
  /** Total fixture tokens the surface currently prices at. */
  totalTokens(): number
  /** Typed stop reasons recorded so far. */
  readonly stops: string[]
}

/** Build one fixture. Prices are the harness's own; see the module header. */
export async function createCompactionFixture(options: {
  /** Session id (must be unique per fixture in one file). */
  readonly id: string
  /** Context window in fixture tokens; sets the 40/70/80 waterlines. */
  readonly contextWindow: number
  /** Extra policy overrides for `resolveConfig`. */
  readonly config?: Parameters<typeof resolveConfig>[0]
  /** Summary body size rule, in characters, from the replayed input size. */
  readonly summaryCharsFor?: (inputChars: number) => number
  /** Install a fake `toolResultPruner` so the ①② prune path is observable. */
  readonly pruner?: {
    /** Fraction of the original character count the pruner keeps. */
    readonly keepRatio: number
  }
}): Promise<CompactionFixture> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptedSummaryAdapter(options.summaryCharsFor ?? (inputChars => Math.max(64, Math.floor(inputChars / 16))))
  ctx.llm.registerAdapter(['mock-route'], adapter)

  const session = Session.create(SessionId(options.id))
  // `compactIfNeeded` routes by the session's request header: without one it
  // returns `null` before doing anything (`routedTarget`), so the fixture must
  // declare the route it prices against.
  session.append('request/header', {
    header: { config: { provider: 'mock-route', model: 'mock-model' } },
    reason: 'initial',
  })
  // The production commit path requires an OPEN turn: the compaction bracket is
  // enclosed in a turn (`compactSurfaceRegion` throws otherwise). The fixture
  // opens turn 1 and every appended node must belong to the open turn.
  let openTurnNumber = 1
  session.append('turn/start', { turn: 1 })
  /** Price per CURRENT surface node, maintained by the harness on every append. */
  const price = new Map<SessionSeq, number>()
  const chars = new Map<SessionSeq, number>()
  const kind = new Map<SessionSeq, FixtureNodeKind>()

  const measure = (): TokenMeasurement => {
    const nodes = session.surface.nodes.map(seq => ({
      seq,
      tokens: price.get(seq) ?? 0,
      heuristicTokens: price.get(seq) ?? 0,
    }))
    const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
    return {
      totalTokens: surfaceTokens,
      surfaceTokens,
      nodes,
      logRevision: 0,
      baseline: { kind: 'estimated' as const, tokens: 0 },
      surfaceDeltaTokens: surfaceTokens,
    } as unknown as TokenMeasurement
  }

  const estimateMessage = (message: { readonly content: readonly unknown[] }): number =>
    priceContent(message.content)

  const config = resolveConfig({
    toolGroupSummarizer: { enabled: false },
    maxMaintenanceBatches: 1,
    maxPressureBatches: 2,
    ...options.config,
  })
  const spec = resolveCompactSpec(resolveTargetPolicy(config, { provider: 'mock-route', model: 'mock-model' }), options.contextWindow)
  const stops: string[] = []

  const fakePruner = options.pruner === undefined
    ? undefined
    : {
      pruneSession: (
        target: Session,
        pruneOptions: {
          candidateSeqs?: readonly SessionSeq[]
          onReplacement?: (entry: { replacementSeq: SessionSeq }) => void
        },
      ) => {
        const pruned: { originalSeq: SessionSeq; replacementSeq: SessionSeq; callId: string; charsBefore: number; charsAfter: number }[] = []
        for (const seq of pruneOptions.candidateSeqs ?? []) {
          const event = target.eventAt(seq)
          if (event?.type !== 'tool/result') continue
          const originalChars = chars.get(seq) ?? 0
          const kept = Math.max(64, Math.floor(originalChars * options.pruner!.keepRatio))
          const text = `[pruned] ${'p'.repeat(Math.max(1, kept - 9))}`
          target.append('compaction/prune', {
            shadowedRange: { start: seq, end: seq },
            shadowedSeqs: [seq],
            shadowedTokenCount: price.get(seq) ?? 0,
          })
          const replacement = target.append('tool/result', {
            ...event.data,
            message: createToolResultMessage({
              callId: event.data.message.source.callId,
              content: [{ type: 'text', text }],
              isError: false,
            }),
          }, {
            surfaceOp: { op: 'replace' as const, start: seq, end: seq },
            sourceEventSeqs: [seq],
          })
          // The replacement is priced by the SAME rule the meter uses for any
          // node: characters / CHARS_PER_TOKEN.
          price.set(replacement.seq, priceContent([{ type: 'text', text }]))
          chars.set(replacement.seq, text.length)
          kind.set(replacement.seq, 'tool-result')
          pruned.push({
            originalSeq: seq,
            replacementSeq: replacement.seq,
            callId: String(event.data.message.source.callId),
            charsBefore: originalChars,
            charsAfter: text.length,
          })
          pruneOptions.onReplacement?.({ replacementSeq: replacement.seq })
        }
        return {
          pruned,
          charsRemoved: pruned.reduce((sum, entry) => sum + (entry.charsBefore - entry.charsAfter), 0),
        }
      },
    }

  /** Every `compactRegion` call this fixture made: the pass's own plan. */
  const regionCalls: Array<{ start: SessionSeq; end: SessionSeq }> = []

  const engine = {
    config,
    ctx: {
      tokenMeter: { measure: () => measure(), estimateMessage },
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: options.contextWindow } }),
        stream: (generateOptions: GenerateOptions) => ctx.llm.stream(generateOptions),
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      get: (key: string) => (key === 'toolResultPruner' ? fakePruner : undefined),
    },
    toolGroupAuditStore: undefined,
    summaryRequests: 0,
    summarizeToolGroups: async () => { /* op1 needs the audit store; see E01 limitations */ },
    sourceIndex: (target: Session) => buildSurfaceSourceIndex(target),
    hasPendingToolIntermediateWork: () => 'none',
    internalFindFirstToolStageDebtIndex: () => null,
    pressureStops: new WeakMap(),
    // REAL commit path: prepare → summarize (fake LLM) → shrink assert → bracket.
    compactRegion: async (start: SessionSeq, end: SessionSeq, owner: Agent, signal?: AbortSignal): Promise<CompactionResult> => {
      regionCalls.push({ start, end })
      return compactSurfaceRegion(
        {
          meter: { measure: () => measure(), estimateMessage },
          summarize: (input, summarizeAgent, summarizeSignal) =>
            summarizeWithLlm(
              ctx,
              {
                summarizationProvider: 'mock-route',
                summarizationModel: 'mock-model',
                maxTokens: config.maxTokens,
              },
              input,
              summarizeAgent,
              summarizeSignal,
            ),
        },
        owner.session,
        start,
        end,
        owner,
        { owner: 'current-turn', stability: 'whole-surface' },
        signal,
      )
    },
  }
  const seams = engine as unknown as Record<string, unknown>
  const prototype = BasicCompactionEngine.prototype as unknown as {
    zones: (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) => SurfaceZones
    envelopeBudget: (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) => { summarizerInputCapTokens: number }
    envelopeZoneBudget: (current: Session, priced: TokenMeasurement, spec: ReturnType<typeof resolveCompactSpec>) => { retainedTailTokens: number; forgetBoundaryTokens: number; envelopeDominated: boolean }
    pressurePassTerminated: (current: Session, totalTokens: number) => boolean
    stopEnvelopeBudgetPass: (current: Session, reason: string, totalTokens: number, thresholdTokens: number) => void
    logPressureStop: (reason: string, totalTokens: number, thresholdTokens: number) => void
  }
  seams['zones'] = (current: Session, priced: TokenMeasurement) =>
    prototype.zones.call(engine, current, priced, spec)
  seams['envelopeBudget'] = (current: Session, priced: TokenMeasurement) =>
    prototype.envelopeBudget.call(engine, current, priced, spec)
  seams['envelopeZoneBudget'] = (current: Session, priced: TokenMeasurement) =>
    prototype.envelopeZoneBudget.call(engine, current, priced, spec)
  seams['pressurePassTerminated'] = (current: Session, totalTokens: number) =>
    prototype.pressurePassTerminated.call(engine, current, totalTokens)
  seams['stopEnvelopeBudgetPass'] = (current: Session, reason: string, totalTokens: number, thresholdTokens: number) => {
    stops.push(reason)
    prototype.stopEnvelopeBudgetPass.call(engine, current, reason, totalTokens, thresholdTokens)
  }
  seams['logPressureStop'] = (reason: string, totalTokens: number, thresholdTokens: number) => {
    stops.push(reason)
    prototype.logPressureStop.call(engine, reason, totalTokens, thresholdTokens)
  }

  const agent = { session, options: { provider: 'mock-route', model: 'mock-model' } } as unknown as Agent

  const append: CompactionFixture['append'] = (nodeKind, appendOptions) => {
    if (appendOptions.turn !== openTurnNumber) {
      throw new Error(`fixture: node declares turn ${appendOptions.turn} but turn ${openTurnNumber} is open`)
    }
    const index = session.surface.nodes.length
    const defaults: Record<FixtureNodeKind, number> = { user: 400, assistant: 800, 'tool-call': 200, 'tool-result': 4_000, checkpoint: 200 }
    const nodeChars = appendOptions.chars ?? defaults[nodeKind]
    const text = 'y'.repeat(Math.max(1, nodeChars))
    const callId = appendOptions.callId ?? `call-${index}`
    let seq: SessionSeq
    if (nodeKind === 'user' || nodeKind === 'checkpoint') {
      seq = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }), SURFACE).seq
    } else if (nodeKind === 'tool-result') {
      seq = session.append('tool/result', {
        turn: appendOptions.turn,
        step: appendOptions.step,
        message: createToolResultMessage({
          callId: ToolCallId(callId),
          content: [{ type: 'text', text }],
          isError: false,
        }),
      }, SURFACE).seq
    } else if (nodeKind === 'tool-call') {
      seq = session.append('assistant/message', {
        turn: appendOptions.turn,
        step: appendOptions.step,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: JSON.stringify({ command: text }) }],
          source: { kind: 'model', provider: 'mock-route', model: 'mock-model' },
        }),
      }, SURFACE).seq
    } else {
      seq = session.append('assistant/message', {
        turn: appendOptions.turn,
        step: appendOptions.step,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'mock-route', model: 'mock-model' },
        }),
      }, SURFACE).seq
    }
    const priced = appendOptions.tokens ?? priceContent([{ type: 'text', text }])
    price.set(seq, priced)
    chars.set(seq, nodeChars)
    kind.set(seq, nodeKind)
    return { index, seq }
  }

  const ledger: CompactionLedgerEntry[] = []

  const beginTurn: CompactionFixture['beginTurn'] = (turn) => {
    const next = turn ?? openTurnNumber + 1
    session.append('turn/start', { turn: next })
    openTurnNumber = next
    return next
  }
  const endTurn: CompactionFixture['endTurn'] = (reason = 'completed') => {
    session.append('turn/end', { turn: openTurnNumber, reason: { kind: reason } })
  }

  const fixture: CompactionFixture = {
    session,
    adapter,
    ledger,
    stops,
    append,
    beginTurn,
    endTurn,
    measure,
    generation: () => session.surface.replaceGeneration,
    kinds: () => session.surface.nodes.map(seq => kind.get(seq) ?? 'checkpoint'),
    zones: () => prototype.zones.call(engine, session, measure(), spec),
    totalTokens: () => measure().totalTokens,
    run: async (trigger = 'pressure') => {
      const before = measure()
      const zonesBefore = prototype.zones.call(engine, session, before, spec)
      const zoneBudgetBefore = prototype.envelopeZoneBudget.call(engine, session, before, spec)
      const generationBefore = session.surface.replaceGeneration
      const requestsBefore = adapter.requests.length
      const stopCountBefore = stops.length
      const regionCallsBefore = regionCalls.length
      const result = await BasicCompactionEngine.prototype.compactIfNeeded.call(
        engine,
        agent,
        trigger,
        new AbortController().signal,
      )
      const after = measure()
      const inputs = adapter.inputChars.slice(requestsBefore)
      const outputs = adapter.outputChars.slice(requestsBefore)
      // The pass's own plan: the exact (start, end) seq pair it handed to the
      // real region transaction, priced against the PRE-call surface.
      const calls = regionCalls.slice(regionCallsBefore)
      const plan = calls.length === 0 ? null : calls[calls.length - 1]!
      const preNodes = [...before.nodes]
      const planSpan = plan === null ? null : spanOf(session, preNodes, plan.start, plan.end)
      const entry: CompactionLedgerEntry = {
        beforeTotalTokens: before.totalTokens,
        beforeSurfaceTokens: before.surfaceTokens,
        beforeEnvelopeTokens: before.totalTokens - before.surfaceTokens,
        zonesBefore: {
          forgetStart: zonesBefore.forget?.startIndex ?? -1,
          forgetEnd: zonesBefore.forget?.endIndex ?? -1,
          forgetTokens: zonesBefore.forget?.tokens ?? 0,
          toolStart: zonesBefore.tool?.startIndex ?? -1,
          toolEnd: zonesBefore.tool?.endIndex ?? -1,
          toolTokens: zonesBefore.tool?.tokens ?? 0,
          recentStart: zonesBefore.recent?.startIndex ?? -1,
          recentTokens: zonesBefore.recent?.tokens ?? 0,
          retainedTailTokens: zoneBudgetBefore.retainedTailTokens,
        },
        surfaceGenerationBefore: generationBefore,
        surfaceGenerationAfter: session.surface.replaceGeneration,
        selected: planSpan,
        summary: {
          requests: adapter.requests.length - requestsBefore,
          inputChars: inputs.reduce((sum, value) => sum + value, 0),
          outputChars: outputs.reduce((sum, value) => sum + value, 0),
          inputTokens: inputs.reduce((sum, value) => sum + Math.ceil(value / CHARS_PER_TOKEN), 0),
          outputTokens: outputs.reduce((sum, value) => sum + Math.ceil(value / CHARS_PER_TOKEN), 0),
          outputText: adapter.requests.length === requestsBefore ? null : adapter.outputText,
        },
        afterTotalTokens: after.totalTokens,
        afterSurfaceTokens: after.surfaceTokens,
        netReleasedTokens: before.totalTokens - after.totalTokens,
        netReleaseRatio: before.totalTokens === 0 ? 0 : (before.totalTokens - after.totalTokens) / before.totalTokens,
        shadowedNodes: shadowedCount(result),
        stopReasons: stops.slice(stopCountBefore),
        trigger,
        belowThresholdAfter: after.totalTokens < spec.thresholdTokens,
        kindsAfter: session.surface.nodes.map(seq => kind.get(seq) ?? 'checkpoint'),
      }
      ledger.push(entry)
      return entry
    },
  }
  return fixture
}

/** Shadowed node count of a compaction result (0 for `null`). */
function shadowedCount(result: CompactionResult | null): number {
  if (result === null) return 0
  const value = result as unknown as { shadowedSeqs?: readonly unknown[] }
  return value.shadowedSeqs?.length ?? 0
}

/**
 * Price a planned `(start, end)` span against a PRE-call snapshot: the surface
 * indexes both endpoints occupied, the span's summed fixture price, and the
 * source event types it covered. Returns `null` when either endpoint is not a
 * surface node of that snapshot.
 */
export function spanOf(
  session: Session,
  nodes: TokenMeasurement['nodes'],
  start: SessionSeq,
  end: SessionSeq,
): CompactionLedgerEntry['selected'] {
  const startIndex = nodes.findIndex(node => node.seq === start)
  const endIndex = nodes.findIndex(node => node.seq === end)
  if (startIndex < 0 || endIndex < startIndex) return null
  const slice = nodes.slice(startIndex, endIndex + 1)
  return {
    startIndex,
    endIndex,
    tokens: slice.reduce((sum, node) => sum + node.tokens, 0),
    sourceKinds: slice.map(node => session.eventAt(node.seq)?.type ?? 'missing'),
    sourceSeqs: slice.map(node => Number(node.seq)),
  }
}

/** The retained-tail floor of the current snapshot (production helper). */
export function retainedTailOf(session: Session, measurement: TokenMeasurement): number {
  return retainedTailFloorTokens(session, measurement)
}
