import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ToolGroupAuditRecord } from './tool-group-audit.ts'
import { toolGroupAuditDomainSpec } from './tool-group-domain.ts'

export interface ToolGroupAuditStore {
  readonly open: (record: ToolGroupAuditRecord) => Promise<void>
  readonly finish: (requestId: string, update: (record: ToolGroupAuditRecord) => ToolGroupAuditRecord) => Promise<void>
  readonly recordsForSession: (sessionId: string) => readonly ToolGroupAuditRecord[]
  readonly close: () => Promise<void>
}

export async function openToolGroupAuditStore(ctx: Context): Promise<ToolGroupAuditStore> {
  const domain = await ctx.storageDomain.open(toolGroupAuditDomainSpec) as Domain<typeof toolGroupAuditDomainSpec>
  const table = domain.table('audit') as KvTable<string, ToolGroupAuditRecord>
  return {
    open: record => table.put(record.requestId, record),
    finish: async (requestId, update) => { await table.update(requestId, update) },
    recordsForSession: sessionId => [...table.entries()].map(([, record]) => record).filter(record => record.sessionId === sessionId),
    close: () => domain.close(),
  }
}
