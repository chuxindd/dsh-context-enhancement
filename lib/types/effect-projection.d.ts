import { z } from 'zod';
/** Counts durable evidence events emitted by the four context capabilities. */
export interface ContextEnhancementEvidence {
    taskStateBasic: number;
    taskStatePrompt: number;
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
        taskStateBasic: z.ZodNumber;
        taskStatePrompt: z.ZodNumber;
        toolResultPruner: z.ZodNumber;
        compactionBasic: z.ZodNumber;
    }, z.core.$strict>;
    init: () => ContextEnhancementEvidence;
    apply: (state: NoInfer<ContextEnhancementEvidence>, event: import("@deepseek-ai/dsh-session").SessionEvent) => ContextEnhancementEvidence;
    wire: {
        viewSchema: z.ZodObject<{
            taskStateBasic: z.ZodNumber;
            taskStatePrompt: z.ZodNumber;
            toolResultPruner: z.ZodNumber;
            compactionBasic: z.ZodNumber;
        }, z.core.$strict>;
        view: (state: NoInfer<ContextEnhancementEvidence>) => ContextEnhancementEvidence;
    };
};
//# sourceMappingURL=effect-projection.d.ts.map