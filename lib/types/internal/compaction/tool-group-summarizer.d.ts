import type { ContentBlock, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolGroupSummary } from './tool-group-summary.ts';
import type { ToolGroup } from './tool-groups.ts';
import type { SessionRead } from './tool-pairing.ts';
export interface ToolGroupSummaryRoute {
    readonly provider: string;
    readonly model: string;
    readonly maxTokens: number;
}
export interface ToolGroupSummaryCallResult {
    readonly summary: ToolGroupSummary;
    readonly rawOutput: readonly ContentBlock[];
    readonly usage?: TokenUsage;
    readonly provider: string;
    readonly model: string;
}
export declare class ToolGroupSummaryFallbackError extends Error {
    readonly reason: ToolGroupSummaryFailureReason;
    constructor(reason: ToolGroupSummaryFailureReason, message: string, options?: ErrorOptions);
}
export type ToolGroupSummaryFailureReason = 'route' | 'stream' | 'empty' | 'json' | 'schema' | 'source';
export declare function buildToolGroupSummaryMessage(session: SessionRead, group: ToolGroup): UserMessage;
export declare function estimateToolGroupAuxiliaryRequestTokens(session: SessionRead, group: ToolGroup, reserveTokens: number, estimateMessage: (message: UserMessage) => number): number;
export declare function summarizeToolGroup(ctx: Context, session: SessionRead, group: ToolGroup, agent: Agent, route: ToolGroupSummaryRoute, signal?: AbortSignal, inputCapTokens?: number): Promise<ToolGroupSummaryCallResult>;
//# sourceMappingURL=tool-group-summarizer.d.ts.map