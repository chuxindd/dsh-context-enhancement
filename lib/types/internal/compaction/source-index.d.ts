/**
 * Durable source classification for the current session surface.
 *
 * Classification is derived from replacement provenance and official compaction
 * events, never from generated text. It can therefore be rebuilt after a
 * process restart from the Session log plus the surface relationship.
 */
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
export type SurfaceSourceKind = 'original' | 'tool-summary' | 'tool-pruned' | 'history-summary' | 'unknown-replacement';
export interface SurfaceSourceEntry {
    readonly seq: SessionSeq;
    readonly kind: SurfaceSourceKind;
    readonly sourceEventSeqs: readonly SessionSeq[];
    /**
     * Later completed turns after this replacement. Under the ordinary
     * maintenance/overflow rule a replacement may only re-enter semantic
     * compaction after this many of them; the whole-zone pressure pass
     * deliberately relaxes that rule for known replacements (see
     * {@link SurfaceSourceIndex.canCompactHistory}).
     */
    readonly completedTurnsAfter: number;
}
export interface SurfaceSourceIndex {
    readonly entries: ReadonlyMap<SessionSeq, SurfaceSourceEntry>;
    entry(seq: SessionSeq): SurfaceSourceEntry;
    isOriginalToolResult(seq: SessionSeq): boolean;
    /**
     * Whether one surface node may be folded into a semantic history compaction.
     *
     * Original content is always eligible. Replacement content is deferred until
     * `minReentryTurns` later completed turns exist, so a replacement is served
     * by real requests before being condensed again — EXCEPT that the whole-zone
     * pressure pass passes `allowImmediateReentry` to fold every replacement this
     * engine durably produced (tool summary, pruned result, history summary):
     * once such a replacement sits inside a later invocation's forget zone, newer
     * dialogue exists after it and its content has reached at least one request,
     * so it is historical regardless of `turn/end` boundaries. Unknown
     * third-party replacements are never relaxed by the flag and keep the
     * completed-turn rule in every path. Same-invocation freshness is NOT a
     * source-index concern: the engine excludes its own just-created
     * replacements through a round-local set before consulting this index.
     */
    canCompactHistory(seq: SessionSeq, minReentryTurns: number, allowImmediateReentry?: boolean): boolean;
}
/** Reconstruct current source types entirely from persisted session provenance. */
export declare function buildSurfaceSourceIndex(session: Session, toolSummaryReplacementSeqs?: readonly SessionSeq[]): SurfaceSourceIndex;
//# sourceMappingURL=source-index.d.ts.map