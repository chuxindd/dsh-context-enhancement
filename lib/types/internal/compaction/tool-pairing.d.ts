/**
 * Tool-pairing balance over a session surface, re-implemented for
 * `dsh-context-enhancement` from the MIT-licensed official rc1 source.
 *
 * SOURCE: this file is a local copy of the official rc.1 release file
 * `packages/compaction/compaction/src/tool-pairing.ts` from the
 * `deepseek-harness` repository (tag 0.1.2-rc.1, LICENSE MIT), with the Card5/6
 * migration delta (structural `SessionRead` over the root `Session` import)
 * folded in. It exists because official `@deepseek-ai` packages' `src/*`
 * subpaths are not a stable third-party API. Only the published rc1 exports
 * of the official packages are consumed elsewhere. Provenance is recorded in
 * THIRD_PARTY_NOTICES.md.
 *
 * Compaction changes surface positions, so safe cuts are derived from
 * tool-call/result content in current surface order rather than step markers.
 * Cordis-free: it imports no cordis value and only session *types* (never the
 * root Context merge).
 * @module dsh-context-enhancement/internal/compaction/tool-pairing
 */
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session/types';
/**
 * Read side of a session surface that the pairing helpers and the pure
 * surface-structure leaves need: the ordered current surface and per-seq event
 * lookup over the log that names it. A live or detached `Session` (from the
 * `@deepseek-ai/dsh-session` root) is assignable to this shape; declaring it
 * structurally keeps cordis-free leaves from importing the root entry, which
 * merges the host-only `ctx.sessions` into every consumer program. Reads
 * resolve one surface seq at a time through {@link eventAt}; callers that need
 * a full log scan use the Session's `snapshotEvents()` directly outside these
 * leaves.
 */
export interface SessionRead {
    /**
     * Return the immutable event stored at one exact sequence number.
     * @param seq - the event's session sequence.
     * @returns the accepted event, or undefined when the log does not contain it.
     */
    eventAt(seq: SessionSeq): SessionEvent | undefined;
    /** Live ordered surface over the event log. */
    readonly surface: {
        /** Current surface event sequences in model-visible order. */
        readonly nodes: readonly SessionSeq[];
        /** Monotonic count of committed positional replacements. */
        readonly replaceGeneration: number;
    };
}
/**
 * Whether the cut immediately before a current surface sequence is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param seq - event sequence whose leading cut is checked.
 * @returns true when no unanswered tool call crosses the cut.
 * @throws when the seq is absent from the current surface, a surface sequence has no
 * matching log event, or a tool result has no preceding open call.
 */
export declare function toolPairingBalancedBefore(session: SessionRead, seq: SessionSeq): boolean;
/**
 * Whether the cut immediately after a current surface sequence is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param seq - event sequence whose trailing cut is checked.
 * @returns true when no unanswered tool call crosses the cut.
 * @throws when the seq is absent from the current surface, a surface sequence has no
 * matching log event, or a tool result has no preceding open call.
 */
export declare function toolPairingBalancedAfter(session: SessionRead, seq: SessionSeq): boolean;
//# sourceMappingURL=tool-pairing.d.ts.map