/**
 * Host-minted opaque identities of the durable task-state domain: the branded
 * request id that keys one audit row (and pairs its open and finished phases)
 * and the branded entry id that names one committed fact, decision, constraint,
 * or risk. Branding reuses `@deepseek-ai/dsh-brand` so the values stay
 * nominally typed at every same-process boundary without owning runtime state.
 * @module dsh-context-enhancement/internal/task-state/contract/brand
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
/**
 * Host-minted opaque identity of one auxiliary task-state collect-and-merge
 * request. It keys the single audit record that carries the request's open
 * (pre-dispatch) phase and its finished outcome, and never repeats across
 * requests.
 */
export type TaskStateRequestId = Branded<'TaskStateRequestId'>;
/**
 * Brand a Host-minted task-state request id.
 * @param id - opaque request identity.
 * @returns the same string, branded; no validation is performed.
 */
export declare function TaskStateRequestId(id: string): TaskStateRequestId;
/**
 * Opaque identity of one durable task-state entry. New facts, decisions,
 * constraints, and risks receive Host-minted type-prefixed UUIDs such as
 * `fact-<uuid>`; the auxiliary model may echo an existing id but never mints
 * one. The brand is opaque: no UUID-format runtime check exists — minting and
 * validating the format is the Host durable boundary, owned by the provider
 * at commit.
 */
export type TaskStateEntryId = Branded<'TaskStateEntryId'>;
/**
 * Brand a Host-minted task-state entry id.
 * @param id - opaque entry identity.
 * @returns the same string, branded; no validation is performed.
 */
export declare function TaskStateEntryId(id: string): TaskStateEntryId;
//# sourceMappingURL=brand.d.ts.map