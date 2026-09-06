import z from 'zod';
import type { SessionSeq } from '@deepseek-ai/dsh-session/types';
import type { ToolGroupAuditRecord } from './tool-group-audit.ts';
export declare const toolGroupAuditSchema: z.ZodType<ToolGroupAuditRecord>;
export declare const toolGroupAuditDomainSpec: {
    name: string;
    version: number;
    layout: "single";
    tables: {
        audit: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, ToolGroupAuditRecord>;
    };
};
export declare function recordsForSession(records: readonly ToolGroupAuditRecord[], sessionId: string, createdAt?: number): ToolGroupAuditRecord[];
export declare function recordSourceSeqs(record: ToolGroupAuditRecord): readonly SessionSeq[];
//# sourceMappingURL=tool-group-domain.d.ts.map