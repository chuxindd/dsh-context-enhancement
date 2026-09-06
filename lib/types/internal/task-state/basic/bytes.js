/**
 * Deterministic UTF-8 byte bounding shared by the task-state input filter and
 * the Host semantic validation of model output. Every bound is explicit and
 * marked with a fixed U+2026 suffix so replay and diagnostics can tell exactly
 * where and how a value was cut. Code points are the cutting unit, so no
 * multibyte character is ever split.
 * @module dsh-context-enhancement/internal/task-state/basic/bytes
 */
import { Buffer } from 'node:buffer';
/** Deterministic marker appended to any truncated value. */
export const TRUNCATION_MARKER = '…';
/** UTF-8 byte length of {@link TRUNCATION_MARKER}. */
export const MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
/**
 * Bound a string to an explicit UTF-8 byte limit, cutting on code-point
 * boundaries so no multibyte character is split. The cut appends the fixed
 * {@link TRUNCATION_MARKER} and never exceeds the limit; an empty value at a
 * limit below the marker size keeps only the marker.
 * @param value - the string to bound.
 * @param limitBytes - explicit UTF-8 byte limit.
 * @returns the retained text and the truncation facts.
 */
export function boundUtf8(value, limitBytes) {
    const actualBytes = Buffer.byteLength(value, 'utf8');
    if (actualBytes <= limitBytes) {
        return { text: value, truncated: false, keptBytes: actualBytes };
    }
    if (limitBytes < MARKER_BYTES) {
        throw new Error(`task-state-basic: byte limit ${limitBytes} is below the marker size ${MARKER_BYTES}`);
    }
    let kept = '';
    let keptBytes = 0;
    for (const codePoint of value) {
        const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
        if (keptBytes + codePointBytes + MARKER_BYTES > limitBytes)
            break;
        kept += codePoint;
        keptBytes += codePointBytes;
    }
    return {
        text: `${kept}${TRUNCATION_MARKER}`,
        truncated: true,
        keptBytes: keptBytes + MARKER_BYTES,
    };
}
/**
 * Bound a JSON-safe string field, appending one truncation record when the
 * bound cut the value.
 * @param path - dotted field path recorded on the truncation record.
 * @param value - the string to bound.
 * @param limitBytes - explicit UTF-8 byte limit.
 * @param records - mutable truncation accumulator this call appends to.
 * @returns the bounded text.
 */
export function boundField(path, value, limitBytes, records) {
    const result = boundUtf8(value, limitBytes);
    if (result.truncated) {
        records.push({ path, limitBytes, keptBytes: result.keptBytes });
    }
    return result.text;
}
//# sourceMappingURL=bytes.js.map