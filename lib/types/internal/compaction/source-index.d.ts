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
    /** A history summary may only re-enter after this many later completed turns. */
    readonly completedTurnsAfter: number;
}
export interface SurfaceSourceIndex {
    readonly entries: ReadonlyMap<SessionSeq, SurfaceSourceEntry>;
    entry(seq: SessionSeq): SurfaceSourceEntry;
    isOriginalToolResult(seq: SessionSeq): boolean;
    canCompactHistory(seq: SessionSeq, minReentryTurns: number, allowImmediateHistorySummary?: boolean): boolean;
}
/** Reconstruct current source types entirely from persisted session provenance. */
export declare function buildSurfaceSourceIndex(session: Session, toolSummaryReplacementSeqs?: readonly SessionSeq[]): SurfaceSourceIndex;
//# sourceMappingURL=source-index.d.ts.map