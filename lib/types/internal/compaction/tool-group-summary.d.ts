import type { SessionSeq } from '@deepseek-ai/dsh-session/types';
import type { ToolGroup } from './tool-groups.ts';
import type { SessionRead } from './tool-pairing.ts';
export declare const TOOL_GROUP_SUMMARY_VERSION: 1;
export interface ToolGroupSummaryItem {
    readonly sourceSeq: number;
    readonly callId?: string;
    readonly summary: string;
    readonly facts: readonly string[];
    readonly files: readonly string[];
    readonly identifiers: readonly string[];
    readonly errors: readonly string[];
    readonly unresolved: readonly string[];
}
export interface ToolGroupSummary {
    readonly version: typeof TOOL_GROUP_SUMMARY_VERSION;
    readonly groupSummary: string;
    readonly items: readonly ToolGroupSummaryItem[];
    readonly groupErrors: readonly string[];
    readonly unresolved: readonly string[];
}
export interface ToolGroupSummaryInputItem {
    readonly sourceSeq: SessionSeq;
    readonly callId?: string;
    readonly role: 'tool-call' | 'tool-result';
    readonly content: string;
}
export interface ToolGroupSummaryInput {
    readonly version: typeof TOOL_GROUP_SUMMARY_VERSION;
    readonly group: ToolGroup;
    readonly items: readonly ToolGroupSummaryInputItem[];
}
export declare function buildToolGroupSummaryInput(session: SessionRead, group: ToolGroup): ToolGroupSummaryInput;
export declare function parseToolGroupSummary(value: unknown, input: ToolGroupSummaryInput): ToolGroupSummary;
//# sourceMappingURL=tool-group-summary.d.ts.map