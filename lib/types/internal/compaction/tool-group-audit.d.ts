import type { SessionSeq } from '@deepseek-ai/dsh-session/types';
import type { ToolGroup } from './tool-groups.ts';
import type { ToolGroupSummary } from './tool-group-summary.ts';
export type ToolGroupAuditStatus = 'open' | 'success' | 'fallback' | 'failure';
export interface ToolGroupFingerprintInput {
    readonly lifecycle: {
        readonly sessionId: string;
        readonly createdAt?: number;
    };
    readonly sourceSeqs: readonly SessionSeq[];
    readonly callIds: readonly string[];
    readonly eventTypes: readonly string[];
    readonly contentDigest: string;
    readonly schemaVersion: number;
}
export interface ToolGroupAuditRecord {
    readonly requestId: string;
    readonly sessionId: string;
    readonly lifecycle?: {
        readonly createdAt?: number;
    };
    readonly fingerprint: string;
    readonly sourceSeqs: readonly SessionSeq[];
    readonly surfaceGeneration: number;
    readonly provider: string;
    readonly model: string;
    readonly schemaVersion: number;
    readonly status: ToolGroupAuditStatus;
    readonly rawOutput?: unknown;
    readonly summary?: ToolGroupSummary;
    readonly replacementSeqs?: readonly SessionSeq[];
    readonly error?: string;
}
export declare function toolGroupFingerprint(input: ToolGroupFingerprintInput): string;
export declare function contentDigest(parts: readonly string[]): string;
export declare function openToolGroupAudit(requestId: string, sessionId: string, group: ToolGroup, surfaceGeneration: number, provider: string, model: string, fingerprint: string): ToolGroupAuditRecord;
export declare function finishToolGroupAudit(record: ToolGroupAuditRecord, status: Exclude<ToolGroupAuditStatus, 'open'>, patch?: Pick<ToolGroupAuditRecord, 'rawOutput' | 'summary' | 'replacementSeqs' | 'error'>): ToolGroupAuditRecord;
export declare function successfulAuditFor(records: readonly ToolGroupAuditRecord[], fingerprint: string): ToolGroupAuditRecord | undefined;
export declare function recoverableOpenAuditFor(records: readonly ToolGroupAuditRecord[], fingerprint: string): ToolGroupAuditRecord | undefined;
export declare function assertToolGroupCommitStable(sessionId: string, currentGeneration: number, currentSourceSeqs: readonly SessionSeq[], record: ToolGroupAuditRecord): void;
//# sourceMappingURL=tool-group-audit.d.ts.map