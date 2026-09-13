/**
 * Storage-domain declaration for authoritative durable task state. The
 * provider opens this one process-global domain with the `single` layout so a
 * damaged or incompatible document fails activation loudly as a whole instead
 * of being read as an empty medium.
 *
 * Two tables:
 * - `sessions`, keyed directly by the Session id, holds the authoritative
 *   lifecycle-fenced record: identity, the latest committed stable WHEN one
 *   exists, and the latest durable terminal verdict WHEN one was measured;
 * - `audit`, keyed by the Host-minted request id, holds the per-request
 *   open/finished phases (the pre-dispatch request evidence and its outcome).
 *
 * ATOMIC BOUNDARY (measured against the DSH storage API, not assumed): the
 * domain layer serializes writes on ONE per-domain chain, but every
 * `KvTable.put` is its own durable unit operation — in the `single` layout each
 * one republishes the WHOLE document (`dsh-storage-json` `writeAtomic`). Two
 * table puts are therefore two whole-file replacements, and there is NO
 * cross-table transaction to be had (the domain contract says so explicitly).
 * The only atomic durable boundary available to this plugin is ONE record in
 * ONE table. That is why the optional stable, the optional terminal verdict,
 * and the cursor the verdict carries all live inside the ONE `sessions` record:
 * a terminal verdict and the committed state it advances are written by a
 * single put, and a crash between them is impossible by construction. The
 * `audit` table is diagnostic and is written strictly AFTER that authority put,
 * so a lost audit row is a diagnostic gap and never a state claim.
 *
 * CLEAN BREAK (explicitly authorized): this generation is a NEW domain identity
 * `context_enhancement_task_state_v2` at version 2. The previous
 * `context_enhancement_task_state` v1 document is never read, never opened,
 * never migrated and never rewritten — it is not even the unit this descriptor
 * resolves to (the JSON backend derives the file name from the domain name).
 * `version: 2` additionally makes a document stamped for another format version
 * reject the whole open (`version-mismatch`), which is the fail-closed lever
 * for any document that does carry this name.
 * @module dsh-context-enhancement/internal/task-state/basic/domain
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { taskStateAuditSchema, taskStateRecordSchema, } from "../contract/index.js";
/**
 * Domain identity and durable schemas of the authoritative task-state store.
 * The name is deliberately deployment-owned and version-suffixed so an install
 * of this bundle never collides with an upstream `task_state` domain of a
 * different format — and so the incompatible v1 document of this same plugin is
 * left untouched on the medium instead of being reinterpreted.
 */
export const taskStateDomainSpec = defineDomain({
    name: 'context_enhancement_task_state_v2',
    version: 2,
    layout: 'single',
    tables: {
        sessions: domainTable(taskStateRecordSchema),
        audit: domainTable(taskStateAuditSchema),
    },
});
/**
 * The RETIRED domain name of the previous, incompatible generation. It exists
 * only so diagnostics and tests can name the medium this build refuses to read:
 * no code path of this provider opens, reads, migrates, or deletes that unit,
 * and the JSON backend never resolves {@link taskStateDomainSpec} to its file.
 */
export const TASK_STATE_LEGACY_DOMAIN_NAME = 'context_enhancement_task_state';
/** The two declared table names, in spec order. */
export const TASK_STATE_SESSIONS_TABLE = 'sessions';
export const TASK_STATE_AUDIT_TABLE = 'audit';
//# sourceMappingURL=domain.js.map