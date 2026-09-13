/**
 * Deterministic versioned input filter for the task-state auxiliary request.
 * It folds a batch window of Session events into an owned, bounded, lossless
 * JSON projection of the durable fields the task-state model needs and
 * excludes raw reasoning, chunks, binary data, presentation metadata,
 * transport and UI events, live objects, and the task-state audit events
 * themselves. The original Session events are never mutated: `tool/call.arguments`
 * is parsed only inside the derived projection. Every field is explicitly
 * UTF-8-bounded with deterministic marked truncation.
 *
 * The filter reads plugin-owned event vocabulary (goal/change, todo/write,
 * plan/mode, command/run, request/header, agent-preset/selected,
 * compaction/start, compaction/end) through a widened JSON view instead of
 * importing each producer package's type merge: the projection is a pure
 * function of the lossless durable JSON.
 *
 * @module dsh-context-enhancement/internal/task-state/basic/filter
 */
import { Buffer } from 'node:buffer';
import { boundField } from "./bytes.js";
/** Deterministic filter version recorded on requests and committed stables. */
export const TASK_STATE_FILTER_VERSION = 'task-state-basic/filter-v3';
/** Shipped default per-field byte limits (whole-batch budget stays deployment config). */
export const DEFAULT_FILTER_FIELD_LIMITS = Object.freeze({
    userMessageBytes: 4_000,
    assistantMessageBytes: 2_000,
    toolNameBytes: 200,
    toolArgumentsBytes: 2_000,
    toolResultTextBytes: 4_000,
    toolResultMetaBytes: 2_000,
    jsonLeafStringBytes: 400,
    errorBytes: 400,
    commandBytes: 400,
    stateBytes: 2_000,
});
/** Slash-command names whose durable lifecycle materially changes task intent. */
const LIFECYCLE_COMMANDS = new Set([
    'goal',
    'plan',
    'compact',
]);
/** JSON leaves that look like binary/base64/bytes never enter the projection. */
const BINARY_LEAF_PATTERN = /^(?:[A-Za-z0-9+/]{16,}={0,2}|data:[^;,]{1,40};base64,)/u;
/** Maximum array entries and object nesting retained by the JSON leaf walk. */
const MAX_JSON_ARRAY_ITEMS = 8;
const MAX_JSON_DEPTH = 6;
/** Text fragments of one content-block list (raw reasoning excluded by block type). */
function textOf(blocks) {
    if (!Array.isArray(blocks))
        return '';
    const collected = [];
    for (const block of blocks) {
        if (!isRecord(block) || block['type'] !== 'text')
            continue;
        const text = block['text'];
        if (typeof text === 'string' && text.trim().length > 0)
            collected.push(text);
    }
    return collected.join('\n');
}
/** The durable text of one `tool-result` message: its inner content blocks. */
function toolResultText(message) {
    if (!isRecord(message))
        return '';
    const content = message['content'];
    if (!Array.isArray(content))
        return '';
    const block = content[0];
    if (!isRecord(block) || block['type'] !== 'tool-result')
        return '';
    return textOf(block['content']);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Whether one parsed JSON leaf string is worth retaining. */
function isMeaningfulLeaf(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return false;
    return !BINARY_LEAF_PATTERN.test(trimmed);
}
/**
 * Collect the meaningful scalar leaves of one parsed JSON value as bounded
 * `path -> text` entries, with deterministic array caps and depth bounds.
 * An array over the item cap and any container at the depth bound each leave
 * one deterministic `…` marker leaf under the cut path.
 */
function jsonLeaves(value, path, out, leafBytes, depth, records) {
    if (depth > MAX_JSON_DEPTH) {
        out.push({ path: `${path}…`, value: '…' });
        return;
    }
    if (value === null || value === undefined)
        return;
    if (typeof value === 'string') {
        if (!isMeaningfulLeaf(value))
            return;
        out.push({ path, value: boundField(path, value, leafBytes, records) });
        return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        out.push({ path, value: String(value) });
        return;
    }
    if (Array.isArray(value)) {
        for (const [index, child] of value.entries()) {
            if (index >= MAX_JSON_ARRAY_ITEMS) {
                out.push({ path: `${path}[${index}…]`, value: '…' });
                return;
            }
            jsonLeaves(child, `${path}[${index}]`, out, leafBytes, depth + 1, records);
        }
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        jsonLeaves(child, path === '' ? key : `${path}.${key}`, out, leafBytes, depth + 1, records);
    }
}
/** Render bounded leaves as a deterministic JSON record (first value wins on a repeated path). */
function renderLeaves(leaves) {
    if (leaves.length === 0)
        return '';
    const record = {};
    for (const leaf of leaves) {
        record[leaf.path] ??= leaf.value;
    }
    return JSON.stringify(record);
}
/** Parse tool-call arguments; malformed JSON degrades to the raw bounded string. */
function projectArguments(argumentsRaw, leafBytes, wholeBytes, records) {
    const raw = typeof argumentsRaw === 'string' ? argumentsRaw.trim() : '';
    if (raw.length === 0)
        return { kind: 'raw', text: '' };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        // The malformed branch degrades to the bounded raw string.
        return { kind: 'raw', text: boundField('tool/call.arguments', raw, wholeBytes, records) };
    }
    const leaves = [];
    jsonLeaves(parsed, '', leaves, leafBytes, 0, records);
    return { kind: 'json', leaves };
}
/** Whether a message's source is a direct human or authorized goal continuation. */
function directHumanKind(message) {
    if (!isRecord(message))
        return undefined;
    const source = message['source'];
    if (!isRecord(source))
        return undefined;
    const kind = source['kind'];
    if (kind !== 'user' && kind !== 'goal')
        return undefined;
    return kind;
}
/** Join message text blocks of a user/assistant/tool message. */
function messageText(message) {
    /* v8 ignore next 3 -- every caller passes a record already checked by isRecord. */
    if (!isRecord(message))
        return '';
    const content = message['content'];
    if (!Array.isArray(content))
        return '';
    return textOf(content);
}
/** Turn-end reason projected as bounded durable facts. */
function projectTurnEndReason(reason) {
    if (!isRecord(reason))
        return null;
    const kind = reason['kind'];
    if (kind === 'aborted') {
        const inner = reason['reason'];
        const innerKind = isRecord(inner) ? inner['kind'] : undefined;
        return { kind, reason: { kind: innerKind === undefined ? 'unknown' : innerKind } };
    }
    if (kind === 'error') {
        const error = reason['error'];
        const code = isRecord(error) ? error['code'] : undefined;
        return { kind, ...(code === undefined ? {} : { code }) };
    }
    return { kind };
}
/** Bound one optional durable string field, dropping it when absent or blank. */
function optionalBound(record, key, path, limitBytes, records) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0)
        return undefined;
    return boundField(path, value, limitBytes, records);
}
/** Read one durable field, dropping non-string values to ''. */
function stringField(value) {
    return typeof value === 'string' ? value : '';
}
/**
 * Project one eligible Session event into owned lossless JSON. Only events the
 * filter marks eligible reach this function; each projection reads only the
 * durable fields recorded by that event through the widened JSON view and
 * never copies the full event.
 * @param event - eligible source Session event (widened).
 * @param limits - explicit field byte limits.
 * @param records - truncation accumulator this projection appends to.
 * @returns the owned projection fields, or `undefined` when the event projects nothing meaningful.
 */
function projectEvent(event, limits, records) {
    const data = event.data;
    switch (event.type) {
        case 'user/message': {
            const kind = directHumanKind(data);
            if (kind === undefined)
                return undefined;
            const text = messageText(data);
            if (text.trim().length === 0)
                return undefined;
            return {
                kind: kind === 'goal' ? 'goal-continuation' : 'user',
                text: boundField('user/message.text', text, limits.userMessageBytes, records),
            };
        }
        case 'assistant/message': {
            if (isRecord(data) && data['interrupted'] === true)
                return undefined;
            if (!isRecord(data) || !isRecord(data['message']))
                return undefined;
            const text = messageText(data['message']);
            if (text.trim().length === 0)
                return undefined;
            return {
                kind: 'assistant',
                text: boundField('assistant/message.text', text, limits.assistantMessageBytes, records),
            };
        }
        case 'tool/call': {
            if (!isRecord(data))
                return undefined;
            const name = boundField('tool/call.name', stringField(data['name']), limits.toolNameBytes, records);
            const projected = projectArguments(data['arguments'], limits.jsonLeafStringBytes, limits.toolArgumentsBytes, records);
            const args = projected.kind === 'json'
                // The legal JSON branch is whole-bounded: the complete rendered leaf
                // record (not only each leaf) must fit `toolArgumentsBytes`.
                ? boundField('tool/call.arguments', renderLeaves(projected.leaves), limits.toolArgumentsBytes, records)
                : projected.text;
            const result = {
                kind: 'tool/call',
                name,
                callId: stringField(data['callId']),
            };
            if (args.trim().length > 0)
                result.arguments = args;
            return result;
        }
        case 'tool/result': {
            if (!isRecord(data))
                return undefined;
            const message = data['message'];
            const content = isRecord(message) ? message['content'] : undefined;
            const first = Array.isArray(content) ? content[0] : undefined;
            const block = isRecord(first) ? first : undefined;
            const callId = block !== undefined && block['type'] === 'tool-result'
                ? stringField(block['toolCallId'])
                : '';
            const isError = block !== undefined && block['isError'] === true;
            const text = toolResultText(message);
            const error = data['error'];
            const result = {
                kind: 'tool/result',
                callId,
                isError,
            };
            if (text.trim().length > 0) {
                result.text = boundField('tool/result.text', text, limits.toolResultTextBytes, records);
            }
            if (isRecord(error)) {
                const name = optionalBound(error, 'name', 'tool/result.error.name', limits.errorBytes, records);
                const code = optionalBound(error, 'code', 'tool/result.error.code', limits.errorBytes, records);
                if (name !== undefined || code !== undefined) {
                    result.error = {
                        ...(name === undefined ? {} : { name }),
                        ...(code === undefined ? {} : { code }),
                    };
                }
            }
            const meta = data['meta'];
            if (meta !== undefined) {
                const metaLeaves = [];
                jsonLeaves(meta, 'meta', metaLeaves, limits.jsonLeafStringBytes, 0, records);
                const rendered = renderLeaves(metaLeaves);
                if (rendered.trim().length > 0) {
                    result.meta = boundField('tool/result.meta', rendered, limits.toolResultMetaBytes, records);
                }
            }
            if (result.text === undefined && result.meta === undefined && result.error === undefined)
                return undefined;
            return result;
        }
        case 'turn/end': {
            if (!isRecord(data))
                return undefined;
            return { kind: 'turn/end', turn: data['turn'], reason: projectTurnEndReason(data['reason']) };
        }
        case 'goal/change': {
            if (!isRecord(data))
                return undefined;
            const operation = data['operation'];
            if (operation === 'clear') {
                // The clear tombstone is the authority fact that REMOVES the Goal view.
                // It projects with the identity it removed, so a replay can tell which
                // goal revision a clear superseded instead of seeing an anonymous
                // "something was cleared" fact.
                const cleared = data['cleared'];
                return {
                    kind: 'goal/change',
                    operation: 'clear',
                    ...(isRecord(cleared) && typeof cleared['id'] === 'string' && cleared['id'].length > 0
                        ? { clearedId: cleared['id'] }
                        : {}),
                    ...(isRecord(cleared) && typeof cleared['revision'] === 'number' && Number.isSafeInteger(cleared['revision'])
                        ? { clearedRevision: cleared['revision'] }
                        : {}),
                };
            }
            const goal = data['goal'];
            if (!isRecord(goal))
                return undefined;
            const roundsStarted = data['roundsStarted'];
            return {
                kind: 'goal/change',
                operation,
                goal: {
                    ...(typeof goal['id'] === 'string' ? { id: goal['id'] } : {}),
                    ...(typeof goal['revision'] === 'number' && Number.isSafeInteger(goal['revision']) ? { revision: goal['revision'] } : {}),
                    ...(typeof goal['phase'] === 'string' ? { phase: goal['phase'] } : {}),
                    objective: boundField('goal/change.objective', stringField(goal['objective']), limits.stateBytes, records),
                    ...(typeof goal['maxGoalRounds'] === 'number' && Number.isSafeInteger(goal['maxGoalRounds'])
                        ? { maxGoalRounds: goal['maxGoalRounds'] }
                        : {}),
                    // Goal-round progress: which continuation round of its cap this
                    // snapshot records, so the model can interpret how far a bounded
                    // goal has advanced.
                    ...(typeof roundsStarted === 'number' && Number.isSafeInteger(roundsStarted)
                        ? { roundsStarted }
                        : {}),
                    ...(isRecord(goal['blockedReason']) && typeof goal['blockedReason']['code'] === 'string'
                        ? { blockedReason: goal['blockedReason']['code'] }
                        : {}),
                },
            };
        }
        case 'request/header': {
            // A routed-request header snapshots the provider/model selection that
            // produced the surrounding assistant text. Only a header whose config
            // names a concrete model and whose reason marks an actual selection
            // point projects: `initial`, `resume`, or `change`. A `series` header
            // carries no new model fact, so it is skipped.
            if (!isRecord(data))
                return undefined;
            const reason = data['reason'];
            if (reason !== 'initial' && reason !== 'resume' && reason !== 'change')
                return undefined;
            const header = data['header'];
            if (!isRecord(header))
                return undefined;
            const config = header['config'];
            if (!isRecord(config))
                return undefined;
            const provider = stringField(config['provider']);
            const model = stringField(config['model']);
            if (provider.length === 0 || model.length === 0)
                return undefined;
            const result = {
                kind: 'request/header',
                reason,
                provider: boundField('request/header.provider', provider, limits.toolNameBytes, records),
                model: boundField('request/header.model', model, limits.toolNameBytes, records),
            };
            const reasoningEffort = config['reasoningEffort'];
            if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) {
                result.reasoningEffort = boundField('request/header.reasoningEffort', reasoningEffort, limits.toolNameBytes, records);
            }
            return result;
        }
        case 'agent-preset/selected': {
            // The durable preset selection that composes the Session's tools and
            // prompt sections. Only a non-blank preset id projects.
            if (!isRecord(data))
                return undefined;
            const preset = stringField(data['agentPreset']);
            if (preset.length === 0)
                return undefined;
            return {
                kind: 'agent-preset/selected',
                preset: boundField('agent-preset/selected.preset', preset, limits.toolNameBytes, records),
            };
        }
        case 'compaction/start': {
            if (!isRecord(data))
                return undefined;
            return {
                kind: 'compaction/start',
                compactionId: boundField('compaction/start.compactionId', stringField(data['compactionId']), limits.errorBytes, records),
                ...(typeof data['turn'] === 'number' && Number.isSafeInteger(data['turn']) ? { turn: data['turn'] } : {}),
            };
        }
        case 'compaction/end': {
            if (!isRecord(data))
                return undefined;
            const error = optionalBound(data, 'error', 'compaction/end.error', limits.errorBytes, records);
            return {
                kind: 'compaction/end',
                compactionId: boundField('compaction/end.compactionId', stringField(data['compactionId']), limits.errorBytes, records),
                ...(error === undefined ? {} : { error }),
            };
        }
        case 'todo/write': {
            if (!isRecord(data))
                return undefined;
            const todos = data['todos'];
            if (!Array.isArray(todos))
                return undefined;
            // `todo/write` is a WHOLE-LIST replacement fact, and an empty list is the
            // legal explicit clear: `{ todos: [] }` is what the durable producer
            // writes to say "there is no list". Dropping that projection would make a
            // clear unobservable and leave the previous list rendered as live, so the
            // clear projects as its own marked authority fact.
            if (todos.length === 0)
                return { kind: 'todo/write', status: 'cleared', todos: [] };
            return {
                kind: 'todo/write',
                status: 'current',
                todos: todos.map((todo) => ({
                    content: boundField('todo/write.content', stringField(isRecord(todo) ? todo['content'] : undefined), limits.stateBytes, records),
                    status: stringField(isRecord(todo) ? todo['status'] : undefined),
                })),
            };
        }
        case 'plan/mode': {
            if (!isRecord(data))
                return undefined;
            return { kind: 'plan/mode', active: data['active'] === true };
        }
        case 'command/run': {
            if (!isRecord(data))
                return undefined;
            const name = stringField(data['name']);
            if (!LIFECYCLE_COMMANDS.has(name))
                return undefined;
            const source = isRecord(data['source']) ? data['source']['kind'] : undefined;
            const result = {
                kind: 'command/run',
                commandId: stringField(data['commandId']),
                name,
            };
            const args = optionalBound(data, 'args', 'command/run.args', limits.commandBytes, records);
            if (args !== undefined)
                result.args = args;
            if (source !== undefined)
                result.source = source;
            return result;
        }
        // `command/done` is deliberately absent: it records no `name`, so a
        // stateless per-event projection cannot tell whether its paired run was
        // lifecycle-relevant, and its outcome duplicates the authoritative state
        // the durable goal/plan/todo events already record.
        /* v8 ignore next 2 -- filterEvent gates on ELIGIBLE_TYPES before calling, so no eligible type reaches this default. */
        default:
            return undefined;
    }
}
/** Event types the filter considers eligible for folding. */
const ELIGIBLE_TYPES = new Set([
    'user/message',
    'assistant/message',
    'tool/call',
    'tool/result',
    'turn/end',
    'goal/change',
    'todo/write',
    'plan/mode',
    'command/run',
    // Selected-model route snapshots (`request/header`) and durable preset
    // selections: both tell the model which composition produced the surrounding
    // assistant text, so they are small projectable markers.
    'request/header',
    'agent-preset/selected',
    // Compaction bracket markers: the model sees that a compaction ran, which
    // owner turn it covered, and whether it failed. `compaction/summary` is
    // deliberately NOT eligible.
    'compaction/start',
    'compaction/end',
]);
/** Event types that never enter the projection regardless of payload. */
const NEVER_ELIGIBLE = new Set([
    'task-state/update-request',
    'task-state/update-finished',
    'context-enhancement/task-state-committed',
]);
/**
 * Whether one event type is eligible for the task-state source filter.
 * The task-state audit events and every excluded presentation/transport/chunk
 * type are never eligible. The task-state audit events no longer exist as
 * Session events in this implementation (they are storage-domain rows), but
 * the names stay reserved so an older log that did record them (or a foreign
 * producer) can never feed the fold.
 * @param type - Session event type.
 * @returns whether the filter may fold the event.
 */
export function isEligibleType(type) {
    if (NEVER_ELIGIBLE.has(type))
        return false;
    return ELIGIBLE_TYPES.has(type);
}
/**
 * Filter one Session event: decide eligibility and project owned durable
 * fields when the event is eligible AND projects meaningful content.
 * @param event - candidate Session event.
 * @param limits - explicit field byte limits.
 * @returns the owned projection plus the truncation records applied, or `null`
 *   when the event is ineligible or projects nothing meaningful.
 */
export function filterEvent(event, limits = DEFAULT_FILTER_FIELD_LIMITS) {
    if (!isEligibleType(event.type))
        return null;
    const records = [];
    const fields = projectEvent(event, limits, records);
    if (fields === undefined)
        return null;
    return {
        event: { seq: event.seq, type: event.type, fields },
        truncation: records,
    };
}
/**
 * Measure the serialized UTF-8 byte length of one JSON value.
 * @param value - the JSON value to serialize and measure.
 * @returns UTF-8 byte length of the value's JSON serialization.
 */
export function jsonBytes(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
//# sourceMappingURL=filter.js.map