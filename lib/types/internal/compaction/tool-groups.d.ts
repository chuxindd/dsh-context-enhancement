import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session/types';
import type { SessionRead } from './tool-pairing.ts';
/** A conservative, surface-positioned group of related tool/result nodes. */
export interface ToolGroup {
    readonly sourceSeqs: readonly SessionSeq[];
    readonly toolResultSeqs: readonly SessionSeq[];
    readonly callIds: readonly string[];
    readonly startSeq: SessionSeq;
    readonly endSeq: SessionSeq;
    readonly estimatedTokens: number;
    readonly startPosition: number;
    readonly endPosition: number;
    readonly turn: number;
}
export interface ToolGroupSelectionOptions {
    readonly olderRange?: {
        readonly start: SessionSeq;
        readonly end: SessionSeq;
    } | null;
    readonly minGroupResults?: number;
    readonly minGroupChars?: number;
    readonly minGroupTokens?: number;
    readonly maxGroupTokens?: number;
    readonly maxGroups?: number;
    readonly estimateTokens?: (event: SessionEvent) => number;
    readonly measureText?: (event: SessionEvent<'tool/result'>) => number;
}
/** Find qualifying complete tool groups in current surface order. */
export declare function selectToolGroups(session: SessionRead, options?: ToolGroupSelectionOptions): ToolGroup[];
//# sourceMappingURL=tool-groups.d.ts.map