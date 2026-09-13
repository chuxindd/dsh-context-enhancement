/**
 * Prompt consumer for durable task state (`dsh-context-enhancement/task-state-prompt`).
 *
 * MODEL-VISIBLE DELIVERY IS A PLUGIN-OWNED FIXED SLOT
 * ---------------------------------------------------
 * One Session lifecycle carries AT MOST ONE model-visible Stable task-state
 * slot: a `user/message` surface node whose `source.kind` is
 * `task-state-slot`. The first committed stable CREATES the slot with a plain
 * surface append; every later committed revision REPLACES that exact node with
 * `surfaceOp: { op: 'replace', start, end }` plus `sourceEventSeqs: [start]`,
 * so the previous revision stops being model-visible instead of accumulating.
 *
 * Why the delivery is not the dynamic runtime context anymore
 * ----------------------------------------------------------
 * The `{{task_state_snapshot}}` runtime-context contribution is still
 * registered (the template and the variable name stay reserved, and an
 * unregistered variable would make assembly throw), but its value is the empty
 * string. DSH's agent loop is the only writer of that projection and it appends
 * (`packages/core/agent-loop/src/agent.ts`: `surfaceOp: 'append'`), with no
 * plugin-visible boundary between its append and the request derived from the
 * surface; shadowing its node does not converge either, because
 * `RuntimeContextProjection` re-emits an unchanged snapshot once its retained
 * node is replaced. Any non-empty value here therefore re-enters the
 * append-only projection that E08 measured (one visible snapshot per revision).
 * The legal replacement channel is the plugin's own append, which is what this
 * module uses.
 *
 * WHERE THE SLOT IS MAINTAINED, AND WHY IT IS SAFE HERE
 * -----------------------------------------------------
 * Maintenance runs on the `agent/pre-step` waterfall — the step boundary the
 * host dispatches before `step/start`, before the claimed messages are
 * appended, and before the request is derived. That is outside every
 * `Session.append()` publication, so the append is legal: an observer of
 * `session/event` may NOT append (the store rejects a reentrant append while
 * another append is being published). Nothing is appended during prompt
 * assembly, so an assembly-only consumer performs no session side effect, and a
 * step the loop rejects (or an aborted turn) is left untouched, because no
 * request would ever read the node.
 *
 * INDEPENDENT INJECTION BUDGET I & STALENESS
 * ------------------------------------------
 * - Injection tokens are bounded by independent token budget I (maxTokens).
 * - maxBytes and maxTokens act as independent dual bounds; neither fakes the other.
 * - Authoritative Goal and TODO views render first and verbatim. If even the
 *   authoritative representation cannot fit within budget I or maxBytes, slot
 *   maintenance fails closed (typed blocked) and injects nothing misleading.
 * - When durable cursor lags eligible session events, text carries an explicit
 *   stale marker and source metadata records staleness: 'stale'. Once a catch-up
 *   revision is committed, staleness returns to 'fresh'.
 *
 * FAIL-CLOSED RULES
 * -----------------
 * - a replacement that throws is caught locally, counted, and appends nothing:
 *   the surface keeps exactly the node it had, so the model never sees two
 *   snapshots at once;
 * - a slot node shadowed by another surface operation (compaction) is rebuilt
 *   with a fresh generation instead of a stale replacement;
 * - two or more visible slot nodes collapse into ONE node through a single
 *   range replacement, and only when the shadowed run is contiguous; a
 *   non-contiguous run would force a range replacement over real content, so it
 *   fails closed and appends nothing;
 * - in-memory bookkeeping is fenced to the exact Session object AND lifecycle,
 *   so a resumed same-id Session re-resolves the slot from ITS OWN log, and a
 *   forked child never reuses its parent's record.
 * @module dsh-context-enhancement/internal/task-state/prompt/index
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import type { TaskStateSlotSource, TaskStateStaleness } from '../contract/types.ts';
import type { TaskStatePromptConfig } from './types.ts';
export { TASK_STATE_STALE_MARKER, TASK_STATE_TRUNCATION_MARKER, estimateSlotTokens, renderTaskStateSlot, renderTaskStateSnapshot, resolveInjectionBudget, } from './render.ts';
export type { RenderTaskStateSlotOptions, RenderTaskStateSlotResult } from './render.ts';
export type { ResolvedInjectionBudget, TaskStatePromptConfig } from './types.ts';
export { DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS, TASK_STATE_SLOT_ID, TASK_STATE_SLOT_SOURCE_KIND, isTaskStateSlotSource, } from '../contract/index.ts';
export type { TaskStateSlotSource, TaskStateSlotSourceKind, TaskStateStaleness, } from '../contract/types.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "task-state-prompt";
/**
 * Register the runtime-context contribution while `systemPrompt` is available.
 * No service key is injected for `taskState` or `sessions`: a composition
 * without a task-state provider, or without a session store, must still mount
 * cleanly (injecting nothing) rather than wait on a service.
 */
export declare const inject: string[];
/** Schemastery validation for {@link TaskStatePromptConfig}. */
export declare const Config: z<TaskStatePromptConfig>;
/** Read-only diagnostics of the slot bookkeeping (host introspection and tests). */
export interface TaskStateSlotDiagnostics {
    readonly sessionId: string;
    readonly lifecycleCreatedAt: number;
    readonly slotSeq: number;
    readonly generation: number;
    readonly revision: number;
    readonly digest: string;
    readonly textBytes: number;
    readonly failures: number;
    readonly rebuilds: number;
    readonly collisions: number;
    readonly eligibleHighWater: number;
    readonly staleness: TaskStateStaleness;
    readonly injectionTokens: number;
    readonly budgetTokens: number;
    readonly truncation: boolean;
}
/**
 * Read the in-memory slot bookkeeping of every prompt consumer mounted in one
 * context's root.
 * @param ctx - Any context of the application (a plugin context works).
 * @returns One entry per Session a mounted consumer currently holds a slot for;
 *   empty for an unmounted or disposed consumer.
 */
export declare function taskStateSlotDiagnostics(ctx: Context): readonly TaskStateSlotDiagnostics[];
/**
 * Whether one logged slot node belongs to THIS Session lifecycle.
 *
 * A slot node is durable evidence of one lifecycle's own delivery, so it names
 * the Session id and lifecycle epoch that wrote it. Both must match the live
 * Session: a node inherited through a fork prefix names the PARENT's id and the
 * PARENT's epoch, and adopting it would make the child's in-memory bookkeeping
 * claim a node its own lifecycle never wrote — the child would then never
 * publish its own snapshot, and a later collapse would report the parent's node
 * as the child's own revision.
 *
 * Matching is by the durable `(sessionId, lifecycleCreatedAt)` pair alone, never
 * by content: an identical revision/digest/text is not ownership, because a
 * child that inherited the parent's prefix can legitimately hold a node whose
 * content its own stable also renders.
 * @param session - the live Session whose ownership is being decided.
 * @param source - the logged slot source of one candidate node.
 * @returns true when this exact lifecycle wrote the node.
 */
export declare function isOwnSlotNode(session: Session, source: Pick<TaskStateSlotSource, 'sessionId' | 'lifecycleCreatedAt'>): boolean;
/**
 * Register the reserved `{{task_state_snapshot}}` context and variable, and the
 * step-boundary slot maintenance that owns the single model-visible Stable slot.
 * @param ctx - plugin context; the registrations dispose with it.
 * @param config - the deployment byte and token budgets for one rendered snapshot.
 */
export declare function apply(ctx: Context, config: TaskStatePromptConfig): void;
//# sourceMappingURL=index.d.ts.map