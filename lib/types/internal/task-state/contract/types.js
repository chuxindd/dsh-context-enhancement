/**
 * Pure types of the durable task-state domain: the committed stable record,
 * the auxiliary-model candidate, the lifecycle-bound session identity, the
 * audit vocabulary (open/finished phases keyed by request id), and the
 * branded request and entry ids.
 *
 * The task-state family deliberately declares NO SessionEventMap members: the
 * pre-dispatch request audit and the finished outcome are rows of the
 * provider-owned `sessions`/`audit` storage domain, never Session events, so a
 * composition unloading task-state leaves old Sessions fully readable by
 * rc.1 code that has never heard of these types.
 * @module dsh-context-enhancement/internal/task-state/contract/types
 */
export {};
//# sourceMappingURL=types.js.map