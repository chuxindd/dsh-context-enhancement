/**
 * Basic durable task-state provider (`ctx.taskState`): the sole MVP owner of
 * the authoritative `context_enhancement_task_state` storage domain, the
 * published committed pointers, the versioned input filter, per-Session
 * background scheduling, independent auxiliary LLM calls, output validation,
 * private writes, and lifecycle. It subclasses the read-only Service
 * Definition; it never exposes a write, finalize, status, or changed method.
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

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  TaskStateService,
  type TaskStateRecord,
  type TaskStateStable,
  type TaskStateUpdateFinishedData,
  type TaskStateUpdateRequestData,
} from '../contract/index.ts'
import {
  finishAuditRow,
  highestCertifiedRevision,
  openAuditRow,
  rowsForLifecycle,
  selectRepairRow,
  type TaskStateAuditRecord,
} from '../contract/audit.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { taskStateDomainSpec } from './domain.ts'
import { resolveTaskStateBasicConfig } from './config.ts'
import type { TaskStateBasicConfig } from './types.ts'
import { TASK_STATE_SYSTEM_INSTRUCTION, frameProjection } from './prompt.ts'
import { filterEvent, isEligibleType } from './filter.ts'
import { TaskStateWorker } from './worker.ts'

export type { TaskStateBasicConfig } from './types.ts'
export type {
  TaskStateFilteredEvent,
  TaskStateBatchProjection,
  TaskStateHostNormalization,
  TaskStateBatchErrorCode,
  TaskStateBatchFailure,
} from './types.ts'

/** One live Session's committed pointer and its owning worker. */
interface SessionRuntime {
  readonly worker: TaskStateWorker
  /** Committed stable pointer; published only after the authority put. */
  stable: TaskStateStable | undefined
  /** Startup reconciliation is admitted at most once for this lifecycle. */
  repairScheduled: boolean
}

/** The durable lifecycle identity derived from one Session header. */
function lifecycleOf(session: Session): { createdAt: number; cwd?: string } {
  return {
    createdAt: session.header.createdAt,
    ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
  }
}

/**
 * The basic task-state provider service. A host-level plugin (not agent- or
 * preset-scoped): it opens ONE process-global domain and serves every Session
 * in the overlay.
 */
export class TaskStateBasicService extends TaskStateService {
  static inject = ['storageDomain', 'sessions', 'llm']

  /** Required deployment policy; every field is explicit from the composition. */
  static Config: z<TaskStateBasicConfig> = z.object({
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
  })

  private readonly config: Readonly<TaskStateBasicConfig>
  private sessionsTable?: KvTable<SessionId, TaskStateRecord>
  private auditTable?: KvTable<string, TaskStateAuditRecord>
  private readonly runtimes = new Map<SessionId, SessionRuntime>()
  /** Startup audit repairs that disposal must drain before closing the domain. */
  private readonly repairs = new Set<Promise<void>>()
  /** Admission closes at plugin disposal; workers reject new batches then. */
  private admissionOpen = true
  /** Set when the domain failed to open: the provider serves nothing further. */
  private disabled = false

  /**
   * @param ctx - host context carrying storage-domain, sessions, and llm.
   * @param config - validated required deployment policy.
   */
  constructor(ctx: Context, config: TaskStateBasicConfig) {
    super(ctx)
    this.config = resolveTaskStateBasicConfig(config)
  }

  /** Open the authoritative domain, seed committed pointers, and install lifecycle. */
  protected async [Service.init](): Promise<void> {
    // Sessions may be created while the domain opens (another plugin's init).
    // Capture them so none is missed between this listener install and the
    // post-open seed of `ctx.sessions.list()`.
    const createdDuringOpen = new Set<Session>()
    const captureCreated = (session: Session): void => { createdDuringOpen.add(session) }
    const releaseCapture = this.ctx.on('session/created', captureCreated, { global: true })

    let domain
    try {
      domain = await this.ctx.storageDomain.open(taskStateDomainSpec)
    } catch (error: unknown) {
      // A damaged or incompatible domain (or an already-open one) must never
      // be treated as an empty medium: task state is disabled for the whole
      // overlay, startup never invokes a model to regenerate state, and every
      // ordinary Session stays usable.
      this.disabled = true
      this.admissionOpen = false
      releaseCapture()
      this.ctx.logger.error(
        'task-state-basic: authoritative context_enhancement_task_state domain failed to open; task state is disabled and no stable will be published. '
        + `Medium left unchanged; no model was invoked. Cause: ${describeOpenFailure(error)}`,
      )
      return
    }
    releaseCapture()
    this.ctx.effect(() => async () => {
      this.admissionOpen = false
      const workers = [...this.runtimes.values()].map(runtime => runtime.worker)
      await Promise.all(workers.map(worker => worker.dispose()))
      await this.drainRepairs()
      this.runtimes.clear()
      await domain.close()
    }, 'task-state-basic.domainAndWorkers')
    this.sessionsTable = domain.table('sessions')
    this.auditTable = domain.table('audit')

    // Startup: seed committed pointers from lifecycle-matching stored records,
    // reconcile their audit credentials, and repair any committed stable whose
    // finished phase never became durable. The reconcile runs outside the
    // observer stack on a tracked promise that disposal drains.
    const seeded = new Set<string>()
    for (const session of [...this.ctx.sessions.list(), ...createdDuringOpen]) {
      if (seeded.has(session.id)) continue
      seeded.add(session.id)
      this.runtimeFor(session)
    }

    this.installLifecycle()
  }

  /** Track one audit repair so provider disposal observes and drains it. */
  private trackRepair(label: string, operation: () => Promise<void>): Promise<void> {
    if (!this.admissionOpen || this.disabled) return Promise.resolve()
    const repair = Promise.resolve().then(operation).catch((error: unknown) => {
      this.ctx.logger.error(`task-state-basic: ${label} audit repair failed: ${String(error)}`)
    })
    this.repairs.add(repair)
    void repair.finally(() => { this.repairs.delete(repair) })
    return repair
  }

  /** Drain every repair admitted before provider disposal closed admission. */
  private async drainRepairs(): Promise<void> {
    while (this.repairs.size > 0) await Promise.all([...this.repairs])
  }

  /** Append a repair credential when the log has not certified the stored stable. */
  private scheduleRepair(session: Session): void {
    void this.trackRepair(`${session.id} startup`, async () => {
      if (this.ctx.sessions.get(session.id) !== session) return
      await this.reconcileRepair(session)
    })
  }

  /**
   * Reconcile one Session's durable audit against its committed sessions-table
   * stable: when the stable's revision exceeds every certified revision, fill
   * the matching open audit row with a repair credential (never rerunning the
   * model, never inventing raw output).
   */
  private async reconcileRepair(session: Session): Promise<void> {
    const stored = this.recordFor(session)
    if (stored === undefined) return
    const { stable } = stored
    const audit = this.auditTable
    if (audit === undefined) return
    const rows = rowsForLifecycle([...audit.entries()].map(entry => entry[1]), lifecycleOf(session))
    if (highestCertifiedRevision(rows) >= stable.revision) return
    const open = selectRepairRow(rows, stable.revision)
    if (open === undefined) {
      this.ctx.logger.warn(
        `task-state-basic: ${session.id} committed stable revision ${stable.revision} has no matching open audit row; leaving it uncertified (stable stays authoritative)`,
      )
      return
    }
    const finished: TaskStateUpdateFinishedData = {
      outcome: 'repair',
      requestId: open.requestId,
      revision: stable.revision,
      sourceCursor: stable.sourceCursor,
    }
    await this.finishOpenAudit(open.requestId, lifecycleOf(session), stable, finished)
  }

  /**
   * Live-repair one just-committed stable whose finished audit did not become
   * durable: fill that exact request's open row. The operation is tracked so
   * disposal cannot close the domain while repair is pending.
   */
  private scheduleAuditRepair(
    id: SessionId,
    stable: TaskStateStable,
    requestId: string,
  ): Promise<void> {
    return this.trackRepair(`${id} live`, async () => {
      const session = this.ctx.sessions.get(id)
      if (session === undefined) return
      const row = this.auditTable?.get(requestId)
      if (row === undefined || String(row.requestId) !== requestId) return
      const finished: TaskStateUpdateFinishedData = {
        outcome: 'repair',
        requestId: row.requestId,
        revision: stable.revision,
        sourceCursor: stable.sourceCursor,
      }
      await this.finishOpenAudit(row.requestId, lifecycleOf(session), stable, finished)
    })
  }

  /** Finish only the exact row that is still open for this lifecycle and commit. */
  private async finishOpenAudit(
    requestId: TaskStateUpdateRequestData['requestId'],
    lifecycle: ReturnType<typeof lifecycleOf>,
    stable: TaskStateStable,
    finished: TaskStateUpdateFinishedData,
  ): Promise<void> {
    const audit = this.auditTable
    if (audit === undefined) return
    const key = String(requestId)
    await audit.update(key, (current) => {
      const rejected = current.finished !== undefined
        || String(current.requestId) !== key
        || String(current.request.requestId) !== key
        || current.session.createdAt !== lifecycle.createdAt
        || current.session.cwd !== lifecycle.cwd
        || current.request.revision !== stable.revision
        || (finished.outcome !== 'failure'
          && (finished.revision !== stable.revision || finished.sourceCursor !== stable.sourceCursor))
      if (rejected) return current
      return finishAuditRow(current, finished)
    })
  }

  /** One runtime for a live Session: identity-fenced record + single worker. */
  private runtimeFor(session: Session): SessionRuntime {
    let runtime = this.runtimes.get(session.id)
    if (runtime === undefined) {
      runtime = {
        worker: new TaskStateWorker(this.ctx, session, this.config, {
          system: TASK_STATE_SYSTEM_INSTRUCTION,
          route: { provider: this.config.provider, model: this.config.model },
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
          onCommitted: (id, stable) => { this.publishCommitted(id, stable) },
          scheduleAuditRepair: (id, stable, requestId) => this.scheduleAuditRepair(id, stable, requestId),
        }),
        stable: undefined,
        repairScheduled: false,
      }
      this.runtimes.set(session.id, runtime)
    }
    // Seed a lifecycle-matching stored stable into any runtime that has none
    // yet (startup list or a later async session creation), and reconcile the
    // audit credential when the stable has not been certified.
    if (runtime.stable === undefined) {
      const record = this.recordFor(session)
      if (record !== undefined) {
        runtime.stable = record.stable
        if (!runtime.repairScheduled) {
          runtime.repairScheduled = true
          this.scheduleRepair(session)
        }
      }
    }
    return runtime
  }

  /** Install creation/event/disposal observers that drive the workers. */
  private installLifecycle(): void {
    this.ctx.on('session/created', (session: Session) => {
      if (this.disabled) return
      this.runtimeFor(session)
    }, { global: true })

    this.ctx.on('session/event', (session: Session, event) => {
      if (this.disabled) return
      if (!isEligibleType(event.type)) return
      // Only events whose real filter projection is non-empty may raise the
      // pending eligible count: an event the batch fold would skip must never
      // inflate the threshold.
      if (filterEvent({ type: event.type, seq: event.seq, data: event.data }) === null) return
      const runtime = this.runtimes.get(session.id)
      if (runtime === undefined) return
      // The synchronous observer only raises the pending watermark and defers
      // scheduling; the worker's performBatch never runs append, flush, model,
      // or storage work inline on this stack.
      runtime.worker.observe(event.seq)
      queueMicrotask(() => {
        runtime.worker.maybeSchedule()
      })
    }, { global: true })

    this.ctx.on('session/disposed', (session: Session) => {
      if (this.disabled) return
      const runtime = this.runtimes.get(session.id)
      if (runtime === undefined) return
      // Close admission, abort cancellable work, prevent late append/publish.
      void runtime.worker.dispose().then(() => {
        this.runtimes.delete(session.id)
      }).catch((error: unknown) => {
        this.ctx.logger.warn(`task-state-basic: worker disposal for "${session.id}" failed: ${String(error)}`)
        this.runtimes.delete(session.id)
      })
    }, { global: true })
  }

  /** The lifecycle-matching stored record, or `undefined` (absent or mismatched). */
  private recordFor(session: Session): TaskStateRecord | undefined {
    const table = this.sessionsTable
    if (table === undefined) return undefined
    const record = table.get(session.id)
    if (record === undefined) return undefined
    const identity = record.session
    if (identity.createdAt !== session.header.createdAt || identity.cwd !== session.header.cwd) {
      return undefined
    }
    return record
  }

  /**
   * Count PROJECTABLE eligible events above the committed cursor for one
   * Session by running the real versioned filter over each event.
   */
  private eligibleEventCount(session: Session | undefined, id: SessionId): number {
    if (session === undefined || this.disabled) return 0
    const cursor = this.publishedStable(id)?.sourceCursor ?? -1
    let count = 0
    for (const event of session.snapshotEvents()) {
      if (event.seq <= cursor) continue
      if (!isEligibleType(event.type)) continue
      if (filterEvent({ type: event.type, seq: event.seq, data: event.data }) === null) continue
      count += 1
    }
    return count
  }

  /** Put one open-phase audit row keyed by the request id. */
  private async putOpenAudit(id: SessionId, data: TaskStateUpdateRequestData): Promise<void> {
    const session = this.ctx.sessions.get(id)
    const audit = this.auditTable
    if (session === undefined || audit === undefined || !this.admissionOpen || this.disabled) return
    await audit.put(String(data.requestId), openAuditRow(data.requestId, lifecycleOf(session), data))
  }

  /** Put one finished-phase audit update on the request id's existing open row. */
  private async putFinishedAudit(id: SessionId, finished: TaskStateUpdateFinishedData): Promise<void> {
    const audit = this.auditTable
    if (audit === undefined || !this.admissionOpen || this.disabled) return
    const key = String(finished.requestId ?? '')
    if (key.length === 0) return
    const existing = audit.get(key)
    if (existing === undefined) {
      this.ctx.logger.warn(`task-state-basic: ${id} finished audit for unknown open row "${key}" dropped`)
      return
    }
    const session = this.ctx.sessions.get(id)
    if (session === undefined) return
    const stable = finished.outcome === 'success' || finished.outcome === 'repair'
      ? this.publishedStable(id)
      : undefined
    if (stable !== undefined) {
      await this.finishOpenAudit(existing.requestId, lifecycleOf(session), stable, finished)
      return
    }
    await audit.update(key, current => current.finished === undefined
      ? finishAuditRow(current, finished)
      : current)
  }

  /** The authoritative commit: replace one Session's stable record. */
  private async putStable(id: SessionId, stable: TaskStateStable): Promise<void> {
    const session = this.ctx.sessions.get(id)
    if (session === undefined) throw new Error(`task-state-basic: session "${id}" is not live`)
    const table = this.sessionsTable
    if (table === undefined) throw new Error('task-state-basic: domain is not initialized')
    const existing = table.get(id)
    // A session id names a storage slot, not a lifecycle: a record written by
    // an earlier lifecycle with the same id must never be overwritten by this
    // one.
    if (existing !== undefined
      && (existing.session.createdAt !== session.header.createdAt
        || existing.session.cwd !== session.header.cwd)) {
      throw new Error(`task-state-basic: session "${id}" record belongs to another lifecycle and cannot be overwritten`)
    }
    await table.put(id, {
      session: {
        createdAt: session.header.createdAt,
        ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
      },
      stable,
    })
  }

  /** Publish the committed pointer only after the authority put resolved. */
  private publishCommitted(id: SessionId, stable: TaskStateStable): void {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined) return
    runtime.stable = stable
  }

  /** The published committed pointer, or `undefined`. */
  private publishedStable(id: SessionId): TaskStateStable | undefined {
    return this.runtimes.get(id)?.stable
  }

  /** Read the synchronous committed stable of one Session. */
  override getStable(sessionId: SessionId): TaskStateStable | undefined {
    if (this.disabled) return undefined
    return this.publishedStable(sessionId)
  }
}

/** Render one domain-open failure into a bounded diagnostic. */
function describeOpenFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    const codeText = code === undefined ? undefined
      : typeof code === 'string' || typeof code === 'number'
        ? String(code)
        : JSON.stringify(code)
    return codeText === undefined ? error.message : `${codeText}: ${error.message}`
  }
  return String(error)
}

export default TaskStateBasicService
