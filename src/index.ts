/** Host entry for the context-enhancement bundle and its browser companion. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { contextEnhancementProjectionDefinition } from './effect-projection.ts'

export const inject = ['sessionProjections']

export function apply(ctx: Context): void {
  ctx.sessionProjections.register(contextEnhancementProjectionDefinition)
}
