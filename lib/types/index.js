/** Host entry for the context-enhancement bundle and its browser companion. */
import { contextEnhancementProjectionDefinition } from "./effect-projection.js";
export const inject = ['sessionProjections'];
export function apply(ctx) {
    ctx.sessionProjections.register(contextEnhancementProjectionDefinition);
}
//# sourceMappingURL=index.js.map