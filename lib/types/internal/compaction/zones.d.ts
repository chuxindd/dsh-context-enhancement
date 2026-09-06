/**
 * Positional three-zone planning for progressive context compaction.
 *
 * All ranges are expressed as current-surface indexes. This is deliberate:
 * replacement events append fresh sequence numbers and therefore visible seqs
 * are not necessarily numerically ordered. Pairing and step-boundary checks
 * keep every emitted range whole.
 */
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
export type CompactionZone = 'forget' | 'tool' | 'recent';
export interface SurfaceIndexRange {
    readonly startIndex: number;
    readonly endIndex: number;
    readonly startSeq: SessionSeq;
    readonly endSeq: SessionSeq;
    readonly tokens: number;
}
export interface SurfaceZones {
    readonly totalTokens: number;
    readonly recentBoundaryTokens: number;
    readonly forgetBoundaryTokens: number;
    readonly forget: SurfaceIndexRange | null;
    readonly tool: SurfaceIndexRange | null;
    readonly recent: SurfaceIndexRange | null;
}
export interface ZoneRatios {
    readonly recentRatio: number;
    readonly forgetBoundaryRatio: number;
    /** Model context capacity used for tail-distance boundaries. */
    readonly contextWindow: number;
}
export interface ForgetBatchOptions {
    readonly targetBatchTokens: number;
    readonly maxBatchTokens: number;
}
export type ForgetBatchBlockReason = 'no-forget-range' | 'unsafe-forget-start' | 'oldest-unit-too-large' | 'no-safe-batch-end';
export type ForgetBatchPlan = {
    readonly kind: 'selected';
    readonly range: SurfaceIndexRange;
} | {
    readonly kind: 'blocked';
    readonly reason: ForgetBatchBlockReason;
};
/**
 * Partition one token snapshot into non-overlapping forget/tool/recent zones.
 * Boundaries are measured from the newest surface tail and moved toward the
 * historical side until the cut is outside any open tool pair.
 */
export declare function partitionSurfaceZones(session: Session, measurement: TokenMeasurement, ratios: ZoneRatios): SurfaceZones;
/** Return a current-surface range by indexes, or null for an empty range. */
export declare function rangeFromIndexes(session: Session, measurement: TokenMeasurement, startIndex: number, endIndex: number): SurfaceIndexRange | null;
/**
 * Select the oldest complete forget-zone batch. The first complete unit is
 * allowed to be below the target, but never above max; if it is above max no
 * semantic call is made. The returned range never crosses the forget boundary.
 */
export declare function planForgetBatch(session: Session, measurement: TokenMeasurement, zones: SurfaceZones, options: ForgetBatchOptions): ForgetBatchPlan;
export declare function selectForgetBatch(session: Session, measurement: TokenMeasurement, zones: SurfaceZones, options: ForgetBatchOptions): SurfaceIndexRange | null;
//# sourceMappingURL=zones.d.ts.map