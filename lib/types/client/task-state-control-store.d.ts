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
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { TaskStateStable } from '../internal/task-state/contract/types.ts';
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots';
import type { TaskStateControlBaseline, TaskStateControlUpdate, TaskStateStableOrNone } from './task-state-control.ts';
/**
 * Connection lifecycle of the shared mirror: `connecting` (no opening
 * baseline applied on the current generation), `live` (an opening baseline
 * applied and the snapshot holds current data), and `error` (the stream
 * failed terminally; the last applied snapshot stays readable and
 * {@link TaskStateControlMirror.retry} reopens a fresh generation).
 */
export type TaskStateConnectionStatus = 'connecting' | 'live' | 'error';
/** The complete observable snapshot folded from the Host control stream. */
export interface TaskStateControlMirrorState {
    /**
     * Latest committed stable per Session the Host reported, folded with
     * monotonic-revision de-duplication. `null` = the Host explicitly reported
     * none for that Session; an absent key = the Host has not reported the
     * Session on the current generation.
     */
    readonly items: Readonly<Record<SessionId, TaskStateStableOrNone>>;
    /** Current connection lifecycle of the Remote snapshot stream. */
    readonly connection: TaskStateConnectionStatus;
    /** Terminal failure detail; present only while `connection` is `error`. */
    readonly error?: string;
    /** Monotone generation counter: bumps every time a new opening baseline applied. */
    readonly generation: number;
}
/** The initial (pre-frame) snapshot of the shared mirror. */
export declare function createTaskStateControlInitialState(): TaskStateControlMirrorState;
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
export declare function reduceTaskStateControlBaseline(state: TaskStateControlMirrorState, baseline: TaskStateControlBaseline): TaskStateControlMirrorState;
/**
 * Fold one live per-Session update into the mirror snapshot. An update at or
 * below the current revision of its Session is an idempotent replay and is
 * skipped; an update for a Session the Host had not reported yet ADDS it.
 * @param state - current mirror snapshot.
 * @param update - live frame.
 * @returns the next snapshot (the same reference when nothing changed).
 */
export declare function reduceTaskStateControlUpdate(state: TaskStateControlMirrorState, update: TaskStateControlUpdate): TaskStateControlMirrorState;
/**
 * Record a terminal stream failure. The last applied snapshot stays readable
 * so the view can keep showing the last known summary while offering a retry.
 * @param state - current mirror snapshot.
 * @param error - the terminal failure.
 * @returns the next error snapshot (the same reference when already in error).
 */
export declare function reduceTaskStateControlFailure(state: TaskStateControlMirrorState, error: unknown): TaskStateControlMirrorState;
/**
 * Options of one {@link TaskStateControlMirror}.
 */
export interface TaskStateControlMirrorOptions {
    /**
     * Open ONE physical generation of the logical stream: an async iterable
     * that yields exactly one opening `baseline` frame then live `update`
     * frames, ending when the generation is over (a fresh call opens a fresh
     * generation with a fresh baseline). Returns `undefined` while the Host
     * proxy namespace is absent, which keeps the mirror `connecting` and
     * probes again after `retryDelayMs`.
     */
    readonly open: (signal: AbortSignal) => AsyncIterable<unknown> | undefined;
    /**
     * Delay between carrier-loss reopens and namespace-absent probes.
     * Defaults to 1500 ms.
     */
    readonly retryDelayMs?: number;
    /** Observe a retryable carrier loss before the mirror reopens. */
    readonly carrierFailed?: (error: unknown) => void;
}
/**
 * A local protocol violation of the `taskState.control` generation contract
 * (a frame failed envelope validation, a generation ended before its opening
 * baseline, or a generation carried more than one opening baseline). Such a
 * failure is TERMINAL — never auto-retried — because retrying cannot repair a
 * contract violation.
 */
export declare class TaskStateControlProtocolError extends Error {
    /**
     * @param message - human-readable violation detail.
     */
    constructor(message: string);
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
export declare class TaskStateControlMirror implements HostObservable<TaskStateControlMirrorState> {
    private readonly options;
    private state;
    private readonly listeners;
    private controller;
    private consumer;
    private started;
    private disposed;
    /**
     * @param options - generation opener and reconnect pacing.
     */
    constructor(options: TaskStateControlMirrorOptions);
    /** Current mirror snapshot (the `getSnapshot` half of the observable). */
    getSnapshot: () => TaskStateControlMirrorState;
    /** Subscribe to snapshot changes (the `subscribe` half of the observable). */
    subscribe: (listener: () => void) => (() => void);
    /** Begin consuming the stream. Idempotent; repeated calls are inert. */
    start(): void;
    /**
     * Retry after a terminal failure (or a pre-connection absence): reset the
     * snapshot and reopen one fresh generation immediately.
     */
    retry(): void;
    /**
     * Permanently stop this mirror and wait for its consumer to quiesce.
     * @returns when no generation or callback can still run.
     */
    dispose(): Promise<void>;
    private notifyIfChanged;
    private consume;
}
/**
 * The newest committed stable of one Session, or `null` when none is folded.
 * @param state - current mirror snapshot.
 * @param sessionId - Session whose stable should be read.
 * @returns the Session's stable, or `null` when absent or reported none.
 */
export declare function selectSessionStable(state: TaskStateControlMirrorState, sessionId: SessionId): TaskStateStable | null;
/** Whether the mirror holds a usable committed stable for one Session. */
export declare function hasSessionStable(state: TaskStateControlMirrorState, sessionId: SessionId): boolean;
/**
 * The per-Session view of the shared mirror: the Session's folded stable
 * plus the connection lifecycle the view renders.
 */
export interface TaskStateControlSessionState {
    /** Latest committed stable of the Session, or `null` when none is folded. */
    readonly stable: TaskStateStable | null;
    /** Connection lifecycle of the shared Remote snapshot stream. */
    readonly connection: TaskStateConnectionStatus;
    /** Terminal failure detail; present only while `connection` is `error`. */
    readonly error?: string;
    /** Monotone generation counter of the applied baselines. */
    readonly generation: number;
}
/** Project the per-Session view out of the shared mirror snapshot. */
export declare function selectTaskStateControlSession(state: TaskStateControlMirrorState, sessionId: SessionId): TaskStateControlSessionState;
/**
 * Create one per-Session observable source over a shared mirror. The source
 * caches its projected view per mirror snapshot, so unrelated mirror changes
 * (another Session's update) never produce a new `getSnapshot` reference for
 * this Session.
 * @param mirror - shared mirror to read.
 * @param sessionId - Session whose stable the source tracks.
 * @returns a stable observable the entry inject face can hand to a view.
 */
export declare function createTaskStateControlSessionSource(mirror: TaskStateControlMirror, sessionId: SessionId): HostObservable<TaskStateControlSessionState>;
//# sourceMappingURL=task-state-control-store.d.ts.map