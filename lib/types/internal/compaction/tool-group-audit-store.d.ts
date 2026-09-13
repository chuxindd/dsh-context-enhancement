import type { Context } from '@deepseek-ai/cordis';
import type { ToolGroupAuditRecord } from './tool-group-audit.ts';
export interface ToolGroupAuditStore {
    readonly open: (record: ToolGroupAuditRecord) => Promise<void>;
    readonly finish: (requestId: string, update: (record: ToolGroupAuditRecord) => ToolGroupAuditRecord) => Promise<void>;
    readonly recordsForSession: (sessionId: string, createdAt?: number) => readonly ToolGroupAuditRecord[];
    readonly close: () => Promise<void>;
}
/** Write attempts one audit write spends before it reports failure to its caller. */
export declare const TOOL_GROUP_AUDIT_WRITE_ATTEMPTS = 2;
export declare function openToolGroupAuditStore(ctx: Context): Promise<ToolGroupAuditStore>;
//# sourceMappingURL=tool-group-audit-store.d.ts.map