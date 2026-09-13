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
    /**
     * Absolute retained-tail boundary in surface tokens. When present it replaces
     * `floor(contextWindow * recentRatio)`, so a budget already expressed as an
     * integer (the envelope grant, or `spec.retainTokens`) never round-trips
     * through a ratio: `floor(capacity * (tokens / capacity))` can land one token
     * below `tokens` in binary floating point, and one token is enough to move
     * the tail boundary across a step and change which tool pairs stay whole.
     */
    readonly recentBoundaryTokens?: number;
    /**
     * Absolute forget boundary in surface tokens. When present it replaces
     * `floor(contextWindow * forgetBoundaryRatio)`, so an envelope-derived
     * boundary (`min(legacy forget boundary, grant)`) is applied exactly.
     */
    readonly forgetBoundaryTokens?: number;
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
export type PressureSpanBlockReason = 'envelope-dominated' | 'no-safe-prefix' | 'span-below-minimum';
export interface PressureSpanOptions {
    /**
     * Reclaim target in surface tokens: the ACTUAL pressure deficit
     * `U = max(0, totalTokens - pressureThreshold)`. The meter identity
     * `T = E + S` with `dT/dS = 1` makes request and surface units identical, so
     * a span priced `P` whose replacement prices `s` ends pressure exactly when
     * `P - s > U`. The region transaction's strict-shrink check bounds the
     * replacement only loosely: `minSpanTokens <= s <= P - 1`. The checkpoint
     * floor is a LOWER bound, and the shrink assertion caps the replacement one
     * token under the span, so no span price can force the replacement toward
     * the floor and the worst legal replacement reclaims exactly one token.
     * `P >= U + minSpanTokens + 1` therefore makes `P` the smallest span that
     * CAN end pressure — if the replacement lands at the checkpoint floor — and
     * never a one-pass clearing guarantee: the caller must re-measure after
     * every replacement and re-plan while the request stays above threshold.
     */
    readonly reclaimTokens: number;
    /**
     * Largest span price one auxiliary call may carry: `Bcap`, the biggest span
     * whose request input `E + span + instruction` still leaves the configured
     * response reserve, safety margin, and summary generation cap free.
     * `<= 0` vetoes the pass outright.
     */
    readonly inputCapTokens: number;
    /**
     * Smallest span price worth a call: the framed checkpoint the summary would
     * become. A span at or below it can never satisfy the shrink assertion.
     */
    readonly minSpanTokens: number;
    /**
     * Optional upper bound on surface endpoint index (inclusive).
     * When provided, candidate spans must end at or before this index.
     */
    readonly maxEndIndex?: number | undefined;
    /**
     * Optional lower bound on surface start index (inclusive).
     * When provided, candidate spans must start at or after this index.
     * Used for skip-forward in multi-batch pressure passes to exclude
     * replacements produced earlier in the same invocation.
     */
    readonly minStartIndex?: number | undefined;
}
export type PressureSpanPlan = {
    readonly kind: 'selected';
    readonly range: SurfaceIndexRange;
} | {
    readonly kind: 'blocked';
    readonly reason: PressureSpanBlockReason;
};
/**
 * Select the single span an above-threshold pressure pass may shadow.
 *
 * There is exactly one pressure planner. It is envelope-aware end to end: the
 * span is sized to the request's actual pressure deficit rather than to a
 * window fraction, and it is bounded by `Bcap` — the largest span whose
 * auxiliary input `E + span + instruction` still leaves the configured response
 * reserve, safety margin, and summary generation cap free — so a dominating
 * request envelope (system prompt, tool catalog, provider anchor above the
 * heuristic price) can never turn a pressure pass into an over-budget call.
 *
 * The planner walks the older head — every surface position before
 * `zones.recent.startIndex`, regardless of how the forget/tool boundaries split
 * it — and tracks two safe answers in one pass:
 *
 * - the FIRST pairing/step-safe prefix priced at or above the reclaim target
 *   `U + minSpan + 1` (the deficit-sized answer: the smallest span that CAN end
 *   pressure, and only when its replacement lands at the checkpoint floor —
 *   the shrink assertion alone promises at least one token of progress), and
 * - the LAST safe prefix priced at or below `Bcap` (the widest answer).
 *
 * When no safe prefix reaches the strict target under the cap, the widest safe
 * prefix still wins whenever it prices above the checkpoint floor: head and
 * deficit grow together (`head - U = threshold - E - tail`), so a head that
 * cannot reach the target now never will, and progress beats a permanent stop.
 * Otherwise the pass is refused with a typed reason:
 *
 * - `envelope-dominated`: `Bcap <= 0`, so no auxiliary call can be sent at all;
 * - `no-safe-prefix`: the surface head itself is pairing-pinned (no prefix can
 *   start there) or no safe end exists under the cap;
 * - `span-below-minimum`: every safe prefix would be shadowed by a summary as
 *   expensive as itself.
 *
 * The selection is a progress guarantee, not a deficit guarantee: every
 * returned span prices above the checkpoint floor, so a strict-shrink
 * replacement exists, but the shrink assertion lets that replacement reclaim
 * anywhere between one token and `P - minSpan`, so how much pressure one pass
 * releases depends on the replacement price the summarizer produces. The
 * caller must re-measure after the replacement and re-plan within its own
 * bounded budget while the request is still above threshold.
 *
 * The retained tail is never touched: every candidate ends before
 * `zones.recent.startIndex`, which the partition already rounded head-ward to a
 * pairing-balanced step boundary. Only call this for a pressure pass: it
 * deliberately reaches across the forget boundary, which every bounded
 * maintenance batch must still respect.
 *
 * @param session - session whose current surface supplies the older head.
 * @param measurement - priced snapshot of the current surface.
 * @param zones - partition of that same surface and measurement.
 * @param options - pressure deficit, auxiliary input cap, and span floor.
 * @returns the selected span, or a blocked plan naming the reason.
 */
export declare function planPressureSpan(session: Session, measurement: TokenMeasurement, zones: SurfaceZones, options: PressureSpanOptions): PressureSpanPlan;
//# sourceMappingURL=zones.d.ts.map