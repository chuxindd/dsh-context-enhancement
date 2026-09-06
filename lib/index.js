import { Tn as object, wn as number } from "./schemas-B9RBVgB9.js";
//#region lib/types/effect-projection.js
const evidenceSchema = object({
	taskStateRequests: number().int().nonnegative(),
	taskStateBasic: number().int().nonnegative(),
	taskStatePrompt: number().int().nonnegative(),
	toolResultPruner: number().int().nonnegative(),
	compactionBasic: number().int().nonnegative()
}).strict();
const initial = {
	taskStateRequests: 0,
	taskStateBasic: 0,
	taskStatePrompt: 0,
	toolResultPruner: 0,
	compactionBasic: 0
};
/** Project logged evidence into a small browser-readable counter object. */
const contextEnhancementProjectionDefinition = {
	key: "contextEnhancement",
	stateVersion: 1,
	stateSchema: evidenceSchema,
	init: () => initial,
	apply: (state, event) => {
		if (event.type === "request/header") return {
			...state,
			taskStateRequests: state.taskStateRequests + 1
		};
		if (event.type === "compaction/prune") return {
			...state,
			toolResultPruner: state.toolResultPruner + 1
		};
		if (event.type === "compaction/end") return {
			...state,
			compactionBasic: state.compactionBasic + 1
		};
		return state;
	},
	wire: {
		viewSchema: evidenceSchema,
		view: (state) => state
	}
};
//#endregion
//#region lib/types/index.js
/** Host entry for the context-enhancement Bundle and its browser companion. */
/** Register durable evidence counters for the browser proof panel. */
const inject = ["sessionProjections"];
function apply(ctx) {
	ctx.sessionProjections.register(contextEnhancementProjectionDefinition);
}
//#endregion
export { apply, inject };
