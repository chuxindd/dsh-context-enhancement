import z from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ToolGroupAuditRecord } from './tool-group-audit.ts'

const nonNegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const nonEmpty = z.string().min(1).refine(value => value.trim() === value)
// `aborted` (an attempt that ended without a proven landing, recovered by a
// later instance) and `repaired` (a landing proven by Session provenance after
// the attempt was gone) complete the B6.2 state machine. Every field B6.2 adds
// is optional, so a document written before it still validates here; the domain
// version deliberately stays 1, because bumping it would reject every existing
// document at open (`version-mismatch`) and disable the audit outright.
const status = z.enum(['open', 'success', 'fallback', 'failure', 'aborted', 'repaired'])

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
  attempt: nonNegative.optional(),
  ownerId: nonEmpty.optional(),
  recoveredFrom: status.optional(),
  diagnostic: nonEmpty.optional(),
  repairEvidence: z.array(nonNegative).optional(),
}).strict() as unknown as z.ZodType<ToolGroupAuditRecord>

export const toolGroupAuditDomainSpec = defineDomain({
  name: 'context_enhancement_tool_group_summary',
  version: 1,
  layout: 'single',
  tables: {
    audit: domainTable<string, ToolGroupAuditRecord>(toolGroupAuditSchema),
  },
})

export function recordsForSession(
  records: readonly ToolGroupAuditRecord[],
  sessionId: string,
  createdAt?: number,
): ToolGroupAuditRecord[] {
  return records.filter(record => record.sessionId === sessionId
    && createdAt !== undefined
    && record.lifecycle?.createdAt === createdAt)
}

export function recordSourceSeqs(record: ToolGroupAuditRecord): readonly SessionSeq[] {
  return record.sourceSeqs
}
