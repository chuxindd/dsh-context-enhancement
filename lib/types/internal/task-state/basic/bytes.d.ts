/**
 * Deterministic UTF-8 byte bounding shared by the task-state input filter and
 * the Host semantic validation of model output. Every bound is explicit and
 * marked with a fixed U+2026 suffix so replay and diagnostics can tell exactly
 * where and how a value was cut. Code points are the cutting unit, so no
 * multibyte character is ever split.
 * @module dsh-context-enhancement/internal/task-state/basic/bytes
 */
/** Deterministic marker appended to any truncated value. */
export declare const TRUNCATION_MARKER = "\u2026";
/** UTF-8 byte length of {@link TRUNCATION_MARKER}. */
export declare const MARKER_BYTES: number;
/** One deterministic, marked truncation applied to a field. */
export interface ByteBoundResult {
    /** The retained text, at or under `limitBytes` UTF-8 bytes. */
    readonly text: string;
    /** Whether the value exceeded the bound and was cut. */
    readonly truncated: boolean;
    /** UTF-8 bytes retained after truncation (includes the marker when cut). */
    readonly keptBytes: number;
}
/**
 * Bound a string to an explicit UTF-8 byte limit, cutting on code-point
 * boundaries so no multibyte character is split. The cut appends the fixed
 * {@link TRUNCATION_MARKER} and never exceeds the limit; an empty value at a
 * limit below the marker size keeps only the marker.
 * @param value - the string to bound.
 * @param limitBytes - explicit UTF-8 byte limit.
 * @returns the retained text and the truncation facts.
 */
export declare function boundUtf8(value: string, limitBytes: number): ByteBoundResult;
/**
 * Bound a JSON-safe string field, appending one truncation record when the
 * bound cut the value.
 * @param path - dotted field path recorded on the truncation record.
 * @param value - the string to bound.
 * @param limitBytes - explicit UTF-8 byte limit.
 * @param records - mutable truncation accumulator this call appends to.
 * @returns the bounded text.
 */
export declare function boundField(path: string, value: string, limitBytes: number, records: {
    path: string;
    limitBytes: number;
    keptBytes: number;
}[]): string;
//# sourceMappingURL=bytes.d.ts.map