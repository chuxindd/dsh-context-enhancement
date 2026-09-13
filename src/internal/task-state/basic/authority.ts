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

import type {
  TaskStateGoalView,
  TaskStateStable,
  TaskStateTodoReference,
  TaskStateTodoView,
  TaskStateTodoViewItem,
} from '../contract/types.ts'
import { MARKER_BYTES, boundUtf8 } from './bytes.ts'
import type { TaskStateFilteredEvent } from './types.ts'

/** Which authoritative named view one window (or one event) replaced. */
export type TaskStateAuthorityViewName = 'goal' | 'todo'

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
  readonly goalView: TaskStateGoalView
  /** Authoritative TODO view after this window. */
  readonly todoView: TaskStateTodoView
  /** Views replaced by a newer authority fact in this window, in `goal`, `todo` order. */
  readonly changed: readonly TaskStateAuthorityViewName[]
  /** Views explicitly cleared by an authority fact in this window, in `goal`, `todo` order. */
  readonly cleared: readonly TaskStateAuthorityViewName[]
  /** Host-derived bounded TODO reference for the resolved view (empty unless `current`). */
  readonly todoReferences: readonly TaskStateTodoReference[]
  /** Whether this window carried a `goal/change` fact that changed the committed Goal view. */
  readonly goalChanged: boolean
  /** Whether this window carried a `todo/write` fact that changed the committed TODO view. */
  readonly todoChanged: boolean
}

/** The absent Goal view: no authority fact ever established one. */
export const NO_GOAL_VIEW: TaskStateGoalView = Object.freeze({ status: 'none' })

/** The absent TODO view: no authority fact ever established one. */
export const NO_TODO_VIEW: TaskStateTodoView = Object.freeze({ status: 'none', items: Object.freeze([]) as readonly TaskStateTodoViewItem[] })

/** The authority fact types whose observation is urgent (never waits for `minEvents`). */
const AUTHORITY_EVENT_TYPES: ReadonlySet<string> = new Set(['goal/change', 'todo/write'])

/**
 * Whether one Session event type is an authority fact type. The provider uses
 * this on the synchronous observer stack to decide that the observation needs
 * an urgent scheduling request; it reads only the event TYPE, so the
 * synchronous stack never projects, reads storage, or calls a model.
 * @param type - the Session event type.
 * @returns true for `goal/change` and `todo/write`.
 */
export function isAuthorityEventType(type: string): boolean {
  return AUTHORITY_EVENT_TYPES.has(type)
}

/** One projected `goal/change` snapshot fact read back out of the projection. */
interface ProjectedGoalSnapshot {
  readonly operation?: string
  readonly goal?: {
    readonly id?: unknown
    readonly revision?: unknown
    readonly phase?: unknown
    readonly objective?: unknown
  }
}

/** One projected `todo/write` fact read back out of the projection. */
interface ProjectedTodoWrite {
  readonly status?: string
  readonly todos?: readonly { readonly content?: unknown; readonly status?: unknown }[]
}

/** Read the projected fields of one filtered event as a JSON record. */
function fieldsOf(event: TaskStateFilteredEvent): Record<string, unknown> {
  const fields = event.fields
  return typeof fields === 'object' && fields !== null ? fields as Record<string, unknown> : {}
}

/** Resolve the Goal view a single `goal/change` projection states. */
function goalViewOf(event: TaskStateFilteredEvent): TaskStateGoalView | undefined {
  const fields = fieldsOf(event)
  if (fields['kind'] !== 'goal/change') return undefined
  const operation = typeof fields['operation'] === 'string' ? fields['operation'] : undefined
  if (operation === undefined) return undefined
  if (operation === 'clear') return { status: 'cleared' }
  const snapshot = fields as ProjectedGoalSnapshot
  const goal = snapshot.goal
  if (goal === undefined || typeof goal !== 'object' || goal === null) {
    // A non-clear goal fact without a snapshot states no goal value: it cannot
    // establish a view, so the previous authority survives.
    return undefined
  }
  const view: {
    status: 'current'
    goalId?: string
    goalRevision?: number
    phase?: string
    objective?: string
  } = { status: 'current' }
  if (typeof goal.id === 'string' && goal.id.length > 0) view.goalId = goal.id
  if (typeof goal.revision === 'number' && Number.isSafeInteger(goal.revision) && goal.revision > 0) {
    view.goalRevision = goal.revision
  }
  if (typeof goal.phase === 'string' && goal.phase.length > 0) view.phase = goal.phase
  if (typeof goal.objective === 'string' && goal.objective.length > 0) view.objective = goal.objective
  return view
}

/** Resolve the TODO view a single `todo/write` projection states. */
function todoViewOf(event: TaskStateFilteredEvent): TaskStateTodoView | undefined {
  const fields = fieldsOf(event)
  if (fields['kind'] !== 'todo/write') return undefined
  const projected = fields as ProjectedTodoWrite
  const raw = Array.isArray(projected.todos) ? projected.todos : undefined
  const cleared = projected.status === 'cleared' || (raw !== undefined && raw.length === 0)
  if (cleared) return { status: 'cleared', sourceSeq: event.seq, items: [] }
  if (raw === undefined) return undefined
  const items: TaskStateTodoViewItem[] = []
  for (const item of raw) {
    const content = typeof item.content === 'string' ? item.content : ''
    const status = typeof item.status === 'string' ? item.status : ''
    if (content.length === 0) continue
    items.push({ content, status: status.length === 0 ? 'pending' : status })
  }
  // A non-empty whole-list write states a CURRENT list even when every item
  // carried unreadable content: the authority fact exists, so the previous
  // list is replaced rather than silently kept alive.
  return { status: 'current', sourceSeq: event.seq, items }
}

/** Whether two Goal views state the same authoritative value. */
function sameGoalView(left: TaskStateGoalView, right: TaskStateGoalView): boolean {
  return left.status === right.status
    && left.goalId === right.goalId
    && left.goalRevision === right.goalRevision
    && left.phase === right.phase
    && left.objective === right.objective
}

/** Whether two TODO views state the same authoritative value. */
function sameTodoView(left: TaskStateTodoView, right: TaskStateTodoView): boolean {
  if (left.status !== right.status || left.items.length !== right.items.length) return false
  for (let index = 0; index < left.items.length; index += 1) {
    const a = left.items[index]
    const b = right.items[index]
    if (a === undefined || b === undefined) return false
    if (a.content !== b.content || a.status !== b.status) return false
  }
  return true
}

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
export function todoReferencesOf(view: TaskStateTodoView, maxEntryBytes: number): readonly TaskStateTodoReference[] {
  if (view.status !== 'current' || view.sourceSeq === undefined) return []
  // A bound below the truncation marker cannot produce a valid bounded value at
  // all, so no reference is derived instead of throwing inside a commit path.
  if (maxEntryBytes < MARKER_BYTES) return []
  const parts: string[] = []
  for (const item of view.items) {
    const content = item.content.trim()
    if (content.length === 0) continue
    parts.push(`${content} [${item.status}]`)
  }
  if (parts.length === 0) return []
  const text = boundUtf8(parts.join('; '), maxEntryBytes).text
  if (text.length === 0) return []
  return [{ seq: view.sourceSeq, content: text }]
}

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
export function resolveAuthorityViews(
  events: readonly TaskStateFilteredEvent[],
  base: TaskStateStable | null,
  limits: { readonly maxEntryBytes: number },
): TaskStateAuthorityResolution {
  const baseGoal = base?.goalView ?? NO_GOAL_VIEW
  const baseTodo = base?.todoView ?? NO_TODO_VIEW

  let goalView: TaskStateGoalView | undefined
  let todoView: TaskStateTodoView | undefined
  for (const event of events) {
    const goal = goalViewOf(event)
    if (goal !== undefined) goalView = goal
    const todo = todoViewOf(event)
    if (todo !== undefined) todoView = todo
  }

  const resolvedGoal = goalView ?? baseGoal
  const resolvedTodo = todoView ?? baseTodo
  const goalChanged = goalView !== undefined && !sameGoalView(resolvedGoal, baseGoal)
  const todoChanged = todoView !== undefined && !sameTodoView(resolvedTodo, baseTodo)
  const changed: TaskStateAuthorityViewName[] = []
  const cleared: TaskStateAuthorityViewName[] = []
  if (goalChanged) changed.push('goal')
  if (todoChanged) changed.push('todo')
  if (goalChanged && resolvedGoal.status === 'cleared' && baseGoal.status === 'current') cleared.push('goal')
  if (todoChanged && resolvedTodo.status === 'cleared' && baseTodo.status === 'current') cleared.push('todo')

  return {
    goalView: resolvedGoal,
    todoView: resolvedTodo,
    changed,
    cleared,
    todoReferences: todoReferencesOf(resolvedTodo, limits.maxEntryBytes),
    goalChanged,
    todoChanged,
  }
}

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
export function authorityUrgency(
  event: TaskStateFilteredEvent,
  base: TaskStateStable | null,
): TaskStateAuthorityViewName | undefined {
  if (event.type === 'todo/write') {
    return todoViewOf(event) === undefined ? undefined : 'todo'
  }
  if (event.type !== 'goal/change') return undefined
  const goal = goalViewOf(event)
  if (goal === undefined) return undefined
  return sameGoalView(goal, base?.goalView ?? NO_GOAL_VIEW) ? undefined : 'goal'
}
