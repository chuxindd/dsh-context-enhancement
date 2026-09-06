import { createHash } from 'node:crypto';
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
export function openToolGroupAudit(requestId, sessionId, group, surfaceGeneration, provider, model, fingerprint, lifecycle = { createdAt: 0 }) {
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
    };
}
export function finishToolGroupAudit(record, status, patch = {}) {
    if (record.status !== 'open')
        throw new Error(`tool-group-audit: cannot finish ${record.status} record`);
    return { ...record, ...patch, status };
}
export function successfulAuditFor(records, fingerprint) {
    return records.find(record => record.fingerprint === fingerprint && record.status === 'success');
}
export function recoverableOpenAuditFor(records, fingerprint) {
    return records.find(record => record.fingerprint === fingerprint && record.status === 'open');
}
/** Whether one durable tool group still permits semantic summarization work. */
export function shouldAttemptToolGroupSummary(records, fingerprint) {
    if (successfulAuditFor(records, fingerprint) !== undefined)
        return false;
    if (recoverableOpenAuditFor(records, fingerprint) !== undefined)
        return true;
    if (records.some(record => record.fingerprint === fingerprint && record.status === 'fallback'))
        return false;
    const failures = records.filter(record => record.fingerprint === fingerprint && record.status === 'failure').length;
    return failures < 2;
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