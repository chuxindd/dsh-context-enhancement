export const TOOL_GROUP_SUMMARY_VERSION = 1;
export function buildToolGroupSummaryInput(session, group) {
    const items = group.sourceSeqs.map(seq => {
        const event = session.eventAt(seq);
        if (event === undefined)
            throw new Error(`tool-group-summary: source seq ${seq} is missing`);
        return inputItem(event);
    });
    return { version: TOOL_GROUP_SUMMARY_VERSION, group, items };
}
export function parseToolGroupSummary(value, input) {
    if (!isRecord(value))
        throw new Error('tool-group-summary: output must be an object');
    if (value.version !== TOOL_GROUP_SUMMARY_VERSION)
        throw new Error('tool-group-summary: unsupported schema version');
    const summary = requiredString(value.groupSummary, 'groupSummary');
    const items = requiredArray(value.items, 'items').map((item, index) => parseItem(item, index));
    const groupErrors = stringArray(value.groupErrors, 'groupErrors');
    const unresolved = stringArray(value.unresolved, 'unresolved');
    validateSources(items, input);
    return { version: TOOL_GROUP_SUMMARY_VERSION, groupSummary: summary, items, groupErrors, unresolved };
}
function parseItem(value, index) {
    if (!isRecord(value))
        throw new Error(`tool-group-summary: items[${index}] must be an object`);
    const sourceSeq = value.sourceSeq;
    if (typeof sourceSeq !== 'number' || !Number.isSafeInteger(sourceSeq) || sourceSeq < 0)
        throw new Error(`tool-group-summary: items[${index}].sourceSeq is invalid`);
    return {
        sourceSeq,
        ...value.callId === undefined ? {} : { callId: requiredString(value.callId, `items[${index}].callId`) },
        summary: requiredString(value.summary, `items[${index}].summary`),
        facts: stringArray(value.facts, `items[${index}].facts`),
        files: stringArray(value.files, `items[${index}].files`),
        identifiers: stringArray(value.identifiers, `items[${index}].identifiers`),
        errors: stringArray(value.errors, `items[${index}].errors`),
        unresolved: stringArray(value.unresolved, `items[${index}].unresolved`),
    };
}
function validateSources(items, input) {
    const allowed = new Map();
    for (const item of input.items)
        allowed.set(item.sourceSeq, item);
    const seen = new Set();
    for (const item of items) {
        const source = allowed.get(item.sourceSeq);
        if (source === undefined)
            throw new Error(`tool-group-summary: source seq ${item.sourceSeq} is not in the input group`);
        if (seen.has(item.sourceSeq))
            throw new Error(`tool-group-summary: source seq ${item.sourceSeq} is duplicated`);
        seen.add(item.sourceSeq);
        if (item.callId !== undefined && source.callId !== item.callId) {
            throw new Error(`tool-group-summary: source seq ${item.sourceSeq} call id does not match input`);
        }
        assertFactsBelongToInput(item, source);
    }
    for (const source of input.items) {
        if (!seen.has(source.sourceSeq))
            throw new Error(`tool-group-summary: missing summary item for source seq ${source.sourceSeq}`);
    }
}
function assertFactsBelongToInput(item, source) {
    const input = source.content;
    const claims = [...item.facts, ...item.files, ...item.identifiers, ...item.errors];
    for (const claim of claims) {
        if (claim.trim().length === 0 || !input.includes(claim)) {
            throw new Error(`tool-group-summary: claim is not present in source seq ${source.sourceSeq}`);
        }
    }
}
function inputItem(event) {
    if (event.type === 'tool/result') {
        const block = event.data.message.content[0];
        return {
            sourceSeq: event.seq,
            role: 'tool-result',
            callId: String(event.data.message.source.callId),
            content: block?.type === 'tool-result'
                ? typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                : '',
        };
    }
    if (event.type === 'assistant/message') {
        const calls = event.data.message.content.filter(block => block.type === 'tool-call');
        return {
            sourceSeq: event.seq,
            role: 'tool-call',
            content: calls.map(call => `${call.name} ${call.arguments}`).join('\n'),
        };
    }
    throw new Error(`tool-group-summary: source seq ${event.seq} is not a tool node`);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim().length === 0)
        throw new Error(`tool-group-summary: ${name} must be a non-empty string`);
    return value;
}
function requiredArray(value, name) {
    if (!Array.isArray(value))
        throw new Error(`tool-group-summary: ${name} must be an array`);
    return value;
}
function stringArray(value, name) {
    return requiredArray(value, name).map((entry, index) => requiredString(entry, `${name}[${index}]`));
}
//# sourceMappingURL=tool-group-summary.js.map