import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '../effect-projection.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ContextEnhancementAction } from './ContextEnhancementAction.tsx'
import { en, NS, zh, type ContextEnhancementKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { contextEnhancement: ContextEnhancementKey } }
export const inject = ['locale', 'slots']
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-enhancement: dictionaries')
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'context-enhancement', order: 10, locale: NS,
  }, ContextEnhancementAction))
}
