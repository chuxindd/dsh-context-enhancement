/**
 * dsh-context-enhancement — `./task-state-basic` subpath.
 *
 * The durable task-state provider (`ctx.taskState`): the sole MVP owner of
 * the authoritative `context_enhancement_task_state` storage domain, the
 * published committed pointers, the versioned input filter, per-Session
 * background scheduling, independent auxiliary LLM calls, output validation,
 * private writes, and lifecycle.
 *
 * The default export is the Loader-recognizable Service class (the Loader
 * treats a default-exported Service subclass as a mountable plugin row). The
 * provider declares NO SessionEventMap members: its audit vocabulary lives in
 * its own storage-domain `audit` table, never in the Session log.
 *
 * @module dsh-context-enhancement/task-state-basic
 */
import { TaskStateBasicService } from "./internal/task-state/basic/service.js";
export { TaskStateBasicService } from "./internal/task-state/basic/service.js";
export { taskStateDomainSpec } from "./internal/task-state/basic/domain.js";
export default TaskStateBasicService;
//# sourceMappingURL=task-state-basic.js.map