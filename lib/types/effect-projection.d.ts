import { z } from 'zod';
/** Counts durable evidence events emitted by context capabilities. */
export interface ContextEnhancementEvidence {
    /** Request envelopes participating in task-state processing; not successes. */
    taskStateRequests: number;
    taskStateBasic: number;
    taskStatePrompt: number;
    /**
     * Successful tool-result reductions on the current surface: the umbrella
     * "归纳工具操作" capability. Every reduction path — semantic tool-group
     * summarization and the deterministic head/middle prune — logs the shared
     * `compaction/prune` shadow-price event immediately before its replacement,
     * so this one counter covers them all without a separate capability.
     */
    toolResultPruner: number;
    compactionBasic: number;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        /** Counts of context-enhancement evidence events in the current Session. */
        contextEnhancement: ContextEnhancementEvidence;
    }
    interface SessionProjectionStateMap {
        /** Internal state for context-enhancement evidence counts. */
        contextEnhancement: ContextEnhancementEvidence;
    }
}
/** Project logged evidence into a small browser-readable counter object. */
export declare const contextEnhancementProjectionDefinition: {
    key: "contextEnhancement";
    stateVersion: number;
    stateSchema: z.ZodObject<{
        taskStateRequests: z.ZodNumber;
        taskStateBasic: z.ZodNumber;
        taskStatePrompt: z.ZodNumber;
        toolResultPruner: z.ZodNumber;
        compactionBasic: z.ZodNumber;
    }, z.core.$strict>;
    init: () => ContextEnhancementEvidence;
    apply: (state: NoInfer<ContextEnhancementEvidence>, event: import("@deepseek-ai/dsh-session").SessionEvent) => ContextEnhancementEvidence;
    wire: {
        viewSchema: z.ZodObject<{
            taskStateRequests: z.ZodNumber;
            taskStateBasic: z.ZodNumber;
            taskStatePrompt: z.ZodNumber;
            toolResultPruner: z.ZodNumber;
            compactionBasic: z.ZodNumber;
        }, z.core.$strict>;
        view: (state: NoInfer<ContextEnhancementEvidence>) => ContextEnhancementEvidence;
    };
};
//# sourceMappingURL=effect-projection.d.ts.map