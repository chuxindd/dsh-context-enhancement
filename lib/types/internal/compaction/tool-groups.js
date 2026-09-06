import { toolSegments } from "./tool-segments.js";
const DEFAULTS = {
    minGroupResults: 2,
    minGroupChars: 12_000,
    minGroupTokens: 2_000,
    maxGroupTokens: 12_000,
    maxGroups: 2,
};
/** Find qualifying complete tool groups in current surface order. */
export function selectToolGroups(session, options = {}) {
    const estimateTokens = options.estimateTokens ?? (() => 0);
    const measureText = options.measureText ?? defaultTextLength;
    const minGroupResults = options.minGroupResults ?? DEFAULTS.minGroupResults;
    const minGroupChars = options.minGroupChars ?? DEFAULTS.minGroupChars;
    const minGroupTokens = options.minGroupTokens ?? DEFAULTS.minGroupTokens;
    const maxGroupTokens = options.maxGroupTokens ?? DEFAULTS.maxGroupTokens;
    const maxGroups = options.maxGroups ?? DEFAULTS.maxGroups;
    const positions = olderPositions(session.surface.nodes, options.olderRange);
    if (positions === null || maxGroups <= 0)
        return [];
    const selected = [];
    for (const segment of toolSegments(session)) {
        const startPosition = session.surface.nodes.indexOf(segment.startSeq);
        const endPosition = session.surface.nodes.indexOf(segment.endSeq);
        if (startPosition < 0 || endPosition < startPosition)
            continue;
        if (startPosition < positions.start || endPosition > positions.end)
            continue;
        const sourceSeqs = segment.seqs;
        const toolResultSeqs = sourceSeqs.filter(seq => session.eventAt(seq)?.type === 'tool/result');
        if (toolResultSeqs.length < minGroupResults)
            continue;
        const events = sourceSeqs.map(seq => session.eventAt(seq)).filter((event) => event !== undefined);
        if (events.length !== sourceSeqs.length)
            throw new Error('tool-groups: surface contains a missing event');
        const estimatedTokens = events.reduce((total, event) => total + estimateTokens(event), 0);
        const chars = toolResultSeqs.reduce((total, seq) => {
            const event = session.eventAt(seq);
            return event?.type === 'tool/result' ? total + measureText(event) : total;
        }, 0);
        if (chars < minGroupChars || estimatedTokens < minGroupTokens || estimatedTokens > maxGroupTokens)
            continue;
        const callIds = events.flatMap(event => event.type === 'tool/result'
            ? [String(event.data.message.source.callId)]
            : event.type === 'assistant/message'
                ? event.data.message.content.flatMap(block => block.type === 'tool-call' ? [String(block.id)] : [])
                : []);
        selected.push({
            sourceSeqs: [...sourceSeqs],
            toolResultSeqs,
            callIds: [...new Set(callIds)],
            startSeq: segment.startSeq,
            endSeq: segment.endSeq,
            estimatedTokens,
            startPosition,
            endPosition,
            turn: segment.turn,
        });
        if (selected.length >= maxGroups)
            break;
    }
    return selected;
}
function olderPositions(nodes, range) {
    if (range === null)
        return null;
    if (range === undefined)
        return { start: 0, end: nodes.length - 1 };
    const start = nodes.indexOf(range.start);
    const end = nodes.indexOf(range.end);
    if (start < 0 || end < 0)
        throw new Error('tool-groups: olderRange must name current surface nodes');
    if (start > end)
        throw new Error('tool-groups: olderRange start must precede end in surface order');
    return { start, end };
}
function defaultTextLength(event) {
    return event.data.message.content.reduce((total, block) => total + (block.type === 'tool-result' ? Array.from(block.content).length : 0), 0);
}
//# sourceMappingURL=tool-groups.js.map