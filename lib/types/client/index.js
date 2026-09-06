import { ContextEnhancementAction } from "./ContextEnhancementAction.js";
import { en, NS, zh } from "./locales.js";
export const inject = ['locale', 'slots'];
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-enhancement: dictionaries');
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'context-enhancement', order: 10, locale: NS,
    }, ContextEnhancementAction));
}
//# sourceMappingURL=index.js.map