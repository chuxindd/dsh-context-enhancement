/**
 * Exact auxiliary model instruction and deterministic framing for one
 * collect-and-merge request. The instruction text is pinned verbatim in the
 * request audit row so replay reconstructs the identical model input; the
 * per-request projection frame is JSON that the filter rebuilds from the
 * exact included event sequences and the retained filter implementation.
 * @module dsh-context-enhancement/internal/task-state/basic/prompt
 */
import type { TaskStateStable, TaskStateTruncationRecord } from '../contract/types.ts';
import type { TaskStateFilteredEvent } from './types.ts';
/** Input schema version the framed output must satisfy (pinned v2). */
export declare const TASK_STATE_INPUT_SCHEMA_VERSION = 2;
/** One parsed content-value schema version this provider writes. */
export declare const TASK_STATE_STABLE_SCHEMA_VERSION = 2;
/**
 * The pinned auxiliary system instruction. It describes the exact expected
 * output as JSON (facts, decisions, constraints, risks, evidence, and
 * continuation state), the Host-owned id rules, the authoritative Goal/TODO
 * view rules, and the constraints the Host enforces.
 */
export declare const TASK_STATE_SYSTEM_INSTRUCTION: string;
/**
 * Build the deterministic model-visible input frame for one batch. The frame
 * is the owned JSON that filter v3 reconstructs from the exact included
 * sequences: previous stable content (or null), the authoritative Goal/TODO
 * views of this exact window with their replace/clear provenance, the filter
 * version, the input schema version, the deterministic event projections, and
 * the truncation records. The caller bounds the serialized frame to the batch
 * input budget.
 *
 * The frame's `authorityViews` block is what conveys the replace/clear
 * semantics to the model: `changed` lists the views this window replaced with
 * a newer authority fact and `cleared` lists the views it emptied, so a window
 * holding no authority fact is plainly the ordinary fact-delta case. Ordinary
 * windows are NOT replayed as stable content — the event projections stay the
 * same bounded delta they always were.
 * @param input - base stable, projected events, and truncation records.
 * @returns the serialized deterministic model-visible frame.
 */
export declare function frameProjection(input: {
    readonly base: TaskStateStable | null;
    readonly events: readonly TaskStateFilteredEvent[];
    readonly truncation: readonly TaskStateTruncationRecord[];
}): string;
//# sourceMappingURL=prompt.d.ts.map