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
 * are folded in the background: normal activity schedules the per-Session
 * worker, and establishing a runtime (creation, domain open, or stored-record
 * hydration) additionally offers ONE startup backlog check, which folds an
 * inherited tail that already meets `minEvents` without waiting for a new
 * event. Recovery itself never folds, never replays an unfinished update, and
 * never calls a model — the recovered stable is published first and any
 * backlog revision is committed afterwards by its own scheduled wave.
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
import { activeTerminalBlock, sameTerminalGeneration, terminalGeneration, } from "../contract/spec.js";
import { finishAuditRow, highestCertifiedRevision, openAuditRow, rowsForLifecycle, selectRepairRow, } from "../contract/audit.js";
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { taskStateDomainSpec } from "./domain.js";
import { resolveTaskStateBasicConfig } from "./config.js";
import { TASK_STATE_SYSTEM_INSTRUCTION, frameProjection } from "./prompt.js";
import { commitStable } from "./host.js";
import { authorityUrgency } from "./authority.js";
import { filterEvent, isEligibleType } from "./filter.js";
import { inheritedCoverageRefused, inheritedCursorFloor, sessionInheritedPrefix, } from "./inherited.js";
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
            try {
                this.ctx.logger.error('task-state-basic: authoritative context_enhancement_task_state domain failed to open; task state is disabled and no stable will be published. '
                    + `Medium left unchanged; no model was invoked. Cause: ${describeOpenFailure(error)}`);
            }
            catch { }
            return;
        }
        releaseCapture();
        this.ctx.effect(() => async () => {
            this.admissionOpen = false;
            const workers = [...this.runtimes.values()].map(runtime => runtime.worker);
            await Promise.all(workers.map(worker => worker.dispose().catch((error) => {
                try {
                    this.ctx.logger.warn(`task-state-basic: worker disposal during service dispose failed: ${String(error)}`);
                }
                catch { }
            })));
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
        // observer stack on a tracked promise that disposal drains. Each seeded
        // runtime also offers its one startup backlog check on a microtask (see
        // `runtimeFor`), so a stored Session whose log already holds an eligible
        // tail above its committed cursor folds it without a new event.
        const seeded = new Set();
        for (const session of [...this.ctx.sessions.list(), ...createdDuringOpen]) {
            if (this.ctx.sessions.get(session.id) !== session)
                continue;
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
            try {
                this.ctx.logger.error(`task-state-basic: ${label} audit repair failed: ${String(error)}`);
            }
            catch {
                // Best-effort diagnostic logging; throwing logger must not cause unhandled rejections
            }
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
        const stable = stored.stable;
        // A terminal-only record (an impossible window before the first commit)
        // holds no committed stable, so there is no revision for a repair
        // credential to certify and no model call was ever made for it.
        if (stable === undefined)
            return;
        const audit = this.auditTable;
        if (audit === undefined)
            return;
        const rows = rowsForLifecycle([...audit.entries()].map(entry => entry[1]), lifecycleOf(session));
        if (highestCertifiedRevision(rows) >= stable.revision)
            return;
        const open = selectRepairRow(rows, stable.revision);
        if (open === undefined) {
            try {
                this.ctx.logger.warn(`task-state-basic: ${session.id} committed stable revision ${stable.revision} has no matching open audit row; leaving it uncertified (stable stays authoritative)`);
            }
            catch {
                // Best-effort diagnostic logging; throwing logger must not escape
            }
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
    scheduleAuditRepair(id, stable, requestId, expectedSession) {
        return this.trackRepair(`${id} live`, async () => {
            const session = this.ctx.sessions.get(id);
            if (session === undefined || (expectedSession !== undefined && session !== expectedSession))
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
            // Only a CERTIFYING finished phase (a success or a repair) names the
            // revision and cursor it certifies, so only those may be rejected for
            // disagreeing with the committed stable. A failure, an abort, or a
            // terminal quarantine carries no certification and is settled verbatim.
            const certifying = finished.outcome === 'success' || finished.outcome === 'repair';
            const rejected = current.finished !== undefined
                || String(current.requestId) !== key
                || String(current.request.requestId) !== key
                || current.session.createdAt !== lifecycle.createdAt
                || current.session.cwd !== lifecycle.cwd
                || current.request.revision !== stable.revision
                || (certifying
                    && (finished.revision !== stable.revision || finished.sourceCursor !== stable.sourceCursor));
            if (rejected)
                return current;
            return finishAuditRow(current, finished);
        });
    }
    /** One runtime for a live Session: identity-fenced record + single worker. */
    runtimeFor(session) {
        if (this.ctx.sessions.get(session.id) !== session)
            return undefined;
        const lifecycle = lifecycleOf(session);
        let runtime = this.runtimes.get(session.id);
        if (runtime !== undefined) {
            if (runtime.session !== session
                || runtime.lifecycle.createdAt !== lifecycle.createdAt
                || runtime.lifecycle.cwd !== lifecycle.cwd) {
                const staleRuntime = runtime;
                if (this.runtimes.get(session.id) === staleRuntime) {
                    this.runtimes.delete(session.id);
                }
                void (async () => {
                    let disposeError;
                    try {
                        await staleRuntime.worker.dispose();
                    }
                    catch (error) {
                        disposeError = error;
                    }
                    if (disposeError !== undefined) {
                        try {
                            this.ctx.logger.warn(`task-state-basic: mismatched worker disposal for "${session.id}" failed: ${String(disposeError)}`);
                        }
                        catch { }
                    }
                })();
                runtime = undefined;
            }
        }
        // A runtime created on THIS call. It is registered first and its worker is
        // constructed LAST, after the lifecycle-matching stored stable below has
        // been recovered: the worker's initial backlog count must be measured
        // against the RECOVERED cursor, never against "no cursor" (which would
        // count the already-committed prefix as backlog and could admit a startup
        // wave over events that a committed stable already covers).
        let createdRuntime;
        if (runtime === undefined) {
            const seeded = {
                session,
                lifecycle,
                worker: undefined,
                stable: undefined,
                terminal: undefined,
                terminalBlock: undefined,
                repairScheduled: false,
            };
            runtime = seeded;
            this.runtimes.set(session.id, runtime);
            // Seed a lifecycle-matching stored stable into any runtime that has none
            // yet (startup list or a later async session creation), and reconcile the
            // audit credential when the stable has not been certified. The recovered
            // stable advances the published pointer from nothing to something, so it
            // is announced to committed observers: a control stream whose baseline was
            // already built before this seed (the restart race, when the domain opens
            // after a client reconnected) hydrates instead of staying empty forever.
            if (this.ctx.sessions.get(session.id) === session) {
                const record = this.recordFor(session);
                if (record !== undefined) {
                    runtime.stable = record.stable;
                    runtime.terminal = record.terminal;
                    const recovered = record.stable;
                    if (recovered !== undefined)
                        this.notifyCommitted(session.id, recovered);
                    runtime.repairScheduled = true;
                }
            }
            this.refreshTerminalBlock(runtime);
            const worker = new TaskStateWorker(this.ctx, session, this.config, {
                system: TASK_STATE_SYSTEM_INSTRUCTION,
                resolveRoute: id => {
                    const current = this.ctx.sessions.get(id)?.requestHeader()?.config;
                    return current === undefined
                        ? { provider: this.config.provider, model: this.config.model }
                        : { provider: current.provider, model: current.model };
                },
                liveSession: id => {
                    const live = this.ctx.sessions.get(id);
                    return live === session ? live : undefined;
                },
                committedCursor: id => this.effectiveCursor(id, session),
                readBase: id => this.publishedStable(id, session) ?? null,
                cursorFloor: id => this.effectiveCursor(id, session),
                activeBlock: id => this.activeTerminalBlock(id, session),
                eligibleCount: id => this.eligibleEventCount(this.ctx.sessions.get(id) === session ? session : undefined, id),
                frame: (_id, base, batchWindow) => frameProjection({
                    base,
                    events: batchWindow.events,
                    truncation: batchWindow.truncation,
                }),
                putOpenAudit: (_id, data) => this.putOpenAudit(session, data),
                putFinishedAudit: (_id, data) => this.putFinishedAudit(session, data),
                putStable: (_id, stable) => this.putStable(session, stable),
                putTerminal: (_id, terminal) => this.putTerminal(session, terminal),
                onCommitted: (id, stable) => { this.publishCommitted(id, stable, runtime); },
                scheduleAuditRepair: (id, stable, requestId) => this.scheduleAuditRepair(id, stable, requestId, session),
            });
            runtime.worker = worker;
            if (runtime.repairScheduled)
                this.scheduleRepair(session);
            createdRuntime = runtime;
        }
        // Seed a lifecycle-matching stored stable into any runtime that has none
        // yet (a later hydration of a Session the provider already knows, or a
        // runtime whose first seed found no record). The recovered stable advances
        // the published pointer from nothing to something, so it is announced to
        // committed observers: a control stream whose baseline was already built
        // before this seed (the restart race, when the domain opens after a client
        // reconnected) hydrates instead of staying empty forever.
        if (runtime.stable === undefined && this.ctx.sessions.get(session.id) === session) {
            const record = this.recordFor(session);
            if (record !== undefined) {
                runtime.stable = record.stable;
                runtime.terminal = record.terminal;
                const recovered = record.stable;
                if (recovered !== undefined)
                    this.notifyCommitted(session.id, recovered);
                if (!runtime.repairScheduled) {
                    runtime.repairScheduled = true;
                    this.scheduleRepair(session);
                }
            }
            this.refreshTerminalBlock(runtime);
        }
        // Recovery and backlog processing are two separate steps. The recovered
        // stable above is published synchronously — the baseline is served before
        // any backlog work — and the ONE startup backlog check of a runtime created
        // on this call is offered afterwards on a microtask, so the check never
        // folds, reads storage, or calls a model on the caller's synchronous stack.
        // It folds the inherited eligible tail above the committed cursor when that
        // tail already meets `minEvents`, so a restarted Session no longer serves a
        // stale stable until a new Session event happens to arrive.
        // `maybeScheduleStartup` is idempotent per worker, and the microtask is
        // fenced to this exact runtime, so a replacement Session can never be
        // advanced by a check queued for its predecessor.
        if (createdRuntime !== undefined) {
            const target = createdRuntime;
            queueMicrotask(() => {
                if (!this.admissionOpen || this.disabled)
                    return;
                if (this.ctx.sessions.get(session.id) !== session)
                    return;
                if (this.runtimes.get(session.id) !== target)
                    return;
                target.worker.maybeScheduleStartup();
            });
        }
        return runtime;
    }
    /** Install creation/event/disposal observers that drive the workers. */
    installLifecycle() {
        this.ctx.on('session/created', (session) => {
            if (this.disabled)
                return;
            if (this.ctx.sessions.get(session.id) !== session)
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
            const projected = filterEvent({ type: event.type, seq: event.seq, data: event.data });
            if (projected === null)
                return;
            const runtime = this.runtimes.get(session.id);
            if (runtime === undefined || runtime.session !== session)
                return;
            // An authority fact needs an `urgent` wave: the Goal/TODO views it
            // decides are injected authoritative state, so waiting for `minEvents`
            // ordinary events would keep a superseded objective or a cleared list
            // visible. The classification reads the projection and the committed
            // pointer only — both already in memory — and the request itself stays on
            // the microtask below, so no model, storage, or fold work ever runs on
            // this synchronous stack.
            const urgent = authorityUrgency({ seq: projected.event.seq, type: projected.event.type, fields: projected.event.fields }, runtime.stable ?? null) !== undefined;
            // The synchronous observer only raises the pending watermark and defers
            // scheduling; the worker's performBatch never runs append, flush, model,
            // or storage work inline on this stack.
            runtime.worker.observe(event.seq);
            const target = runtime;
            queueMicrotask(() => {
                if (!this.admissionOpen || this.disabled)
                    return;
                if (this.ctx.sessions.get(session.id) !== session)
                    return;
                if (this.runtimes.get(session.id) !== target)
                    return;
                if (urgent)
                    target.worker.maybeScheduleUrgent(event.seq);
                target.worker.maybeSchedule();
            });
        }, { global: true });
        this.ctx.on('session/disposed', (session) => {
            if (this.disabled)
                return;
            const runtime = this.runtimes.get(session.id);
            if (runtime === undefined || runtime.session !== session)
                return;
            // Close admission, abort cancellable work, prevent late append/publish.
            void (async () => {
                let disposeError;
                try {
                    await runtime.worker.dispose();
                }
                catch (error) {
                    disposeError = error;
                }
                finally {
                    if (this.runtimes.get(session.id) === runtime) {
                        this.runtimes.delete(session.id);
                    }
                }
                if (disposeError !== undefined) {
                    try {
                        this.ctx.logger.warn(`task-state-basic: worker disposal for "${session.id}" failed: ${String(disposeError)}`);
                    }
                    catch {
                        // Best-effort diagnostic logging
                    }
                }
            })();
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
     * Read the effective committed cursor for one Session: the newest of the
     * committed stable's `sourceCursor` (absent before the first commit) and the
     * durable terminal verdict's cursor. A verdict therefore never has to be
     * carried by a stable, and a stable never silently discards one.
     *
     * The result is always fenced against the Session's own-event boundary, so a
     * forked child can never fold (or report coverage of) its inherited prefix:
     * see {@link fenceCursor}.
     */
    effectiveCursor(id, expectedSession) {
        const session = expectedSession ?? this.ctx.sessions.get(id);
        if (session === undefined)
            return -1;
        const inherited = sessionInheritedPrefix(session);
        const runtime = this.runtimes.get(id);
        if (runtime !== undefined && (expectedSession === undefined || runtime.session === expectedSession)) {
            const stableCursor = runtime.stable?.sourceCursor ?? -1;
            const terminalCursor = runtime.terminal?.cursor ?? -1;
            return this.fenceCursor(session, inherited, runtime.stable?.inherited, Math.max(stableCursor, terminalCursor));
        }
        const record = this.recordFor(session);
        const stableCursor = record?.stable?.sourceCursor ?? -1;
        const terminalCursor = record?.terminal?.cursor ?? -1;
        return this.fenceCursor(session, inherited, record?.stable?.inherited, Math.max(stableCursor, terminalCursor));
    }
    /**
     * Fence one stored coverage claim against the LIVE own-event boundary of its
     * Session lifecycle.
     *
     * Below the boundary nothing may be claimed: those sequences are the parent's
     * facts, delivered to this lifecycle as history. A claim that contradicts the
     * live boundary is refused as a whole and the lifecycle re-derives from its own
     * events above the boundary, which is the conservative direction — the content
     * is still served, while no unverifiable coverage is trusted. Every lifecycle
     * that did not begin on an inherited prefix floors at `-1`, so its cursor is
     * exactly what it was before this contract existed.
     */
    fenceCursor(session, inherited, marker, claimed) {
        const floor = inheritedCursorFloor(inherited);
        if (inheritedCoverageRefused(inherited, marker)) {
            this.warnDiagnostic(`task-state-basic: Session "${String(session.id)}" holds a coverage claim whose inherited boundary `
                + `(ownBoundarySeq ${String(marker?.ownBoundarySeq)}) disagrees with the live fork cut `
                + `(${String(inherited?.ownBoundarySeq)}); the claim is refused and the state is re-derived from the Session's own events above seq ${String(floor)}`);
            return floor;
        }
        return Math.max(claimed, floor);
    }
    /**
     * Emit one best-effort lifecycle diagnostic. A warning must never fail a read,
     * a commit, or a startup path, and a throwing logger must not escape.
     */
    warnDiagnostic(message) {
        try {
            this.ctx.logger.warn(message);
        }
        catch {
            // Diagnostics are best-effort only.
        }
    }
    /**
     * The generation of one Session's CURRENT measurable situation: the committed
     * base stable (revision identity, cursor, digest, and filter version) together
     * with the configured framed-input budget. A terminal verdict stores the
     * generation it was measured against, so this is what decides whether the
     * window must be re-opened.
     */
    currentGeneration(session) {
        const stable = this.publishedStable(session.id, session) ?? this.recordFor(session)?.stable ?? null;
        return terminalGeneration(stable, this.config.maxInputBytes);
    }
    /**
     * Recompute one runtime's ACTIVE terminal block from its durable verdict.
     * Called after a verdict write and after every commit, because a commit
     * changes the base generation and therefore re-opens a blocked window.
     */
    refreshTerminalBlock(runtime, session) {
        if (runtime === undefined)
            return;
        const live = session ?? runtime.session;
        if (this.ctx.sessions.get(runtime.session.id) !== runtime.session) {
            runtime.terminalBlock = undefined;
            return;
        }
        runtime.terminalBlock = activeTerminalBlock(runtime.terminal, this.currentGeneration(live));
    }
    /**
     * The still-active block of one Session, or `undefined` when its verdict is a
     * quarantine or its generation no longer matches. The provider reads the
     * durable record for a runtime it does not own, so a Session hydrated later
     * still answers with its own stored, generation-fenced block.
     */
    activeTerminalBlock(id, expectedSession) {
        const session = expectedSession ?? this.ctx.sessions.get(id);
        if (session === undefined)
            return undefined;
        const runtime = this.runtimes.get(id);
        if (runtime !== undefined && (expectedSession === undefined || runtime.session === expectedSession)) {
            return runtime.terminalBlock;
        }
        return activeTerminalBlock(this.recordFor(session)?.terminal, this.currentGeneration(session));
    }
    /**
     * Count PROJECTABLE eligible events above the committed cursor for one
     * Session by running the real versioned filter over each event.
     */
    eligibleEventCount(session, id) {
        if (session === undefined || this.disabled)
            return 0;
        const cursor = this.effectiveCursor(id, session);
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
    async putOpenAudit(session, data) {
        const audit = this.auditTable;
        if (audit === undefined || !this.admissionOpen || this.disabled)
            return;
        if (this.ctx.sessions.get(session.id) !== session)
            return;
        await audit.put(String(data.requestId), openAuditRow(data.requestId, lifecycleOf(session), data));
    }
    /** Put one finished-phase audit update on the request id's existing open row. */
    async putFinishedAudit(session, finished) {
        const audit = this.auditTable;
        if (audit === undefined || !this.admissionOpen || this.disabled)
            return;
        const key = String(finished.requestId ?? '');
        if (key.length === 0)
            return;
        const existing = audit.get(key);
        if (existing === undefined) {
            try {
                this.ctx.logger.warn(`task-state-basic: ${session.id} finished audit for unknown open row "${key}" dropped`);
            }
            catch { }
            return;
        }
        if (this.ctx.sessions.get(session.id) !== session)
            return;
        const stable = finished.outcome === 'success' || finished.outcome === 'repair'
            ? this.publishedStable(session.id, session)
            : undefined;
        if (stable !== undefined) {
            await this.finishOpenAudit(existing.requestId, lifecycleOf(session), stable, finished);
            return;
        }
        await audit.update(key, current => current.finished === undefined
            ? finishAuditRow(current, finished)
            : current);
    }
    /**
     * The authoritative commit: replace one Session's stable record.
     *
     * The durable terminal verdict — when the lifecycle holds one — is carried
     * forward VERBATIM inside the same record put, so a commit can neither
     * resurrect a quarantined window nor lose the typed reason why a blocked one
     * is blocked. The verdict keeps its own stored generation: a commit changes
     * the current generation, so the next decision about that window is a
     * re-evaluation against the NEW base rather than an inherited ban.
     */
    async putStable(session, stable) {
        const id = session.id;
        const live = this.ctx.sessions.get(id);
        if (live !== session)
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
        const runtime = this.runtimes.get(id);
        const terminal = existing?.terminal ?? runtime?.terminal;
        await table.put(id, {
            session: {
                createdAt: session.header.createdAt,
                ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
            },
            stable,
            ...terminal !== undefined ? { terminal } : {},
        });
        // A commit changes the base generation, so a blocked window must be
        // re-measured rather than inherited: refresh the cached active block now
        // that the new stable is the committed base.
        this.refreshTerminalBlock(runtime, session);
    }
    /**
     * Persist ONE durable terminal verdict.
     *
     * The write carries the lifecycle identity, the untouched committed stable
     * WHEN one exists, and the verdict — all inside ONE record put, because one
     * `KvTable.put` is the only atomic durable boundary this storage contract
     * offers (per-table puts are separate whole-document rewrites). The effective
     * cursor (`max(stable?.sourceCursor ?? -1, terminal.cursor)`) therefore can
     * never advance without its provenance, and a rejected or failed put changes
     * neither the medium nor the in-memory pointer.
     *
     * `stable` is NOT required: a verdict is recorded just as durably before the
     * Session's first commit, so an impossible window no longer has to stall
     * forever. It NEVER manufactures a stable — the record simply carries none.
     *
     * Admission is monotone:
     * - a `quarantined` verdict must strictly advance the effective cursor past
     *   the floor it was measured against, so a quarantine can never be a no-op
     *   and can never move the cursor backwards;
     * - a `block…` verdict must name the CURRENT generation. It records the
     *   typed reason why the pending window stays pending, so a restart does not
     *   re-fold (and never re-pays for) a window whose cause is unchanged, while
     *   a changed base/filter/budget re-opens it. A block that would restate the
     *   verdict already stored for the same generation is refused, so a blocked
     *   window cannot churn the medium.
     *
     * Single-writer contract: this is a read-modify-write on the JSON domain's
     * single unit and there is NO record-level compare-and-swap (B1 is
     * `blocked-upstream`), so it is only safe while one process writes the
     * domain. It never claims CAS.
     * @param session - the live Session whose record is written.
     * @param terminal - the terminal verdict to record.
     * @returns whether the verdict became durable (and therefore took effect).
     */
    async putTerminal(session, terminal) {
        if (!this.admissionOpen || this.disabled)
            return false;
        const id = session.id;
        const live = this.ctx.sessions.get(id);
        if (live !== session)
            return false;
        const table = this.sessionsTable;
        if (table === undefined)
            return false;
        const existing = table.get(id);
        if (existing !== undefined
            && (existing.session.createdAt !== session.header.createdAt
                || existing.session.cwd !== session.header.cwd)) {
            return false;
        }
        const runtime = this.runtimes.get(id);
        const published = runtime !== undefined && runtime.session === session ? runtime.stable : undefined;
        // The record's own committed stable and the published pointer are the same
        // durable value; either may be absent before the first commit, and neither
        // is ever fabricated to make room for a verdict.
        const stable = existing?.stable ?? published;
        const floor = Math.max(stable?.sourceCursor ?? -1, existing?.terminal?.cursor ?? -1);
        if (terminal.kind === 'quarantined') {
            // The effective cursor is a maximum over the committed stable and the
            // verdict, so a quarantine below either one would be a no-op or a
            // regression: refuse it instead of writing a claim that advances nothing.
            if (terminal.cursor <= floor)
                return false;
        }
        else {
            // A block advances NOTHING by construction; it must instead describe the
            // situation in force right now, and it must not restate the block that is
            // already stored for this very generation.
            const current = this.currentGeneration(session);
            if (terminal.cursor !== floor)
                return false;
            if (existing?.terminal !== undefined
                && existing.terminal.kind !== 'quarantined'
                && sameTerminalGeneration(existing.terminal.generation, current)
                && existing.terminal.kind === terminal.kind
                && existing.terminal.blockSeq === terminal.blockSeq) {
                return false;
            }
            if (!sameTerminalGeneration(terminal.generation, current))
                return false;
        }
        const next = {
            session: {
                createdAt: session.header.createdAt,
                ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
            },
            ...stable !== undefined ? { stable } : {},
            terminal,
        };
        await table.put(id, next);
        if (runtime !== undefined && runtime.session === session) {
            // The durable verdict is now the authority for this lifecycle; the
            // in-memory pointer mirrors exactly what the record holds. The committed
            // stable pointer is left untouched: publishing one is `runtimeFor`'s job,
            // and a terminal verdict never publishes anything.
            runtime.terminal = terminal;
            this.refreshTerminalBlock(runtime, session);
        }
        return true;
    }
    /** Publish the committed pointer only after the authority put resolved. */
    publishCommitted(id, stable, expectedRuntime) {
        const runtime = this.runtimes.get(id);
        if (runtime === undefined)
            return;
        if (expectedRuntime !== undefined && runtime !== expectedRuntime)
            return;
        const live = this.ctx.sessions.get(id);
        if (live === undefined || live !== runtime.session)
            return;
        runtime.stable = stable;
        // Advancing the committed base is EXACTLY what changes the measurable
        // generation, so a blocked window must be re-evaluated here — at the one
        // place the published pointer moves — rather than only where the put
        // resolved. A manual replacement publishes through this same seam, so it
        // re-opens a blocked window just like an ordinary commit does.
        this.refreshTerminalBlock(runtime, live);
        this.notifyCommitted(id, stable);
    }
    /** Announce one published or recovered stable to every committed observer. */
    notifyCommitted(id, stable) {
        for (const listener of this.committedListeners) {
            try {
                listener(id, stable);
            }
            catch (error) {
                try {
                    this.ctx.logger.warn(`task-state-basic: committed observer for "${id}" failed: ${String(error)}`);
                }
                catch {
                    // A throwing logger must not prevent subsequent listeners from being notified.
                }
            }
        }
    }
    /**
     * Observe every committed stable after its authority put resolved, plus the
     * stable recovered from storage when a runtime first seeds it. The listener
     * receives the Session identity and the committed stable; live audit repairs
     * never publish (they certify an already-published stable), so an observer
     * sees exactly the values that advanced the published pointer — including
     * the startup/reconnect recovery that advances it from nothing to a durable
     * stable, which is how an already-open remote stream hydrates a Session
     * whose baseline was read before the seed.
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
        if (runtime === undefined) {
            return { ok: false, code: 'not-found', message: 'The session is no longer available.' };
        }
        try {
            return await runtime.worker.enqueueMutation(async () => {
                if (this.disabled || !this.admissionOpen) {
                    return { ok: false, code: 'unavailable', message: 'Task-state storage is unavailable.' };
                }
                const liveStart = this.ctx.sessions.get(request.sessionId);
                if (liveStart !== session || this.runtimes.get(request.sessionId) !== runtime) {
                    if (liveStart === undefined) {
                        return { ok: false, code: 'unavailable', message: 'The session is no longer available.' };
                    }
                    const activeStable = this.runtimes.get(request.sessionId)?.stable;
                    return {
                        ok: false,
                        code: 'conflict',
                        message: 'The summary changed while it was being edited.',
                        ...activeStable !== undefined ? { stable: activeStable } : {},
                    };
                }
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
                const inherited = sessionInheritedPrefix(session);
                const stable = commitStable(content, current.schemaVersion, current.revision + 1, current.filterVersion, current.sourceCursor, inherited);
                const requestId = TaskStateRequestId(`ts-manual-${randomUUID()}`);
                const identity = lifecycleOf(session);
                const open = {
                    requestId,
                    revision: stable.revision,
                    trigger: 'manual',
                    base: current,
                    includedSeqs: [],
                    filterVersion: current.filterVersion,
                    system: 'User-authored task-state edit.',
                    route: { provider: 'dsh-context-enhancement', model: 'manual-edit' },
                    maxTokens: 0,
                    schema: { version: current.schemaVersion, material: { source: 'manual-edit' } },
                    truncation: [],
                    ...inherited === null ? {} : { inherited },
                };
                await this.putOpenAudit(session, open);
                if (this.disabled || !this.admissionOpen) {
                    return { ok: false, code: 'unavailable', message: 'Task-state storage is unavailable.' };
                }
                const liveAfterAudit = this.ctx.sessions.get(request.sessionId);
                if (liveAfterAudit !== session || this.runtimes.get(request.sessionId) !== runtime) {
                    if (liveAfterAudit === undefined) {
                        return { ok: false, code: 'unavailable', message: 'The session is no longer available.' };
                    }
                    const activeStable = this.runtimes.get(request.sessionId)?.stable;
                    return {
                        ok: false,
                        code: 'conflict',
                        message: 'The summary changed while it was being edited.',
                        ...activeStable !== undefined ? { stable: activeStable } : {},
                    };
                }
                await this.putStable(session, stable);
                if (this.disabled || !this.admissionOpen) {
                    return { ok: false, code: 'unavailable', message: 'Task-state storage is unavailable.' };
                }
                const liveAfterPut = this.ctx.sessions.get(request.sessionId);
                if (liveAfterPut !== session || this.runtimes.get(request.sessionId) !== runtime) {
                    if (liveAfterPut === undefined) {
                        return { ok: false, code: 'unavailable', message: 'The session is no longer available.' };
                    }
                    const activeStable = this.runtimes.get(request.sessionId)?.stable;
                    return {
                        ok: false,
                        code: 'conflict',
                        message: 'The summary changed while it was being edited.',
                        ...activeStable !== undefined ? { stable: activeStable } : {},
                    };
                }
                this.publishCommitted(request.sessionId, stable, runtime);
                try {
                    await this.finishOpenAudit(requestId, identity, stable, {
                        outcome: 'manual', requestId, revision: stable.revision, sourceCursor: stable.sourceCursor,
                    });
                }
                catch (error) {
                    try {
                        this.ctx.logger.error(`task-state-basic: ${request.sessionId} manual-edit audit finish failed: ${String(error)}`);
                    }
                    catch {
                        // Best-effort diagnostic logging; throwing logger must not prevent repair scheduling
                    }
                    await this.scheduleAuditRepair(request.sessionId, stable, String(requestId), session);
                }
                return { ok: true, stable };
            });
        }
        catch (error) {
            if (error instanceof Error && error.message === 'task-state-basic/session-disposed') {
                return { ok: false, code: 'unavailable', message: 'The session is no longer available.' };
            }
            throw error;
        }
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
            // A user-authored edit changes only the editable content: the
            // authoritative Goal/TODO views and the bounded TODO reference they imply
            // are carried forward untouched, because a manual edit is not an
            // authority fact and may never invent or clear one.
            todoReferences: current.todoReferences,
            goalView: current.goalView,
            todoView: current.todoView,
        };
    }
    /** The published committed pointer, or `undefined`. */
    publishedStable(id, expectedSession) {
        const runtime = this.runtimes.get(id);
        if (runtime === undefined)
            return undefined;
        const live = this.ctx.sessions.get(id);
        if (live === undefined || live !== runtime.session)
            return undefined;
        if (expectedSession !== undefined && live !== expectedSession)
            return undefined;
        return runtime.stable;
    }
    /** Read the synchronous committed stable of one Session. */
    getStable(sessionId) {
        if (this.disabled)
            return undefined;
        return this.publishedStable(sessionId);
    }
    /**
     * Read the synchronous durable terminal verdict of one Session, if present:
     * a `quarantined` culprit window or a `block…` verdict naming a measured
     * cause that is not a log event (an oversized base stable, or an authority
     * fact that may never be skipped).
     */
    getTerminal(sessionId) {
        if (this.disabled)
            return undefined;
        const runtime = this.runtimes.get(sessionId);
        if (runtime !== undefined)
            return runtime.terminal;
        const session = this.ctx.sessions.get(sessionId);
        if (session === undefined)
            return undefined;
        return this.recordFor(session)?.terminal;
    }
    /**
     * Read the terminal BLOCK of one Session that still applies to the current
     * base/filter/budget generation, or `undefined`. A quarantine never blocks,
     * and a block whose generation changed is already re-openable.
     */
    getActiveTerminalBlock(sessionId) {
        if (this.disabled)
            return undefined;
        return this.activeTerminalBlock(sessionId);
    }
    /**
     * Read the whole durable record of one Session, if present. The record may
     * carry a terminal verdict without any committed stable (an impossible
     * window before the first commit), which is why `stable` is optional.
     */
    getRecord(sessionId) {
        if (this.disabled)
            return undefined;
        const session = this.ctx.sessions.get(sessionId);
        if (session === undefined)
            return undefined;
        return this.recordFor(session);
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