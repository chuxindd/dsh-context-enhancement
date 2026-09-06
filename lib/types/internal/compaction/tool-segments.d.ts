/**
 * Conservative deterministic tool-segment identification over a session
 * surface, re-implemented for `dsh-context-enhancement` from the MIT-licensed
 * Card5/6 migration delta of the official rc.1 tree.
 *
 * SOURCE: this file is a local copy of the working-tree Card5/6 addition
 * `packages/compaction/compaction/src/tool-segments.ts` (MIT, on top of tag
 * 0.1.2-rc.1 of the `deepseek-harness` repository). The upstream file lands in
 * the published package only after the migration ships; this standalone package
 * must not depend on that unshipped subpath, so the helper is copied here.
 * Provenance is recorded in THIRD_PARTY_NOTICES.md.
 *
 * A tool segment is a maximal same-turn surface run of assistant tool-call
 * messages and complete tool results that starts and ends at balanced tool-pair
 * cuts. Every parallel call of one assistant message stays together because the
 * run consumes the whole assistant node and its complete results, and an open
 * or incomplete trailing tail is excluded. Ordinary user messages, ordinary
 * assistant responses, runtime-context snapshots, compaction replacements, and
 * every other non-tool surface node interrupt a segment, and a run cannot cross
 * a turn. The segmenter infers no semantic objectives, data dependencies,
 * cross-turn causality, child-session semantics, or dependencies among parallel
 * tools; ambiguous work therefore remains in separate segments.
 *
 * @module dsh-context-enhancement/internal/compaction/tool-segments
 */
import type { SessionSeq } from '@deepseek-ai/dsh-session/types';
import type { SessionRead } from './tool-pairing.ts';
/** One balanced deterministic tool segment over contiguous current surface positions. */
export interface ToolSegment {
    /** Surface seq of the segment's first node. */
    readonly startSeq: SessionSeq;
    /** Surface seq of the segment's last node. */
    readonly endSeq: SessionSeq;
    /** Seqs of the segment's nodes in surface order (not necessarily sorted by value after replacements). */
    readonly seqs: readonly SessionSeq[];
    /** Turn that owns the whole segment. */
    readonly turn: number;
}
/**
 * Enumerate the current surface's balanced deterministic tool segments in
 * surface order.
 *
 * Each maximal same-turn run of tool-burst nodes is scanned for balanced
 * tool-pair cuts. The emitted segment starts at the first run position whose
 * leading cut is balanced and ends at the last position whose trailing cut is
 * balanced, so a complete call/result pair is never split, parallel calls from
 * one assistant message stay together, and an open or incomplete trailing tail
 * (an unanswered assistant tool call) is excluded rather than emitted as a
 * partial segment. A run left open by an interrupt or an unanswered earlier
 * call emits no partial segment.
 * @param session - session supplying the authoritative current surface.
 * @returns the balanced tool segments in surface order.
 * @throws when a surface node has no matching log event or the surface is
 * otherwise corrupt (delegated to the tool-pairing predicates).
 */
export declare function toolSegments(session: SessionRead): ToolSegment[];
/**
 * Find the balanced tool segment that owns a current surface node, for snapping
 * a caller-selected boundary to a whole segment.
 * @param session - session supplying the current surface.
 * @param seq - a current surface node seq.
 * @returns the owning segment, or null when the node belongs to no balanced segment.
 * @throws when the seq is absent from the current surface.
 */
export declare function toolSegmentAt(session: SessionRead, seq: SessionSeq): ToolSegment | null;
//# sourceMappingURL=tool-segments.d.ts.map