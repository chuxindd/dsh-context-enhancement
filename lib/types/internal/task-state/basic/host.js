/**
 * Versioned Host semantic validation of one auxiliary task-state candidate
 * against the committed base and the batch window. It parses nothing (the
 * caller parses with `JSON.parse` and the contract schema), mints Host-owned
 * branded ids for new entries, verifies echoed ids exist in the base, applies
 * the complete-candidate update rules, bounds every retained value with the
 * configured UTF-8 byte and item limits, verifies every evidence and TODO
 * reference points into the folded batch window, and computes the stable
 * digest over the normalized content. Any failure rejects the complete
 * candidate; the previous stable and cursor stay untouched.
 * @module dsh-context-enhancement/internal/task-state/basic/host
 */
import { randomUUID, createHash } from 'node:crypto';
import { TaskStateEntryId, taskStateCandidateSchema, taskStateStableSchema, } from "../contract/index.js";
import { boundUtf8 } from "./bytes.js";
/** Kinded list names in committed order, each paired with its entry-id kind prefix. */
const KINDS = [
    ['facts', 'fact'],
    ['decisions', 'decision'],
    ['constraints', 'constraint'],
    ['risks', 'risk'],
];
/**
 * Verify one candidate parses against the contract candidate schema.
 * @param raw - the parsed model output to validate.
 * @returns the schema-validated candidate content.
 * @throws when the value does not satisfy the contract candidate schema.
 */
export function parseCandidate(raw) {
    const parsed = taskStateCandidateSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`task-state-basic: candidate failed the durable schema: ${parsed.error.message}`);
    }
    return parsed.data;
}
/** Mint one opaque kind-prefixed branded id (`fact-<uuid>`). */
function mintId(prefix) {
    return TaskStateEntryId(`${prefix}-${randomUUID()}`);
}
/** Bound one retained entry or continuation field to the configured byte limit. */
function boundEntry(text, limitBytes) {
    const bounded = boundUtf8(text, limitBytes);
    return bounded.text;
}
/**
 * Normalize one parsed candidate into committed content. Steps, in order:
 * check per-kind count and per-list item limits; bound every retained entry,
 * continuation, evidence note, and TODO content; verify every echoed id exists
 * in the base, is used in the list whose kind matches its prefix, echoes the
 * base content VERBATIM, and is unique across the complete candidate; mint ids
 * for every new entry; require every evidence and TODO reference sequence to be
 * one of the exact folded eligible sequences; then validate the fully id-ed
 * content against the committed-content schema.
 * @param candidate - parsed and schema-validated candidate content.
 * @param context - durable base and folded-window facts.
 * @returns the normalized committed content.
 */
export function normalizeCandidate(candidate, context) {
    const { limits } = context;
    const checkCount = (kind) => {
        const list = candidate[kind];
        if (list.length > limits.maxEntriesPerKind) {
            throw new Error(`task-state-basic: candidate ${kind} has ${list.length} entries, exceeding maxEntriesPerKind ${limits.maxEntriesPerKind}`);
        }
    };
    checkCount('facts');
    checkCount('decisions');
    checkCount('constraints');
    checkCount('risks');
    /** The exact base entry one echoed id names, or `undefined`. */
    const baseEntryById = new Map();
    for (const entry of context.base?.entries ?? [])
        baseEntryById.set(entry.id, entry);
    // Echoed-id dedupe is global across every kinded list: an id must name at
    // most one committed entry in the whole candidate.
    const seenEchoed = new Set();
    const kinded = {
        facts: [],
        decisions: [],
        constraints: [],
        risks: [],
    };
    for (const [list, prefix] of KINDS) {
        const out = kinded[list];
        for (const entry of candidate[list]) {
            const content = boundEntry(entry.content, limits.maxEntryBytes);
            if (entry.id === undefined) {
                // Host-minted ids draw from the full UUID space, so a collision with a
                // base entry id is impossible; the entry simply receives a fresh id.
                out.push({ id: mintId(prefix), content });
                continue;
            }
            const id = String(entry.id);
            const baseEntry = baseEntryById.get(id);
            if (baseEntry === undefined) {
                throw new Error(`task-state-basic: candidate echoes unknown entry id "${id}"`);
            }
            if (seenEchoed.has(id)) {
                throw new Error(`task-state-basic: candidate echoes entry id "${id}" more than once`);
            }
            seenEchoed.add(id);
            // The echoed id's kind prefix must match the list it appears in: an
            // entry carried into the wrong kinded list would change its meaning
            // while pretending to be unchanged.
            if (baseEntry.kind !== prefix) {
                throw new Error(`task-state-basic: candidate echoes "${id}" in ${list}, but the base holds it as a ${baseEntry.kind}`);
            }
            // Echoing an id commits to the base content verbatim. A materially
            // different proposal must drop the id and appear as a new no-id entry.
            if (content !== baseEntry.content) {
                throw new Error(`task-state-basic: candidate echoes "${id}" with changed content; drop the id and add a new ${prefix} without an id when the content changes`);
            }
            out.push({ id: TaskStateEntryId(id), content });
        }
    }
    const boundNote = (note) => boundEntry(note, limits.maxEntryBytes);
    const evidence = candidate.evidence.map((reference) => {
        if (!context.includedSeqs.has(reference.seq)) {
            throw new Error(`task-state-basic: evidence reference ${reference.seq} is not an included eligible sequence`);
        }
        return { seq: reference.seq, note: boundNote(reference.note) };
    });
    if (evidence.length > limits.maxListItems) {
        throw new Error(`task-state-basic: candidate evidence exceeds maxListItems ${limits.maxListItems}`);
    }
    const todoReferences = candidate.todoReferences.map((reference) => {
        if (!context.includedSeqs.has(reference.seq)) {
            throw new Error(`task-state-basic: todo reference ${reference.seq} is not an included eligible sequence`);
        }
        return { seq: reference.seq, content: boundNote(reference.content) };
    });
    if (todoReferences.length > limits.maxListItems) {
        throw new Error(`task-state-basic: candidate todoReferences exceeds maxListItems ${limits.maxListItems}`);
    }
    const openWork = candidate.continuation.openWork.map(item => boundEntry(item, limits.maxEntryBytes));
    const nextActions = candidate.continuation.nextActions.map(item => boundEntry(item, limits.maxEntryBytes));
    if (openWork.length > limits.maxListItems || nextActions.length > limits.maxListItems) {
        throw new Error(`task-state-basic: continuation lists exceed maxListItems ${limits.maxListItems}`);
    }
    const continuation = {
        currentObjective: boundEntry(candidate.continuation.currentObjective, limits.maxEntryBytes),
        currentFocus: boundEntry(candidate.continuation.currentFocus, limits.maxEntryBytes),
        openWork,
        nextActions,
    };
    // Every kinded list slot was filled by the KINDS loop above.
    const facts = kinded.facts;
    const decisions = kinded.decisions;
    const constraints = kinded.constraints;
    const risks = kinded.risks;
    // Every field below was schema-validated on the candidate and rebuilt from
    // bounded strings, so the assembled content needs no second whole-object
    // validation here; commitStable re-validates the complete committed stable.
    return {
        facts,
        decisions,
        constraints,
        risks,
        evidence,
        todoReferences,
        continuation,
    };
}
/**
 * Compute the SHA-256 digest over one stable's normalized structured content.
 * @param content - normalized committed content to digest.
 * @returns lowercase hex digest of the content's JSON serialization.
 */
export function digestOf(content) {
    return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
/**
 * Build the committed stable from normalized content and Host-owned metadata.
 * @param content - normalized committed content.
 * @param schemaVersion - stable content schema version.
 * @param revision - next monotonic revision (base revision + 1, or 1 first).
 * @param filterVersion - deterministic input-filter version that produced the projection.
 * @param sourceCursor - last eligible sequence actually folded.
 * @returns the immutable committed stable.
 */
export function commitStable(content, schemaVersion, revision, filterVersion, sourceCursor) {
    const digest = digestOf(content);
    const stable = {
        schemaVersion,
        revision,
        filterVersion,
        sourceCursor,
        digest,
        ...content,
    };
    const check = taskStateStableSchema.safeParse(stable);
    if (!check.success) {
        throw new Error(`task-state-basic: committed stable failed its durable schema: ${check.error.message}`);
    }
    return stable;
}
//# sourceMappingURL=host.js.map