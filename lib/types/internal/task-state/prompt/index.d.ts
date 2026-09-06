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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { TaskStatePromptConfig } from './types.ts';
export { TASK_STATE_TRUNCATION_MARKER, renderTaskStateSnapshot } from './render.ts';
export type { TaskStatePromptConfig } from './types.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "task-state-prompt";
/**
 * Register the runtime-context contribution while `systemPrompt` is available.
 * No service key is injected for `taskState`: the provider is only ever read
 * inside prompt assembly, and a composition without a task-state provider must
 * still mount cleanly (rendering nothing) rather than wait on a service.
 */
export declare const inject: string[];
/** Schemastery validation for {@link TaskStatePromptConfig}. */
export declare const Config: z<TaskStatePromptConfig>;
/**
 * Register the `{{task_state_snapshot}}` context and variable provider for the
 * lifetime of `ctx`.
 * @param ctx - plugin context; the registrations dispose with it.
 * @param config - the deployment byte budget for one rendered snapshot.
 */
export declare function apply(ctx: Context, config: TaskStatePromptConfig): void;
//# sourceMappingURL=index.d.ts.map