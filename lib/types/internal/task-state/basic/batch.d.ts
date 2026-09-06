/**
 * Deterministic batch-window fold for one task-state update: it walks the
 * eligible Session events between the committed source cursor and one pending
 * watermark, projects each through the versioned filter, and stops when the
 * configured maximum eligible-event count or the maximum framed-input byte
 * budget would be exceeded. The folded window is immutable once returned; the
 * caller owns it for the whole update, so events arriving during the request
 * only raise the pending watermark and produce a later trailing batch.
 *
 * The maximum framed-input budget constrains the COMPLETE deterministic model
 * frame — the previous stable content, the event projections, the truncation
 * metadata, and every framing wrapper — so an oversized first event or an
 * oversized base stable can never bypass the budget. If field-level
 * deterministic truncation has already run and even the smallest meaningful
 * window cannot fit the budget, the fold reports `infeasible`: the caller
 * records a terminal budget failure, never calls the model, and never
 * advances the cursor.
 * @module dsh-context-enhancement/internal/task-state/basic/batch
 */
import type { TaskStateStable, TaskStateTruncationRecord } from '../contract/types.ts';
import type { TaskStateFilteredEvent } from './types.ts';
/** The complete deterministic projection of one batch window. */
export interface FoldedBatchWindow {
    /** Exact eligible sequences folded into the window, ascending. */
    readonly includedSeqs: readonly number[];
    /** Sequence of the last eligible event actually folded; equals the committed cursor endpoint. */
    readonly sourceCursor: number;
    /** Owned JSON event projections, ordered by source sequence. */
    readonly events: readonly TaskStateFilteredEvent[];
    /** Explicit UTF-8 byte limits applied while projecting (recorded per truncated field). */
    readonly truncation: readonly TaskStateTruncationRecord[];
    /** UTF-8 bytes of the complete serialized framed projection. */
    readonly inputBytes: number;
}
/** The outcome of folding one batch window. */
export type FoldedBatch = {
    readonly kind: 'empty';
} | {
    readonly kind: 'infeasible';
    readonly frameBytes: number;
    readonly maxInputBytes: number;
} | {
    readonly kind: 'window';
    readonly window: FoldedBatchWindow;
};
/** Batch window budget from the validated deployment policy. */
export interface BatchWindowBudget {
    /** Maximum eligible Session events folded into one window. */
    readonly maxEvents: number;
    /** Maximum UTF-8 bytes of the complete serialized framed projection. */
    readonly maxInputBytes: number;
}
/**
 * Fold one immutable batch window over an owned slice of the Session log.
 * Only events with a sequence above `cursor` and at or below `windowEndSeq`
 * are candidates; an eligible event that projects no meaningful content is
 * skipped (it neither enters the window nor advances the endpoint). Folding
 * stops as soon as adding another event would exceed `budget.maxEvents` or
 * `budget.maxInputBytes`. If the smallest meaningful window (the base frame
 * plus one candidate) still exceeds the input budget, the fold is
 * `infeasible` and must never dispatch a model call or advance the cursor.
 * @param events - the Session's complete ordered events (read-only snapshot).
 * @param base - committed base stable, or `null` before the first commit.
 * @param cursor - committed source cursor; only sequences above it fold.
 * @param windowEndSeq - inclusive pending watermark of this window.
 * @param budget - validated event-count and byte budgets.
 * @returns the folded window, `empty` when no meaningful eligible event lies
 *   in the window, or `infeasible` when even one meaningful event cannot fit
 *   the complete framed-input budget.
 */
export declare function foldBatchWindow(events: readonly {
    readonly seq: number;
    readonly type: string;
    readonly data: unknown;
}[], base: TaskStateStable | null, cursor: number, windowEndSeq: number, budget: BatchWindowBudget): FoldedBatch;
//# sourceMappingURL=batch.d.ts.map