/**
 * Durable source classification for the current session surface.
 *
 * Classification is derived from replacement provenance and official compaction
 * events, never from generated text. It can therefore be rebuilt after a
 * process restart from the Session log plus the surface relationship.
 */
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
/** Reconstruct current source types entirely from persisted session provenance. */
export function buildSurfaceSourceIndex(session, toolSummaryReplacementSeqs = []) {
    const knownToolSummaries = new Set(toolSummaryReplacementSeqs);
    const entries = new Map();
    for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        if (event === undefined)
            throw new Error(`source-index: surface seq ${seq} has no event`);
        const kind = classifyEvent(session, event, knownToolSummaries.has(seq));
        entries.set(seq, {
            seq,
            kind,
            sourceEventSeqs: replacementSources(event),
            completedTurnsAfter: kind === 'original' ? 0 : completedTurnsAfter(session, event),
        });
    }
    return {
        entries,
        entry(seq) {
            const entry = entries.get(seq);
            if (entry === undefined)
                throw new Error(`source-index: surface seq ${seq} is not indexed`);
            return entry;
        },
        isOriginalToolResult(seq) {
            const event = session.eventAt(seq);
            return event?.type === 'tool/result' && entries.get(seq)?.kind === 'original';
        },
        canCompactHistory(seq, minReentryTurns, allowImmediateReentry = false) {
            const entry = entries.get(seq);
            if (entry === undefined || entry.kind === 'unknown-replacement')
                return false;
            if (entry.kind === 'original')
                return true;
            if (allowImmediateReentry
                && (entry.kind === 'tool-summary' || entry.kind === 'tool-pruned' || entry.kind === 'history-summary')) {
                return true;
            }
            return entry.completedTurnsAfter >= minReentryTurns;
        },
    };
}
function classifyEvent(session, event, knownToolSummary) {
    if (isHistorySummary(event))
        return 'history-summary';
    if (event.type !== 'tool/result' || !isReplacementSurfaceEvent(event))
        return 'original';
    if (wasPruned(session, event))
        return 'tool-pruned';
    // Only the successful persistent audit identifies this package's tool
    // summaries. Session replacement metadata has no producer field, so an
    // unknown third-party replacement must remain protected rather than being
    // misrepresented as a successful tool summary.
    return knownToolSummary ? 'tool-summary' : 'unknown-replacement';
}
function isHistorySummary(event) {
    if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event))
        return false;
    const source = event.data.source;
    return source.kind === 'plugin' && isCompactCheckpointSource(source);
}
/** A pruner replacement is durably and unambiguously preceded by its price event. */
function wasPruned(session, event) {
    const preceding = event.seq === 0 ? undefined : session.eventAt((event.seq - 1));
    if (preceding?.type !== 'compaction/prune')
        return false;
    const sources = replacementSources(event);
    return sources.length === 1
        && preceding.data.shadowedSeqs.length === 1
        && preceding.data.shadowedSeqs[0] === sources[0];
}
function replacementSources(event) {
    return isReplacementSurfaceEvent(event) ? [...(event.sourceEventSeqs ?? [])] : [];
}
function completedTurnsAfter(session, replacement) {
    let count = 0;
    for (let seq = replacement.seq + 1; seq < session.seq; seq += 1) {
        const event = session.eventAt(seq);
        if (event?.type === 'turn/end' && event.data.reason?.kind === 'completed')
            count += 1;
    }
    return count;
}
//# sourceMappingURL=source-index.js.map