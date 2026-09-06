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
import z from '@deepseek-ai/schemastery';
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction';
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { assertNever } from '@deepseek-ai/dsh-util-values';
import { randomUUID } from 'node:crypto';
import { selectToolGroups } from "./internal/compaction/tool-groups.js";
import { summarizeToolGroup, ToolGroupSummaryFallbackError } from "./internal/compaction/tool-group-summarizer.js";
import { replaceToolGroup } from "./internal/compaction/tool-group-replacement.js";
import { assertToolGroupCommitStable, contentDigest, finishToolGroupAudit, openToolGroupAudit, recoverableOpenAuditFor, successfulAuditFor, toolGroupFingerprint } from "./internal/compaction/tool-group-audit.js";
import { openToolGroupAuditStore } from "./internal/compaction/tool-group-audit-store.js";
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy, TargetPressureConfigError, } from "./internal/compaction/config.js";
import { assertNoActiveCompaction, compactSurfaceRegion, selectCompactableRange, splitRetainedTail, } from "./internal/compaction/region.js";
import { summarizeWithLlm } from "./internal/compaction/summarizer.js";
/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(session) {
    const config = session.requestHeader()?.config;
    if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
        return undefined;
    }
    return { provider: config.provider, model: config.model };
}
/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(agent) {
    const routed = routedTarget(agent.session);
    if (routed !== undefined)
        return routed;
    if (agent.options.provider === undefined || agent.options.provider.length === 0
        || agent.options.model === undefined || agent.options.model.length === 0)
        return undefined;
    return { provider: agent.options.provider, model: agent.options.model };
}
const thresholdRatioSchema = z.number();
const retainRatioSchema = z.number();
const retainTokensSchema = z.number().step(1).min(0);
const summarizationProviderSchema = z.string();
const summarizationModelSchema = z.string();
const maxTokensSchema = z.number().step(1).min(1);
const compactionRetriesSchema = z.number().step(1).min(0);
const maxOverflowRetriesSchema = z.number().step(1).min(0);
const modelPolicy = z.object({
    provider: z.string().required(),
    model: z.string().required(),
    thresholdRatio: thresholdRatioSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
});
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
export class BasicCompactionEngine extends CompactionEngine {
    static inject = ['llm', 'tokenMeter', 'sessions'];
    static Config = z.object({
        thresholdRatio: thresholdRatioSchema,
        retainRatio: retainRatioSchema,
        retainTokens: retainTokensSchema,
        summarizationProvider: summarizationProviderSchema,
        summarizationModel: summarizationModelSchema,
        maxTokens: maxTokensSchema,
        compactionRetries: compactionRetriesSchema,
        maxOverflowRetries: maxOverflowRetriesSchema,
        modelPolicies: z.array(modelPolicy),
        auto: z.boolean(),
        toolGroupSummarizer: z.object({
            enabled: z.boolean(),
            minGroupResults: z.number().step(1).min(1),
            minGroupChars: z.number().step(1).min(1),
            minGroupTokens: z.number().step(1).min(1),
            maxGroupTokens: z.number().step(1).min(1),
            maxGroupsPerPass: z.number().step(1).min(1),
            maxSummaryTokens: z.number().step(1).min(1),
        }),
    });
    /** Resolved and validated compaction configuration. */
    config;
    warnedPressureConfigTargets = new Set();
    overflowRetries = new WeakMap();
    overflowAgents = new WeakMap();
    toolGroupAuditStore;
    toolGroupAuditStorePromise;
    constructor(ctx, config = {}) {
        super(ctx);
        this.config = resolveConfig(config);
        this.toolGroupAuditStorePromise = openToolGroupAuditStore(ctx).then(store => {
            this.toolGroupAuditStore = store;
        }).catch(error => {
            this.toolGroupAuditStorePromise = undefined;
            ctx.logger.warn(`tool-group summarization audit disabled: ${error instanceof Error ? error.message : String(error)}`);
        });
        ctx.effect(() => async () => {
            await this.toolGroupAuditStorePromise;
            await this.toolGroupAuditStore?.close();
            this.toolGroupAuditStore = undefined;
        }, 'tool-group-summary.audit-store');
        if (this.config.auto)
            this._registerAutomaticCompaction();
    }
    /**
     * Register automatic between-step pressure and model-request overflow
     * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
     * overrides are honored at event time.
     */
    _registerAutomaticCompaction() {
        const { ctx } = this;
        const logResult = (result, trigger) => {
            ctx.logger.info(`compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
                + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
                + `~${result.shadowedTokenCount} tokens)`);
        };
        ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
            if (!signal.aborted) {
                try {
                    const result = await this.compactIfNeeded(agent, 'pressure', signal);
                    if (result !== null)
                        logResult(result, 'step pressure');
                }
                catch (error) {
                    if (error instanceof TargetPressureConfigError) {
                        if (this.warnedPressureConfigTargets.has(error.targetKey))
                            return next();
                        this.warnedPressureConfigTargets.add(error.targetKey);
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`);
                }
            }
            return next();
        });
        ctx.on('agent/status', ({ agent, status }) => {
            if (status === 'idle')
                this.overflowRetries.delete(agent);
        });
        // A successful response starts a fresh overflow-recovery sequence even
        // when tool calls continue the same turn into another request.
        ctx.on('session/event', (session, event) => {
            if (event.type !== 'assistant/message')
                return;
            const agent = this.overflowAgents.get(session);
            if (agent !== undefined)
                this.overflowRetries.delete(agent);
        });
        ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
            if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted)
                return next();
            this.overflowAgents.set(agent.session, agent);
            const target = routedTarget(agent.session);
            if (target === undefined)
                return next();
            const policy = resolveTargetPolicy(this.config, target);
            const retries = this.overflowRetries.get(agent) ?? 0;
            if (retries >= policy.maxOverflowRetries)
                return next();
            const generation = agent.session.surface.replaceGeneration;
            let result;
            try {
                result = await this.compactIfNeeded(agent, 'context-overflow', signal);
            }
            catch (recoveryError) {
                const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
                // A model-free prune can land before later summary work fails. That
                // durable reduction is sufficient retry proof; do not discard it just
                // because the optional second phase threw. Cancellation still wins.
                // The signal can abort while recovery is awaited.
                if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
                    ctx.logger.warn(`context-overflow compaction failed after durable surface progress: ${message}; `
                        + 'retrying from the replacement surface');
                    this.overflowRetries.set(agent, retries + 1);
                    return { kind: 'retry' };
                }
                ctx.logger.warn(
                // The signal can abort while recovery is awaited.
                `context-overflow compaction failed: ${message}; ${signal.aborted
                    ? 'cancellation prevents retry'
                    : 'preserving the original request error'}`);
                return next();
            }
            // The signal can abort while compaction is awaited.
            if (signal.aborted
                || agent.session.surface.replaceGeneration <= generation)
                return next();
            if (result !== null)
                logResult(result, 'context overflow recovery');
            this.overflowRetries.set(agent, retries + 1);
            return { kind: 'retry' };
        });
    }
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
    async summarize(input, agent, signal) {
        const target = conversationTarget(agent);
        const config = target === undefined
            ? this.config
            : resolveTargetPolicy(this.config, target);
        return summarizeWithLlm(this.ctx, config, input, agent, signal);
    }
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
    async compactIfNeeded(agent, trigger, signal) {
        const target = routedTarget(agent.session);
        if (target === undefined)
            return null;
        const policy = resolveTargetPolicy(this.config, target);
        const meter = this.ctx.tokenMeter;
        let measurement = meter.measure(agent.session);
        switch (trigger) {
            case 'context-overflow':
                break;
            case 'pressure':
                break;
            /* Closed-union exhaustiveness guard */
            default:
                assertNever(trigger, 'compaction trigger');
        }
        // Pruning is optional so compaction-basic remains independently composable.
        // Overflow always qualifies; pressure first resolves the routed model's
        // capacity and checks its target-specific threshold.
        const prune = this.ctx.get('toolResultPruner');
        if (trigger === 'context-overflow') {
            if (prune !== undefined) {
                prune.pruneSession(agent.session);
                measurement = meter.measure(agent.session);
            }
            // Overflow recovery keeps whole-surface pruning and opts out of the
            // empty-benefit guard: its retry depends on advancing the surface, and
            // re-compacting an isolated checkpoint is that path's last deterministic
            // reduction (the non-shrink assertion still guards growth).
            const range = selectCompactableRange(agent.session, measurement, 0, false);
            if (range === null)
                return null;
            return this.compactRegion(range.start, range.end, agent, signal);
        }
        const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;
        assertNoActiveCompaction(agent.session, 'automatic pressure compaction');
        const targetKey = `${target.provider}/${target.model}`;
        if (context === undefined) {
            throw new TargetPressureConfigError(targetKey, `compaction-basic: no context capacity for ${targetKey}; `
                + 'configure contextWindow on that adapter model');
        }
        const spec = resolveCompactSpec(policy, context.contextWindow);
        if (measurement.totalTokens < spec.thresholdTokens)
            return null;
        // Once pressure qualifies, derive the retained-tail boundary from the same
        // resolved retention used for global compaction and reduce only the older
        // head outside it: recent results stay at high fidelity unless the pruner's
        // own experimental hard limit forces one down. With no older head the prune
        // call still consults that hard limit, then remeasure through the singleton
        // replay fold and stop when the deterministic reduction cleared pressure.
        if (prune !== undefined) {
            let split = splitRetainedTail(agent.session, measurement, spec.retainTokens);
            await this.summarizeToolGroups(agent, target, policy, split.olderRange, signal);
            measurement = meter.measure(agent.session);
            split = splitRetainedTail(agent.session, measurement, spec.retainTokens);
            prune.pruneSession(agent.session, { olderRange: split.olderRange });
            measurement = meter.measure(agent.session);
        }
        if (measurement.totalTokens < spec.thresholdTokens)
            return null;
        let result = null;
        for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
            const range = selectCompactableRange(agent.session, measurement, spec.retainTokens);
            if (range === null) {
                // Either the whole surface is retained (nothing older to reduce) or the
                // guard rejected an isolated checkpoint head. A first-pass null means
                // deterministic reduction already cleared pressure; a post-success null
                // means the replacement checkpoint is the only remaining head, so any
                // further model call would be an empty-benefit pass and the bounded
                // convergence throw below reports the shortfall.
                if (result === null)
                    return null;
                break;
            }
            result = await this.compactRegion(range.start, range.end, agent, signal);
            measurement = meter.measure(agent.session);
            if (measurement.totalTokens < spec.thresholdTokens)
                return result;
        }
        throw new Error(`compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
            + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);
    }
    async summarizeToolGroups(agent, target, policy, olderRange, signal) {
        const config = this.config.toolGroupSummarizer;
        if (!config.enabled || olderRange === null)
            return;
        await this.toolGroupAuditStorePromise;
        const store = this.toolGroupAuditStore;
        if (store === undefined)
            return;
        const session = agent.session;
        const groups = selectToolGroups(session, {
            olderRange,
            minGroupResults: config.minGroupResults,
            minGroupChars: config.minGroupChars,
            minGroupTokens: config.minGroupTokens,
            maxGroupTokens: config.maxGroupTokens,
            maxGroups: config.maxGroupsPerPass,
            estimateTokens: event => event.type === 'tool/result' || event.type === 'assistant/message'
                ? this.ctx.tokenMeter.estimateMessage(event.data.message)
                : 0,
        });
        for (const group of groups) {
            const events = group.sourceSeqs.map(seq => session.eventAt(seq));
            const digest = contentDigest(events.map(event => JSON.stringify(event)));
            const fingerprint = toolGroupFingerprint({
                lifecycle: { sessionId: session.id },
                sourceSeqs: group.sourceSeqs,
                callIds: group.callIds,
                eventTypes: events.map(event => event?.type ?? 'missing'),
                contentDigest: digest,
                schemaVersion: 1,
            });
            const records = store.recordsForSession(session.id);
            if (successfulAuditFor(records, fingerprint) !== undefined)
                continue;
            const priorOpen = recoverableOpenAuditFor(records, fingerprint);
            const requestId = priorOpen?.requestId ?? `tg-${randomUUID()}`;
            const open = priorOpen ?? openToolGroupAudit(requestId, session.id, group, session.surface.replaceGeneration, policy.summarizationProvider || target.provider, policy.summarizationModel || target.model, fingerprint);
            try {
                if (priorOpen === undefined)
                    await store.open(open);
                const result = await summarizeToolGroup(this.ctx, session, group, agent, { provider: open.provider, model: open.model, maxTokens: config.maxSummaryTokens }, signal);
                assertToolGroupCommitStable(session.id, session.surface.replaceGeneration, group.sourceSeqs, open);
                const replacement = replaceToolGroup(session, group, result.summary);
                await store.finish(requestId, current => finishToolGroupAudit(current, 'success', { rawOutput: result.rawOutput, summary: result.summary, replacementSeqs: replacement.replacementSeqs }));
            }
            catch (error) {
                const reason = error instanceof ToolGroupSummaryFallbackError ? error.reason : 'failure';
                const message = error instanceof Error ? error.message : String(error);
                try {
                    await store.finish(requestId, current => finishToolGroupAudit(current, reason === 'failure' ? 'failure' : 'fallback', { error: message }));
                }
                catch (auditError) {
                    this.ctx.logger.warn(`tool-group summary audit finish failed: ${auditError instanceof Error ? auditError.message : String(auditError)}`);
                }
            }
        }
    }
    /**
     * Compact one inclusive positional range from the agent-owned surface using
     * the effective token meter for all retention and shrink pricing.
     * @param start - inclusive first surface-node seq.
     * @param end - inclusive last surface-node seq.
     * @param agent - owner of the target session, used by the summarizer.
     * @param signal - optional summarization cancellation signal.
     * @returns the successful durable compaction result.
     */
    async compactRegion(start, end, agent, signal) {
        return compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, agent, { owner: 'current-turn', stability: 'whole-surface' }, signal);
    }
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
    compactNow(agent, signal, sourceCommandId) {
        signal.throwIfAborted();
        try {
            return agent.runMaintenance(async (agentSignal) => {
                const operationSignal = AbortSignal.any([agentSignal, signal]);
                try {
                    operationSignal.throwIfAborted();
                    // The durable compaction lock outranks range selection so a live
                    // unmatched marker reports busy even when the head is an isolated
                    // checkpoint the empty-benefit guard would otherwise decline.
                    assertNoActiveCompaction(agent.session, 'manual compaction');
                    const range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0);
                    if (range === null)
                        return null;
                    return await compactSurfaceRegion(this.regionDependencies(), agent.session, range.start, range.end, agent, {
                        owner: null,
                        stability: 'selected-span',
                        ...sourceCommandId === undefined ? {} : { sourceCommandId },
                        flush: async () => {
                            await this.ctx.sessions.flush(agent.session);
                        },
                    }, operationSignal);
                }
                catch (error) {
                    if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
                        throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error });
                    }
                    operationSignal.throwIfAborted();
                    throw error;
                }
            });
        }
        catch (error) {
            throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error });
        }
    }
    /** Bind the effective token meter and dynamically dispatched summarizer hook. */
    regionDependencies() {
        return {
            meter: this.ctx.tokenMeter,
            summarize: (input, owner, abort) => this.summarize(input, owner, abort),
        };
    }
}
export default BasicCompactionEngine;
//# sourceMappingURL=compaction-basic.js.map