/**
 * Deterministic UTF-8-byte-bounded and token-bounded rendering of one committed
 * task-state stable for the main model. The renderer is a pure function of the
 * stable plus the deployment's byte and token budgets: it never reads storage,
 * consults a Session, appends an event, or awaits, and it never mutates or
 * re-authorizes the stable.
 *
 * The authoritative Goal and TODO views render first and verbatim from the
 * committed views, so the model always sees the state the Session is committed
 * to; a cleared view renders as an explicit clear rather than as an absent
 * section. Truncation drops whole lines from the tail (evidence first, then
 * facts/decisions/risks, then continuation) and appends a fixed marker, so no
 * UTF-8 codepoint is ever split and the returned text always fits both budgets.
 * If even the authoritative minimum representation cannot fit within budget I
 * or maxBytes, it fails closed (typed block) and injects nothing misleading.
 * @module dsh-context-enhancement/internal/task-state/prompt/render
 */
import type { Message } from '@deepseek-ai/dsh-llm';
import { TASK_STATE_STALE_MARKER } from '../contract/index.ts';
import type { TaskStateStable, TaskStateStaleness } from '../contract/types.ts';
import type { ResolvedInjectionBudget, TaskStatePromptConfig } from './types.ts';
/** Fixed model-visible marker appended when a bounded render dropped any line. */
export declare const TASK_STATE_TRUNCATION_MARKER = "[Task-state snapshot truncated; the committed durable state remains authoritative.]";
/** Fixed model-visible marker displayed when the stable cursor lags session eligible high-water. */
export { TASK_STATE_STALE_MARKER };
/** Resolve the single injection budget from deployment config with conservative defaults. */
export declare function resolveInjectionBudget(config: TaskStatePromptConfig): ResolvedInjectionBudget;
/**
 * Estimate tokens for a slot message text using the real tokenMeter when available,
 * with an audited conservative fallback (CJK and structural overhead aware).
 */
export declare function estimateSlotTokens(text: string, meter?: {
    estimateMessage(message: Message): number;
}): number;
/** Options for slot rendering and bounding. */
export interface RenderTaskStateSlotOptions {
    readonly maxBytes: number;
    readonly maxTokens?: number;
    readonly eligibleHighWater?: number;
    readonly meter?: {
        estimateMessage(message: Message): number;
    } | undefined;
}
/** Result of slot rendering with full metadata for source and diagnostics. */
export interface RenderTaskStateSlotResult {
    readonly text: string;
    readonly staleness: TaskStateStaleness;
    readonly truncation: boolean;
    readonly injectionTokens: number;
    readonly budgetTokens: number;
    readonly eligibleHighWater: number;
    readonly blocked: boolean;
}
/**
 * Render one committed stable as a bounded slot snapshot.
 *
 * Checks both byte budget (maxBytes) and token budget I (maxTokens).
 * Enforces authoritative minimum representation priority: Goal and TODO views
 * render first and verbatim. If even the authoritative minimum cannot fit within
 * both budgets, fails closed (blocked). Truncation drops low-priority sections
 * (evidence first, then facts/decisions/risks, then continuation) and appends
 * the fixed truncation marker.
 */
export declare function renderTaskStateSlot(stable: TaskStateStable, options: RenderTaskStateSlotOptions): RenderTaskStateSlotResult;
/**
 * Bounded rendering of one committed stable deterministically within a UTF-8 byte budget.
 * Retained for backward compatibility with existing tests and callers.
 */
export declare function renderTaskStateSnapshot(stable: TaskStateStable, maxBytes: number): string;
//# sourceMappingURL=render.d.ts.map