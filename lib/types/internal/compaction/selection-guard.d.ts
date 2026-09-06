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
import type { SessionSeq } from '@deepseek-ai/dsh-session/types';
import type { SessionRead } from './tool-pairing.ts';
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
export declare function isIsolatedOldSummaryRange(session: SessionRead, seqs: readonly SessionSeq[]): boolean;
//# sourceMappingURL=selection-guard.d.ts.map