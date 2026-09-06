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
    const recentBoundaryTokens = Math.floor(capacity * ratios.recentRatio);
    const forgetBoundaryTokens = Math.floor(capacity * ratios.forgetBoundaryRatio);
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
export function selectForgetBatch(session, measurement, zones, options) {
    const zone = zones.forget;
    if (zone === null)
        return null;
    if (!toolPairingBalancedBefore(session, zone.startSeq))
        return null;
    const target = Math.max(1, options.targetBatchTokens);
    const max = Math.max(target, options.maxBatchTokens);
    let candidate = null;
    for (let end = zone.startIndex; end <= zone.endIndex; end += 1) {
        if (!toolPairingBalancedAfter(session, session.surface.nodes[end]))
            continue;
        if (!stepBoundaryAfter(session, end, zone.endIndex))
            continue;
        const range = makeRange([...session.surface.nodes], measurement, zone.startIndex, end);
        if (range === null)
            continue;
        if (range.tokens > max)
            break;
        candidate = range;
        if (range.tokens >= target)
            break;
    }
    return candidate;
}
/** A batch boundary must not split a surface step with the same turn/step. */
function stepBoundaryAfter(session, index, zoneEnd) {
    if (index >= zoneEnd)
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