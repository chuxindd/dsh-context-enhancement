import z from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
const nonNegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nonEmpty = z.string().min(1).refine(value => value.trim() === value);
const status = z.enum(['open', 'success', 'fallback', 'failure']);
export const toolGroupAuditSchema = z.object({
    requestId: nonEmpty,
    sessionId: nonEmpty,
    lifecycle: z.object({ createdAt: nonNegative }).partial().optional(),
    fingerprint: nonEmpty,
    sourceSeqs: z.array(nonNegative),
    surfaceGeneration: nonNegative,
    provider: nonEmpty,
    model: nonEmpty,
    schemaVersion: nonNegative,
    status,
    rawOutput: z.unknown().optional(),
    summary: z.unknown().optional(),
    replacementSeqs: z.array(nonNegative).optional(),
    error: z.string().optional(),
}).strict();
export const toolGroupAuditDomainSpec = defineDomain({
    name: 'context_enhancement_tool_group_summary',
    version: 1,
    layout: 'single',
    tables: {
        audit: domainTable(toolGroupAuditSchema),
    },
});
export function recordsForSession(records, sessionId) {
    return records.filter(record => record.sessionId === sessionId);
}
export function recordSourceSeqs(record) {
    return record.sourceSeqs;
}
//# sourceMappingURL=tool-group-domain.js.map