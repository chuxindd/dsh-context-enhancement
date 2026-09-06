/** Three-zone compaction configuration resolution and model-policy inheritance. */
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';
import type { BasicCompactionConfig, ResolvedCompactSpec, ResolvedConfig, ResolvedTargetPolicy } from './types.ts';
export declare class TargetPressureConfigError extends Error {
    readonly targetKey: string;
    constructor(targetKey: string, message: string);
}
export declare function resolveConfig(config?: BasicCompactionConfig): ResolvedConfig;
export declare function resolveTargetPolicy(config: ResolvedConfig, target: Pick<LlmCallConfig, 'provider' | 'model'>): ResolvedTargetPolicy;
export declare function resolveCompactSpec(policy: ResolvedTargetPolicy, contextWindow: number): ResolvedCompactSpec;
//# sourceMappingURL=config.d.ts.map