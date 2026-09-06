/**
 * dsh-context-enhancement — `./task-state-prompt` subpath.
 *
 * The prompt consumer for durable task state: it renders one Session's
 * committed task-state stable into the dynamic runtime context through the
 * existing `ctx.systemPrompt` registry (context template
 * `{{task_state_snapshot}}` plus a variable provider of the same name).
 *
 * This module exports named `name`/`inject`/`Config`/`apply` and deliberately
 * has NO default export: the Loader mounts it as a function plugin by those
 * named members, and an accidental default would shadow the shape.
 *
 * @module dsh-context-enhancement/task-state-prompt
 */
import z from '@deepseek-ai/schemastery';
import { renderTaskStateSnapshot } from "./internal/task-state/prompt/render.js";
export { TASK_STATE_TRUNCATION_MARKER, renderTaskStateSnapshot } from "./internal/task-state/prompt/render.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'task-state-prompt';
/**
 * Register the runtime-context contribution while `systemPrompt` is available.
 * No service key is injected for `taskState`: a composition without a
 * task-state provider must still mount cleanly (rendering nothing).
 */
export const inject = ['systemPrompt'];
/** Schemastery validation for {@link TaskStatePromptConfig}. */
export const Config = z.object({
    maxBytes: z.number().step(1).min(1).required(),
});
/**
 * The fixed runtime-context template. Interpolation resolves
 * `task_state_snapshot` once; the provider value is not scanned again, so a
 * literal `{{...}}` inside stable-derived content survives unchanged.
 */
const SNAPSHOT_CONTEXT = '{{task_state_snapshot}}';
/**
 * Register the `{{task_state_snapshot}}` context and variable provider for the
 * lifetime of `ctx`.
 * @param ctx - plugin context; the registrations dispose with it.
 * @param config - the deployment byte budget for one rendered snapshot.
 */
export function apply(ctx, config) {
    const maxBytes = config.maxBytes;
    ctx.systemPrompt.context({
        // The task-state snapshot rides after the policy contexts: it is durable
        // background state about the session's own work, not a per-request
        // mechanism policy.
        name: 'task-state:snapshot',
        order: 125,
        text: SNAPSHOT_CONTEXT,
    });
    ctx.systemPrompt.variable('task_state_snapshot', (context) => {
        const sessionId = context.agent?.session.id;
        if (sessionId === undefined)
            return '';
        // Read the committed pointer live so a provider mounted after this consumer
        // still contributes; an unmounted provider renders nothing.
        const stable = ctx.get('taskState')?.getStable(sessionId);
        if (stable === undefined)
            return '';
        return renderTaskStateSnapshot(stable, maxBytes);
    });
}
//# sourceMappingURL=task-state-prompt.js.map