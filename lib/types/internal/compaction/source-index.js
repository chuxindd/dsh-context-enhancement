/**
 * Durable source classification for the current session surface.
 *
 * Classification is derived from each replacement's OWN durable provenance —
 * written into the Session log by the producer beside the replacement — plus the
 * official compaction events, never from generated text and never from a separate
 * storage document. The tool-group audit is a diagnostic and a work schedule; it
 * is NOT the type authority (see {@link ReductionProvenance}), so an audit
 * document that is lost, truncated, or overwritten by another writer's
 * whole-document last-write-wins cannot change how a committed replacement is
 * classified. A replacement whose provenance is missing or damaged fails closed
 * to `unknown-replacement`, which is never read as an original fact.
 */
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import { createHash } from 'node:crypto';
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { isTaskStateSlotSource } from "../task-state/contract/index.js";
// ---------------------------------------------------------------------------
// Durable reduction provenance
// ---------------------------------------------------------------------------
/**
 * Producer marker of every reduction provenance record this package writes.
 *
 * The field rides the OFFICIAL shadow-price event the shared protocol already
 * places immediately before a replacement, because the DSH surface contract
 * forbids every other carrier:
 *
 * - a `tool/result` surface replacement may change ONLY its content
 *   (`assertToolResultRewrite`), so the replacement's own `data` cannot carry it;
 * - `Session.append()` cannot mark an event `ignorable`, and the persistence read
 *   path refuses event types outside the harness's own generated vocabulary that
 *   lack that marker, so a plugin-owned event type would make every Session this
 *   package touched unreadable after a restart;
 * - the official `compaction/prune` data type is a closed interface member that
 *   TypeScript refuses to widen by module augmentation, so the writer carries the
 *   field on its own widened payload type and the classifier re-validates it from
 *   the logged JSON.
 */
export const REDUCTION_PROVENANCE_PRODUCER = 'dsh-context-enhancement';
/** Schema version of {@link ReductionProvenance}. Any other value fails closed. */
export const REDUCTION_PROVENANCE_VERSION = 1;
/**
 * The exact text a reduction's digest binds: every text block of the replacement
 * message in document order, nested tool-result blocks included.
 *
 * It reads text only — never the serialized block objects — so the digest stays
 * stable across JSON round-trips that re-order object keys, and the classifier
 * can recompute the SAME value from the logged event. The parts are digested as a
 * JSON array rather than a joined string, so no separator choice can make two
 * different texts collide.
 */
function reductionTextParts(content) {
    const parts = [];
    const visit = (blocks) => {
        for (const block of blocks) {
            if (block.type === 'text')
                parts.push(block.text);
            else if (block.type === 'tool-result')
                visit(block.content);
        }
    };
    visit(content);
    return parts;
}
/** Canonical digest of one reduction record over its fields and its content. */
export function reductionDigest(input) {
    return createHash('sha256').update(JSON.stringify([
        REDUCTION_PROVENANCE_PRODUCER,
        String(REDUCTION_PROVENANCE_VERSION),
        input.kind,
        JSON.stringify([...input.coveredSeqs]),
        JSON.stringify([...input.sourceEventSeqs]),
        JSON.stringify(input.groupId),
        String(input.generation),
        JSON.stringify(reductionTextParts(input.content)),
    ])).digest('hex');
}
/**
 * Encode one reduction's durable provenance record.
 *
 * The builder is a pure encoder and deliberately validates nothing: it is the
 * producer's statement of what it did, and the classifier re-validates every
 * field it reads back. A damaged record is therefore representable (and is
 * rejected on read) rather than silently repaired on write.
 * @param input - the reduction's own account of itself.
 * @returns the frozen-by-`Session.append` provenance record.
 */
export function reductionProvenance(input) {
    return {
        producer: REDUCTION_PROVENANCE_PRODUCER,
        schemaVersion: REDUCTION_PROVENANCE_VERSION,
        kind: input.kind,
        coveredSeqs: [...input.coveredSeqs],
        sourceEventSeqs: [...input.sourceEventSeqs],
        groupId: input.groupId,
        generation: input.generation,
        digest: reductionDigest(input),
    };
}
/**
 * Build the official shadow-price payload for one single-node reduction, with
 * this package's provenance attached.
 * @param shadowedSeq - the one shadowed surface node.
 * @param shadowedTokenCount - heuristic price of the shadowed content.
 * @param provenance - the validated-shape provenance record of this reduction.
 * @returns the payload to append as `compaction/prune`, immediately before the
 *   replacement.
 */
export function shadowPriceWithProvenance(shadowedSeq, shadowedTokenCount, provenance) {
    return {
        shadowedRange: { start: shadowedSeq, end: shadowedSeq },
        shadowedSeqs: [shadowedSeq],
        shadowedTokenCount,
        provenance,
    };
}
/** Whether one value is a data record an unknown JSON payload can be read from. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Read one non-empty array of event seqs, or `undefined` when it is malformed. */
function readSeqArray(value) {
    if (!Array.isArray(value) || value.length === 0)
        return undefined;
    const seqs = [];
    for (const item of value) {
        if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)
            return undefined;
        seqs.push(item);
    }
    return seqs;
}
/**
 * The validated durable provenance of one surface node, or `undefined` when the
 * node carries none this package can trust.
 *
 * The record must agree with the OFFICIAL part of the event it rides — the
 * shadowed range the shared shadow-price protocol states — and its digest must
 * still bind the replacement content that is actually in the log. Anything else
 * (a foreign producer, an unknown schema version, a truncated or re-typed
 * payload, a range that disagrees with the protocol's own statement, a stale
 * digest) returns `undefined`, which the classifier turns into
 * `unknown-replacement` rather than a guess.
 * @param session - session owning the log.
 * @param replacement - the surface event being classified.
 * @returns the validated record, or `undefined`.
 */
function readReductionProvenance(session, replacement) {
    if (replacement.type !== 'tool/result' || !isReplacementSurfaceEvent(replacement))
        return undefined;
    if (replacement.seq === 0)
        return undefined;
    // The shared shadow-price protocol places the metering event immediately
    // before the replacement it prices; that adjacency is the record's address.
    const price = session.eventAt((replacement.seq - 1));
    if (price?.type !== 'compaction/prune')
        return undefined;
    // The official event type is closed, so the additive record is read as unknown
    // JSON and validated field by field before any of it is trusted.
    const raw = price.data.provenance;
    if (!isRecord(raw))
        return undefined;
    if (raw['producer'] !== REDUCTION_PROVENANCE_PRODUCER)
        return undefined;
    if (raw['schemaVersion'] !== REDUCTION_PROVENANCE_VERSION)
        return undefined;
    const kind = raw['kind'];
    if (kind !== 'tool-summary' && kind !== 'tool-pruned')
        return undefined;
    const coveredSeqs = readSeqArray(raw['coveredSeqs']);
    const sourceEventSeqs = readSeqArray(raw['sourceEventSeqs']);
    if (coveredSeqs === undefined || sourceEventSeqs === undefined)
        return undefined;
    // The official shadowed range is the protocol's own statement of what this
    // replacement stands for: a record that disagrees with it is unusable.
    const shadowedSeqs = readSeqArray(price.data.shadowedSeqs);
    if (shadowedSeqs === undefined
        || shadowedSeqs.length !== coveredSeqs.length
        || shadowedSeqs.some((seq, index) => seq !== coveredSeqs[index]))
        return undefined;
    // The covered range must be part of the cited source set, and every source must
    // be a distinct, strictly earlier event.
    if (coveredSeqs.some(seq => !sourceEventSeqs.includes(seq)))
        return undefined;
    if (sourceEventSeqs.some((seq, index) => seq >= replacement.seq || sourceEventSeqs.indexOf(seq) !== index)) {
        return undefined;
    }
    const groupId = raw['groupId'];
    if (kind === 'tool-summary') {
        if (typeof groupId !== 'string' || groupId.length === 0)
            return undefined;
    }
    else if (groupId !== null) {
        return undefined;
    }
    const generation = raw['generation'];
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0)
        return undefined;
    if (generation > session.surface.replaceGeneration)
        return undefined;
    const digest = raw['digest'];
    if (typeof digest !== 'string')
        return undefined;
    const expected = reductionDigest({
        kind,
        coveredSeqs,
        sourceEventSeqs,
        groupId: typeof groupId === 'string' ? groupId : null,
        generation,
        content: replacement.data.message.content,
    });
    if (digest !== expected)
        return undefined;
    return {
        producer: REDUCTION_PROVENANCE_PRODUCER,
        schemaVersion: REDUCTION_PROVENANCE_VERSION,
        kind,
        coveredSeqs,
        sourceEventSeqs,
        groupId: typeof groupId === 'string' ? groupId : null,
        generation,
        digest,
    };
}
// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
/** Reconstruct current source types entirely from persisted session provenance. */
export function buildSurfaceSourceIndex(session, auditClaimedSummarySeqs = []) {
    // The tool-group audit's served-replacement seqs. They are a DIAGNOSTIC claim
    // and can only ever make a classification stricter: a served-audit row that
    // names a node whose durable Session provenance does not say `tool-summary` is
    // two durable documents disagreeing, and this package refuses to pick one
    // (see `classifyEvent`). The audit never creates a kind.
    const auditClaimedSummaries = new Set(auditClaimedSummarySeqs);
    const boundary = ownBoundarySeq(session);
    const entries = new Map();
    for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        if (event === undefined)
            throw new Error(`source-index: surface seq ${seq} has no event`);
        // Validate each node's durable provenance ONCE: the kind, the exposed entry,
        // and the covered range all read the same validated record.
        const reduction = readReductionProvenance(session, event);
        const kind = classifyEvent(event, reduction, auditClaimedSummaries.has(seq));
        entries.set(seq, {
            seq,
            kind,
            sourceEventSeqs: replacementSources(event),
            completedTurnsAfter: kind === 'original' ? 0 : completedTurnsAfter(session, event, boundary),
            reduction: reduction ?? null,
            inherited: Number(seq) < boundary,
        });
    }
    return {
        entries,
        ownBoundarySeq: boundary,
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
                && !entry.inherited
                && (entry.kind === 'tool-summary' || entry.kind === 'tool-pruned' || entry.kind === 'history-summary')) {
                return true;
            }
            return entry.completedTurnsAfter >= minReentryTurns;
        },
        replacementCoverage(seq) {
            const event = session.eventAt(seq);
            const entry = entries.get(seq);
            if (event === undefined || entry === undefined)
                return undefined;
            // The creating node of a known non-dialogue source keeps its own kind:
            // reporting a Stable task-state slot as `original` would misrepresent
            // runtime/task-state delivery as a conversation fact.
            if (!isReplacementSurfaceEvent(event)) {
                return { kind: entry.kind === 'task-state-slot' ? 'task-state-slot' : 'original', coveredSeqs: null };
            }
            // A validated record states the covered range explicitly; only a
            // replacement without one falls back to the seqs the event itself cites.
            return { kind: entry.kind, coveredSeqs: entry.reduction?.coveredSeqs ?? entry.sourceEventSeqs };
        },
    };
}
/**
 * Classify one surface node from its validated durable provenance.
 *
 * A replacement is the kind its OWN record says it is. A replacement without a
 * usable record is `unknown-replacement` — never `original`, and never one of
 * the kind buckets a foreign producer might have intended, because this package
 * cannot prove what such a node holds. A node that is not a replacement is an
 * `original` fact of the conversation regardless of what event precedes it.
 * @param event - the node being classified.
 * @param reduction - its validated provenance, when it has one.
 * @param auditClaimedSummary - whether the diagnostic audit claims this exact
 *   node as a served semantic summary.
 * @returns the node's source kind.
 */
function classifyEvent(event, reduction, auditClaimedSummary) {
    // A Stable task-state slot is a runtime/task-state source whether it CREATED
    // the slot (plain append) or replaced it, so it is classified by its durable
    // source before the tool-result and history-summary paths. Classifying it as
    // `original` would let history compaction repeatedly fold live durable state
    // as ordinary conversation content.
    if (event.type === 'user/message' && isTaskStateSlotSource(event.data.source))
        return 'task-state-slot';
    if (isHistorySummary(event))
        return 'history-summary';
    if (event.type !== 'tool/result' || !isReplacementSurfaceEvent(event))
        return 'original';
    if (reduction === undefined)
        return 'unknown-replacement';
    // A served-audit claim that contradicts the durable provenance is a conflict,
    // not evidence: this package fails closed instead of trusting the writable
    // document over the log.
    if (auditClaimedSummary && reduction.kind !== 'tool-summary')
        return 'unknown-replacement';
    return reduction.kind;
}
function isHistorySummary(event) {
    if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event))
        return false;
    const source = event.data.source;
    return source.kind === 'plugin' && isCompactCheckpointSource(source);
}
function replacementSources(event) {
    return isReplacementSurfaceEvent(event) ? [...(event.sourceEventSeqs ?? [])] : [];
}
/**
 * The Session's own-event boundary: the seq of its first own event.
 *
 * `Session.inheritedEventCount` is the durable seeding length restored from the
 * persisted `seedLength` header field, so it is the same value before and after a
 * resume — unlike `firstLiveSeq`, which reports the in-process constructor seed
 * length and therefore the WHOLE stored log length after a resume. An unseeded
 * Session reports `0`: it has no prefix and its first own event is seq 0, which
 * is what keeps every unforked Session's index byte-for-byte identical.
 */
function ownBoundarySeq(session) {
    const inherited = Number(session.inheritedEventCount);
    return Number.isSafeInteger(inherited) && inherited > 0 ? inherited : 0;
}
/**
 * How many completed turns of the CURRENT lifecycle follow one replacement.
 *
 * The count starts at the replacement's own successor, but never below the
 * Session's own boundary: the completed turns of an inherited prefix belong to
 * the parent lifecycle and cannot age a node for the child that inherited it.
 * @param session - session owning the log.
 * @param replacement - the replacement node being aged.
 * @param boundary - the Session's own-event boundary (`0` when unseeded).
 * @returns the number of own completed turns after the replacement.
 */
function completedTurnsAfter(session, replacement, boundary) {
    let count = 0;
    for (let seq = Math.max(replacement.seq + 1, boundary); seq < session.seq; seq += 1) {
        const event = session.eventAt(seq);
        if (event?.type === 'turn/end' && event.data.reason?.kind === 'completed')
            count += 1;
    }
    return count;
}
//# sourceMappingURL=source-index.js.map