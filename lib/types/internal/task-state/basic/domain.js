/**
 * Storage-domain declaration for authoritative durable task state. The
 * provider opens this one process-global domain with the `single` layout so a
 * damaged or incompatible document fails activation loudly as a whole instead
 * of being read as an empty medium.
 *
 * Two tables:
 * - `sessions`, keyed directly by the Session id, holds the authoritative
 *   lifecycle-fenced record (identity + latest committed stable);
 * - `audit`, keyed by the Host-minted request id, holds the per-request
 *   open/finished phases (the pre-dispatch request evidence and its outcome).
 *
 * The audit table is diagnostic-only: it never becomes a second state
 * authority, and there is no cross-table atomicity assumption between the two
 * tables.
 * @module dsh-context-enhancement/internal/task-state/basic/domain
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { taskStateAuditSchema, taskStateRecordSchema, } from "../contract/index.js";
/**
 * Domain identity and durable schemas of the authoritative task-state store.
 * The name is deliberately deployment-owned (`context_enhancement_task_state`)
 * so an install of this bundle never collides with an upstream `task_state`
 * domain of a different format.
 */
export const taskStateDomainSpec = defineDomain({
    name: 'context_enhancement_task_state',
    version: 1,
    layout: 'single',
    tables: {
        sessions: domainTable(taskStateRecordSchema),
        audit: domainTable(taskStateAuditSchema),
    },
});
/** The two declared table names, in spec order. */
export const TASK_STATE_SESSIONS_TABLE = 'sessions';
export const TASK_STATE_AUDIT_TABLE = 'audit';
//# sourceMappingURL=domain.js.map