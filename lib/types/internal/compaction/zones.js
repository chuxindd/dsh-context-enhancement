/**
 * Positional three-zone planning for progressive context compaction.
 *
 * All ranges are expressed as current-surface indexes. This is deliberate:
 * replacement events append fresh sequence numbers and therefore visible seqs
 * are not necessarily numerically ordered. Pairing and step-boundary checks
 * keep every emitted range whole.
 */
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from "./tool-pairing.js";
/**
 * Partition one token snapshot into non-overlapping forget/tool/recent zones.
 * Boundaries are measured from the newest surface tail and moved toward the
 * historical side until the cut is outside any open tool pair.
 */
export function partitionSurfaceZones(session, measurement, ratios) {
    const nodes = [...session.surface.nodes];
    assertMeasurementSurface(nodes, measurement);
    if (nodes.length === 0) {
        return {
            totalTokens: 0,
            recentBoundaryTokens: 0,
            forgetBoundaryTokens: 0,
            forget: null,
            tool: null,
            recent: null,
        };
    }
    const capacity = ratios.contextWindow;
    if (!Number.isFinite(capacity) || capacity <= 0)
        throw new Error('compaction zones: contextWindow must be positive');
    const recentBoundaryTokens = absoluteBoundary(ratios.recentBoundaryTokens, capacity, ratios.recentRatio, 'recentBoundaryTokens');
    const forgetBoundaryTokens = absoluteBoundary(ratios.forgetBoundaryTokens, capacity, ratios.forgetBoundaryRatio, 'forgetBoundaryTokens');
    const recentStart = boundaryFromTail(session, measurement, recentBoundaryTokens);
    const forgetStart = Math.min(recentStart, boundaryFromTail(session, measurement, forgetBoundaryTokens));
    return {
        totalTokens: measurement.surfaceTokens,
        recentBoundaryTokens,
        forgetBoundaryTokens,
        forget: makeRange(nodes, measurement, 0, forgetStart - 1),
        tool: makeRange(nodes, measurement, forgetStart, recentStart - 1),
        recent: makeRange(nodes, measurement, recentStart, nodes.length - 1),
    };
}
/** Return a current-surface range by indexes, or null for an empty range. */
export function rangeFromIndexes(session, measurement, startIndex, endIndex) {
    assertMeasurementSurface([...session.surface.nodes], measurement);
    return makeRange([...session.surface.nodes], measurement, startIndex, endIndex);
}
/**
 * Select the oldest complete forget-zone batch. The first complete unit is
 * allowed to be below the target, but never above max; if it is above max no
 * semantic call is made. The returned range never crosses the forget boundary.
 */
export function planForgetBatch(session, measurement, zones, options) {
    const zone = zones.forget;
    if (zone === null)
        return { kind: 'blocked', reason: 'no-forget-range' };
    if (!toolPairingBalancedBefore(session, zone.startSeq)) {
        return { kind: 'blocked', reason: 'unsafe-forget-start' };
    }
    const target = Math.max(1, options.targetBatchTokens);
    const max = Math.max(target, options.maxBatchTokens);
    let candidate = null;
    let sawSafeEnd = false;
    for (let end = zone.startIndex; end <= zone.endIndex; end += 1) {
        if (!toolPairingBalancedAfter(session, session.surface.nodes[end]))
            continue;
        if (!stepBoundaryAfter(session, end, zone.endIndex))
            continue;
        sawSafeEnd = true;
        const range = makeRange([...session.surface.nodes], measurement, zone.startIndex, end);
        if (range === null)
            continue;
        if (range.tokens > max) {
            return candidate === null
                ? { kind: 'blocked', reason: 'oldest-unit-too-large' }
                : { kind: 'selected', range: candidate };
        }
        candidate = range;
        if (range.tokens >= target)
            break;
    }
    if (candidate !== null)
        return { kind: 'selected', range: candidate };
    return { kind: 'blocked', reason: sawSafeEnd ? 'oldest-unit-too-large' : 'no-safe-batch-end' };
}
export function selectForgetBatch(session, measurement, zones, options) {
    const plan = planForgetBatch(session, measurement, zones, options);
    return plan.kind === 'selected' ? plan.range : null;
}
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
export function planPressureSpan(session, measurement, zones, options) {
    const cap = Math.max(0, Math.floor(options.inputCapTokens));
    const minSpan = Math.max(0, Math.floor(options.minSpanTokens));
    const reclaim = Math.max(0, Math.floor(options.reclaimTokens));
    if (cap <= 0)
        return { kind: 'blocked', reason: 'envelope-dominated' };
    const nodes = [...session.surface.nodes];
    assertMeasurementSurface(nodes, measurement);
    const recentEnd = (zones.recent?.startIndex ?? nodes.length) - 1;
    const headEndIndex = options.maxEndIndex !== undefined
        ? Math.min(recentEnd, Math.floor(options.maxEndIndex))
        : recentEnd;
    const requestedStart = Math.max(0, Math.floor(options.minStartIndex ?? 0));
    let startIndex = requestedStart;
    if (requestedStart === 0) {
        if (headEndIndex < 0 || !toolPairingBalancedBefore(session, nodes[0])) {
            return { kind: 'blocked', reason: 'no-safe-prefix' };
        }
    }
    else {
        while (startIndex <= headEndIndex
            && (!toolPairingBalancedBefore(session, nodes[startIndex])
                || !stepBoundaryAfter(session, startIndex - 1, headEndIndex))) {
            startIndex += 1;
        }
        if (startIndex > headEndIndex) {
            return { kind: 'blocked', reason: 'no-safe-prefix' };
        }
    }
    // One walk, two answers: the first safe prefix that can end pressure (the
    // deficit-sized selection) and the last safe prefix under the cap (the widest
    // fallback). Node prices are non-negative, so the first over-cap prefix ends
    // the walk.
    const endTarget = reclaim + minSpan + 1;
    let deficitSized = null;
    let widest = null;
    let tokens = 0;
    for (let endIndex = startIndex; endIndex <= headEndIndex; endIndex += 1) {
        tokens += measurement.nodes[endIndex].tokens;
        if (tokens > cap)
            break;
        if (!toolPairingBalancedAfter(session, nodes[endIndex]))
            continue;
        if (!stepBoundaryAfter(session, endIndex, headEndIndex))
            continue;
        const range = {
            startIndex,
            endIndex,
            startSeq: nodes[startIndex],
            endSeq: nodes[endIndex],
            tokens,
        };
        widest = range;
        if (deficitSized === null && tokens >= endTarget)
            deficitSized = range;
    }
    const range = deficitSized ?? widest;
    if (range === null)
        return { kind: 'blocked', reason: 'no-safe-prefix' };
    if (range.tokens <= minSpan)
        return { kind: 'blocked', reason: 'span-below-minimum' };
    return { kind: 'selected', range };
}
/** A batch boundary must not split a surface step with the same turn/step. */
function stepBoundaryAfter(session, index, _zoneEnd) {
    if (index >= session.surface.nodes.length - 1)
        return true;
    const current = session.eventAt(session.surface.nodes[index]);
    const next = session.eventAt(session.surface.nodes[index + 1]);
    if (current === undefined || next === undefined)
        return false;
    return !sameStep(current, next);
}
function sameStep(left, right) {
    const leftData = left.data;
    const rightData = right.data;
    return leftData.turn !== undefined && leftData.step !== undefined
        && leftData.turn === rightData.turn && leftData.step === rightData.step;
}
/**
 * One zone boundary in surface tokens: the caller's absolute value when it
 * supplied one, otherwise the legacy window fraction. Absolute values are
 * normalized to non-negative integers so a budget derived from integer meter
 * prices reaches the partition unchanged.
 */
function absoluteBoundary(absolute, capacity, ratio, name) {
    if (absolute === undefined)
        return Math.floor(capacity * ratio);
    if (!Number.isFinite(absolute))
        throw new Error(`compaction zones: ${name} must be finite`);
    return Math.max(0, Math.floor(absolute));
}
function boundaryFromTail(session, measurement, boundaryTokens) {
    const nodes = [...session.surface.nodes];
    if (boundaryTokens <= 0)
        return nodes.length;
    let total = 0;
    let start = nodes.length;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        total += measurement.nodes[index].tokens;
        start = index;
        if (total >= boundaryTokens)
            break;
    }
    while (start > 0 && (!toolPairingBalancedBefore(session, nodes[start])
        || !stepBoundaryAfter(session, start - 1, nodes.length - 1)))
        start -= 1;
    return start;
}
function makeRange(nodes, measurement, startIndex, endIndex) {
    if (startIndex > endIndex || startIndex < 0 || endIndex >= nodes.length)
        return null;
    let tokens = 0;
    for (let index = startIndex; index <= endIndex; index += 1) {
        tokens += measurement.nodes[index].tokens;
    }
    return {
        startIndex,
        endIndex,
        startSeq: nodes[startIndex],
        endSeq: nodes[endIndex],
        tokens,
    };
}
function assertMeasurementSurface(nodes, measurement) {
    if (nodes.length !== measurement.nodes.length
        || nodes.some((seq, index) => measurement.nodes[index]?.seq !== seq)) {
        throw new Error('compaction zones: token-meter surface does not match current session surface');
    }
}
//# sourceMappingURL=zones.js.map