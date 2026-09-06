import type { Context } from '@deepseek-ai/cordis';
import type { ToolGroupAuditRecord } from './tool-group-audit.ts';
export interface ToolGroupAuditStore {
    readonly open: (record: ToolGroupAuditRecord) => Promise<void>;
    readonly finish: (requestId: string, update: (record: ToolGroupAuditRecord) => ToolGroupAuditRecord) => Promise<void>;
    readonly recordsForSession: (sessionId: string) => readonly ToolGroupAuditRecord[];
    readonly close: () => Promise<void>;
}
export declare function openToolGroupAuditStore(ctx: Context): Promise<ToolGroupAuditStore>;
//# sourceMappingURL=tool-group-audit-store.d.ts.map