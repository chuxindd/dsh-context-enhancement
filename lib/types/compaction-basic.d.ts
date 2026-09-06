/**
 * `dsh-context-enhancement` — `./compaction-basic` subpath entry.
 *
 * A replacement for the official `@deepseek-ai/dsh-compaction-basic` backend
 * provider, delivered from this standalone root package. It does NOT
 * re-declare `ctx.compaction`: the default-exported class extends the official
 * rc1 {@link CompactionEngine} Service Definition consumed from the published
 * `@deepseek-ai/dsh-compaction` package, so the Loader recognizes it as the
 * `compaction` service provider. The official rc1 behavior and Config
 * vocabulary are preserved exactly; the Card5/6 region-aware migration delta
 * is folded in (see the internal module provenance headers). The optional
 * `ctx.toolResultPruner` pruning companion is this package's own
 * `./tool-result-pruner` service — compaction-basic and the pruner are mounted
 * in the same preset isolate realm and must not have two providers.
 *
 * Only the published rc1 exports of the official packages are imported; the
 * rc1 `src/*` subpaths are not a stable third-party API. The internal
 * implementation files under `src/internal/compaction/` are local MIT copies
 * (with provenance headers) of the official rc1 backend sources.
 *
 * @module dsh-context-enhancement/compaction-basic
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import type { SessionSeq } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import type { SummarizationInput, SummaryResult } from './internal/compaction/summarizer.ts';
import type { BasicCompactionConfig, ResolvedConfig } from './internal/compaction/types.ts';
export type { BasicCompactionConfig, CompactionPolicyConfig, ModelCompactPolicyConfig, ResolvedCompactSpec, ResolvedConfig, ResolvedRetention, ResolvedTargetPolicy, } from './internal/compaction/types.ts';
/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing. Extends the
 * official rc1 {@link CompactionEngine}, preserving official behavior and
 * Config while adding the Card5/6 region-aware passes: retention-aware older
 * pruning, the recursive empty-benefit guard on the old-summary head, and the
 * overflow opt-out that re-compacts an isolated checkpoint as the last
 * deterministic reduction.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export declare class BasicCompactionEngine extends CompactionEngine {
    static inject: string[];
    static Config: z<BasicCompactionConfig>;
    /** Resolved and validated compaction configuration. */
    readonly config: ResolvedConfig;
    private readonly warnedPressureConfigTargets;
    private readonly overflowRetries;
    private readonly overflowAgents;
    private toolGroupAuditStore;
    private toolGroupAuditStorePromise;
    constructor(ctx: Context, config?: BasicCompactionConfig);
    /**
     * Register automatic between-step pressure and model-request overflow
     * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
     * overrides are honored at event time.
     */
    private _registerAutomaticCompaction;
    /**
     * Summarize the replayed conversation region through a direct one-shot
     * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
     * prompt, tools, and messages so the provider's KV cache is not invalidated.
     * Override this sole hook for a template or remote summarizer.
     * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
     * @param agent - supplies routed-model history, fallback model, and session id.
     * @param signal - optional cancellation forwarded to the adapter.
     * @returns safe text summary blocks and the exact auxiliary call envelope and output.
     */
    protected summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>;
    /**
     * Compact for replayed step-boundary pressure or one provider-confirmed context
     * overflow. Both triggers price the latest durable routed request envelope;
     * overflow bypasses the normal threshold and retained-tail policy so it can
     * force one useful balanced reduction. Pressure first prunes only the older
     * head outside the retained tail (region-aware), remeasures, and stops early
     * when the deterministic reduction cleared pressure.
     * @param agent - agent whose latest durable routed request is measured.
     * @param trigger - normal step-boundary pressure or context-overflow recovery.
     * @param signal - live turn cancellation signal forwarded to summarization.
     * @returns the latest summary compaction result, or `null` when no summary ran.
     */
    compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>;
    /** Record why an above-threshold pressure pass could not continue safely. */
    private logPressureStop;
    /** Rebuild source types from Session provenance and durable successful audits. */
    private sourceIndex;
    /** Rebuild the durable fingerprint used to classify one selected tool group. */
    private toolGroupFingerprint;
    /** Whether a forget batch still contains raw content owed an intermediate tool pass. */
    private hasPendingToolIntermediateWork;
    /** Derive current zones from one fresh meter snapshot and the routed capacity. */
    private zones;
    /**
     * Overflow is the only path allowed to relax normal zones. It first prunes
     * provenance-indexed original results, then progresses oldest-first through
     * forget, tool, and recent ranges. No custom SessionEventMap entry is needed:
     * each reduction uses the official compaction/prune or compaction transaction.
     */
    private recoverOverflow;
    private summarizeToolGroups;
    /**
     * Compact one inclusive positional range from the agent-owned surface using
     * the effective token meter for all retention and shrink pricing.
     * @param start - inclusive first surface-node seq.
     * @param end - inclusive last surface-node seq.
     * @param agent - owner of the target session, used by the summarizer.
     * @param signal - optional summarization cancellation signal.
     * @returns the successful durable compaction result.
     */
    compactRegion(start: SessionSeq, end: SessionSeq, agent: Agent, signal?: AbortSignal): Promise<CompactionResult>;
    /**
     * Force one useful idle-session compaction below the pressure threshold, and
     * resolve only after its standalone marker pair is durably checkpointed. The
     * durable compaction lock is rechecked before range selection so a live
     * unmatched marker reports busy even when the only remaining head is an
     * isolated checkpoint the empty-benefit guard would otherwise decline.
     * @param agent - idle agent whose next-turn admission this call reserves.
     * @param signal - cancellation scoped to this compaction request.
     * @param sourceCommandId - initiating command identity for presentation correlation.
     * @returns the committed result, or `null` when no safe useful range exists.
     */
    compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
    /** Bind the effective token meter and dynamically dispatched summarizer hook. */
    private regionDependencies;
}
export default BasicCompactionEngine;
//# sourceMappingURL=compaction-basic.d.ts.map