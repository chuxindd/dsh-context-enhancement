/**
 * Pure types of the task-state prompt consumer: the validated deployment
 * config. Type-only module: no runtime code lives here.
 * @module dsh-context-enhancement/internal/task-state/prompt/types
 */

/** Deployment config for the task-state prompt consumer. */
export interface TaskStatePromptConfig {
  /**
   * Maximum UTF-8 bytes of the rendered `{{task_state_snapshot}}` value for one
   * prompt assembly. A committed stable larger than the budget is head-retained
   * with a fixed truncation marker; the durable stable is never changed. This
   * is an explicit deployment choice: no repository default hardcodes a byte
   * budget.
   */
  readonly maxBytes: number
}
