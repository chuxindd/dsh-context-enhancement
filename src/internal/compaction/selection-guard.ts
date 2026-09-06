/**
 * Empty-benefit guard for recursive global compaction, re-implemented for
 * `dsh-context-enhancement` from the MIT-licensed Card5/6 migration delta of
 * the official rc.1 tree.
 *
 * SOURCE: this file is a local copy of the working-tree Card5/6 addition
 * `packages/compaction/compaction/src/selection-guard.ts` (MIT, on top of tag
 * 0.1.2-rc.1 of the `deepseek-harness` repository). The upstream file lands in
 * the published package only after the migration ships; this standalone package
 * must not depend on that unshipped subpath, so the helper is copied here.
 * Unlike the upstream leaf it consumes the checkpoint predicate through the
 * published rc1 `@deepseek-ai/dsh-compaction/checkpoint` subpath instead of a
 * local `./checkpoint.ts`, so no checkpoint module is re-implemented.
 * Provenance is recorded in THIRD_PARTY_NOTICES.md.
 *
 * The guard rejects a candidate older surface span that contains only old
 * compaction summaries with no current non-checkpoint node, so a later
 * compaction pass never spends a model call re-summarizing an isolated old
 * summary. Cordis-free: it reads only the session surface (through the
 * structural {@link SessionRead} type), the shared checkpoint predicate, and
 * the session surface predicate, and never loads the host plugin's Context
 * merges.
 *
 * An old compaction replacement is otherwise a normal current surface node and
 * may enter a later global compaction span together with newer old content —
 * no summary is permanently protected. This guard only rejects the
 * all-summary case; the existing non-shrink transaction assertion remains the
 * final guard.
 *
 * @module dsh-context-enhancement/internal/compaction/selection-guard
 */

import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type { SessionRead } from './tool-pairing.ts'

/**
 * Whether a current surface node is an old compaction summary: a user-role
 * replacement message carrying the compaction checkpoint marker. The
 * replacement requirement matches the compaction invariant's checkpoint
 * recognition, so an appended user message that merely carries the marker
 * without shadowing a range is not treated as a summary.
 * @param event - a current surface-node event.
 * @returns true when the node is a compaction replacement checkpoint.
 */
function isOldCompactionSummary(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  if (!isReplacementSurfaceEvent(event)) return false
  const { source } = event.data
  return source.kind === 'plugin' && isCompactCheckpointSource(source)
}

/**
 * Whether a candidate surface span holds only old compaction summaries with no
 * current non-checkpoint node, making a recursive compaction of that span an
 * empty-benefit pass.
 *
 * Caller contract: `seqs` must name a complete, contiguous, duplicate-free
 * span of the session's current surface, listed in current surface order —
 * exactly `session.surface.nodes.slice(start, end)` for one `start`/`end`.
 * Any other input (an out-of-order list, a sparse list that skips a surface
 * node, a repeated seq, a seq that is not a current surface node, or a seq
 * with no matching log event) is a caller bug and is rejected loudly rather
 * than answered silently. Pass the empty array for "no candidate".
 *
 * @param session - session whose current surface contains the candidate seqs.
 * @param seqs - the candidate span's current surface node seqs, in surface order.
 * @returns true when the span is non-empty and every node is an old compaction
 * summary; false when the span is empty or contains at least one
 * non-checkpoint node.
 * @throws when `seqs` is not a complete contiguous duplicate-free span of the
 * current surface in surface order, when a seq names no current surface node,
 * or when a current surface seq names no matching log event.
 */
export function isIsolatedOldSummaryRange(session: SessionRead, seqs: readonly SessionSeq[]): boolean {
  if (seqs.length === 0) return false
  const surfaceNodes = session.surface.nodes
  const seen = new Set<SessionSeq>()
  let startIndex = -1
  for (const [offset, seq] of seqs.entries()) {
    const position = surfaceNodes.indexOf(seq)
    // A shadowed event remains in the log but is not a current surface node;
    // naming one is a caller bug, so reject it loudly rather than let a stale
    // node steer the guard.
    if (position === -1) {
      throw new Error(`selection-guard: surface seq ${seq} is not a current surface node`)
    }
    if (seen.has(seq)) {
      throw new Error(`selection-guard: candidate seqs must not repeat surface seq ${seq}`)
    }
    seen.add(seq)
    if (offset === 0) {
      startIndex = position
      continue
    }
    // Require the candidate to be exactly one contiguous surface span in
    // surface order; out-of-order, sparse, or duplicated candidates cannot
    // represent the span a recursive compaction would actually shadow.
    if (position !== startIndex + offset) {
      throw new Error('selection-guard: candidate seqs must name a contiguous span of the current surface in surface order; '
        + `seq ${seq} does not follow surface position ${startIndex + offset}`)
    }
  }
  return seqs.every((seq) => {
    const event = session.eventAt(seq)
    if (event === undefined || event.seq !== seq) {
      throw new Error(`selection-guard: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    return isOldCompactionSummary(event)
  })
}
