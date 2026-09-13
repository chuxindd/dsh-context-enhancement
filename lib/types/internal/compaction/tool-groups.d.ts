import type { ContentBlock } from '@deepseek-ai/dsh-llm';
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
    /**
     * Classify one tool result as still eligible for selection — an original,
     * never-replaced result. A candidate run that mixes eligible and ineligible
     * results is split at safe step/pair boundaries and only its all-eligible
     * sub-spans are returned, so an already-summarized sibling never hides the raw
     * originals beside it. Defaults to treating every result as eligible.
     */
    readonly isEligibleResult?: (seq: SessionSeq) => boolean;
    /**
     * Validate whether one candidate group fits the auxiliary request budget.
     * When provided, groups whose complete serialized request (instruction +
     * JSON overhead + generation reserve) exceeds the input cap are rejected.
     */
    readonly isGroupFittable?: ((group: ToolGroup) => boolean) | undefined;
}
/** Find qualifying complete tool groups in current surface order. */
export declare function selectToolGroups(session: SessionRead, options?: ToolGroupSelectionOptions): ToolGroup[];
/**
 * The shared production-default text metric for one tool-result MESSAGE's
 * content: Unicode code points across EVERY `text` block — message-level text
 * blocks and the text blocks nested in each `tool-result` block alike.
 *
 * Group selection must qualify on the same measure the deterministic pruning
 * threshold uses. Counting the ContentBlock ARRAY LENGTH instead made
 * `minGroupChars` a block count no real group could ever satisfy, and counting
 * only the first content block hid the later text of a multi-block result from
 * the pending-work probe that the deterministic pruner would still reduce.
 * @param content - the message-level content blocks of one tool result.
 * @returns total Unicode code points across every text block.
 */
export declare function toolResultTextLength(content: readonly ContentBlock[]): number;
//# sourceMappingURL=tool-groups.d.ts.map