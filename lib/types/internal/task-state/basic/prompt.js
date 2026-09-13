/**
 * Exact auxiliary model instruction and deterministic framing for one
 * collect-and-merge request. The instruction text is pinned verbatim in the
 * request audit row so replay reconstructs the identical model input; the
 * per-request projection frame is JSON that the filter rebuilds from the
 * exact included event sequences and the retained filter implementation.
 * @module dsh-context-enhancement/internal/task-state/basic/prompt
 */
import { resolveAuthorityViews } from "./authority.js";
import { DEFAULT_FILTER_FIELD_LIMITS, TASK_STATE_FILTER_VERSION } from "./filter.js";
/** Input schema version the framed output must satisfy (pinned v2). */
export const TASK_STATE_INPUT_SCHEMA_VERSION = 2;
/** One parsed content-value schema version this provider writes. */
export const TASK_STATE_STABLE_SCHEMA_VERSION = 2;
/**
 * The pinned auxiliary system instruction. It describes the exact expected
 * output as JSON (facts, decisions, constraints, risks, evidence, and
 * continuation state), the Host-owned id rules, the authoritative Goal/TODO
 * view rules, and the constraints the Host enforces.
 */
export const TASK_STATE_SYSTEM_INSTRUCTION = [
    'You are the durable task-state updater for one AI coding-assistant session. Update the previous durable task state from the supplied projection of recent session events.',
    '',
    'Return ONLY one JSON object with EXACTLY these fields:',
    '{',
    '  "facts": [{ "content": "string" } | { "id": "fact-<uuid>", "content": "string" }],',
    '  "decisions": [{ "content": "string" } | { "id": "decision-<uuid>", "content": "string" }],',
    '  "constraints": [{ "content": "string" } | { "id": "constraint-<uuid>", "content": "string" }],',
    '  "risks": [{ "content": "string" } | { "id": "risk-<uuid>", "content": "string" }],',
    '  "evidence": [{ "seq": <number>, "note": "string" }],',
    '  "continuation": {',
    '    "currentObjective": "string",',
    '    "currentFocus": "string",',
    '    "openWork": ["string"],',
    '    "nextActions": ["string"]',
    '  }',
    '}',
    '',
    'Authoritative Goal and TODO views:',
    '- `authorityViews.goal` and `authorityViews.todo` in the input are AUTHORITATIVE views the Host resolved from the newest durable `goal/change` and `todo/write` facts of this exact window. They are not yours to write: the output schema above has no field for them and anything you emit for them is ignored.',
    '- A new goal revision REPLACES the previous goal outright; `authorityViews.changed` names every view whose committed value this window changed (a clear is a change), and `authorityViews.cleared` names the subset of those views this window emptied (a goal clear tombstone, or a whole-list TODO write carrying an empty list).',
    '- When `changed` or `cleared` names `goal`, the superseded objective is gone: never restate it, and never carry the old goal into `continuation.currentObjective` or `openWork`. State the objective that the authoritative view states, or nothing when the goal was cleared.',
    '- When `changed` or `cleared` names `todo`, the previous TODO list is gone. Never restate cleared items anywhere, and never treat the TODO list as yours to maintain: it is reproduced from the authoritative view, not from your output.',
    '',
    'Rules:',
    '- A NEW fact, decision, constraint, or risk OMITS the id: the Host mints one with the matching prefix.',
    '- An entry CARRIED FORWARD from the previous state ECHOES its exact existing id verbatim. Do not invent, rename, or change any id prefix.',
    '- An entry you remove entirely disappears; never edit the content of an entry whose id you echo — drop it and add a new entry without an id when the content changes materially.',
    '- Keep the four kinded lists authoritative and deduplicated: same fact in several lists is wrong.',
    '- `evidence` references the exact `seq` values listed as eligible in the projection; every note explains what the reference supports in one short sentence. Never reference a seq the projection did not list.',
    '- `continuation.currentObjective` is the human task objective in force; `currentFocus` what is being worked on; `openWork` concrete unfinished work; `nextActions` concrete next steps. TODO stays separate and never merges into these fields.',
    '- Empty lists are `[]`. Preserve exact file paths, commands, queries, error strings, identifiers, and numeric values.',
    '- Keep every string short enough that the total output fits the reported byte budget. Output ONLY the JSON object: no Markdown fence, no commentary, no tool call.',
].join('\n');
/**
 * Build the deterministic model-visible input frame for one batch. The frame
 * is the owned JSON that filter v3 reconstructs from the exact included
 * sequences: previous stable content (or null), the authoritative Goal/TODO
 * views of this exact window with their replace/clear provenance, the filter
 * version, the input schema version, the deterministic event projections, and
 * the truncation records. The caller bounds the serialized frame to the batch
 * input budget.
 *
 * The frame's `authorityViews` block is what conveys the replace/clear
 * semantics to the model: `changed` lists the views this window replaced with
 * a newer authority fact and `cleared` lists the views it emptied, so a window
 * holding no authority fact is plainly the ordinary fact-delta case. Ordinary
 * windows are NOT replayed as stable content — the event projections stay the
 * same bounded delta they always were.
 * @param input - base stable, projected events, and truncation records.
 * @returns the serialized deterministic model-visible frame.
 */
export function frameProjection(input) {
    const authority = resolveAuthorityViews(input.events, input.base, {
        maxEntryBytes: TASK_STATE_AUTHORITY_REFERENCE_BYTES,
    });
    const frame = {
        previousStable: input.base === null ? null : contentOfStable(input.base),
        authorityViews: {
            goal: authority.goalView,
            todo: authority.todoView,
            changed: authority.changed,
            cleared: authority.cleared,
        },
        filterVersion: TASK_STATE_FILTER_VERSION,
        inputSchemaVersion: TASK_STATE_INPUT_SCHEMA_VERSION,
        events: input.events.map(event => ({
            seq: event.seq,
            type: event.type,
            fields: event.fields,
        })),
        truncation: input.truncation,
    };
    return JSON.stringify(frame);
}
/**
 * Byte bound applied to the authority reference content inside the frame. The
 * frame is a bounded model input, not a commit path, so it uses the shipped
 * state-field bound rather than a deployment policy.
 */
const TASK_STATE_AUTHORITY_REFERENCE_BYTES = DEFAULT_FILTER_FIELD_LIMITS.stateBytes;
/** Stable content view (without Host commit metadata) handed to the model. */
function contentOfStable(stable) {
    return {
        facts: stable.facts,
        decisions: stable.decisions,
        constraints: stable.constraints,
        risks: stable.risks,
        evidence: stable.evidence,
        todoReferences: stable.todoReferences,
        goalView: stable.goalView,
        todoView: stable.todoView,
        continuation: stable.continuation,
    };
}
//# sourceMappingURL=prompt.js.map