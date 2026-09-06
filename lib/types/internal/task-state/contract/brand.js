/**
 * Host-minted opaque identities of the durable task-state domain: the branded
 * request id that keys one audit row (and pairs its open and finished phases)
 * and the branded entry id that names one committed fact, decision, constraint,
 * or risk. Branding reuses `@deepseek-ai/dsh-brand` so the values stay
 * nominally typed at every same-process boundary without owning runtime state.
 * @module dsh-context-enhancement/internal/task-state/contract/brand
 */
/**
 * Brand a Host-minted task-state request id.
 * @param id - opaque request identity.
 * @returns the same string, branded; no validation is performed.
 */
export function TaskStateRequestId(id) {
    return id;
}
/**
 * Brand a Host-minted task-state entry id.
 * @param id - opaque entry identity.
 * @returns the same string, branded; no validation is performed.
 */
export function TaskStateEntryId(id) {
    return id;
}
//# sourceMappingURL=brand.js.map