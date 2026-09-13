import { DomainError } from '@deepseek-ai/dsh-storage-domain';
import { toolGroupAuditDomainSpec } from "./tool-group-domain.js";
/** Write attempts one audit write spends before it reports failure to its caller. */
export const TOOL_GROUP_AUDIT_WRITE_ATTEMPTS = 2;
/**
 * Whether one rejected audit write is worth retrying.
 *
 * A backend write failure (an I/O error, a busy medium) is transient and gets
 * the bounded retry. A domain-layer refusal is deterministic and is NOT: a
 * `closed` domain rejects every retry, and a `missing-key` update means the row
 * this transition targeted is gone — which is precisely the durable symptom of
 * a whole-document last-write-wins overwrite by another writer, and the caller
 * must report it as that instead of hammering the store. Retrying it could not
 * succeed, and pretending it had would be worse than failing.
 * @param error - the rejection.
 * @returns whether one more attempt may be made.
 */
function isRetryableAuditWrite(error) {
    if (error instanceof DomainError)
        return error.code !== 'closed' && error.code !== 'missing-key';
    return true;
}
/**
 * Run one durable audit write with a bounded retry.
 *
 * The write itself stays unconditional — the storage contract exposes no
 * compare-and-swap (B1's `blocked-specific-api` gap), so this is availability,
 * not conflict detection: a failure that survives the retry propagates to the
 * caller, which reports it and keeps classifying from the Session log.
 * @param write - the write to attempt.
 * @returns the write's value.
 * @throws the last rejection when every attempt failed.
 */
async function withAuditWriteRetry(write) {
    for (let attempt = 0;; attempt += 1) {
        try {
            return await write();
        }
        catch (error) {
            if (attempt + 1 >= TOOL_GROUP_AUDIT_WRITE_ATTEMPTS || !isRetryableAuditWrite(error))
                throw error;
        }
    }
}
export async function openToolGroupAuditStore(ctx) {
    const domain = await ctx.storageDomain.open(toolGroupAuditDomainSpec);
    const table = domain.table('audit');
    return {
        open: record => withAuditWriteRetry(() => table.put(record.requestId, record)),
        finish: (requestId, update) => withAuditWriteRetry(async () => { await table.update(requestId, update); }),
        recordsForSession: (sessionId, createdAt) => [...table.entries()].map(([, record]) => record).filter(record => record.sessionId === sessionId
            && createdAt !== undefined
            && record.lifecycle?.createdAt === createdAt),
        close: () => domain.close(),
    };
}
//# sourceMappingURL=tool-group-audit-store.js.map