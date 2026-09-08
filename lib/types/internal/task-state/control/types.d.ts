/**
 * Wire vocabulary of the Host task-state Remote (`ctx.remote.taskState`): the
 * `control` stream carries every live Session's committed state, while `edit`
 * submits revision-checked user replacements.
 *
 * ## Contract
 *
 * Every stream generation opens with EXACTLY ONE `baseline` frame holding a
 * whole-set snapshot, then yields live replacement frames in commit order.
 * Consumers treat a `baseline` as authoritative for the whole set and each
 * later frame as a complete replacement of ONE Session's row, so a reconnect
 * never needs history: open a fresh generation, apply its baseline, and keep
 * applying frames.
 *
 * The three visible row states map to:
 * - a committed stable (`stable` present),
 * - a live Session with no committed stable yet (`stable: null`), and
 * - an absent key (a Session the Host does not currently know — never
 *   announced, already disposed, or not yet created).
 *
 * ## Compatibility
 *
 * This module declares NO `SessionEventMap` member and appends NO Session-log
 * event: the frames are delivered only over the Remote stream carrier and the
 * client keeps its own store. Stream values come from the read-only task-state
 * Service through the minimal {@link TaskStateCommitSource} seam. Manual edits
 * use the separate provider-owned {@link TaskStateEditSource} seam, write the
 * authoritative domain, and publish the resulting committed replacement. No
 * path writes the Session log.
 * @module dsh-context-enhancement/internal/task-state/control/types
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { TaskStateStable } from '../contract/types.ts';
import type { TaskStateCommittedListener } from '../basic/types.ts';
export type { TaskStateCommittedListener };
/**
 * The minimal task-state surface the control stream depends on: the read-only
 * committed pointer of the Service Definition plus the provider's committed
 * observer seam. {@link TaskStateCommitSource} is structurally satisfied by
 * `TaskStateBasicService`; a composition whose provider does not expose
 * `subscribeCommitted` (an older or alternate implementation) still serves
 * authoritative baselines and Session-lifecycle frames, just no commit deltas.
 */
export interface TaskStateCommitSource {
    /** Read the synchronous committed stable of one Session. */
    getStable(sessionId: SessionId): TaskStateStable | undefined;
    /**
     * Observe every committed stable after its authority put resolved.
     * @param listener - committed-stable observer.
     * @returns a disposer removing this listener.
     */
    subscribeCommitted(listener: TaskStateCommittedListener): () => void;
}
/** User-editable fields of one committed task-state stable. */
export interface TaskStateEditValue {
    readonly currentObjective: string;
    readonly currentFocus: string;
    readonly openWork: readonly string[];
    readonly nextActions: readonly string[];
    readonly facts: readonly string[];
    readonly decisions: readonly string[];
    readonly constraints: readonly string[];
    readonly risks: readonly string[];
}
/** Optimistic replacement request from the context view. */
export interface TaskStateEditRequest {
    readonly sessionId: SessionId;
    readonly expectedRevision: number;
    readonly value: TaskStateEditValue;
}
/** Result of one durable manual replacement. */
export type TaskStateEditResult = {
    readonly ok: true;
    readonly stable: TaskStateStable;
} | {
    readonly ok: false;
    readonly code: 'unavailable' | 'not-found' | 'conflict' | 'invalid';
    readonly message: string;
    readonly stable?: TaskStateStable;
};
/** Provider-owned manual mutation seam consumed only by the control service. */
export interface TaskStateEditSource {
    editStable(request: TaskStateEditRequest): Promise<TaskStateEditResult>;
}
/** One live Session's complete state row in a baseline or replacement frame. */
export interface TaskStateControlSessionState {
    /** The committed stable, or `null` while the Session has none committed. */
    readonly stable: TaskStateStable | null;
}
/** Whole-set snapshot emitted exactly once at the opening of a generation. */
export interface TaskStateControlBaseline {
    /** Live Sessions keyed by Session id. */
    readonly items: Readonly<Record<string, TaskStateStable | null>>;
}
/** One generation of the Host-wide task-state control stream. */
export type TaskStateControlFrame = {
    readonly type: 'baseline';
    readonly value: TaskStateControlBaseline;
} | {
    readonly type: 'update';
    readonly value: {
        readonly sessionId: SessionId;
        readonly stable: TaskStateStable | null;
    };
};
//# sourceMappingURL=types.d.ts.map