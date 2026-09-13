/**
 * Authoritative Goal/TODO view resolution for one folded batch window.
 *
 * Goal and TODO are NOT ordinary appended facts: each is a named view whose
 * value is decided by the NEWEST durable authority fact in the window, so a new
 * revision REPLACES the previous value and an explicit clear REMOVES it. This
 * module is the single Host-owned resolution used by every reader of a window:
 *
 * - the model-visible frame (`prompt.ts`) publishes the resolved views and the
 *   replace/clear provenance so the auxiliary model is told what changed;
 * - Host semantic validation (`host.ts`) commits the resolved views verbatim,
 *   so a model that echoes a superseded goal or a cleared list cannot merge it
 *   back into the authoritative state.
 *
 * Real DSH event contracts resolved here (verified against the harness
 * packages, not assumed):
 * - `goal/change` carries either a complete post-mutation snapshot
 *   (`{ kind, version: 1, operation: 'create'|'edit'|'pause'|'resume'|
 *   'complete'|'block', goal: { id, revision, objective, phase,
 *   maxGoalRounds }, roundsStarted, createdAt, updatedAt }`) or a clear
 *   tombstone (`{ kind, version: 1, operation: 'clear', cleared: { id,
 *   revision }, clearedAt }`);
 * - `todo/write` carries a whole replacement list (`{ todos: TodoItem[] }`),
 *   so the latest write wins and `{ todos: [] }` is the legal explicit clear.
 *
 * Windows without an authority fact for one view CARRY THAT VIEW FORWARD from
 * the committed base — the absence of a new fact never erases an existing
 * authoritative value, and it never re-merges a superseded one either.
 * @module dsh-context-enhancement/internal/task-state/basic/authority
 */
import type { TaskStateGoalView, TaskStateStable, TaskStateTodoReference, TaskStateTodoView } from '../contract/types.ts';
import type { TaskStateFilteredEvent } from './types.ts';
/** Which authoritative named view one window (or one event) replaced. */
export type TaskStateAuthorityViewName = 'goal' | 'todo';
/**
 * The complete authoritative resolution of one folded window.
 *
 * `changed` and `cleared` are the model-facing replace/clear provenance: they
 * name the views this window REPLACED with a new value and the views it
 * explicitly CLEARED, in the fixed order `goal`, `todo`. An empty `changed` and
 * `cleared` therefore states "this window carried no authoritative change" —
 * the ordinary fact-delta case.
 */
export interface TaskStateAuthorityResolution {
    /** Authoritative Goal view after this window. */
    readonly goalView: TaskStateGoalView;
    /** Authoritative TODO view after this window. */
    readonly todoView: TaskStateTodoView;
    /** Views replaced by a newer authority fact in this window, in `goal`, `todo` order. */
    readonly changed: readonly TaskStateAuthorityViewName[];
    /** Views explicitly cleared by an authority fact in this window, in `goal`, `todo` order. */
    readonly cleared: readonly TaskStateAuthorityViewName[];
    /** Host-derived bounded TODO reference for the resolved view (empty unless `current`). */
    readonly todoReferences: readonly TaskStateTodoReference[];
    /** Whether this window carried a `goal/change` fact that changed the committed Goal view. */
    readonly goalChanged: boolean;
    /** Whether this window carried a `todo/write` fact that changed the committed TODO view. */
    readonly todoChanged: boolean;
}
/** The absent Goal view: no authority fact ever established one. */
export declare const NO_GOAL_VIEW: TaskStateGoalView;
/** The absent TODO view: no authority fact ever established one. */
export declare const NO_TODO_VIEW: TaskStateTodoView;
/**
 * Whether one Session event type is an authority fact type. The provider uses
 * this on the synchronous observer stack to decide that the observation needs
 * an urgent scheduling request; it reads only the event TYPE, so the
 * synchronous stack never projects, reads storage, or calls a model.
 * @param type - the Session event type.
 * @returns true for `goal/change` and `todo/write`.
 */
export declare function isAuthorityEventType(type: string): boolean;
/**
 * Derive the bounded TODO reference implied by one authoritative TODO view:
 * exactly one reference pointing at the winning `todo/write` sequence, or none
 * at all when the view is not `current`. The reference is Host-authored, so a
 * cleared list can never leave a stale reference behind and the auxiliary model
 * can never resurrect one.
 * @param view - the resolved authoritative TODO view.
 * @param maxEntryBytes - configured byte bound for the reference content.
 * @returns zero or one bounded reference.
 */
export declare function todoReferencesOf(view: TaskStateTodoView, maxEntryBytes: number): readonly TaskStateTodoReference[];
/**
 * Resolve the authoritative Goal/TODO views of one folded window against the
 * committed base.
 *
 * The newest authority fact in the window wins for its own view; a window
 * without one carries the base view forward (or `none` when no base exists).
 * Replace and clear provenance is computed by comparing the resolved view with
 * the base view, so "changed" means the authoritative value really differs and
 * "cleared" means this window is what removed a value that still existed.
 * @param events - the folded window's projections, ascending by sequence.
 * @param base - the committed base stable, or `null` before the first commit.
 * @param limits - the configured byte bound for a derived TODO reference content.
 * @returns the complete resolution for this window.
 */
export declare function resolveAuthorityViews(events: readonly TaskStateFilteredEvent[], base: TaskStateStable | null, limits: {
    readonly maxEntryBytes: number;
}): TaskStateAuthorityResolution;
/**
 * Classify one newly observed authority event: does observing it require an
 * urgent wave, and for which view?
 *
 * - any `todo/write` is urgent: the whole list is replaced by that one fact, so
 *   a clear or mutation that waits for `minEvents` leaves a stale list injected;
 * - a `goal/change` is urgent only when it actually changes the authoritative
 *   Goal view relative to the committed base. A fact that restates the view
 *   already committed (or states no goal value at all) carries nothing new and
 *   must not force a wave on its own.
 * @param event - the projection of one observed authority event.
 * @param base - the committed base stable, or `null`.
 * @returns the urgent view name, or `undefined` when no urgent wave is warranted.
 */
export declare function authorityUrgency(event: TaskStateFilteredEvent, base: TaskStateStable | null): TaskStateAuthorityViewName | undefined;
//# sourceMappingURL=authority.d.ts.map