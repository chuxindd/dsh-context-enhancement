/**
 * Basic durable task-state provider (`ctx.taskState`): the sole MVP owner of
 * the authoritative `context_enhancement_task_state` storage domain, the
 * published committed pointers, the versioned input filter, per-Session
 * background scheduling, independent auxiliary LLM calls, output validation,
 * private writes, and lifecycle. It subclasses the read-only Service
 * Definition; its plugin-owned control Remote may invoke the provider's
 * revision-checked `editStable` method without widening `ctx.taskState` for
 * ordinary consumers.
 *
 * Startup opens and validates the domain, then publishes each stored
 * lifecycle-matching stable directly — no model call, no history fold, no
 * unfinished-update replay. A damaged or incompatible domain fails activation
 * LOUDLY and puts the whole provider into a permanent disabled state: it
 * serves no stable pointer, installs no Session observers or workers, never
 * opens storage a second time, and never invokes a model to repair the
 * medium. Ordinary Sessions remain fully usable; they simply see
 * `getStable()` return `undefined`. Eligible events after a committed cursor
 * are processed later in the background when normal activity schedules the
 * per-Session worker.
 *
 * The plugin declares NO SessionEventMap members: the audit vocabulary lives
 * in this provider's own storage domain (`sessions` + `audit` tables), never
 * in the Session log, so unloading task-state leaves old Sessions readable
 * and reloadable by rc.1 code.
 * @module dsh-context-enhancement/internal/task-state/basic/service
 */
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TaskStateService, TaskStateEntryId, TaskStateRequestId, } from "../contract/index.js";
import { finishAuditRow, highestCertifiedRevision, openAuditRow, rowsForLifecycle, selectRepairRow, } from "../contract/audit.js";
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { taskStateDomainSpec } from "./domain.js";
import { resolveTaskStateBasicConfig } from "./config.js";
import { TASK_STATE_SYSTEM_INSTRUCTION, frameProjection } from "./prompt.js";
import { commitStable } from "./host.js";
import { filterEvent, isEligibleType } from "./filter.js";
import { TaskStateWorker } from "./worker.js";
/** The durable lifecycle identity derived from one Session header. */
function lifecycleOf(session) {
    return {
        createdAt: session.header.createdAt,
        ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
    };
}
/**
 * The basic task-state provider service. A host-level plugin (not agent- or
 * preset-scoped): it opens ONE process-global domain and serves every Session
 * in the overlay.
 */
export class TaskStateBasicService extends TaskStateService {
    static inject = ['storageDomain', 'sessions', 'llm'];
    /** Required deployment policy; every field is explicit from the composition. */
    static Config = z.object({
        provider: z.string().required(),
        model: z.string().required(),
        minEvents: z.number().step(1).min(1).required(),
        maxEvents: z.number().step(1).min(1).required(),
        maxInputBytes: z.number().step(1).min(1).required(),
        maxOutputTokens: z.number().step(1).min(1).required(),
        timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
        maxInfraRetries: z.number().step(1).min(0).required(),
        maxEntriesPerKind: z.number().step(1).min(1).required(),
        maxEntryBytes: z.number().step(1).min(1).required(),
        maxListItems: z.number().step(1).min(1).required(),
    });
    config;
    sessionsTable;
    auditTable;
    runtimes = new Map();
    /** Startup audit repairs that disposal must drain before closing the domain. */
    repairs = new Set();
    /** Admission closes at plugin disposal; workers reject new batches then. */
    admissionOpen = true;
    /** Set when the domain failed to open: the provider serves nothing further. */
    disabled = false;
    /** Registered committed-stable observers, notified after each authority put. */
    committedListeners = new Set();
    /**
     * @param ctx - host context carrying storage-domain, sessions, and llm.
     * @param config - validated required deployment policy.
     */
    constructor(ctx, config) {
        super(ctx);
        this.config = resolveTaskStateBasicConfig(config);
    }
    /** Open the authoritative domain, seed committed pointers, and install lifecycle. */
    async [Service.init]() {
        // Sessions may be created while the domain opens (another plugin's init).
        // Capture them so none is missed between this listener install and the
        // post-open seed of `ctx.sessions.list()`.
        const createdDuringOpen = new Set();
        const captureCreated = (session) => { createdDuringOpen.add(session); };
        const releaseCapture = this.ctx.on('session/created', captureCreated, { global: true });
        let domain;
        try {
            domain = await this.ctx.storageDomain.open(taskStateDomainSpec);
        }
        catch (error) {
            // A damaged or incompatible domain (or an already-open one) must never
            // be treated as an empty medium: task state is disabled for the whole
            // overlay, startup never invokes a model to regenerate state, and every
            // ordinary Session stays usable.
            this.disabled = true;
            this.admissionOpen = false;
            releaseCapture();
            this.ctx.logger.error('task-state-basic: authoritative context_enhancement_task_state domain failed to open; task state is disabled and no stable will be published. '
                + `Medium left unchanged; no model was invoked. Cause: ${describeOpenFailure(error)}`);
            return;
        }
        releaseCapture();
        this.ctx.effect(() => async () => {
            this.admissionOpen = false;
            const workers = [...this.runtimes.values()].map(runtime => runtime.worker);
            await Promise.all(workers.map(worker => worker.dispose()));
            await this.drainRepairs();
            this.runtimes.clear();
            this.committedListeners.clear();
            await domain.close();
        }, 'task-state-basic.domainAndWorkers');
        this.sessionsTable = domain.table('sessions');
        this.auditTable = domain.table('audit');
        // Startup: seed committed pointers from lifecycle-matching stored records,
        // reconcile their audit credentials, and repair any committed stable whose
        // finished phase never became durable. The reconcile runs outside the
        // observer stack on a tracked promise that disposal drains.
        const seeded = new Set();
        for (const session of [...this.ctx.sessions.list(), ...createdDuringOpen]) {
            if (seeded.has(session.id))
                continue;
            seeded.add(session.id);
            this.runtimeFor(session);
        }
        this.installLifecycle();
    }
    /** Track one audit repair so provider disposal observes and drains it. */
    trackRepair(label, operation) {
        if (!this.admissionOpen || this.disabled)
            return Promise.resolve();
        const repair = Promise.resolve().then(operation).catch((error) => {
            this.ctx.logger.error(`task-state-basic: ${label} audit repair failed: ${String(error)}`);
        });
        this.repairs.add(repair);
        void repair.finally(() => { this.repairs.delete(repair); });
        return repair;
    }
    /** Drain every repair admitted before provider disposal closed admission. */
    async drainRepairs() {
        while (this.repairs.size > 0)
            await Promise.all([...this.repairs]);
    }
    /** Append a repair credential when the log has not certified the stored stable. */
    scheduleRepair(session) {
        void this.trackRepair(`${session.id} startup`, async () => {
            if (this.ctx.sessions.get(session.id) !== session)
                return;
            await this.reconcileRepair(session);
        });
    }
    /**
     * Reconcile one Session's durable audit against its committed sessions-table
     * stable: when the stable's revision exceeds every certified revision, fill
     * the matching open audit row with a repair credential (never rerunning the
     * model, never inventing raw output).
     */
    async reconcileRepair(session) {
        const stored = this.recordFor(session);
        if (stored === undefined)
            return;
        const { stable } = stored;
        const audit = this.auditTable;
        if (audit === undefined)
            return;
        const rows = rowsForLifecycle([...audit.entries()].map(entry => entry[1]), lifecycleOf(session));
        if (highestCertifiedRevision(rows) >= stable.revision)
            return;
        const open = selectRepairRow(rows, stable.revision);
        if (open === undefined) {
            this.ctx.logger.warn(`task-state-basic: ${session.id} committed stable revision ${stable.revision} has no matching open audit row; leaving it uncertified (stable stays authoritative)`);
            return;
        }
        const finished = {
            outcome: 'repair',
            requestId: open.requestId,
            revision: stable.revision,
            sourceCursor: stable.sourceCursor,
        };
        await this.finishOpenAudit(open.requestId, lifecycleOf(session), stable, finished);
    }
    /**
     * Live-repair one just-committed stable whose finished audit did not become
     * durable: fill that exact request's open row. The operation is tracked so
     * disposal cannot close the domain while repair is pending.
     */
    scheduleAuditRepair(id, stable, requestId) {
        return this.trackRepair(`${id} live`, async () => {
            const session = this.ctx.sessions.get(id);
            if (session === undefined)
                return;
            const row = this.auditTable?.get(requestId);
            if (row === undefined || String(row.requestId) !== requestId)
                return;
            const finished = {
                outcome: 'repair',
                requestId: row.requestId,
                revision: stable.revision,
                sourceCursor: stable.sourceCursor,
            };
            await this.finishOpenAudit(row.requestId, lifecycleOf(session), stable, finished);
        });
    }
    /** Finish only the exact row that is still open for this lifecycle and commit. */
    async finishOpenAudit(requestId, lifecycle, stable, finished) {
        const audit = this.auditTable;
        if (audit === undefined)
            return;
        const key = String(requestId);
        await audit.update(key, (current) => {
            const rejected = current.finished !== undefined
                || String(current.requestId) !== key
                || String(current.request.requestId) !== key
                || current.session.createdAt !== lifecycle.createdAt
                || current.session.cwd !== lifecycle.cwd
                || current.request.revision !== stable.revision
                || (finished.outcome !== 'failure'
                    && (finished.revision !== stable.revision || finished.sourceCursor !== stable.sourceCursor));
            if (rejected)
                return current;
            return finishAuditRow(current, finished);
        });
    }
    /** One runtime for a live Session: identity-fenced record + single worker. */
    runtimeFor(session) {
        let runtime = this.runtimes.get(session.id);
        if (runtime === undefined) {
            runtime = {
                worker: new TaskStateWorker(this.ctx, session, this.config, {
                    system: TASK_STATE_SYSTEM_INSTRUCTION,
                    resolveRoute: id => {
                        const current = this.ctx.sessions.get(id)?.requestHeader()?.config;
                        return current === undefined
                            ? { provider: this.config.provider, model: this.config.model }
                            : { provider: current.provider, model: current.model };
                    },
                    liveSession: id => this.ctx.sessions.get(id),
                    committedCursor: id => this.publishedStable(id)?.sourceCursor ?? -1,
                    readBase: id => this.publishedStable(id) ?? null,
                    eligibleCount: id => this.eligibleEventCount(this.ctx.sessions.get(id), id),
                    frame: (_id, base, batchWindow) => frameProjection({
                        base,
                        events: batchWindow.events,
                        truncation: batchWindow.truncation,
                    }),
                    putOpenAudit: (id, data) => this.putOpenAudit(id, data),
                    putFinishedAudit: (id, data) => this.putFinishedAudit(id, data),
                    putStable: (id, stable) => this.putStable(id, stable),
                    onCommitted: (id, stable) => { this.publishCommitted(id, stable); },
                    scheduleAuditRepair: (id, stable, requestId) => this.scheduleAuditRepair(id, stable, requestId),
                }),
                stable: undefined,
                repairScheduled: false,
            };
            this.runtimes.set(session.id, runtime);
        }
        // Seed a lifecycle-matching stored stable into any runtime that has none
        // yet (startup list or a later async session creation), and reconcile the
        // audit credential when the stable has not been certified.
        if (runtime.stable === undefined) {
            const record = this.recordFor(session);
            if (record !== undefined) {
                runtime.stable = record.stable;
                if (!runtime.repairScheduled) {
                    runtime.repairScheduled = true;
                    this.scheduleRepair(session);
                }
            }
        }
        return runtime;
    }
    /** Install creation/event/disposal observers that drive the workers. */
    installLifecycle() {
        this.ctx.on('session/created', (session) => {
            if (this.disabled)
                return;
            this.runtimeFor(session);
        }, { global: true });
        this.ctx.on('session/event', (session, event) => {
            if (this.disabled)
                return;
            if (!isEligibleType(event.type))
                return;
            // Only events whose real filter projection is non-empty may raise the
            // pending eligible count: an event the batch fold would skip must never
            // inflate the threshold.
            if (filterEvent({ type: event.type, seq: event.seq, data: event.data }) === null)
                return;
            const runtime = this.runtimes.get(session.id);
            if (runtime === undefined)
                return;
            // The synchronous observer only raises the pending watermark and defers
            // scheduling; the worker's performBatch never runs append, flush, model,
            // or storage work inline on this stack.
            runtime.worker.observe(event.seq);
            queueMicrotask(() => {
                runtime.worker.maybeSchedule();
            });
        }, { global: true });
        this.ctx.on('session/disposed', (session) => {
            if (this.disabled)
                return;
            const runtime = this.runtimes.get(session.id);
            if (runtime === undefined)
                return;
            // Close admission, abort cancellable work, prevent late append/publish.
            void runtime.worker.dispose().then(() => {
                this.runtimes.delete(session.id);
            }).catch((error) => {
                this.ctx.logger.warn(`task-state-basic: worker disposal for "${session.id}" failed: ${String(error)}`);
                this.runtimes.delete(session.id);
            });
        }, { global: true });
    }
    /** The lifecycle-matching stored record, or `undefined` (absent or mismatched). */
    recordFor(session) {
        const table = this.sessionsTable;
        if (table === undefined)
            return undefined;
        const record = table.get(session.id);
        if (record === undefined)
            return undefined;
        const identity = record.session;
        if (identity.createdAt !== session.header.createdAt || identity.cwd !== session.header.cwd) {
            return undefined;
        }
        return record;
    }
    /**
     * Count PROJECTABLE eligible events above the committed cursor for one
     * Session by running the real versioned filter over each event.
     */
    eligibleEventCount(session, id) {
        if (session === undefined || this.disabled)
            return 0;
        const cursor = this.publishedStable(id)?.sourceCursor ?? -1;
        let count = 0;
        for (const event of session.snapshotEvents()) {
            if (event.seq <= cursor)
                continue;
            if (!isEligibleType(event.type))
                continue;
            if (filterEvent({ type: event.type, seq: event.seq, data: event.data }) === null)
                continue;
            count += 1;
        }
        return count;
    }
    /** Put one open-phase audit row keyed by the request id. */
    async putOpenAudit(id, data) {
        const session = this.ctx.sessions.get(id);
        const audit = this.auditTable;
        if (session === undefined || audit === undefined || !this.admissionOpen || this.disabled)
            return;
        await audit.put(String(data.requestId), openAuditRow(data.requestId, lifecycleOf(session), data));
    }
    /** Put one finished-phase audit update on the request id's existing open row. */
    async putFinishedAudit(id, finished) {
        const audit = this.auditTable;
        if (audit === undefined || !this.admissionOpen || this.disabled)
            return;
        const key = String(finished.requestId ?? '');
        if (key.length === 0)
            return;
        const existing = audit.get(key);
        if (existing === undefined) {
            this.ctx.logger.warn(`task-state-basic: ${id} finished audit for unknown open row "${key}" dropped`);
            return;
        }
        const session = this.ctx.sessions.get(id);
        if (session === undefined)
            return;
        const stable = finished.outcome === 'success' || finished.outcome === 'repair'
            ? this.publishedStable(id)
            : undefined;
        if (stable !== undefined) {
            await this.finishOpenAudit(existing.requestId, lifecycleOf(session), stable, finished);
            return;
        }
        await audit.update(key, current => current.finished === undefined
            ? finishAuditRow(current, finished)
            : current);
    }
    /** The authoritative commit: replace one Session's stable record. */
    async putStable(id, stable) {
        const session = this.ctx.sessions.get(id);
        if (session === undefined)
            throw new Error(`task-state-basic: session "${id}" is not live`);
        const table = this.sessionsTable;
        if (table === undefined)
            throw new Error('task-state-basic: domain is not initialized');
        const existing = table.get(id);
        // A session id names a storage slot, not a lifecycle: a record written by
        // an earlier lifecycle with the same id must never be overwritten by this
        // one.
        if (existing !== undefined
            && (existing.session.createdAt !== session.header.createdAt
                || existing.session.cwd !== session.header.cwd)) {
            throw new Error(`task-state-basic: session "${id}" record belongs to another lifecycle and cannot be overwritten`);
        }
        await table.put(id, {
            session: {
                createdAt: session.header.createdAt,
                ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
            },
            stable,
        });
    }
    /** Publish the committed pointer only after the authority put resolved. */
    publishCommitted(id, stable) {
        const runtime = this.runtimes.get(id);
        if (runtime === undefined)
            return;
        runtime.stable = stable;
        for (const listener of this.committedListeners) {
            try {
                listener(id, stable);
            }
            catch (error) {
                this.ctx.logger.warn(`task-state-basic: committed observer for "${id}" failed: ${String(error)}`);
            }
        }
    }
    /**
     * Observe every committed stable after its authority put resolved. The
     * listener receives the Session identity and the committed stable; startup
     * reconciliation and live audit repairs never publish, so an observer sees
     * exactly the values that advanced the published pointer.
     *
     * The subscription is caller-owned: the returned disposer removes this
     * listener and must be run by the caller's teardown. The provider unload
     * additionally clears every remaining subscription so a disposed provider
     * never notifies. This is a minimal observer seam for Host-side consumers
     * (remote streams); it never writes the Session log and never changes the
     * storage authority or the lifecycle fence.
     * @param listener - committed-stable observer to add.
     * @returns a disposer removing this listener.
     */
    subscribeCommitted(listener) {
        this.committedListeners.add(listener);
        return () => { this.committedListeners.delete(listener); };
    }
    /** Replace the user-editable stable content under optimistic revision control. */
    async editStable(request) {
        if (this.disabled || !this.admissionOpen) {
            return { ok: false, code: 'unavailable', message: 'Task-state storage is unavailable.' };
        }
        const session = this.ctx.sessions.get(request.sessionId);
        if (session === undefined) {
            return { ok: false, code: 'not-found', message: 'The session is no longer available.' };
        }
        const runtime = this.runtimeFor(session);
        return runtime.worker.enqueueMutation(async () => {
            const current = runtime.stable;
            if (current === undefined) {
                return { ok: false, code: 'not-found', message: 'No task-state summary exists for this session.' };
            }
            if (current.revision !== request.expectedRevision) {
                return { ok: false, code: 'conflict', message: 'The summary changed while it was being edited.', stable: current };
            }
            let content;
            try {
                content = this.resolveManualContent(current, request.value);
            }
            catch (error) {
                return { ok: false, code: 'invalid', message: String(error instanceof Error ? error.message : error) };
            }
            const stable = commitStable(content, current.schemaVersion, current.revision + 1, current.filterVersion, current.sourceCursor);
            const requestId = TaskStateRequestId(`ts-manual-${randomUUID()}`);
            const identity = lifecycleOf(session);
            const open = {
                requestId,
                revision: stable.revision,
                base: current,
                includedSeqs: [],
                filterVersion: current.filterVersion,
                system: 'User-authored task-state edit.',
                route: { provider: 'dsh-context-enhancement', model: 'manual-edit' },
                maxTokens: 0,
                schema: { version: current.schemaVersion, material: { source: 'manual-edit' } },
                truncation: [],
            };
            await this.putOpenAudit(request.sessionId, open);
            await this.putStable(request.sessionId, stable);
            this.publishCommitted(request.sessionId, stable);
            try {
                await this.finishOpenAudit(requestId, identity, stable, {
                    outcome: 'manual', requestId, revision: stable.revision, sourceCursor: stable.sourceCursor,
                });
            }
            catch (error) {
                this.ctx.logger.error(`task-state-basic: ${request.sessionId} manual-edit audit finish failed: ${String(error)}`);
                await this.scheduleAuditRepair(request.sessionId, stable, String(requestId));
            }
            return { ok: true, stable };
        });
    }
    /** Validate, bound-check, and identity-map user-authored stable fields. */
    resolveManualContent(current, value) {
        const text = (field, input, empty) => {
            const resolved = input.trim();
            if (!empty && resolved.length === 0)
                throw new Error(`${field} contains an empty item.`);
            if (Buffer.byteLength(resolved, 'utf8') > this.config.maxEntryBytes) {
                throw new Error(`${field} exceeds ${this.config.maxEntryBytes} UTF-8 bytes.`);
            }
            return resolved;
        };
        const plainList = (field, input) => {
            if (input.length > this.config.maxListItems)
                throw new Error(`${field} has too many items.`);
            return input.map((item, index) => text(`${field}[${index}]`, item, false));
        };
        const entries = (field, prefix, input) => {
            if (input.length > this.config.maxEntriesPerKind)
                throw new Error(`${field} has too many items.`);
            const available = [...current[field]];
            return input.map((item, index) => {
                const content = text(`${field}[${index}]`, item, false);
                const existingIndex = available.findIndex(entry => entry.content === content);
                if (existingIndex >= 0)
                    return available.splice(existingIndex, 1)[0];
                return { id: TaskStateEntryId(`${prefix}-${randomUUID()}`), content };
            });
        };
        return {
            facts: entries('facts', 'fact', value.facts),
            decisions: entries('decisions', 'decision', value.decisions),
            constraints: entries('constraints', 'constraint', value.constraints),
            risks: entries('risks', 'risk', value.risks),
            continuation: {
                currentObjective: text('currentObjective', value.currentObjective, true),
                currentFocus: text('currentFocus', value.currentFocus, true),
                openWork: plainList('openWork', value.openWork),
                nextActions: plainList('nextActions', value.nextActions),
            },
            evidence: current.evidence,
            todoReferences: current.todoReferences,
        };
    }
    /** The published committed pointer, or `undefined`. */
    publishedStable(id) {
        return this.runtimes.get(id)?.stable;
    }
    /** Read the synchronous committed stable of one Session. */
    getStable(sessionId) {
        if (this.disabled)
            return undefined;
        return this.publishedStable(sessionId);
    }
}
/** Render one domain-open failure into a bounded diagnostic. */
function describeOpenFailure(error) {
    if (error instanceof Error) {
        const code = error.code;
        const codeText = code === undefined ? undefined
            : typeof code === 'string' || typeof code === 'number'
                ? String(code)
                : JSON.stringify(code);
        return codeText === undefined ? error.message : `${codeText}: ${error.message}`;
    }
    return String(error);
}
export default TaskStateBasicService;
//# sourceMappingURL=service.js.map