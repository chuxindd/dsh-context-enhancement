/**
 * Surface retention selection and the shared log-recorded compaction
 * transaction for the `dsh-context-enhancement` basic compaction backend,
 * re-implemented from the MIT-licensed official rc1 source with the Card5/6
 * region-aware migration delta folded in.
 *
 * SOURCE: local copy of the official rc.1 `dsh-compaction-basic`
 * `src/region.ts` (MIT, tag 0.1.2-rc.1 of `deepseek-harness`) plus the
 * Card5/6 working-tree delta of the same file (`splitRetainedTail`, the
 * `olderRange` split consumed by the region-aware pruner pass, and the
 * recursive empty-benefit guard wired into range selection). The
 * `isIsolatedOldSummaryRange` guard and the pairing predicates are imported
 * from the local pure leaves under `./` instead of the official package root.
 * Only the published rc1 exports of the official packages are consumed.
 * Provenance is recorded in THIRD_PARTY_NOTICES.md.
 *
 * @module dsh-context-enhancement/internal/compaction/region
 */
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SummarizationInput, SummaryResult } from './summarizer.ts';
interface RegionDependencies {
    readonly meter: TokenMeter;
    summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>;
}
/**
 * The retained-tail boundary and the surface span before it, derived from one
 * priced snapshot: an older head eligible for deterministic reduction and
 * semantic compaction, and the recent tail kept verbatim.
 */
interface RetainedTailSplit {
    /** Surface position of the retained tail's first node. */
    readonly keepFromIdx: number;
    /** Current-surface seq of the older head's last node, when a head exists. */
    readonly cutoffSeq: SessionSeq | undefined;
    /** Inclusive older-head seq range in surface order; `null` when every node is retained. */
    readonly olderRange: {
        start: SessionSeq;
        end: SessionSeq;
    } | null;
    /** Older head node seqs in surface order, empty when every node is retained. */
    readonly olderSeqs: readonly SessionSeq[];
}
interface CompactionTransactionOptions {
    /** `current-turn` derives a numbered owner; `null` writes a standalone bracket. */
    readonly owner: 'current-turn' | null;
    /** Surface relationship that must survive asynchronous summarization. */
    readonly stability: 'whole-surface' | 'selected-span';
    /** Optional durability checkpoint after a successfully closed bracket. */
    readonly flush?: () => Promise<void>;
    /** Manual command that initiated this transaction, when present. */
    readonly sourceCommandId?: CommandId;
}
/**
 * Resolve the retained-tail boundary and the older head span before it from one
 * priced snapshot, rounding the boundary head-ward to a balanced tool-pair cut
 * so a call/result pair is never split. The span's `start`/`end` seqs are the
 * current-surface first/last nodes of the older head in surface order; when
 * surface replacements made the visible seqs non-monotonic, `start` may be
 * numerically larger than `end` and the range is still the closed position
 * interval.
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement from the conversation meter.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @returns the retained-tail split with the older head seqs in surface order.
 */
export declare function splitRetainedTail(session: Session, measurement: TokenMeasurement, retainTokens: number): RetainedTailSplit;
/**
 * Resolve the next head-anchored range while retaining a priced recent tail,
 * never splitting an assistant tool-call/result pair. Unless the caller opts
 * out, it also rejects a head holding only old compaction summaries with no
 * non-checkpoint node, so pressure and manual compaction never spend a model
 * call on an empty-benefit pass. Overflow recovery opts out (the fourth
 * positional parameter is `false`): its retry depends on advancing the surface,
 * and re-compacting an isolated checkpoint is that path's last deterministic
 * reduction (the non-shrink assertion still guards growth).
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement from the conversation meter.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @param guardIsolatedOldSummary - reject an all-checkpoint older head. Defaults to `true`.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export declare function selectCompactableRange(session: Session, measurement: TokenMeasurement, retainTokens: number, guardIsolatedOldSummary?: boolean): {
    start: SessionSeq;
    end: SessionSeq;
} | null;
/**
 * Run the single compaction transaction over one selected positional span.
 * Selection and validation are read-only. Idle/log validation and
 * `compaction/start` are synchronously adjacent, so the durable opening marker is
 * the compaction lock before summarization yields. Every later failure makes
 * exactly one `compaction/end` attempt; a failed close deliberately leaves the
 * unmatched start detectable.
 * @param dependencies - conversation meter and dynamically dispatched summarizer hook.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @param agent - agent used by the summarizer.
 * @param options - bracket owner, stability rule, and optional durability checkpoint.
 * @param signal - optional summarization cancellation signal.
 * @returns the successful durable compaction result.
 */
export declare function compactSurfaceRegion(dependencies: RegionDependencies, session: Session, start: SessionSeq, end: SessionSeq, agent: Agent, options: CompactionTransactionOptions, signal?: AbortSignal): Promise<CompactionResult>;
/**
 * Recheck the durable compaction lock after an asynchronous policy decision.
 * @param session - session whose latest marker state is inspected.
 * @param stage - operation label included in the busy diagnostic.
 */
export declare function assertNoActiveCompaction(session: Session, stage: string): void;
export {};
//# sourceMappingURL=region.d.ts.map