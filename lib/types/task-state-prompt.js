/**
 * dsh-context-enhancement — `./task-state-prompt` subpath.
 *
 * The prompt consumer for durable task state. Its implementation lives in
 * `./internal/task-state/prompt/index.ts`; this module is the Loader-facing
 * subpath and re-exports exactly that surface (`name`/`inject`/`Config`/`apply`
 * for the function-plugin shape, plus the renderer, the config type, and the
 * slot diagnostics helper).
 *
 * The consumer owns ONE model-visible Stable task-state slot per Session
 * lifecycle on the Session surface: it creates the slot with a surface append
 * and REPLACES that exact node on every later committed revision. The reserved
 * `{{task_state_snapshot}}` runtime-context contribution renders nothing, so a
 * revision can never re-enter DSH's append-only runtime-context projection.
 *
 * This module exports named `name`/`inject`/`Config`/`apply` and deliberately
 * has NO default export: the Loader mounts it as a function plugin by those
 * named members, and an accidental default would shadow the shape.
 *
 * @module dsh-context-enhancement/task-state-prompt
 */
export * from "./internal/task-state/prompt/index.js";
//# sourceMappingURL=task-state-prompt.js.map