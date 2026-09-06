/**
 * Versioned Host semantic validation of one auxiliary task-state candidate
 * against the committed base and the batch window. It parses nothing (the
 * caller parses with `JSON.parse` and the contract schema), mints Host-owned
 * branded ids for new entries, verifies echoed ids exist in the base, applies
 * the complete-candidate update rules, bounds every retained value with the
 * configured UTF-8 byte and item limits, verifies every evidence and TODO
 * reference points into the folded batch window, and computes the stable
 * digest over the normalized content. Any failure rejects the complete
 * candidate; the previous stable and cursor stay untouched.
 * @module dsh-context-enhancement/internal/task-state/basic/host
 */
import { type TaskStateCandidate, type TaskStateStable, type TaskStateStableContent } from '../contract/index.ts';
import type { CandidateHostContext } from './types.ts';
/**
 * Verify one candidate parses against the contract candidate schema.
 * @param raw - the parsed model output to validate.
 * @returns the schema-validated candidate content.
 * @throws when the value does not satisfy the contract candidate schema.
 */
export declare function parseCandidate(raw: unknown): TaskStateCandidate;
/**
 * Normalize one parsed candidate into committed content. Steps, in order:
 * check per-kind count and per-list item limits; bound every retained entry,
 * continuation, evidence note, and TODO content; verify every echoed id exists
 * in the base, is used in the list whose kind matches its prefix, echoes the
 * base content VERBATIM, and is unique across the complete candidate; mint ids
 * for every new entry; require every evidence and TODO reference sequence to be
 * one of the exact folded eligible sequences; then validate the fully id-ed
 * content against the committed-content schema.
 * @param candidate - parsed and schema-validated candidate content.
 * @param context - durable base and folded-window facts.
 * @returns the normalized committed content.
 */
export declare function normalizeCandidate(candidate: TaskStateCandidate, context: CandidateHostContext): TaskStateStableContent;
/**
 * Compute the SHA-256 digest over one stable's normalized structured content.
 * @param content - normalized committed content to digest.
 * @returns lowercase hex digest of the content's JSON serialization.
 */
export declare function digestOf(content: TaskStateStableContent): string;
/**
 * Build the committed stable from normalized content and Host-owned metadata.
 * @param content - normalized committed content.
 * @param schemaVersion - stable content schema version.
 * @param revision - next monotonic revision (base revision + 1, or 1 first).
 * @param filterVersion - deterministic input-filter version that produced the projection.
 * @param sourceCursor - last eligible sequence actually folded.
 * @returns the immutable committed stable.
 */
export declare function commitStable(content: TaskStateStableContent, schemaVersion: number, revision: number, filterVersion: string, sourceCursor: number): TaskStateStable;
export type { CandidateHostContext };
//# sourceMappingURL=host.d.ts.map