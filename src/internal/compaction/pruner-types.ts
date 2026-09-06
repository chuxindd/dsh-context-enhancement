/**
 * Character-budget and range vocabulary for deterministic tool-result pruning,
 * re-implemented for `dsh-context-enhancement` from the MIT-licensed official
 * rc1 source with the Card5/6 `olderRange`/`hardLimitChars` delta.
 *
 * SOURCE: local copy of the official rc.1 `dsh-compaction-tool-result-pruner`
 * `src/types.ts` (MIT, tag dsh-v0.1.2-rc.1 of the `deepseek-harness`
 * repository) plus the Card5/6 working-tree delta (`ToolResultPruneRange`,
 * `ToolResultPruneOptions`, `hardLimitChars`). Provenance is recorded in
 * THIRD_PARTY_NOTICES.md.
 *
 * @module dsh-context-enhancement/internal/compaction/pruner-types
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/**
 * One inclusive span of current-surface nodes named by their event seqs. The
 * edges are resolved by surface POSITION, not by numeric seq order: `start`
 * names the current-surface node at the span's first position and `end` the
 * node at its last position. Surface replacements can make the visible seqs
 * non-monotonic, so `start` may be numerically larger than `end`; the span is
 * still the closed interval between those two positions, and each edge seq
 * must name a current surface node. A pruner pass resolves both edges with
 * `indexOf` against the current surface, then applies the closed position
 * interval in between.
 */
export interface ToolResultPruneRange {
  /** Current surface event seq of the span's first-position node. */
  readonly start: SessionSeq
  /** Current surface event seq of the span's last-position node. */
  readonly end: SessionSeq
}

/** Character-budget policy for deterministic tool-result pruning. */
export interface ToolResultPruneConfig {
  /** Prune when total text exceeds this many Unicode code points. Defaults to `8192`. */
  thresholdChars?: number
  /** Maximum leading Unicode code points retained. Defaults to `4096`. */
  headChars?: number
  /** Maximum trailing Unicode code points retained. Defaults to `1024`. */
  tailChars?: number
  /**
   * Experimental recent-result upper bound, in Unicode code points of `text`
   * blocks only; disabled when absent. A tool result in the protected recent
   * region whose measured text exceeds this bound is reduced to the ordinary
   * head/marker/tail budget, while recent results between `thresholdChars` and
   * this bound stay at high fidelity. The bound counts the same text-only
   * measure as `thresholdChars`: image, attachment, and other non-text blocks
   * are never counted against it or any other budget. Validated at or above
   * `thresholdChars`.
   */
  hardLimitChars?: number
}

/** Validated, detached, deeply immutable pruning configuration. */
export interface ResolvedConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
  /**
   * Recent-result hard bound; `undefined` keeps every recent result protected.
   * The key is always present so consumers can read the disabled state without
   * optional chaining and catalogs render it uniformly. It constrains `text`
   * blocks only; image, attachment, and other non-text blocks are never
   * measured against it.
   */
  readonly hardLimitChars: number | undefined
}

/** Candidate-scope options for one stable-surface pruning pass. */
export interface ToolResultPruneOptions {
  /**
   * Current-surface span eligible for ordinary threshold pruning. A `tool/result`
   * outside the span is recent and stays at high fidelity unless `hardLimitChars`
   * forces one exceptionally large result down to the ordinary budget; `null`
   * marks the whole surface as recent, and an absent field keeps the original
   * whole-surface ordinary pass.
   */
  readonly olderRange?: ToolResultPruneRange | null
}

/** Cited source event and size accounting for one landed surface replacement. */
export interface PrunedEntry {
  /** Full-fidelity tool-result event shadowed by the replacement. */
  readonly originalSeq: SessionSeq
  /** Newly appended pruned tool-result event. */
  readonly replacementSeq: SessionSeq
  /** Tool call shared by the original and replacement. */
  readonly callId: ToolCallId
  /** Original text size in Unicode code points. */
  readonly charsBefore: number
  /** Replacement text size in Unicode code points. */
  readonly charsAfter: number
}

/** Aggregate outcome of one stable-surface pruning pass. */
export interface PruneResult {
  /** Replacements in the snapshotted surface order. */
  readonly pruned: readonly PrunedEntry[]
  /** Total Unicode code points removed across replacements. */
  readonly charsRemoved: number
}
