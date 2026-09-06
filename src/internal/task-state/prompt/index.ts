/**
 * Prompt consumer for durable task state (`dsh-context-enhancement/task-state-prompt`).
 *
 * This module renders one Session's committed task-state stable into the
 * dynamic runtime context. It registers two things through the existing
 * `ctx.systemPrompt` registry: the fixed context template `{{task_state_snapshot}}`
 * and a variable provider named `task_state_snapshot` that resolves the current
 * Session through `AssembleContext.agent.session.id` and reads that Session's
 * committed stable pointer synchronously. An absent stable, an absent agent, or
 * an agent without a session renders an empty string, so the template
 * contributes nothing until a task-state provider publishes a committed stable.
 *
 * Prompt interpolation scans the fixed template once and never recursively
 * scans the returned value, so literal `{{...}}` inside stable-derived content
 * stays unchanged. The consumer reads `ctx.get('taskState')` only — it never
 * imports the provider, opens storage, appends a Session event, or performs
 * async work during assembly.
 * @module dsh-context-enhancement/internal/task-state/prompt/index
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { renderTaskStateSnapshot } from './render.ts'
import type { TaskStatePromptConfig } from './types.ts'

export { TASK_STATE_TRUNCATION_MARKER, renderTaskStateSnapshot } from './render.ts'
export type { TaskStatePromptConfig } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'task-state-prompt'

/**
 * Register the runtime-context contribution while `systemPrompt` is available.
 * No service key is injected for `taskState`: the provider is only ever read
 * inside prompt assembly, and a composition without a task-state provider must
 * still mount cleanly (rendering nothing) rather than wait on a service.
 */
export const inject = ['systemPrompt']

/** Schemastery validation for {@link TaskStatePromptConfig}. */
export const Config: z<TaskStatePromptConfig> = z.object({
  maxBytes: z.number().step(1).min(1).required(),
})

/**
 * The fixed runtime-context template. Interpolation resolves
 * `task_state_snapshot` once; the provider value is not scanned again, so a
 * literal `{{...}}` inside stable-derived content survives unchanged.
 */
const SNAPSHOT_CONTEXT = '{{task_state_snapshot}}'

/**
 * Register the `{{task_state_snapshot}}` context and variable provider for the
 * lifetime of `ctx`.
 * @param ctx - plugin context; the registrations dispose with it.
 * @param config - the deployment byte budget for one rendered snapshot.
 */
export function apply(ctx: Context, config: TaskStatePromptConfig): void {
  const maxBytes = config.maxBytes
  ctx.systemPrompt.context({
    // The task-state snapshot rides after the policy contexts: it is durable
    // background state about the session's own work, not a per-request
    // mechanism policy, so it follows the approval/subagent/delegation rows.
    name: 'task-state:snapshot',
    order: 125,
    text: SNAPSHOT_CONTEXT,
  })
  ctx.systemPrompt.variable('task_state_snapshot', (context) => {
    const sessionId = context.agent?.session.id
    if (sessionId === undefined) return ''
    // Read the committed pointer live so a provider mounted after this consumer
    // still contributes; an unmounted provider renders nothing.
    const stable = ctx.get('taskState')?.getStable(sessionId)
    if (stable === undefined) return ''
    return renderTaskStateSnapshot(stable, maxBytes)
  })
}
