/**
 * Deterministic versioned input filter for the task-state auxiliary request.
 * It folds a batch window of Session events into an owned, bounded, lossless
 * JSON projection of the durable fields the task-state model needs and
 * excludes raw reasoning, chunks, binary data, presentation metadata,
 * transport and UI events, live objects, and the task-state audit events
 * themselves. The original Session events are never mutated: `tool/call.arguments`
 * is parsed only inside the derived projection. Every field is explicitly
 * UTF-8-bounded with deterministic marked truncation.
 *
 * The filter reads plugin-owned event vocabulary (goal/change, todo/write,
 * plan/mode, command/run, request/header, agent-preset/selected,
 * compaction/start, compaction/end) through a widened JSON view instead of
 * importing each producer package's type merge: the projection is a pure
 * function of the lossless durable JSON.
 *
 * @module dsh-context-enhancement/internal/task-state/basic/filter
 */
/** Deterministic filter version recorded on requests and committed stables. */
export declare const TASK_STATE_FILTER_VERSION = "task-state-basic/filter-v2";
/** Explicit per-field UTF-8 byte limits of the filter projection. */
export interface FilterFieldLimits {
    /** Direct human or goal-continuation text. */
    readonly userMessageBytes: number;
    /** Final assistant text. */
    readonly assistantMessageBytes: number;
    /** Tool-call name. */
    readonly toolNameBytes: number;
    /** Serialized tool-call argument projection. */
    readonly toolArgumentsBytes: number;
    /** Concatenated tool-result text. */
    readonly toolResultTextBytes: number;
    /** Serialized tool-result meta projection. */
    readonly toolResultMetaBytes: number;
    /** One JSON-object leaf string inside a parsed tool value. */
    readonly jsonLeafStringBytes: number;
    /** Error diagnostic (name/code/message). */
    readonly errorBytes: number;
    /** Command name and args. */
    readonly commandBytes: number;
    /** Goal and todo single-field text. */
    readonly stateBytes: number;
}
/** Shipped default per-field byte limits (whole-batch budget stays deployment config). */
export declare const DEFAULT_FILTER_FIELD_LIMITS: Readonly<FilterFieldLimits>;
/** Widened view of one lossless Session event read by the filter. */
export interface RawSessionEvent {
    readonly type: string;
    readonly seq: number;
    readonly data: unknown;
}
/** One bounded leaf of a parsed tool value. */
export interface BoundedLeaf {
    /** Deterministic dotted path to the leaf. */
    readonly path: string;
    /** Bounded leaf text. */
    readonly value: string;
}
/** One deterministic, marked truncation applied to a field. */
export interface FilterTruncation {
    readonly path: string;
    readonly limitBytes: number;
    readonly keptBytes: number;
}
/** The complete owned projection of one eligible event. */
export interface FilteredEvent {
    readonly seq: number;
    readonly type: string;
    readonly fields: unknown;
}
/** One whole eligible event projection plus its truncations. */
export interface FilterResult {
    readonly event: FilteredEvent;
    readonly truncation: readonly FilterTruncation[];
}
/**
 * Whether one event type is eligible for the task-state source filter.
 * The task-state audit events and every excluded presentation/transport/chunk
 * type are never eligible. The task-state audit events no longer exist as
 * Session events in this implementation (they are storage-domain rows), but
 * the names stay reserved so an older log that did record them (or a foreign
 * producer) can never feed the fold.
 * @param type - Session event type.
 * @returns whether the filter may fold the event.
 */
export declare function isEligibleType(type: string): boolean;
/**
 * Filter one Session event: decide eligibility and project owned durable
 * fields when the event is eligible AND projects meaningful content.
 * @param event - candidate Session event.
 * @param limits - explicit field byte limits.
 * @returns the owned projection plus the truncation records applied, or `null`
 *   when the event is ineligible or projects nothing meaningful.
 */
export declare function filterEvent(event: RawSessionEvent, limits?: FilterFieldLimits): FilterResult | null;
/**
 * Measure the serialized UTF-8 byte length of one JSON value.
 * @param value - the JSON value to serialize and measure.
 * @returns UTF-8 byte length of the value's JSON serialization.
 */
export declare function jsonBytes(value: unknown): number;
//# sourceMappingURL=filter.d.ts.map