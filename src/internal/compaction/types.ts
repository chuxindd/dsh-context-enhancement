/**
 * Configuration vocabulary for the `dsh-context-enhancement` basic compaction
 * backend, re-implemented from the MIT-licensed official rc1 source.
 *
 * SOURCE: local copy of the official rc.1 `dsh-compaction-basic`
 * `src/types.ts` (MIT, tag dsh-v0.1.2-rc.1 of the `deepseek-harness`
 * repository). The `compaction/*` session-event vocabulary and
 * `CompactionResult` are NOT re-declared here: this package consumes the
 * official published `@deepseek-ai/dsh-compaction` Service Definition, whose
 * root module supplies them. Only the backend's own configuration vocabulary
 * is reproduced. Provenance is recorded in THIRD_PARTY_NOTICES.md.
 *
 * @module dsh-context-enhancement/internal/compaction/types
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Legacy pressure trigger alias. When `pressureRatio` is omitted this supplies it. */
  thresholdRatio?: number
  /** Legacy recent-tail alias. When `recentRatio` is omitted this supplies it. */
  retainRatio?: number
  /** Legacy absolute recent-tail budget; mutually exclusive with retainRatio/recentRatio. */
  retainTokens?: number
  /** Recent zone boundary as a fraction of the model window. Defaults to `0.20`. */
  recentRatio?: number
  /** Forget-zone boundary as a fraction of the model window. Defaults to `0.50`. */
  forgetBoundaryRatio?: number
  /** Tool maintenance trigger as a fraction of the model window. Defaults to `0.40`. */
  toolMaintenanceRatio?: number
  /** Forget maintenance trigger as a fraction of the model window. Defaults to `0.70`. */
  forgetMaintenanceRatio?: number
  /** Pressure trigger as a fraction of the model window. Defaults to `0.80`. */
  pressureRatio?: number
  /** Summary provider; set together with summarizationModel, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with summarizationProvider, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to `8192`. */
  maxTokens?: number
  /** Legacy overflow-zone retry budget; maps to `maxPressureBatches - 1`. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum retries after canonical context overflow; `0` disables recovery. Defaults to `1`. */
  maxOverflowRetries?: number
  /** Target semantic forget batch size. Defaults to `16000`. */
  targetBatchTokens?: number
  /** Maximum semantic forget batch size. Defaults to `24000`. */
  maxBatchTokens?: number
  /** Normal maintenance forget batches. Defaults to `1`; `0` disables this tier. */
  maxMaintenanceBatches?: number
  /** Overflow batches per protected zone and recovery attempt. Defaults to `2`; `0` disables semantic overflow recovery. */
  maxPressureBatches?: number
  /** Completed turns required before a history summary may re-enter. Defaults to `1`. */
  minReentryTurns?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}

/** Basic compaction configuration with an optional exact-target policy table. */
export interface ToolGroupSummarizerConfig {
  enabled?: boolean
  minGroupResults?: number
  minGroupChars?: number
  minGroupTokens?: number
  maxGroupTokens?: number
  maxGroupsPerPass?: number
  maxSummaryTokens?: number
}

export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelCompactPolicyConfig[]
  /** Enable automatic step-boundary pressure and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
  /** Optional semantic summaries for sufficiently large old tool groups. */
  toolGroupSummarizer?: ToolGroupSummarizerConfig
}

/** Exactly one validated retention form. */
export type ResolvedRetention =
  | { readonly retainRatio: number; readonly retainTokens?: never }
  | { readonly retainRatio?: never; readonly retainTokens: number }

/** Validated policy fields shared before and after exact-target matching. */
export interface ResolvedPolicyFields {
  /** Legacy alias retained in the resolved shape for callers and diagnostics. */
  readonly thresholdRatio: number
  readonly recentRatio: number
  readonly forgetBoundaryRatio: number
  readonly toolMaintenanceRatio: number
  readonly forgetMaintenanceRatio: number
  readonly pressureRatio: number
  readonly targetBatchTokens: number
  readonly maxBatchTokens: number
  readonly maxMaintenanceBatches: number
  readonly maxPressureBatches: number
  readonly minReentryTurns: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
}

/** Validated immutable config whose target-specific defaults remain unresolved. */
export type ResolvedConfig = ResolvedPolicyFields & ResolvedRetention & {
  readonly modelPolicies: readonly Readonly<ModelCompactPolicyConfig>[]
  readonly auto: boolean
  readonly toolGroupSummarizer: Required<ToolGroupSummarizerConfig>
}

/** Fully merged policy for one routed conversation target, before capacity scaling. */
export type ResolvedTargetPolicy = ResolvedPolicyFields & ResolvedRetention & {
  readonly target: Pick<LlmCallConfig, 'provider' | 'model'>
}

/** One routed model's concrete pressure and retention budget. */
export type ResolvedCompactSpec = Omit<ResolvedTargetPolicy, 'retainRatio' | 'retainTokens'> & {
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly retainTokens: number
}
