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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { TaskStatePromptConfig } from './internal/task-state/prompt/types.ts';
export { TASK_STATE_TRUNCATION_MARKER, renderTaskStateSnapshot } from './internal/task-state/prompt/render.ts';
export type { TaskStatePromptConfig } from './internal/task-state/prompt/types.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "task-state-prompt";
/**
 * Register the runtime-context contribution while `systemPrompt` is available.
 * No service key is injected for `taskState`: a composition without a
 * task-state provider must still mount cleanly (rendering nothing).
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
//# sourceMappingURL=task-state-prompt.d.ts.map