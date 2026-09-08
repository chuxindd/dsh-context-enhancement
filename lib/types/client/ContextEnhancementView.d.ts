/**
 * Conversation-view Tab "上下文优化" (contextEnhancement): a flat rendering
 * and controlled editor for one Session's committed {@link TaskStateStable}.
 *
 * The view reads its Session's stable out of the shared
 * {@link TaskStateControlMirror} through the per-Session source the entry's
 * inject face provides (`useTaskState`). Edits travel through the plugin-owned
 * Host Remote and replace the authoritative stable under revision control.
 *
 * ## States the view renders
 *
 * - `connecting` — the shared Remote mirror has not applied an opening
 *   baseline yet (or the Host proxy namespace is absent): the loading state.
 * - `error` — the stream failed terminally: an error state with a retry
 *   affordance (keeps the last applied stable readable when one exists).
 * - `live` with `stable === null` — the Host reported no committed stable
 *   for this Session. The Session preset selects either the waiting-for-first-
 *   summary state or the non-contextual state.
 * - `live` with a stable whose content has no entries — the "folded, but
 *   nothing has been folded yet" empty state.
 * - `live` with a committed stable — the flat summary body.
 *
 * The flat body tiles the stable's whole durable content: the meta row
 * (revision / sourceCursor / digest), the continuation (currentObjective,
 * currentFocus, openWork, nextActions), and the four kinded lists plus
 * evidence and todo references. The eight authored summary fields are editable;
 * evidence and todo references remain derived, read-only provenance.
 *
 * @module dsh-context-enhancement/client/ContextEnhancementView
 */
import type { PropsLocale, PropsRuntime, HostObservable } from '@deepseek-ai/dsh-client-ui-slots';
import type { TaskStateControlSessionState } from './task-state-control-store.ts';
import type { NS } from './locales.ts';
import type { TaskStateEditRequest, TaskStateEditResult } from '../internal/task-state/control/types.ts';
/** Owner currency of the conversation-view entry (rendered one at a time). */
export type ContextEnhancementViewOwnerProps = {
    /** Focus request addressed to the selected View (currently unused). */
    readonly viewRequest: {
        readonly view: string;
        readonly focus: string;
    } | null;
};
/** Full props the conversation-view entry composes for this tab. */
export type ContextEnhancementViewProps = PropsRuntime<'conversation.view'> & {
    /** Per-Session source over the shared task-state mirror (entry-injected). */
    useTaskState: () => HostObservable<TaskStateControlSessionState>;
    /** Retry after a terminal stream failure (entry-injected). */
    retryTaskState: () => void;
    /** Commit a user-authored stable replacement through the Host. */
    editTaskState: (request: TaskStateEditRequest) => Promise<TaskStateEditResult>;
} & PropsLocale<typeof NS>;
/**
 * The "上下文优化" conversation view tab.
 * @param props - session kit, per-Session task-state source, locale seat.
 * @returns the summary surface with a revision-controlled editor.
 */
export declare function ContextEnhancementView({ sessionId, useSessions, useProjection, useTaskState, retryTaskState, editTaskState, t, }: ContextEnhancementViewProps): import("react").JSX.Element;
//# sourceMappingURL=ContextEnhancementView.d.ts.map