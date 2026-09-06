/**
 * Configuration resolution for deterministic tool-result pruning,
 * re-implemented for `dsh-context-enhancement` from the MIT-licensed official
 * rc1 source with the Card5/6 `hardLimitChars` delta.
 *
 * SOURCE: local copy of the official rc.1 `dsh-compaction-tool-result-pruner`
 * `src/config.ts` (MIT, tag dsh-v0.1.2-rc.1 of the `deepseek-harness`
 * repository) plus the Card5/6 working-tree delta (`hardLimitChars`).
 * `deepFreeze` comes from the published rc1 `@deepseek-ai/dsh-util-values`
 * package. Provenance is recorded in THIRD_PARTY_NOTICES.md.
 *
 * @module dsh-context-enhancement/internal/compaction/pruner-config
 */
import type { ResolvedConfig, ToolResultPruneConfig } from './pruner-types.ts';
/** Fixed marker substituted for every removed middle span. */
export declare const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
/** Low-friction defaults for coding-agent tool output. */
export declare const DEFAULTS: ResolvedConfig;
/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export declare function codePointLength(text: string): number;
/**
 * Resolve and validate pruning budgets.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export declare function resolveConfig(config?: ToolResultPruneConfig): ResolvedConfig;
//# sourceMappingURL=pruner-config.d.ts.map