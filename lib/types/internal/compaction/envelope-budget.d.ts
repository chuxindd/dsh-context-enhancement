/**
 * Envelope-aware surface budget for compaction.
 *
 * Triggers are priced on the whole request envelope (`measurement.totalTokens`)
 * while every retention and span boundary is a price in SURFACE tokens
 * (`measurement.surfaceTokens`). The two axes differ by the request envelope
 *
 *   E = max(0, totalTokens - surfaceTokens)
 *
 * — system prompt, tool schemas, and provider-anchor mispricing — so a session
 * whose envelope dominates can sit above the pressure threshold while its
 * surface has nothing safe left to release. This module derives the surface side
 * of the same budget so a pass never spends an auxiliary call whose input
 * already exceeds the window:
 *
 *   E     = max(0, T - S)                        request envelope
 *   G     = max(0, W - E - R - M)                safe surface grant (S units)
 *   Rkeep = max(Rmin, min(G, R0))                affordable retained tail
 *   Bcap  = max(0, G - I - C)                    auxiliary input cap (S units)
 *
 * `R` is the configured response reserve, `M` the configured mispricing margin,
 * `I` the priced compaction instruction, and `C` the summarization generation
 * cap. A span priced at or below `Bcap` keeps the auxiliary call at
 * `E + span + I <= W - R - M - C`, so the reserve and the margin always stay
 * free. `Rkeep` never drops below the priced tail covering the open turn and the
 * last completed turn, so the newest dialogue stays verbatim in every case.
 *
 * Nothing here reads or mutates the session: the budget is a pure re-pricing of
 * one meter snapshot.
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter';
/** One resolved policy's envelope-budget inputs, all in tokens. */
export interface EnvelopeBudgetInput {
    /** Model context capacity `W`. */
    readonly contextWindow: number;
    /** Response reserve `R` held free for the conversation's next reply. */
    readonly responseReserveTokens: number;
    /** Mispricing safety margin `M` held free against provider-vs-heuristic drift. */
    readonly safetyMarginTokens: number;
    /** Priced compaction instruction `I` the auxiliary call appends. */
    readonly instructionTokens: number;
    /** Generation cap `C` of the auxiliary summarization call. */
    readonly summaryMaxTokens: number;
    /** Configured retained-tail budget `R0` (surface units). */
    readonly retainTokens: number;
    /** Tail floor `Rmin` covering the open turn and the last completed turn. */
    readonly minRetainTokens: number;
    /** Stable task-state slot injection tokens I deducted from the safe surface grant. */
    readonly injectionTokens?: number;
}
/** One priced envelope budget derived from a single meter snapshot. */
export interface EnvelopeBudget {
    readonly totalTokens: number;
    readonly surfaceTokens: number;
    /** `E = max(0, totalTokens - surfaceTokens)`, the non-surface request envelope. */
    readonly envelopeTokens: number;
    /** Stable task-state slot injection tokens I deducted from G. */
    readonly injectionTokens: number;
    /** `G = max(0, W - E - R - M - I)`, the surface tokens the session may hold. */
    readonly surfaceGrantTokens: number;
    /** `max(Rmin, min(G, R0))`: the affordable retained recent tail. */
    readonly retainedTailTokens: number;
    /** `max(0, G - I - C)`: the largest span price one auxiliary call may carry. */
    readonly summarizerInputCapTokens: number;
    /** True when no span can be sent without exceeding the window (`Bcap <= 0`). */
    readonly envelopeDominated: boolean;
}
/** Derive the surface budget of one meter snapshot. */
export declare function resolveEnvelopeBudget(measurement: Pick<TokenMeasurement, 'totalTokens' | 'surfaceTokens'>, input: EnvelopeBudgetInput): EnvelopeBudget;
/**
 * Price the verbatim tail that must survive any budget: the working set covering
 * the open turn (if one is currently open) and the last successfully/normally
 * completed turn (`turn/end` with `reason.kind === 'completed'`).
 *
 * Interrupted, aborted, or failed newer turns do not count as completed turns,
 * so the retained tail reaches back past them to include the true last completed
 * turn, preserving "open turn + last completed turn" semantics.
 * If turn metadata is absent or incomplete, it conservatively retains at least
 * {@link GUARANTEED_TAIL_TURNS} distinct surface turns so the protection floor
 * never drops into an unsafe state.
 * @param session - session supplying the current surface and event data.
 * @param measurement - priced snapshot of that same surface.
 * @returns the summed route price of the guaranteed tail.
 */
export declare function retainedTailFloorTokens(session: Session, measurement: TokenMeasurement): number;
/**
 * One policy's waterline-grant inputs for the positional zone boundaries.
 *
 * {@link resolveEnvelopeBudget} prices the auxiliary CALL (`Bcap`); this is the
 * companion projection of the same snapshot onto the zone PARTITION, where the
 * legacy boundaries are fractions of the window applied to the surface price
 * while the envelope is what actually fills the request:
 *
 *   E  = max(0, T - S)                     request envelope
 *   G  = max(0, forgetWatermark - E)       surface grant at the waterline
 *   F' = min(F_b, G)                       effective forget boundary
 *   R' = max(Rmin, min(G, R0))             effective retained tail (integer)
 *
 * Both effective boundaries are absolute token counts, so they reach
 * `partitionSurfaceZones` without a ratio round-trip.
 */
export interface EnvelopeZoneBudgetInput {
    /** Pressure trigger `thresholdTokens` the pass is trying to get below. */
    readonly pressureTokens: number;
    /** Forget-maintenance waterline `floor(W * forgetMaintenanceRatio)`. */
    readonly forgetWatermarkTokens: number;
    /** Configured forget boundary `F_b` (surface units); the clamp only narrows it. */
    readonly forgetBoundaryTokens: number;
    /** Configured retained-tail budget `R0` (surface units). */
    readonly retainTokens: number;
    /** Tail floor `Rmin` covering the open turn and the last completed turn. */
    readonly minRetainTokens: number;
    /** Stable task-state slot injection tokens I deducted from the waterline grant. */
    readonly injectionTokens?: number;
}
/** One snapshot's envelope-aware zone boundaries and domination verdict. */
export interface EnvelopeZoneBudget {
    /** `E = max(0, totalTokens - surfaceTokens)`. */
    readonly envelopeTokens: number;
    /** Stable task-state slot injection tokens I. */
    readonly injectionTokens: number;
    /** `G = max(0, forgetWatermarkTokens - E - I)`, the surface price affordable AT the waterline. */
    readonly waterlineGrantTokens: number;
    /** `min(F_b, G)`: the forget zone never exceeds the affordable surface. */
    readonly forgetBoundaryTokens: number;
    /** `max(Rmin, min(G, R0))`: affordable tail, floored by the live working tail. */
    readonly retainedTailTokens: number;
    /** `max(0, S - G)`: surface mass the request cannot afford at the waterline. */
    readonly deficitTokens: number;
    /** True when even the best possible surface reduction cannot end pressure. */
    readonly envelopeDominated: boolean;
}
/**
 * Derive the envelope-aware zone boundaries of one meter snapshot.
 *
 * `E + injectionTokens + retainedTailTokens >= pressureTokens` is exact, not heuristic: the
 * partition never shadows the retained tail or the active runtime slot, so after the largest possible
 * reduction the request still prices at `E + injectionTokens` plus at least the retained tail
 * price. When that reaches the trigger no span can end the above-threshold
 * state, which is the typed `envelope-dominated` stop — the caller must stop
 * without paying for a semantic call.
 * @param measurement - one priced meter snapshot.
 * @param input - resolved policy budgets in tokens.
 * @returns the effective boundaries, deficit, and domination verdict.
 */
export declare function resolveEnvelopeZoneBudget(measurement: Pick<TokenMeasurement, 'totalTokens' | 'surfaceTokens'>, input: EnvelopeZoneBudgetInput): EnvelopeZoneBudget;
//# sourceMappingURL=envelope-budget.d.ts.map