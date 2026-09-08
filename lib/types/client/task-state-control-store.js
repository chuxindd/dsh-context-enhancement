/**
 * Self-owned client mirror of the Host task-state Remote snapshot stream.
 *
 * One {@link TaskStateControlMirror} instance lives for the plugin lifetime
 * (created in the client entry inside an effect, disposed on unload) and
 * folds the `taskState.control` Remote stream described in
 * {@link dsh-context-enhancement/client/task-state-control} into a single
 * observable snapshot: the latest committed {@link TaskStateStable} per
 * Session the Host knows, plus the connection lifecycle.
 *
 * ## Generation model
 *
 * The Host proxy exposes one Remote method (assumed `taskState.control`)
 * whose EVERY call opens one physical generation: it yields exactly one
 * opening {@link TaskStateControlBaseline} followed by any number of live
 * {@link TaskStateControlUpdate} frames, then ends. The mirror treats "one
 * returned iterable" as one generation:
 *
 * - a generation that ends cleanly AFTER its opening baseline applied is a
 *   carrier-style loss — the applied snapshot stays visible and the mirror
 *   reopens a fresh generation after `retryDelayMs`;
 * - a generation that ends BEFORE its opening baseline is a protocol
 *   failure — a terminal `error` state that keeps the last applied snapshot
 *   readable and offers {@link TaskStateControlMirror.retry};
 * - `open` returning `undefined` means the Host proxy namespace is not
 *   mounted yet — the mirror stays `connecting` (the view's loading state)
 *   and probes again after `retryDelayMs`;
 * - {@link TaskStateControlMirror.retry} resets the snapshot and reopens a
 *   fresh generation immediately (user-facing retry after an error).
 *
 * When the real Host proxy lands, its method signature is the only thing the
 * client entry's `open` option has to satisfy; this module's frame
 * vocabulary and fold never change.
 *
 * Conversation-view entries read their own Session's stable out of the shared
 * mirror through a per-Session source. The plugin never writes the shared
 * session-projection stores or any official store.
 *
 * Everything here is React-free, browser-safe, and free of value imports
 * beyond the module itself, so the pure fold and the connection lifecycle are
 * unit-testable in Node and the artifact stays inside the client bundle's
 * purity gate.
 *
 * @module dsh-context-enhancement/client/task-state-control-store
 */
import { applyTaskStateStableForSession, parseTaskStateControlFrame, } from "./task-state-control.js";
/** The initial (pre-frame) snapshot of the shared mirror. */
export function createTaskStateControlInitialState() {
    return { items: Object.freeze({}), connection: 'connecting', generation: 0 };
}
/**
 * Fold one complete opening baseline into the mirror snapshot. A baseline is
 * authoritative for the current generation: its per-Session values are
 * applied with revision de-dup (an idempotent replay never regresses), the
 * item map is replaced by the baseline's Session set (a Session the Host no
 * longer reports disappears), and the snapshot transitions to `live`.
 * @param state - current mirror snapshot.
 * @param baseline - opening frame of the current generation.
 * @returns the next snapshot (a fresh object whenever a baseline is applied).
 */
export function reduceTaskStateControlBaseline(state, baseline) {
    const items = {};
    for (const [sessionId, incoming] of Object.entries(baseline.items)) {
        const id = sessionId;
        items[id] = applyTaskStateStableForSession(state.items[id], incoming);
    }
    return {
        items: Object.freeze(items),
        connection: 'live',
        generation: state.generation + 1,
    };
}
/**
 * Fold one live per-Session update into the mirror snapshot. An update at or
 * below the current revision of its Session is an idempotent replay and is
 * skipped; an update for a Session the Host had not reported yet ADDS it.
 * @param state - current mirror snapshot.
 * @param update - live frame.
 * @returns the next snapshot (the same reference when nothing changed).
 */
export function reduceTaskStateControlUpdate(state, update) {
    const previous = state.items[update.sessionId];
    const stable = applyTaskStateStableForSession(previous, update.stable);
    if (stable === previous)
        return state;
    const items = {
        ...state.items,
        [update.sessionId]: stable,
    };
    return { ...state, items: Object.freeze(items) };
}
/**
 * Record a terminal stream failure. The last applied snapshot stays readable
 * so the view can keep showing the last known summary while offering a retry.
 * @param state - current mirror snapshot.
 * @param error - the terminal failure.
 * @returns the next error snapshot (the same reference when already in error).
 */
export function reduceTaskStateControlFailure(state, error) {
    const message = error instanceof Error ? error.message : String(error);
    if (state.connection === 'error' && state.error === message)
        return state;
    return { ...state, connection: 'error', error: message };
}
/** Wait for `ms` unless the signal aborts first. */
function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted)
            onAbort();
    });
}
/**
 * A local protocol violation of the `taskState.control` generation contract
 * (a frame failed envelope validation, a generation ended before its opening
 * baseline, or a generation carried more than one opening baseline). Such a
 * failure is TERMINAL — never auto-retried — because retrying cannot repair a
 * contract violation.
 */
export class TaskStateControlProtocolError extends Error {
    /**
     * @param message - human-readable violation detail.
     */
    constructor(message) {
        super(message);
        this.name = 'TaskStateControlProtocolError';
    }
}
/**
 * One reconnectable Remote snapshot mirror: an observable snapshot of
 * {@link TaskStateControlMirrorState} plus lifecycle control. Frame values
 * are envelope-validated on arrival; the durable stable values themselves are
 * schema-validated Host-side before publication.
 *
 * Cancellation: {@link TaskStateControlMirror.dispose} aborts the current
 * generation and waits for its consumer to quiesce. Reconnection basics are
 * described in the module doc: automatic reopen on carrier-style loss and
 * namespace-absent probes, plus an explicit {@link TaskStateControlMirror.retry}
 * that resets and reopens after a terminal failure.
 */
export class TaskStateControlMirror {
    options;
    state = createTaskStateControlInitialState();
    listeners = new Set();
    controller;
    consumer;
    started = false;
    disposed = false;
    /**
     * @param options - generation opener and reconnect pacing.
     */
    constructor(options) {
        this.options = options;
    }
    /** Current mirror snapshot (the `getSnapshot` half of the observable). */
    getSnapshot = () => this.state;
    /** Subscribe to snapshot changes (the `subscribe` half of the observable). */
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    /** Begin consuming the stream. Idempotent; repeated calls are inert. */
    start() {
        if (this.started || this.disposed)
            return;
        this.started = true;
        this.controller = new AbortController();
        const consumer = this.consume(this.controller);
        this.consumer = consumer;
        void consumer;
    }
    /**
     * Retry after a terminal failure (or a pre-connection absence): reset the
     * snapshot and reopen one fresh generation immediately.
     */
    retry() {
        if (this.disposed)
            return;
        const previous = this.state;
        const controller = this.controller;
        if (controller !== undefined && !controller.signal.aborted) {
            controller.abort(new Error('task-state control mirror restarted'));
        }
        this.state = createTaskStateControlInitialState();
        this.started = false;
        this.notifyIfChanged(previous);
        this.start();
    }
    /**
     * Permanently stop this mirror and wait for its consumer to quiesce.
     * @returns when no generation or callback can still run.
     */
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        const controller = this.controller;
        if (controller !== undefined && !controller.signal.aborted) {
            controller.abort(new Error('task-state control mirror disposed'));
        }
        await this.consumer;
        this.listeners.clear();
    }
    notifyIfChanged(previous) {
        if (previous === this.state)
            return;
        for (const listener of this.listeners)
            listener();
    }
    async consume(controller) {
        const signal = controller.signal;
        const retryDelayMs = this.options.retryDelayMs ?? 1_500;
        let previous = this.state;
        try {
            for (;;) {
                if (signal.aborted || this.disposed)
                    return;
                const iterable = this.options.open(signal);
                if (iterable === undefined) {
                    // Host proxy namespace not mounted: keep `connecting`, probe later.
                    await delay(retryDelayMs, signal);
                    continue;
                }
                let appliedBaseline = false;
                for await (const value of iterable) {
                    if (signal.aborted || this.disposed)
                        return;
                    const rawItem = value;
                    const isWrapped = typeof rawItem === 'object' && rawItem !== null && 'value' in rawItem && typeof rawItem.accept === 'function';
                    const payload = isWrapped ? rawItem.value : value;
                    const parsed = parseTaskStateControlFrame(payload);
                    if (!parsed.ok) {
                        throw new TaskStateControlProtocolError(`task-state control stream: ${parsed.message}`);
                    }
                    const frame = parsed.frame;
                    if (isWrapped) {
                        ;
                        rawItem.accept();
                    }
                    if (frame.type === 'baseline') {
                        if (appliedBaseline) {
                            throw new TaskStateControlProtocolError('task-state control stream emitted more than one opening baseline');
                        }
                        this.state = reduceTaskStateControlBaseline(this.state, frame.value);
                        appliedBaseline = true;
                    }
                    else {
                        if (!appliedBaseline) {
                            throw new TaskStateControlProtocolError('task-state control stream emitted an update before its opening baseline');
                        }
                        this.state = reduceTaskStateControlUpdate(this.state, frame.value);
                    }
                    this.notifyIfChanged(previous);
                    previous = this.state;
                }
                if (signal.aborted || this.disposed)
                    return;
                if (!appliedBaseline) {
                    // The generation ended before its opening baseline — a protocol
                    // failure, never a carrier loss.
                    throw new TaskStateControlProtocolError('task-state control stream ended before its opening baseline');
                }
                // Clean end after a baseline: a carrier-style loss. Keep the applied
                // snapshot visible, wait, and reopen a fresh generation.
                this.options.carrierFailed?.(new Error('task-state control stream carrier lost'));
                await delay(retryDelayMs, signal);
            }
        }
        catch (error) {
            if (this.disposed || signal.aborted)
                return;
            this.state = reduceTaskStateControlFailure(this.state, error);
            this.notifyIfChanged(previous);
        }
    }
}
/**
 * The newest committed stable of one Session, or `null` when none is folded.
 * @param state - current mirror snapshot.
 * @param sessionId - Session whose stable should be read.
 * @returns the Session's stable, or `null` when absent or reported none.
 */
export function selectSessionStable(state, sessionId) {
    const stable = state.items[sessionId];
    return stable === undefined ? null : stable;
}
/** Whether the mirror holds a usable committed stable for one Session. */
export function hasSessionStable(state, sessionId) {
    const stable = state.items[sessionId];
    return stable !== undefined && stable !== null;
}
/** Project the per-Session view out of the shared mirror snapshot. */
export function selectTaskStateControlSession(state, sessionId) {
    return {
        stable: selectSessionStable(state, sessionId),
        connection: state.connection,
        ...(state.error === undefined ? {} : { error: state.error }),
        generation: state.generation,
    };
}
/**
 * Create one per-Session observable source over a shared mirror. The source
 * caches its projected view per mirror snapshot, so unrelated mirror changes
 * (another Session's update) never produce a new `getSnapshot` reference for
 * this Session.
 * @param mirror - shared mirror to read.
 * @param sessionId - Session whose stable the source tracks.
 * @returns a stable observable the entry inject face can hand to a view.
 */
export function createTaskStateControlSessionSource(mirror, sessionId) {
    let cachedMirrorState;
    let cachedView;
    return {
        getSnapshot: () => {
            const mirrorState = mirror.getSnapshot();
            if (mirrorState !== cachedMirrorState) {
                cachedMirrorState = mirrorState;
                const nextView = selectTaskStateControlSession(mirrorState, sessionId);
                if (cachedView === undefined ||
                    cachedView.stable !== nextView.stable ||
                    cachedView.connection !== nextView.connection ||
                    cachedView.error !== nextView.error ||
                    cachedView.generation !== nextView.generation) {
                    cachedView = nextView;
                }
            }
            return cachedView;
        },
        subscribe: mirror.subscribe,
    };
}
//# sourceMappingURL=task-state-control-store.js.map