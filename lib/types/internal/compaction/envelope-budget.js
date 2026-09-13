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
/**
 * Surface turns the retained budget must always cover verbatim: the open turn
 * and the last completed one. The floor only binds when the envelope is large
 * enough to shrink the affordable tail below two turns.
 */
const GUARANTEED_TAIL_TURNS = 2;
/**
 * The one retained-tail formula: `max(Rmin, min(grant, R0))`. Both resolvers
 * clamp the same configured budget `R0` to the same tail floor `Rmin`, differing
 * only in which surface grant they are given, so every consumer sees one shape.
 */
function retainedTailWithin(grant, retain, minRetain) {
    return Math.max(Math.max(0, minRetain), Math.min(grant, Math.max(0, retain)));
}
/** Derive the surface budget of one meter snapshot. */
export function resolveEnvelopeBudget(measurement, input) {
    const surfaceTokens = Math.max(0, measurement.surfaceTokens);
    const totalTokens = Math.max(0, measurement.totalTokens);
    const envelopeTokens = Math.max(0, totalTokens - surfaceTokens);
    const injectionTokens = Math.max(0, input.injectionTokens ?? 0);
    const surfaceGrantTokens = Math.max(0, input.contextWindow - envelopeTokens - input.responseReserveTokens - input.safetyMarginTokens - injectionTokens);
    const retainedTailTokens = retainedTailWithin(surfaceGrantTokens, input.retainTokens, input.minRetainTokens);
    const summarizerInputCapTokens = Math.max(0, surfaceGrantTokens - Math.max(0, input.instructionTokens) - Math.max(0, input.summaryMaxTokens));
    return {
        totalTokens,
        surfaceTokens,
        envelopeTokens,
        injectionTokens,
        surfaceGrantTokens,
        retainedTailTokens,
        summarizerInputCapTokens,
        envelopeDominated: summarizerInputCapTokens <= 0,
    };
}
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
export function retainedTailFloorTokens(session, measurement) {
    const nodes = session.surface.nodes;
    if (nodes.length === 0)
        return 0;
    const events = session.snapshotEvents();
    let hasTurnMetadata = false;
    let openTurn;
    let lastCompletedTurn;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (ev.type === 'turn/start' || ev.type === 'turn/end') {
            hasTurnMetadata = true;
            break;
        }
    }
    if (hasTurnMetadata) {
        // Determine if a turn is currently open: the latest turn boundary event
        // in the log indicates whether a turn was opened (turn/start) or closed (turn/end).
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const ev = events[i];
            if (ev.type === 'turn/start') {
                const turn = ev.data?.turn;
                if (typeof turn === 'number' && Number.isInteger(turn))
                    openTurn = turn;
                break;
            }
            if (ev.type === 'turn/end') {
                break;
            }
        }
        // Find the latest successfully/normally completed turn (reason.kind === 'completed')
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const ev = events[i];
            if (ev.type === 'turn/end') {
                const data = ev.data;
                if (data?.reason?.kind === 'completed' && typeof data.turn === 'number' && Number.isInteger(data.turn)) {
                    lastCompletedTurn = data.turn;
                    break;
                }
            }
        }
    }
    const seenTurns = new Set();
    let tokens = 0;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const turn = surfaceTurn(session, nodes[index]);
        if (turn !== undefined && !seenTurns.has(turn)) {
            const satisfiedLastCompleted = lastCompletedTurn === undefined || seenTurns.has(lastCompletedTurn);
            const satisfiedOpenTurn = openTurn === undefined || seenTurns.has(openTurn);
            const satisfiedMinTurns = seenTurns.size >= GUARANTEED_TAIL_TURNS;
            if (satisfiedLastCompleted && satisfiedOpenTurn && satisfiedMinTurns) {
                break;
            }
            seenTurns.add(turn);
        }
        tokens += measurement.nodes[index]?.tokens ?? 0;
    }
    return tokens;
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
export function resolveEnvelopeZoneBudget(measurement, input) {
    const surfaceTokens = Math.max(0, measurement.surfaceTokens);
    const envelopeTokens = Math.max(0, Math.max(0, measurement.totalTokens) - surfaceTokens);
    const injectionTokens = Math.max(0, input.injectionTokens ?? 0);
    const waterlineGrantTokens = Math.max(0, input.forgetWatermarkTokens - envelopeTokens - injectionTokens);
    const retainedTailTokens = retainedTailWithin(waterlineGrantTokens, input.retainTokens, input.minRetainTokens);
    return {
        envelopeTokens,
        injectionTokens,
        waterlineGrantTokens,
        forgetBoundaryTokens: Math.min(Math.max(0, input.forgetBoundaryTokens), waterlineGrantTokens),
        retainedTailTokens,
        deficitTokens: Math.max(0, surfaceTokens - waterlineGrantTokens),
        envelopeDominated: envelopeTokens + injectionTokens + retainedTailTokens >= Math.max(0, input.pressureTokens),
    };
}
function surfaceTurn(session, seq) {
    const data = session.eventAt(seq)?.data;
    const turn = data?.turn;
    return typeof turn === 'number' && Number.isInteger(turn) ? turn : undefined;
}
//# sourceMappingURL=envelope-budget.js.map