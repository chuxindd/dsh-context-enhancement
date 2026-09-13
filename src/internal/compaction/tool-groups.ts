import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { toolPairingBalancedBefore } from './tool-pairing.ts'
import type { SessionRead } from './tool-pairing.ts'
import { codePointLength } from './pruner-config.ts'
import { toolSegments } from './tool-segments.ts'

/** A conservative, surface-positioned group of related tool/result nodes. */
export interface ToolGroup {
  readonly sourceSeqs: readonly SessionSeq[]
  readonly toolResultSeqs: readonly SessionSeq[]
  readonly callIds: readonly string[]
  readonly startSeq: SessionSeq
  readonly endSeq: SessionSeq
  readonly estimatedTokens: number
  readonly startPosition: number
  readonly endPosition: number
  readonly turn: number
}

export interface ToolGroupSelectionOptions {
  readonly olderRange?: { readonly start: SessionSeq; readonly end: SessionSeq } | null
  readonly minGroupResults?: number
  readonly minGroupChars?: number
  readonly minGroupTokens?: number
  readonly maxGroupTokens?: number
  readonly maxGroups?: number
  readonly estimateTokens?: (event: SessionEvent) => number
  readonly measureText?: (event: SessionEvent<'tool/result'>) => number
  /**
   * Classify one tool result as still eligible for selection — an original,
   * never-replaced result. A candidate run that mixes eligible and ineligible
   * results is split at safe step/pair boundaries and only its all-eligible
   * sub-spans are returned, so an already-summarized sibling never hides the raw
   * originals beside it. Defaults to treating every result as eligible.
   */
  readonly isEligibleResult?: (seq: SessionSeq) => boolean
  /**
   * Validate whether one candidate group fits the auxiliary request budget.
   * When provided, groups whose complete serialized request (instruction +
   * JSON overhead + generation reserve) exceeds the input cap are rejected.
   */
  readonly isGroupFittable?: ((group: ToolGroup) => boolean) | undefined
}

const DEFAULTS = {
  minGroupResults: 2,
  minGroupChars: 12_000,
  minGroupTokens: 2_000,
  maxGroupTokens: 12_000,
  maxGroups: 2,
} as const

/** Find qualifying complete tool groups in current surface order. */
export function selectToolGroups(
  session: SessionRead,
  options: ToolGroupSelectionOptions = {},
): ToolGroup[] {
  const estimateTokens = options.estimateTokens ?? (() => 0)
  const measureText = options.measureText ?? defaultTextLength
  const minGroupResults = options.minGroupResults ?? DEFAULTS.minGroupResults
  const minGroupChars = options.minGroupChars ?? DEFAULTS.minGroupChars
  const minGroupTokens = options.minGroupTokens ?? DEFAULTS.minGroupTokens
  const maxGroupTokens = options.maxGroupTokens ?? DEFAULTS.maxGroupTokens
  const maxGroups = options.maxGroups ?? DEFAULTS.maxGroups
  const isEligibleResult = options.isEligibleResult
  const isGroupFittable = options.isGroupFittable
  const positions = olderPositions(session.surface.nodes, options.olderRange)
  if (positions === null || maxGroups <= 0) return []

  const selected: ToolGroup[] = []
  for (const segment of toolSegments(session)) {
    const startPosition = session.surface.nodes.indexOf(segment.startSeq)
    const endPosition = session.surface.nodes.indexOf(segment.endSeq)
    if (startPosition < 0 || endPosition < startPosition) continue
    if (startPosition < positions.start || endPosition > positions.end) continue

    const sourceSeqs = segment.seqs
    const toolResultSeqs = sourceSeqs.filter(seq => session.eventAt(seq)?.type === 'tool/result')
    if (toolResultSeqs.length < minGroupResults) continue
    const events = sourceSeqs.map(seq => session.eventAt(seq)).filter((event): event is SessionEvent => event !== undefined)
    if (events.length !== sourceSeqs.length) throw new Error('tool-groups: surface contains a missing event')
    const estimatedTokens = events.reduce((total, event) => total + estimateTokens(event), 0)
    const chars = toolResultSeqs.reduce((total, seq) => {
      const event = session.eventAt(seq)
      return event?.type === 'tool/result' ? total + measureText(event) : total
    }, 0)
    if (chars < minGroupChars || estimatedTokens < minGroupTokens) continue

    // A related run larger than the cap is split at safe step boundaries instead
    // of being dropped: dropping it left the whole run raw forever, which is
    // exactly the content that keeps a high-pressure session above threshold.
    // Each emitted chunk must qualify on its own; an unfittable step stays raw.
    const spans = estimatedTokens <= maxGroupTokens
      ? [sourceSeqs]
      : splitOversizedRun(session, sourceSeqs, maxGroupTokens, estimateTokens)
    for (const span of spans) {
      // A run left mixed by a partial summary is split at safe step/pair cuts
      // and reduced to its eligible sub-spans, so already-summarized siblings
      // never strand the raw results that still need work.
      const eligibleSpans = isEligibleResult === undefined
        ? [span]
        : splitMixedSpan(session, span, isEligibleResult)
      for (const eligible of eligibleSpans) {
        const group = buildGroup(session, eligible, {
          minGroupResults, minGroupChars, minGroupTokens, maxGroupTokens, estimateTokens, measureText,
        }, isGroupFittable)
        if (group === null) continue
        selected.push(group)
        if (selected.length >= maxGroups) break
      }
      if (selected.length >= maxGroups) break
    }
    if (selected.length >= maxGroups) break
  }
  return selected
}

/** Selection thresholds and pricing seams one candidate span must satisfy. */
interface GroupThresholds {
  readonly minGroupResults: number
  readonly minGroupChars: number
  readonly minGroupTokens: number
  readonly maxGroupTokens: number
  readonly estimateTokens: (event: SessionEvent) => number
  readonly measureText: (event: SessionEvent<'tool/result'>) => number
}

/**
 * Build one selectable group from a contiguous surface span of a tool run.
 * @param session - session supplying the current surface.
 * @param seqs - the span's current surface seqs in surface order.
 * @param thresholds - resolved selection budgets and pricing seams.
 * @returns the group, or null when the span is empty, over the token cap, or
 * below the result/char/token minimums.
 * @throws when a span seq has no matching log event (corrupt surface).
 */
function buildGroup(
  session: SessionRead,
  seqs: readonly SessionSeq[],
  thresholds: GroupThresholds,
  isGroupFittable?: (group: ToolGroup) => boolean,
): ToolGroup | null {
  if (seqs.length === 0) return null
  const events = seqs.map((seq) => {
    const event = session.eventAt(seq)
    if (event === undefined) throw new Error('tool-groups: surface contains a missing event')
    return event
  })
  const toolResultSeqs = seqs.filter((_, index) => events[index]!.type === 'tool/result')
  if (toolResultSeqs.length < thresholds.minGroupResults) return null
  const estimatedTokens = events.reduce((total, event) => total + thresholds.estimateTokens(event), 0)
  if (estimatedTokens < thresholds.minGroupTokens || estimatedTokens > thresholds.maxGroupTokens) return null
  const chars = events.reduce((total, event) =>
    total + (event.type === 'tool/result' ? thresholds.measureText(event) : 0), 0)
  if (chars < thresholds.minGroupChars) return null

  const callIds = events.flatMap(event => event.type === 'tool/result'
    ? [String(event.data.message.source.callId)]
    : event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'tool-call' ? [String(block.id)] : [])
      : [])
  const startSeq = seqs[0]!
  const endSeq = seqs.at(-1)!
  const first = events[0]!
  if (first.type !== 'assistant/message' && first.type !== 'tool/result') {
    throw new Error('tool-groups: a tool-run span must start on a tool-call message')
  }
  const candidateGroup: ToolGroup = {
    sourceSeqs: [...seqs],
    toolResultSeqs,
    callIds: [...new Set(callIds)],
    startSeq,
    endSeq,
    estimatedTokens,
    startPosition: session.surface.nodes.indexOf(startSeq),
    endPosition: session.surface.nodes.indexOf(endSeq),
    turn: first.data.turn,
  }
  if (isGroupFittable !== undefined && !isGroupFittable(candidateGroup)) {
    return null
  }
  return candidateGroup
}

/**
 * Split one oversized same-turn tool run into step-aligned chunks that fit the
 * cap. A cut is taken only where the run stays tool-pairing balanced and the two
 * sides belong to different steps, so a tool call never separates from its
 * result, parallel calls of one assistant message stay together, and no chunk
 * spans two steps.
 *
 * Every chunk end is re-evaluated from its own chunk start instead of trusting a
 * running accumulator: the largest safe end whose own price still fits the cap
 * wins, so a fittable prefix survives an over-cap step that only becomes
 * visible later in the run. A step that alone exceeds the cap is emitted as its
 * own over-cap chunk, which {@link buildGroup} then rejects exactly as before,
 * and the split resumes after it so its fittable siblings stay selectable.
 * @param session - session supplying the current surface.
 * @param seqs - the oversized run's seqs in surface order.
 * @param maxGroupTokens - token cap one chunk must not exceed.
 * @param estimateTokens - per-event token price.
 * @returns the chunks in surface order, covering every input seq exactly once.
 */
function splitOversizedRun(
  session: SessionRead,
  seqs: readonly SessionSeq[],
  maxGroupTokens: number,
  estimateTokens: (event: SessionEvent) => number,
): SessionSeq[][] {
  const tokens = seqs.map((seq) => {
    const event = session.eventAt(seq)
    if (event === undefined) throw new Error('tool-groups: surface contains a missing event')
    return estimateTokens(event)
  })
  // A cut position is a chunk boundary before seqs[position]. Only safe step/pair
  // boundaries are candidates, so a chunk never separates a call from its result
  // and never spans two steps.
  const safeCuts = new Set<number>()
  for (let position = 1; position < seqs.length; position += 1) {
    if (safeChunkCut(session, seqs[position - 1]!, seqs[position]!)) safeCuts.add(position)
  }

  const chunks: SessionSeq[][] = []
  let start = 0
  while (start < seqs.length) {
    let fitEnd = -1
    let running = 0
    for (let end = start; end < seqs.length; end += 1) {
      running += tokens[end]!
      if (running > maxGroupTokens) break
      if (end + 1 === seqs.length || safeCuts.has(end + 1)) fitEnd = end + 1
    }
    if (fitEnd > start) {
      chunks.push(seqs.slice(start, fitEnd))
      start = fitEnd
      continue
    }
    // Nothing from this start fits the cap, so the smallest safe unit is emitted
    // raw and the split continues after it instead of swallowing the whole run.
    const nextCut = [...safeCuts].find(position => position > start) ?? seqs.length
    chunks.push(seqs.slice(start, nextCut))
    start = nextCut
  }
  return chunks
}

/**
 * Split one candidate span so no returned span mixes eligible and ineligible
 * tool results, cutting only at safe step/pair boundaries, and keep only the
 * spans whose results are all eligible.
 *
 * A partial summary can leave a run where replaced results sit beside raw ones.
 * Returning that mixed run made the caller skip it as a whole and strand the raw
 * siblings forever, so the mixed span is cut where eligibility changes and only
 * the all-eligible part is offered for selection. A mix that cannot be cut apart
 * safely (the change falls inside one step or across an open pair) yields no
 * selectable span, exactly like any other unfittable unit.
 * @param session - session supplying the current surface.
 * @param seqs - the candidate span's seqs in surface order.
 * @param isEligibleResult - eligibility classifier for one tool result seq.
 * @returns the all-eligible sub-spans in surface order, possibly empty.
 */
function splitMixedSpan(
  session: SessionRead,
  seqs: readonly SessionSeq[],
  isEligibleResult: (seq: SessionSeq) => boolean,
): SessionSeq[][] {
  // Safe boundaries are found up front: an eligibility change is cut at the
  // latest safe boundary after the previous class's last result, which is the
  // assistant message that introduced the new class rather than the result
  // itself (the cut between a call and its result is never safe).
  const cutPositions: number[] = []
  for (let position = 1; position < seqs.length; position += 1) {
    if (safeChunkCut(session, seqs[position - 1]!, seqs[position]!)) cutPositions.push(position)
  }
  const spans: SessionSeq[][] = []
  let start = 0
  let chunkEligible: boolean | undefined
  let lastResult = -1
  for (let index = 0; index < seqs.length; index += 1) {
    const event = session.eventAt(seqs[index]!)
    if (event === undefined) throw new Error('tool-groups: surface contains a missing event')
    if (event.type !== 'tool/result') continue
    const eligible = isEligibleResult(seqs[index]!)
    if (chunkEligible === undefined) {
      chunkEligible = eligible
    } else if (eligible !== chunkEligible) {
      const cut = latestCut(cutPositions, lastResult, index)
      if (cut > start) {
        spans.push(seqs.slice(start, cut))
        start = cut
        chunkEligible = eligible
      }
    }
    lastResult = index
  }
  spans.push(seqs.slice(start))
  return spans.filter(span => span.every((seq) => {
    const event = session.eventAt(seq)
    if (event === undefined) throw new Error('tool-groups: surface contains a missing event')
    return event.type !== 'tool/result' || isEligibleResult(seq)
  }))
}

/** The latest safe boundary in `(after, at]`, or -1 when the two sides cannot be separated. */
function latestCut(cutPositions: readonly number[], after: number, at: number): number {
  let latest = -1
  for (const position of cutPositions) {
    if (position > after && position <= at) latest = position
  }
  return latest
}

/** Whether a chunk boundary between two adjacent run nodes is balanced and step-aligned. */
function safeChunkCut(session: SessionRead, previous: SessionSeq, next: SessionSeq): boolean {
  if (!toolPairingBalancedBefore(session, next)) return false
  const left = session.eventAt(previous)
  const right = session.eventAt(next)
  if (left === undefined || right === undefined) return false
  return !sameStep(left, right)
}

function sameStep(left: SessionEvent, right: SessionEvent): boolean {
  const leftData = left.data as { turn?: unknown; step?: unknown }
  const rightData = right.data as { turn?: unknown; step?: unknown }
  return leftData.turn !== undefined && leftData.step !== undefined
    && leftData.turn === rightData.turn && leftData.step === rightData.step
}

function olderPositions(
  nodes: readonly SessionSeq[],
  range: { readonly start: SessionSeq; readonly end: SessionSeq } | null | undefined,
): { start: number; end: number } | null {
  if (range === null) return null
  if (range === undefined) return { start: 0, end: nodes.length - 1 }
  const start = nodes.indexOf(range.start)
  const end = nodes.indexOf(range.end)
  if (start < 0 || end < 0) throw new Error('tool-groups: olderRange must name current surface nodes')
  if (start > end) throw new Error('tool-groups: olderRange start must precede end in surface order')
  return { start, end }
}

/**
 * The shared production-default text metric for one tool-result MESSAGE's
 * content: Unicode code points across EVERY `text` block — message-level text
 * blocks and the text blocks nested in each `tool-result` block alike.
 *
 * Group selection must qualify on the same measure the deterministic pruning
 * threshold uses. Counting the ContentBlock ARRAY LENGTH instead made
 * `minGroupChars` a block count no real group could ever satisfy, and counting
 * only the first content block hid the later text of a multi-block result from
 * the pending-work probe that the deterministic pruner would still reduce.
 * @param content - the message-level content blocks of one tool result.
 * @returns total Unicode code points across every text block.
 */
export function toolResultTextLength(content: readonly ContentBlock[]): number {
  let chars = 0
  for (const block of content) {
    if (block.type === 'text') {
      chars += codePointLength(block.text)
      continue
    }
    if (block.type !== 'tool-result') continue
    chars += toolResultTextLength(block.content)
  }
  return chars
}

/** The selection metric: the shared code-point metric over the whole message. */
function defaultTextLength(event: SessionEvent<'tool/result'>): number {
  return toolResultTextLength(event.data.message.content)
}
