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
import { Buffer } from 'node:buffer';
import { filterEvent } from "./filter.js";
import { frameProjection } from "./prompt.js";
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
export function foldBatchWindow(events, base, cursor, windowEndSeq, budget) {
    const includedSeqs = [];
    const projected = [];
    const truncation = [];
    // The window's committed endpoint: the last folded sequence. It is updated
    // with every accepted candidate and only read after the empty-window return
    // below guarantees at least one fold.
    let sourceCursor = 0;
    let inputBytes = Buffer.byteLength(frameProjection({ base, events: [], truncation: [] }), 'utf8');
    if (inputBytes > budget.maxInputBytes) {
        // The base stable alone (with its framing wrappers) already exceeds the
        // whole batch budget; no event could ever fit, so the fold is terminal.
        return { kind: 'infeasible', frameBytes: inputBytes, maxInputBytes: budget.maxInputBytes };
    }
    for (const event of events) {
        if (event.seq <= cursor)
            continue;
        if (event.seq > windowEndSeq)
            break;
        if (projected.length >= budget.maxEvents)
            break;
        const filtered = filterEvent({ type: event.type, seq: event.seq, data: event.data });
        if (filtered === null)
            continue;
        const candidate = {
            seq: filtered.event.seq,
            type: filtered.event.type,
            fields: filtered.event.fields,
        };
        const nextEvents = [...projected, candidate];
        const nextTruncation = [...truncation, ...filtered.truncation];
        const nextBytes = Buffer.byteLength(frameProjection({ base, events: nextEvents, truncation: nextTruncation }), 'utf8');
        if (nextBytes > budget.maxInputBytes) {
            if (projected.length === 0) {
                // Field-level deterministic truncation already ran, yet this single
                // meaningful event cannot fit the complete frame. There is no way to
                // make progress within the configured budget, so the update is a
                // terminal budget failure.
                return { kind: 'infeasible', frameBytes: nextBytes, maxInputBytes: budget.maxInputBytes };
            }
            break;
        }
        projected.push(candidate);
        includedSeqs.push(candidate.seq);
        sourceCursor = candidate.seq;
        truncation.push(...filtered.truncation);
        inputBytes = nextBytes;
    }
    if (projected.length === 0)
        return { kind: 'empty' };
    return {
        kind: 'window',
        window: {
            includedSeqs,
            sourceCursor,
            events: projected,
            truncation,
            inputBytes,
        },
    };
}
//# sourceMappingURL=batch.js.map