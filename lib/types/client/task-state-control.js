/**
 * Client-side contract of the Host task-state Remote snapshot stream.
 *
 * ## Wire contract (design authority for the Host sidecar proxy)
 *
 * The Host proxy opens one reconnectable Remote stream per connection under
 * the assumed namespace/method names `taskState.control` (see
 * {@link TASK_STATE_CONTROL_NAMESPACE} / {@link TASK_STATE_CONTROL_METHOD}).
 * Each physical generation of that stream emits EXACTLY ONE opening
 * {@link TaskStateControlBaseline} frame followed by any number of live
 * {@link TaskStateControlUpdate} frames — the baseline-and-delta shape every
 * DSH Gateway stream carries (see `RemoteSnapshotStream`). A replacement
 * generation (carrier loss, explicit restart) begins again with a fresh
 * baseline, so the client re-synchronizes without accumulating state.
 *
 * The baseline's `items` maps every Session known to the Host to its latest
 * committed {@link TaskStateStable} (or `null` when the Session holds none
 * yet). Updates carry the addressed `sessionId` plus that Session's newest
 * whole stable (or `null` when the provider cleared/never had one). The
 * stable values are the FULL committed stable — never deltas — so each frame
 * is self-describing and a client may apply them with monotonic-revision
 * de-duplication only.
 *
 * If the Host proxy eventually selects different namespace/method names, the
 * only place to change is the transport factory in the client entry
 * (`src/client/index.ts`); everything below consumes this module's frame
 * vocabulary unchanged.
 *
 * ## Why not a Session projection
 *
 * Committing the durable stable as a Session-log whole-value event is blocked
 * by rc.1's reload-compatibility contract (see the Host-side projection
 * notes). The client therefore consumes the stable through its OWN Remote
 * snapshot stream and renders a self-owned store — it never writes to the
 * shared session-projection stores.
 *
 * @module dsh-context-enhancement/client/task-state-control
 */
/** Assumed Remote namespace exposing the task-state control stream. */
export const TASK_STATE_CONTROL_NAMESPACE = 'taskState';
/** Assumed Remote method opening one generation of the control stream. */
export const TASK_STATE_CONTROL_METHOD = 'control';
/** Frame-tag refinement: whether a frame is the generation's opening baseline. */
export function isTaskStateControlBaseline(frame) {
    return frame.type === 'baseline';
}
/** Frame-tag refinement: whether a frame is a live per-Session update. */
export function isTaskStateControlUpdate(frame) {
    return frame.type === 'update';
}
/**
 * Shape-level wire guard: distinguish a control frame from arbitrary remote
 * output so a malformed frame fails the stream instead of corrupting state.
 * The durable `TaskStateStable` values themselves are schema-validated
 * Host-side before publication; this guard only checks the envelope.
 */
export function parseTaskStateControlFrame(value) {
    if (typeof value !== 'object' || value === null) {
        return { ok: false, message: 'task-state control frame is not an object' };
    }
    const candidate = (!('type' in value) && 'value' in value && typeof value.value === 'object' && value.value !== null)
        ? value.value
        : value;
    const frame = candidate;
    if (frame.type === 'baseline') {
        const baseline = frame.value;
        if (typeof baseline !== 'object' || baseline === null || baseline.items === undefined) {
            return { ok: false, message: 'task-state baseline frame is missing its items map' };
        }
        if (typeof baseline.items !== 'object' || baseline.items === null) {
            return { ok: false, message: 'task-state baseline items is not a record' };
        }
        return { ok: true, frame: frame };
    }
    if (frame.type === 'update') {
        const update = frame.value;
        if (typeof update !== 'object' || update === null) {
            return { ok: false, message: 'task-state update frame is missing its value' };
        }
        if (typeof update.sessionId !== 'string' || update.sessionId.length === 0) {
            return { ok: false, message: 'task-state update frame is missing its sessionId' };
        }
        return { ok: true, frame: frame };
    }
    return { ok: false, message: `task-state control frame has unknown type ${String(frame.type)}` };
}
/**
 * Monotonic whole-value application for one Session: accept a newer stable,
 * clear on an explicit `null`, and ignore anything at or below the current
 * revision (idempotent baseline replays and stale updates never regress the
 * folded stable). Returns the same value reference when nothing changed.
 */
export function applyTaskStateStableForSession(current, incoming) {
    if (incoming === null)
        return null;
    if (current === undefined)
        return incoming;
    if (current === null)
        return incoming;
    return incoming.revision > current.revision ? incoming : current;
}
//# sourceMappingURL=task-state-control.js.map