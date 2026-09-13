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
  /**
   * Surface level a pressure pass must reclaim DOWN TO, as a fraction of the
   * model window: the pass stops at `floor(contextWindow * pressureExitRatio)`,
   * not "just below the trigger". Defaults to the resolved
   * `forgetMaintenanceRatio` (so `0.70` by default). Legality requires
   * `forgetMaintenanceRatio <= pressureExitRatio < pressureRatio`: an exit line
   * at or above the trigger is a no-op, and one below the maintenance waterline
   * would make the pressure tier reclaim past the ordinary maintenance target.
   */
  pressureExitRatio?: number
  /**
   * Absolute floor of one semantic batch's net release, in tokens. A batch whose
   * release is below BOTH this floor and {@link minNetReleaseRatio} is recorded
   * as low-yield. Defaults to `1024`; `0` disables this branch of the gate.
   */
  minNetReleaseTokens?: number
  /**
   * Relative floor of one semantic batch's net release, measured against the
   * route price of the span the batch selected (`netRelease / selectedTokens`,
   * the ideal-plan definition). Defaults to `0.15`; `0` disables this branch.
   */
  minNetReleaseRatio?: number
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
  /**
   * Batch budget of one invocation. The ordinary pressure tier pays at most this
   * many semantic batches before returning, and the overflow ladder pays at most
   * this many batches per protected zone and recovery attempt. Defaults to `2`;
   * `0` disables semantic overflow recovery and makes the pressure tier take no
   * batch at all.
   */
  maxPressureBatches?: number
  /** Completed turns required before a history summary may re-enter. Defaults to `1`. */
  minReentryTurns?: number
  /** Response reserve excluded from the surface grant in envelope-budget mode. Defaults to `8192`. */
  responseReserveTokens?: number
  /** Mispricing safety margin excluded from the surface grant in envelope-budget mode. Defaults to `2048`. */
  safetyMarginTokens?: number
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
  /** Surface level a pressure pass reclaims down to, as a window fraction. */
  readonly pressureExitRatio: number
  /** Absolute floor of one semantic batch's net release, in tokens. */
  readonly minNetReleaseTokens: number
  /** Relative floor of one semantic batch's net release, over the selected span. */
  readonly minNetReleaseRatio: number
  readonly targetBatchTokens: number
  readonly maxBatchTokens: number
  readonly maxMaintenanceBatches: number
  /** Batch budget of one invocation: pressure batches, and overflow batches per zone. */
  readonly maxPressureBatches: number
  readonly minReentryTurns: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
  /** Response reserve held free by the surface grant. */
  readonly responseReserveTokens: number
  /** Mispricing margin held free by the surface grant. */
  readonly safetyMarginTokens: number
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
  /** `floor(contextWindow * pressureExitRatio)`: the pressure tier's exit line. */
  readonly pressureExitTokens: number
}
