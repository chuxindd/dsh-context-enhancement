/**
 * `dsh-context-enhancement` — `./tool-result-pruner` subpath entry.
 *
 * Replay-safe, model-free tool-result pruning service providing the official
 * rc1 `toolResultPruner` service identity (`ctx.toolResultPruner`). The
 * official rc1 package has no extensible provider/definition to subclass (its
 * root exports the concrete {@link ToolResultPruner} class directly, and the
 * official service name `toolResultPruner` is matched by the Service
 * constructor), so this module re-implements the rc1 public class semantics
 * from the published rc1 sources — plus the Card5/6 region-aware `olderRange`
 * three-state option and the experimental text-only `hardLimitChars` bound —
 * while registering the same `toolResultPruner` service name. It re-declares
 * the official `ctx.toolResultPruner` Context merge so composition type-checks
 * against this provider in the same preset isolate realm.
 *
 * Only the published rc1 exports of the official packages are imported; the
 * internal implementation is a local MIT copy of the rc1 sources. SOURCE
 * provenance is recorded in THIRD_PARTY_NOTICES.md under
 * `@deepseek-ai/dsh-compaction-tool-result-pruner` (MIT, tag dsh-v0.1.2-rc.1).
 *
 * @module dsh-context-enhancement/tool-result-pruner
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './internal/compaction/pruner-config.ts'
import type {
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
  ToolResultPruneOptions,
  ToolResultPruneRange,
} from './internal/compaction/pruner-types.ts'

export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './internal/compaction/pruner-config.ts'
export type {
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
  ToolResultPruneOptions,
  ToolResultPruneRange,
} from './internal/compaction/pruner-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultPruner: ToolResultPruner
  }
}

interface SnapshotCandidate {
  readonly seq: SessionSeq
  readonly event: SessionEvent<'tool/result'>
  /** Whether the node lies inside the caller-selected older eligible span. */
  readonly ordinaryEligible: boolean
}

/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export class ToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so pruning genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
    // Preserve omission so the resolved config can distinguish a disabled
    // recent-result hard limit from an explicitly configured value.
    hardLimitChars: z.number().step(1).min(1).default(undefined as unknown as number),
  })

  /** Resolved and immutable character budgets. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    this.config = resolveConfig(config)
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Replace an over-budget text middle while retaining rich-block order. Text
   * slicing is by Unicode code point, not UTF-16 code unit, so a retained
   * boundary cannot split a surrogate pair. Grapheme clusters may still split.
   * @param blocks - original tool-result content.
   * @returns pruned content, or `null` when the text is within budget.
   */
  pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    return this.reduceContent(blocks, this.config.thresholdChars)
  }

  /**
   * Reduce one exceptionally large tool result below the configured head,
   * marker, and tail budgets when its `text` exceeds the experimental
   * recent-result hard limit; returns `null` when no hard limit is configured
   * or the content stays within it. Non-text blocks never count toward the
   * measured total.
   * @param blocks - original tool-result content.
   * @returns the bounded replacement, or `null` when reduction does not apply.
   */
  pruneRecentContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    if (this.config.hardLimitChars === undefined) return null
    return this.reduceContent(blocks, this.config.hardLimitChars)
  }

  /**
   * Reduce text whose total exceeds `triggerChars` to the configured head,
   * marker, and tail budget while preserving rich-block order. The measured
   * total counts `text`-block Unicode code points only; image, attachment, and
   * other non-text blocks cost zero and are never sliced or counted against a
   * budget.
   * @param blocks - original tool-result content.
   * @param triggerChars - character bound that makes a reduction apply.
   * @returns the bounded replacement, or `null` when the text is within budget.
   */
  private reduceContent(blocks: readonly ContentBlock[], triggerChars: number): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= triggerChars) return null

    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
      if (marker.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + marker
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    // totalChars > trigger and valid budgets guarantee a removed text span.
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    // Config validation fixes the emitted head + marker + tail budget.
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Prune eligible tool results from one stable current-surface snapshot.
   * Without `options`, every over-budget result in the snapshot is ordinary-
   * eligible, preserving the original whole-surface pass. With `options`, only
   * results inside the caller-selected older eligible span are ordinary-
   * eligible; a result outside the span (the protected recent region) stays at
   * high fidelity unless `hardLimitChars` forces one exceptionally large recent
   * result down to the ordinary budget. The span's `start`/`end` name surface
   * POSITIONS by current-surface event seq (a closed interval resolved with
   * `indexOf`), so a numerically larger `start` than `end` is valid when
   * replacements made the visible seqs non-monotonic. Each replacement
   * preserves the complete event data except for `content`, cites the shadowed
   * node so replay can recover the replacement input, and is immediately
   * preceded by a `compaction/prune` shadow-price event pricing the shadowed
   * node through the injected token meter, so pure consumers can subtract it
   * without per-node state.
   * @param session - session whose current surface is rewritten.
   * @param options - optional eligible older span for region-aware passes.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement, or an `olderRange` names a
   * seq absent from the current surface; replacements committed earlier in the
   * pass remain durable.
   */
  pruneSession(session: Session, options?: ToolResultPruneOptions): PruneResult {
    const nodes = [...session.surface.nodes]
    const olderSpan = options?.olderRange === undefined
      ? { startIndex: 0, endIndex: nodes.length - 1 }
      : options.olderRange === null
        ? null
        : resolveOlderSpan(nodes, options.olderRange)

    const candidates: SnapshotCandidate[] = []
    for (const [position, seq] of nodes.entries()) {
      const event = session.eventAt(seq)
      // Surface seqs are validated contiguous log references.
      if (event?.type !== 'tool/result') continue
      const ordinaryEligible = olderSpan === null
        ? false
        : position >= olderSpan.startIndex && position <= olderSpan.endIndex
      candidates.push({ seq, event, ordinaryEligible })
    }

    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event, ordinaryEligible } of candidates) {
      const result = event.data.message.content[0]
      const content = ordinaryEligible
        ? this.pruneContent(result.content)
        : this.pruneRecentContent(result.content)
      if (content === null) continue
      const charsBefore = this.measureContent(result.content)
      const charsAfter = this.measureContent(content)
      const message = freezeMessage<ToolResultMessage>({
        ...event.data.message,
        content: [{
          ...result,
          content,
        }] as [typeof result],
      })
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent, so pure consumers subtract the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }
}

/** Resolve a caller older span's inclusive surface positions. */
function resolveOlderSpan(nodes: readonly SessionSeq[], range: ToolResultPruneRange): { startIndex: number; endIndex: number } {
  const startIndex = nodes.indexOf(range.start)
  const endIndex = nodes.indexOf(range.end)
  if (startIndex === -1) {
    throw new Error(`tool-result prune: olderRange start seq ${range.start} not found in surface`)
  }
  if (endIndex === -1) {
    throw new Error(`tool-result prune: olderRange end seq ${range.end} not found in surface`)
  }
  if (startIndex > endIndex) {
    throw new Error(
      `tool-result prune: olderRange start seq ${range.start} (position ${startIndex}) `
      + `is after end seq ${range.end} (position ${endIndex}) on the surface`,
    )
  }
  return { startIndex, endIndex }
}

export default ToolResultPruner
