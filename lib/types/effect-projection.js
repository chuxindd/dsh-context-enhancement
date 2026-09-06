import { z } from 'zod';
const evidenceSchema = z.object({
    taskStateRequests: z.number().int().nonnegative(),
    taskStateBasic: z.number().int().nonnegative(),
    taskStatePrompt: z.number().int().nonnegative(),
    toolResultPruner: z.number().int().nonnegative(),
    compactionBasic: z.number().int().nonnegative(),
}).strict();
const initial = {
    taskStateRequests: 0,
    taskStateBasic: 0,
    taskStatePrompt: 0,
    toolResultPruner: 0,
    compactionBasic: 0,
};
/** Project logged evidence into a small browser-readable counter object. */
export const contextEnhancementProjectionDefinition = {
    key: 'contextEnhancement',
    stateVersion: 1,
    stateSchema: evidenceSchema,
    init: () => initial,
    apply: (state, event) => {
        if (event.type === 'request/header') {
            return { ...state, taskStateRequests: state.taskStateRequests + 1 };
        }
        if (event.type === 'compaction/prune')
            return { ...state, toolResultPruner: state.toolResultPruner + 1 };
        if (event.type === 'compaction/end')
            return { ...state, compactionBasic: state.compactionBasic + 1 };
        return state;
    },
    wire: { viewSchema: evidenceSchema, view: state => state },
};
//# sourceMappingURL=effect-projection.js.map