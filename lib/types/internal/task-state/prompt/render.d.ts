/**
 * Deterministic UTF-8-byte-bounded rendering of one committed task-state stable
 * for the main model. The renderer is a pure function of the stable plus the
 * deployment's byte budget: it never reads storage, consults a Session, appends
 * an event, or awaits, and it never mutates or re-authorizes the stable.
 * Truncation drops whole lines from the tail and appends a fixed marker, so no
 * UTF-8 codepoint is ever split and the returned text always fits the budget.
 * @module dsh-context-enhancement/internal/task-state/prompt/render
 */
import type { TaskStateStable } from '../contract/types.ts';
/** Fixed model-visible marker appended when a bounded render dropped any line. */
export declare const TASK_STATE_TRUNCATION_MARKER = "[Task-state snapshot truncated; the committed durable state remains authoritative.]";
/**
 * Render one committed stable deterministically within a UTF-8 byte budget.
 *
 * When the full render fits, it is returned verbatim. Otherwise whole lines are
 * taken from the head while the next line still fits beside the fixed
 * truncation marker, and the marker is appended to whatever prefix survived, so
 * the result never exceeds `maxBytes`, never splits a codepoint, and never
 * pretends to be complete. When even the first line cannot fit beside the
 * marker, an empty string is returned.
 * @param stable - the committed stable to present; its authority is untouched.
 * @param maxBytes - maximum UTF-8 bytes of the returned text; must be a
 *   non-negative safe integer.
 * @returns the bounded model-facing rendering of the stable.
 */
export declare function renderTaskStateSnapshot(stable: TaskStateStable, maxBytes: number): string;
//# sourceMappingURL=render.d.ts.map