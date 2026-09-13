/**
 * Versioned Host semantic validation of one auxiliary task-state candidate
 * against the committed base and the batch window. It parses nothing (the
 * caller parses with `JSON.parse` and the contract schema), mints Host-owned
 * branded ids for new entries, verifies echoed ids exist in the base, applies
 * the complete-candidate update rules, bounds every retained value with the
 * configured UTF-8 byte and item limits, keeps every evidence reference that
 * points into the folded batch window while quarantining (dropping, with a
 * diagnostic) any reference that points outside it, commits the authoritative
 * Goal/TODO views the window resolved (never a model-proposed value), and
 * computes the stable digest over the normalized content. A semantic failure
 * still rejects the complete candidate; the previous stable and cursor stay
 * untouched.
 * @module dsh-context-enhancement/internal/task-state/basic/host
 */
import { type TaskStateCandidate, type TaskStateInheritedPrefix, type TaskStateStable, type TaskStateStableContent } from '../contract/index.ts';
import type { CandidateHostContext, TaskStateReferenceQuarantine } from './types.ts';
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
 * continuation field, and evidence note; verify every echoed id exists in the
 * base, is used in the list whose kind matches its prefix, echoes the base
 * content VERBATIM, and is unique across the complete candidate; mint ids for
 * every new entry; keep every evidence reference whose sequence is one of the
 * exact folded eligible sequences while QUARANTINING (dropping, with a
 * diagnostic) any reference pointing outside the window — a stale reference
 * carried forward from a previous window can never become eligible again, so
 * failing the whole candidate on it would freeze every future update at the
 * last committed revision; commit the Host-resolved authoritative Goal/TODO
 * views and their derived TODO reference from `context.authority`; then
 * validate the fully id-ed content against the committed-content schema. No
 * sequence is ever fabricated for a quarantined reference: only the invalid
 * reference is dropped, valid references and every other summary field are
 * preserved.
 * @param candidate - parsed and schema-validated candidate content.
 * @param context - durable base and folded-window facts.
 * @param onQuarantine - optional observer of each dropped stale reference.
 * @returns the normalized committed content.
 */
export declare function normalizeCandidate(candidate: TaskStateCandidate, context: CandidateHostContext, onQuarantine?: (quarantined: TaskStateReferenceQuarantine) => void): TaskStateStableContent;
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
 * @param inherited - the inherited fork boundary this coverage stops at, or
 *   `null`/absent when the lifecycle began on its own events. Metadata only: it
 *   rides beside the digest and never enters the digested content.
 * @returns the immutable committed stable.
 */
export declare function commitStable(content: TaskStateStableContent, schemaVersion: number, revision: number, filterVersion: string, sourceCursor: number, inherited?: TaskStateInheritedPrefix | null): TaskStateStable;
export type { CandidateHostContext };
//# sourceMappingURL=host.d.ts.map