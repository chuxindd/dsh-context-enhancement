import z from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ToolGroupAuditRecord } from './tool-group-audit.ts'

const nonNegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const nonEmpty = z.string().min(1).refine(value => value.trim() === value)
const status = z.enum(['open', 'success', 'fallback', 'failure'])

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
