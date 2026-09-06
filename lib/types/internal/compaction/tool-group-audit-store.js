import { toolGroupAuditDomainSpec } from "./tool-group-domain.js";
export async function openToolGroupAuditStore(ctx) {
    const domain = await ctx.storageDomain.open(toolGroupAuditDomainSpec);
    const table = domain.table('audit');
    return {
        open: record => table.put(record.requestId, record),
        finish: async (requestId, update) => { await table.update(requestId, update); },
        recordsForSession: sessionId => [...table.entries()].map(([, record]) => record).filter(record => record.sessionId === sessionId),
        close: () => domain.close(),
    };
}
//# sourceMappingURL=tool-group-audit-store.js.map