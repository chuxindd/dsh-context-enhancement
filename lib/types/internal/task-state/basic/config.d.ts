/**
 * Load-time validation and detachment of the task-state-basic deployment
 * policy. Every field is explicit and required from the composition; no
 * repository default hardcodes a deployment choice.
 *
 * The Loader-facing schema lives inline on the service class (`static Config`)
 * so the config catalog's static walker can enumerate every validated key;
 * this module owns the raw-key set and the direct-construction validation used
 * when a caller mounts the plugin without Loader normalization.
 * @module dsh-context-enhancement/internal/task-state/basic/config
 */
import type { TaskStateBasicConfig } from './types.ts';
/**
 * Validate and detach one task-state-basic configuration object (used when a
 * caller constructs the plugin directly without Loader schema normalization).
 * @param config - raw deployment configuration.
 * @returns a detached immutable policy.
 */
export declare function resolveTaskStateBasicConfig(config: TaskStateBasicConfig): Readonly<TaskStateBasicConfig>;
//# sourceMappingURL=config.d.ts.map