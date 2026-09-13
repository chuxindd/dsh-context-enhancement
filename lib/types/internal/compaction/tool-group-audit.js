import { createHash } from 'node:crypto';
/**
 * Machine-readable reasons this state machine stores on a row and logs.
 *
 * They are stable strings rather than prose so a diagnostic can be asserted by
 * a test and grepped in a run log, and so the durable row states WHY a
 * transition happened instead of only that one did.
 */
export const AUDIT_DIAGNOSTIC = {
    /** An `open` row whose owning instance is gone (restart) or holds it elsewhere. */
    interruptedAttempt: 'interrupted-attempt',
    /** An interrupted row was adopted for a new, budgeted attempt. */
    adoptedInterruptedAttempt: 'adopted-interrupted-attempt',
    /** Session provenance proves this group's reduction landed. */
    sessionEvidenceServed: 'session-evidence-served',
    /** The row's claims are not backed by this group's Session provenance. */
    landingClaimConflict: 'landing-claim-conflict',
    /** The attempt budget of one group is spent (its failure/abort history). */
    attemptsExhausted: 'attempts-exhausted',
    /** A durable audit write was rejected; Session provenance still decides types. */
    auditWriteFailed: 'audit-write-failed',
    /** The durable row a transition targeted is gone (whole-document overwrite). */
    auditRecordMissing: 'audit-record-missing',
    /** Session provenance proves a landing no audit row records. */
    auditLandingUnrecorded: 'audit-landing-unrecorded',
};
/**
 * Attempts one tool group may start, counting its own failures and every
 * interruption recovery adopted. A durable budget: adopting an interrupted row
 * increments its `attempt`, so a group can never be re-summarized forever by
 * restarting. Reaching the budget refuses further model work for that group
 * (with {@link AUDIT_DIAGNOSTIC.attemptsExhausted}) without inventing a
 * terminal reduction: classification stays with the Session log either way.
 */
export const TOOL_GROUP_AUDIT_MAX_ATTEMPTS = 2;
export function toolGroupFingerprint(input) {
    const canonical = JSON.stringify({
        lifecycle: input.lifecycle,
        sourceSeqs: [...input.sourceSeqs],
        callIds: [...input.callIds],
        eventTypes: [...input.eventTypes],
        contentDigest: input.contentDigest,
        schemaVersion: input.schemaVersion,
    });
    return createHash('sha256').update(canonical).digest('hex');
}
export function contentDigest(parts) {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function openToolGroupAudit(requestId, sessionId, group, surfaceGeneration, provider, model, fingerprint, lifecycle = { createdAt: 0 }, attempt = {}) {
    return {
        requestId,
        sessionId,
        lifecycle,
        fingerprint,
        sourceSeqs: [...group.sourceSeqs],
        surfaceGeneration,
        provider,
        model,
        schemaVersion: 1,
        status: 'open',
        attempt: attempt.attempt ?? 1,
        ...(attempt.ownerId === undefined ? {} : { ownerId: attempt.ownerId }),
        ...(attempt.recoveredFrom === undefined ? {} : { recoveredFrom: attempt.recoveredFrom }),
    };
}
export function finishToolGroupAudit(record, status, patch = {}) {
    if (record.status !== 'open')
        throw new Error(`tool-group-audit: cannot finish ${record.status} record`);
    return { ...record, ...patch, status };
}
/** Record landed replacements on an audit record while preserving its open status. */
export function recordToolGroupLanded(record, replacementSeqs, patch = {}) {
    const existing = record.replacementSeqs ?? [];
    const merged = Array.from(new Set([...existing, ...replacementSeqs]));
    return { ...record, ...patch, replacementSeqs: merged };
}
// ---------------------------------------------------------------------------
// Recovery: `open`/`aborted` rows judged against the Session log
// ---------------------------------------------------------------------------
/**
 * Session-proven landed reductions of one tool group, read from the VALIDATED
 * provenance of the current surface.
 *
 * This is the authority recovery uses: a node counts only when its own durable
 * record says `tool-summary` AND carries this exact group identity, so neither
 * the audit document nor a shadow-price event's mere adjacency can manufacture
 * evidence. A third-party replacement with no usable provenance, a prune, and a
 * node whose record was damaged all contribute nothing, which is why a repair
 * can never promote a type the Session log does not already state.
 * @param index - classifier built from the Session surface.
 * @param fingerprint - durable tool-group identity the audit schedules under.
 * @returns the matching surface seqs, ascending.
 */
export function sessionLandedReductions(index, fingerprint) {
    const landed = [];
    for (const [seq, entry] of index.entries) {
        const reduction = entry.reduction;
        if (reduction === null || reduction.kind !== 'tool-summary')
            continue;
        if (reduction.groupId !== fingerprint)
            continue;
        landed.push(seq);
    }
    return landed.sort((left, right) => left - right);
}
/**
 * One record copy without the named optional fields.
 *
 * `exactOptionalPropertyTypes` forbids clearing an optional field by assigning
 * `undefined`, and a recovery transition MUST clear one rather than keep it: a
 * stale `error` on a repaired row, or a rejected landing claim surviving into a
 * new attempt, would misreport the row to every later reader.
 * @param record - the row being transitioned.
 * @param keys - optional fields to remove.
 * @returns the row without those fields.
 */
function withoutAuditFields(record, keys) {
    const copy = { ...record };
    for (const key of keys)
        delete copy[key];
    return copy;
}
/**
 * Turn one `open`/`aborted` row into the durable `aborted` verdict.
 *
 * `aborted` states that no landed reduction is proven for this row: it is
 * repairable (adoptable for a new attempt) and is never read as committed. The
 * rejected claims of a conflicting row stay on the record as forensic evidence
 * of what the writable document asserted; they are inert because every reader
 * classifies a row by its status first.
 * @param record - the row being judged.
 * @param diagnostic - reason code, one of {@link AUDIT_DIAGNOSTIC}.
 * @returns the row in its `aborted` state.
 */
export function abortToolGroupAudit(record, diagnostic) {
    if (record.status !== 'open' && record.status !== 'aborted') {
        throw new Error(`tool-group-audit: cannot abort ${record.status} record`);
    }
    return { ...record, status: 'aborted', diagnostic };
}
/**
 * Turn one `open`/`aborted` row into the durable `repaired` verdict.
 *
 * This is the ONLY recovery transition that asserts a landed reduction, and it
 * does so on Session evidence rather than on the audit's own word: the caller
 * passes the seqs {@link sessionLandedReductions} proved. Without evidence the
 * call throws — a repair that could invent a landing would be exactly the
 * fabrication the state machine exists to prevent.
 * @param record - the row being judged.
 * @param evidence - Session-proven landed replacements; must be non-empty.
 * @param diagnostic - reason code, one of {@link AUDIT_DIAGNOSTIC}.
 * @returns the row in its `repaired` state.
 */
export function repairToolGroupAudit(record, evidence, diagnostic = AUDIT_DIAGNOSTIC.sessionEvidenceServed) {
    if (record.status !== 'open' && record.status !== 'aborted') {
        throw new Error(`tool-group-audit: cannot repair ${record.status} record`);
    }
    if (evidence.length === 0) {
        throw new Error('tool-group-audit: repair requires Session-proven landing evidence');
    }
    return {
        ...withoutAuditFields(record, ['error']),
        status: 'repaired',
        diagnostic,
        recoveredFrom: record.status,
        replacementSeqs: [...evidence],
        repairEvidence: [...evidence],
    };
}
/**
 * Adopt one interrupted (`open` by another instance, or `aborted`) row for a
 * new attempt, IN PLACE.
 *
 * In place matters: one durable row per group keeps
 * {@link toolGroupAttemptsSpent} honest, because a second row would
 * double-count the budget and refuse the group a single restart earlier than
 * the policy states. Nothing unproven survives the adoption — the claims of a
 * rejected row and any stale error are dropped, and the only status this can
 * produce is `open`.
 * @param record - the row being adopted.
 * @param adoption - new attempt identity and the re-selected group.
 * @returns the row, now owned by the adopting attempt.
 */
export function adoptToolGroupAudit(record, adoption) {
    if (record.status !== 'open' && record.status !== 'aborted') {
        throw new Error(`tool-group-audit: cannot adopt ${record.status} record`);
    }
    return {
        ...withoutAuditFields(record, ['replacementSeqs', 'repairEvidence', 'error', 'diagnostic', 'ownerId']),
        status: 'open',
        attempt: (record.attempt ?? 1) + 1,
        recoveredFrom: record.status,
        sourceSeqs: [...adoption.sourceSeqs],
        surfaceGeneration: adoption.surfaceGeneration,
        ...(adoption.ownerId === undefined ? {} : { ownerId: adoption.ownerId }),
        ...(adoption.diagnostic === undefined ? {} : { diagnostic: adoption.diagnostic }),
    };
}
/**
 * Restate one of THIS instance's own `open` rows for a fresh attempt.
 *
 * The group is re-selected and the surface generation re-observed, so the
 * stability fence in {@link assertToolGroupCommitStable} guards the new model
 * call rather than a surface state that no longer exists. The attempt ordinal
 * deliberately stays: this is the same attempt continuing, not a new one.
 * @param record - this instance's open row.
 * @param restated - re-selected source seqs and the observed generation.
 * @returns the row, refreshed for the resumed attempt.
 */
export function resumeToolGroupAudit(record, restated) {
    if (record.status !== 'open')
        throw new Error(`tool-group-audit: cannot resume ${record.status} record`);
    return {
        ...record,
        sourceSeqs: [...restated.sourceSeqs],
        surfaceGeneration: restated.surfaceGeneration,
    };
}
/**
 * Find the durable row an attempt for one fingerprint should use.
 *
 * An `open` row is resumable when this instance owns it and adopted otherwise;
 * an `aborted` row is adopted in place. Rows whose reduction is already proven
 * (`success`, `repaired`, or an `open` row carrying verified claims) are never
 * returned: {@link shouldAttemptToolGroupSummary} refuses them before an
 * attempt starts.
 * @param records - rows of the session's lifecycle.
 * @param fingerprint - durable tool-group identity.
 * @param ownerId - this engine instance's identity, when it has one.
 * @returns the slot, or `undefined` when a brand-new row should be opened.
 */
export function attemptSlotFor(records, fingerprint, ownerId) {
    const open = records.find(record => record.fingerprint === fingerprint && record.status === 'open');
    if (open !== undefined)
        return { record: open, adopted: open.ownerId !== ownerId };
    const aborted = records.find(record => record.fingerprint === fingerprint && record.status === 'aborted');
    if (aborted !== undefined)
        return { record: aborted, adopted: true };
    return undefined;
}
/**
 * Judge every `open`/`aborted` row of one session against the Session log and
 * plan the durable transitions it needs (B6.2).
 *
 * The decisions, in order:
 *
 * 1. the row carries claims the Session log does not back → `aborted` with
 *    {@link AUDIT_DIAGNOSTIC.landingClaimConflict}: the writable document and
 *    the log disagree, so no landing is believed and no row is promoted;
 * 2. Session provenance proves this group's reduction landed → `repaired` with
 *    the proven seqs, whatever the row said (including nothing at all, which is
 *    the audit-commit-failed case);
 * 3. an `open` row this instance owns is its live attempt and is left alone;
 * 4. any other `open` row is `aborted` with
 *    {@link AUDIT_DIAGNOSTIC.interruptedAttempt} — a restart, or a concurrent
 *    writer this package cannot distinguish from one (B1's unresolved
 *    single-writer gap). It stays repairable, and it is never read as
 *    committed;
 * 5. an `aborted` row with nothing proven stays as it is (no repeated writes).
 * @param records - rows of the session's lifecycle.
 * @param index - classifier built from the SAME session's current surface.
 * @param ownerId - this engine instance's identity, when it has one. A row that
 *   carries no owner is never treated as this instance's live attempt.
 * @returns the durable transitions to apply, in row order.
 */
export function planAuditRecovery(records, index, ownerId) {
    const steps = [];
    for (const record of records) {
        if (record.status !== 'open' && record.status !== 'aborted')
            continue;
        const landed = sessionLandedReductions(index, record.fingerprint);
        const claims = record.replacementSeqs ?? [];
        const unverified = claims.filter(seq => !landed.includes(seq));
        const planned = claims.length > 0 && unverified.length > 0
            ? { status: 'aborted', diagnostic: AUDIT_DIAGNOSTIC.landingClaimConflict }
            : landed.length > 0
                ? { status: 'repaired', diagnostic: AUDIT_DIAGNOSTIC.sessionEvidenceServed }
                : record.status === 'open' && record.ownerId !== ownerId
                    ? { status: 'aborted', diagnostic: AUDIT_DIAGNOSTIC.interruptedAttempt }
                    : undefined;
        if (planned === undefined)
            continue;
        // A row already in that exact verdict needs no second write; its evidence
        // cannot change, because the surface it was judged from is durable.
        if (record.status === planned.status && record.diagnostic === planned.diagnostic)
            continue;
        steps.push({
            requestId: record.requestId,
            status: planned.status,
            diagnostic: planned.diagnostic,
            apply: planned.status === 'repaired'
                ? current => repairToolGroupAudit(current, landed, planned.diagnostic)
                : current => abortToolGroupAudit(current, planned.diagnostic),
        });
    }
    return steps;
}
// ---------------------------------------------------------------------------
// Scheduling: what one durable tool group still owes
// ---------------------------------------------------------------------------
export function successfulAuditFor(records, fingerprint) {
    return records.find(record => record.fingerprint === fingerprint && record.status === 'success');
}
export function recoverableOpenAuditFor(records, fingerprint) {
    return records.find(record => record.fingerprint === fingerprint && record.status === 'open');
}
/**
 * Whether one audit record CLAIMS its reduction landed on the surface.
 *
 * A `success` or `repaired` record does, and so does an `open` record carrying
 * `replacementSeqs`: the success commit can fail AFTER the surface rewrite is
 * durable (see the engine's `commitToolGroupSuccess`), and that record must
 * still be treated as served evidence — its replacements keep tool-summary
 * provenance, and the group is not outstanding work owed another call.
 *
 * The claim is a CLAIM: `aborted` rows (including a row whose claims recovery
 * rejected) never make it, and a caller that can read the Session log must
 * confirm it with {@link sessionLandedReductions} before spending model work.
 * The claim can only ever make a classification stricter, never create a kind.
 */
export function isServedAudit(record) {
    if (record.status === 'success' || record.status === 'repaired')
        return true;
    // A terminal failure/fallback is only ever written before any replacement
    // exists, so it never proves a landed reduction. An `aborted` row is a
    // recovery verdict that nothing landed.
    if (record.status !== 'open')
        return false;
    return (record.replacementSeqs?.length ?? 0) > 0;
}
/** Every replacement seq CLAIMED as landed by {@link isServedAudit}. */
export function servedReplacementSeqs(records) {
    return records.filter(isServedAudit).flatMap(record => record.replacementSeqs ?? []);
}
/** Attempts started for one fingerprint, counting the initial one of each row. */
export function toolGroupAttemptsSpent(records, fingerprint) {
    return records
        .filter(record => record.fingerprint === fingerprint)
        .reduce((total, record) => total + (record.attempt ?? 1), 0);
}
/** Whether one fingerprint may still start an attempt under the durable budget. */
export function hasToolGroupAttemptBudget(records, fingerprint) {
    return toolGroupAttemptsSpent(records, fingerprint) < TOOL_GROUP_AUDIT_MAX_ATTEMPTS;
}
/**
 * Whether one durable tool group still permits semantic summarization work.
 *
 * The Session evidence wins over every audit state: a group whose reduction the
 * durable provenance proves landed is not outstanding work, whether the audit
 * row is missing, stale, still `open` after a failed commit, or a
 * whole-document last-write-wins overwrite replaced it (R-P2-3). Everything
 * else is read from the rows, and the attempt budget is durable:
 *
 * - `success`/`repaired`, or an `open` row claiming landed replacements → no;
 * - a `fallback` refusal → no;
 * - an `open`/`aborted` row with nothing proven → yes while the budget lasts;
 * - otherwise the remaining budget decides, so two failed attempts end the work
 *   exactly as the pre-B6.2 rule did.
 * @param records - rows of the session's lifecycle.
 * @param fingerprint - durable tool-group identity.
 * @param evidence - Session-proven landing evidence, when the caller can read
 *   the log. Omitting it is the audit-only (degraded) view and is never what
 *   the engine uses.
 * @returns whether an attempt is still owed.
 */
export function shouldAttemptToolGroupSummary(records, fingerprint, evidence = {}) {
    if ((evidence.landed?.length ?? 0) > 0)
        return false;
    if (successfulAuditFor(records, fingerprint) !== undefined)
        return false;
    if (records.some(record => record.fingerprint === fingerprint && record.status === 'repaired'))
        return false;
    const open = recoverableOpenAuditFor(records, fingerprint);
    if (open !== undefined) {
        // An open record whose replacements already landed is served, not pending:
        // re-attempting it would duplicate a reduction that is durably on the surface.
        if (isServedAudit(open))
            return false;
        return hasToolGroupAttemptBudget(records, fingerprint);
    }
    if (records.some(record => record.fingerprint === fingerprint && record.status === 'fallback'))
        return false;
    return hasToolGroupAttemptBudget(records, fingerprint);
}
export function assertToolGroupCommitStable(sessionId, currentGeneration, currentSourceSeqs, record) {
    if (record.sessionId !== sessionId)
        throw new Error('tool-group-audit: session lifecycle changed');
    if (record.surfaceGeneration !== currentGeneration)
        throw new Error('tool-group-audit: surface generation changed');
    if (record.sourceSeqs.length !== currentSourceSeqs.length
        || record.sourceSeqs.some((seq, index) => seq !== currentSourceSeqs[index])) {
        throw new Error('tool-group-audit: source surface changed');
    }
}
//# sourceMappingURL=tool-group-audit.js.map