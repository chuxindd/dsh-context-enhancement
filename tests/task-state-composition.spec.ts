import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import {
  TaskStateBasicService,
  taskStateDomainSpec,
} from '../src/task-state-basic.ts'

/**
 * "Closest independent composition" fixture: the task-state provider is
 * mounted against a REAL storage hub + JSON backend + domain facility (single
 * layout over a real file) and a REAL session store + JSONL session
 * persistence, with one scripted LLM adapter registered under the configured
 * route. This exercises the authoritative domain, restart direct load, audit
 * crash repair, corrupted-domain disable, identity mismatch, and a 0-model
 * restart through the same code paths a Loader composition uses.
 */

/** Deterministic model JSON the scripted adapter replays as its text output. */
const MODEL_JSON = JSON.stringify({
  facts: [{ content: 'the provider commits durably through the real composition' }],
  decisions: [],
  constraints: [],
  risks: [],
  evidence: [],
  todoReferences: [],
  continuation: {
    currentObjective: 'land the task-state provider',
    currentFocus: 'proving the real composition',
    openWork: [],
    nextActions: ['run the gates'],
  },
})

/** Scripted adapter returning one fixed valid task-state JSON text block. */
class TaskStateAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: MODEL_JSON }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: MODEL_JSON } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** JSON backend wrapper rejecting a controlled number of finished-audit writes. */
class FinishedAuditWriteFailureBackend implements StorageBackend {
  private readonly backend: JsonStorageBackend
  private remainingFailures: number

  constructor(storageRoot: string, failures: number) {
    this.backend = new JsonStorageBackend(storageRoot)
    this.remainingFailures = failures
  }

  readonly kv: KvFacet = {
    open: async descriptor => {
      const unit = await this.backend.kv.open(descriptor)
      return this.wrapUnit(unit)
    },
  }

  private wrapUnit(unit: KvUnit): KvUnit {
    return {
      loadAll: () => unit.loadAll(),
      putRecord: async (table, key, value) => {
        const finished = typeof value === 'object' && value !== null
          ? (value as { finished?: unknown }).finished
          : undefined
        if (table === 'audit' && finished !== undefined && this.remainingFailures > 0) {
          this.remainingFailures -= 1
          throw new Error('controlled finished-audit write failure')
        }
        await unit.putRecord(table, key, value)
      },
      deleteRecord: (table, key) => unit.deleteRecord(table, key),
      setGlobal: value => unit.setGlobal(value),
      close: () => unit.close(),
      ...unit.backupRecord === undefined ? {} : {
        backupRecord: (table: string, key: string) => unit.backupRecord!(table, key),
      },
    }
  }

  async close(): Promise<void> {
    await this.backend.close()
  }
}

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount the composition directly (no Loader): real stores, domain, adapter. */
async function mountComposition(
  sessionSubroot = 'sessions',
  withAdapter = true,
  finishedAuditWriteFailures = 0,
): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(root as string, sessionSubroot),
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await ctx.plugin(Storage)
  let backend = 'json'
  if (finishedAuditWriteFailures === 0) {
    await ctx.plugin(StorageJson, { root: join(root as string, 'storage') })
  } else {
    backend = 'json-write-failure'
    const failing = new FinishedAuditWriteFailureBackend(
      join(root as string, 'storage'),
      finishedAuditWriteFailures,
    )
    ctx.effect(() => {
      const unregister = ctx.storage.backend.register(backend, failing)
      return async () => {
        unregister()
        await failing.close()
      }
    })
    ctx.provide(storageBackendServiceKey(backend), failing)
  }
  await ctx.plugin(StorageDomain, { backend })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TaskStateBasicService, {
    provider: 'current-route',
    model: 'current-model',
    minEvents: 1,
    maxEvents: 10,
    maxInputBytes: 100_000,
    maxOutputTokens: 4_000,
    timeoutMs: 5_000,
    maxInfraRetries: 0,
    maxEntriesPerKind: 10,
    maxEntryBytes: 2_000,
    maxListItems: 8,
  })
  if (withAdapter) ctx.llm.registerAdapter(['current-route'], new TaskStateAdapter())
  return ctx
}

/** Append one direct human user/message and return its seq. */
function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Poll one predicate (sync or async) until it holds or the timeout elapses. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!await predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('composition did not settle in time')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

describe('task-state-basic real composition', () => {
  it('persists a manual edit, publishes it, and rejects a stale revision', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-manual-edit-'))
    const createdAt = 1_700_000_000_000
    const first = await mountComposition()
    const session = first.sessions.create(SessionId('manual-edit'), { meta: { cwd: root, createdAt } })
    appendUser(session, 'create the first stable')
    await waitUntil(() => first.taskState.getStable(session.id) !== undefined, 3_000)
    const provider = first.get('taskState') as TaskStateBasicService
    const committed: number[] = []
    const dispose = provider.subscribeCommitted((_id, stable) => { committed.push(stable.revision) })
    const result = await provider.editStable({
      sessionId: session.id,
      expectedRevision: 1,
      value: {
        currentObjective: 'Corrected objective',
        currentFocus: 'Corrected focus',
        openWork: ['Open item'],
        nextActions: ['Next item'],
        facts: ['Edited fact'],
        decisions: ['Edited decision'],
        constraints: ['Edited constraint'],
        risks: ['Edited risk'],
      },
    })
    expect(result).toMatchObject({ ok: true, stable: { revision: 2 } })
    expect(first.taskState.getStable(session.id)).toMatchObject({
      revision: 2,
      continuation: { currentObjective: 'Corrected objective' },
      facts: [{ content: 'Edited fact' }],
    })
    expect(committed).toEqual([2])
    await expect(provider.editStable({
      sessionId: session.id,
      expectedRevision: 1,
      value: {
        currentObjective: 'Stale', currentFocus: '', openWork: [], nextActions: [],
        facts: [], decisions: [], constraints: [], risks: [],
      },
    })).resolves.toMatchObject({ ok: false, code: 'conflict', stable: { revision: 2 } })
    await expect(provider.editStable({
      sessionId: session.id,
      expectedRevision: 2,
      value: {
        currentObjective: 'Too large', currentFocus: '', openWork: [], nextActions: [],
        facts: ['x'.repeat(2_001)], decisions: [], constraints: [], risks: [],
      },
    })).resolves.toMatchObject({ ok: false, code: 'invalid' })
    const stored = JSON.parse(await readFile(join(root, 'storage', 'context_enhancement_task_state.json'), 'utf8')) as {
      tables: { audit: Record<string, { finished?: { outcome?: string } }> }
    }
    expect(Object.values(stored.tables.audit).some(row => row.finished?.outcome === 'manual')).toBe(true)
    dispose()

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)
    const second = await mountComposition('sessions-2', false)
    const resumed = second.sessions.create(SessionId('manual-edit'), { meta: { cwd: root, createdAt } })
    expect(second.taskState.getStable(resumed.id)).toMatchObject({
      revision: 2,
      continuation: { currentObjective: 'Corrected objective' },
      facts: [{ content: 'Edited fact' }],
    })
  })

  it('uses the latest Session request route instead of the configured fallback', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-session-route-'))
    const ctx = await mountComposition()
    const sessionRoute = new TaskStateAdapter()
    ctx.llm.registerAdapter(['session-route'], sessionRoute)
    const session = ctx.sessions.create(SessionId('session-route'), { meta: { cwd: root } })
    session.append('request/header', {
      header: { config: { provider: 'session-route', model: 'session-model' } },
      reason: 'initial',
    })

    appendUser(session, 'use the conversation route')
    await waitUntil(() => ctx.taskState.getStable(session.id) !== undefined, 3_000)

    expect(sessionRoute.requests).toHaveLength(1)
    expect(sessionRoute.requests[0]).toMatchObject({
      provider: 'session-route',
      model: 'session-model',
      purpose: 'task-state',
    })
  })

  it('commits a first stable through a real session writer and storage domain', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-domain-'))
    const ctx = await mountComposition()
    expect(ctx.get('taskState')).toBeInstanceOf(TaskStateBasicService)
    expect(ctx.taskState.getStable(SessionId('never-seen'))).toBeUndefined()

    const session = ctx.sessions.create(SessionId('domain-commit'), { meta: { cwd: root } })
    expect(ctx.taskState.getStable(session.id)).toBeUndefined()
    appendUser(session, 'drive the first commit')
    await waitUntil(() => ctx.taskState.getStable(session.id) !== undefined, 3_000)
    const stable = ctx.taskState.getStable(session.id)
    expect(stable).toBeDefined()
    expect(stable?.revision).toBe(1)
    expect(stable?.facts[0]?.content).toBe('the provider commits durably through the real composition')

    // The authoritative single-layout JSON document holds both tables.
    const text = await readFile(join(root, 'storage', 'context_enhancement_task_state.json'), 'utf8')
    const document = JSON.parse(text) as {
      unit: { name: string; version: number }
      tables: { sessions: Record<string, unknown>; audit: Record<string, unknown> }
    }
    expect(document.unit.name).toBe(taskStateDomainSpec.name)
    expect(document.unit.version).toBe(1)
    expect(Object.keys(document.tables.sessions)).toContain(String(session.id))
    expect(Object.keys(document.tables.audit)).toHaveLength(1)
  })

  it('loads a stored stable directly on restart without a model call or history fold', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-reopen-'))
    const createdAt = 1_700_000_000_000

    const first = await mountComposition()
    const session = first.sessions.create(SessionId('domain-reopen'), {
      meta: { cwd: root, createdAt },
    })
    const seq = appendUser(session, 'first commit survives restart')
    await waitUntil(() => first.taskState.getStable(session.id) !== undefined, 3_000)
    expect(first.taskState.getStable(session.id)?.sourceCursor).toBe(seq)
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    // Restart with NO adapter: any model call would fail loud. Startup must
    // publish the stored stable directly from the domain.
    const second = await mountComposition('sessions-2', false)
    const resumed = second.sessions.create(SessionId('domain-reopen'), {
      meta: { cwd: root, createdAt },
    })
    expect(second.taskState.getStable(resumed.id)).toBeDefined()
    expect(second.taskState.getStable(resumed.id)?.revision).toBe(1)
    expect(second.taskState.getStable(resumed.id)?.facts[0]?.content)
      .toBe('the provider commits durably through the real composition')
  })

  it('enters a disabled overlay on a corrupted domain while ordinary sessions continue', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-corrupt-'))
    // Corrupt the authoritative single-layout unit file BEFORE the provider
    // opens it: malformed JSON fails open loudly and the provider disables.
    // The storage backend creates its root lazily, so the directory must
    // exist before the corrupt file can be planted.
    await mkdir(join(root, 'storage'), { recursive: true })
    await writeFile(join(root, 'storage', 'context_enhancement_task_state.json'), '{not json')

    const ctx = await mountComposition()
    expect(ctx.taskState.getStable(SessionId('any'))).toBeUndefined()
    const session = ctx.sessions.create(SessionId('disabled-live'), { meta: { cwd: root } })
    appendUser(session, 'ordinary session still works')
    await new Promise<void>(resolve => setTimeout(resolve, 120))
    expect(ctx.taskState.getStable(session.id)).toBeUndefined()
    expect(session.snapshotEvents().some(event => event.type === 'user/message')).toBe(true)
  })

  it('never publishes a stored record whose lifecycle identity mismatches the live session', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-identity-'))
    const createdAt = 1_700_000_000_000

    const first = await mountComposition()
    const session = first.sessions.create(SessionId('domain-identity'), {
      meta: { cwd: root, createdAt },
    })
    appendUser(session, 'commit under one lifecycle')
    await waitUntil(() => first.taskState.getStable(session.id) !== undefined, 3_000)
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const second = await mountComposition('sessions-2', false)
    const different = second.sessions.create(SessionId('domain-identity'), {
      meta: { cwd: root, createdAt: createdAt + 1 },
    })
    expect(second.taskState.getStable(different.id)).toBeUndefined()
  })

  it('repairs an open audit row after a put whose finished put failed (audit crash repair)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-gap-'))
    const createdAt = 1_700_000_000_000
    // Reject the success credential and its immediate live repair after the
    // authority put. The first process therefore closes with a real durable
    // stable and its original open audit row, without rewriting the medium.
    const ctx = await mountComposition('sessions', true, 2)
    const session = ctx.sessions.create(SessionId('domain-gap'), {
      meta: { cwd: root, createdAt },
    })
    const seq = appendUser(session, 'commit past a finished audit failure')
    await waitUntil(() => ctx.taskState.getStable(session.id) !== undefined, 3_000)
    const stable = ctx.taskState.getStable(session.id)
    expect(stable?.revision).toBe(1)
    expect(stable?.sourceCursor).toBe(seq)
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)

    const domainPath = join(root, 'storage', 'context_enhancement_task_state.json')
    const crashed = JSON.parse(await readFile(domainPath, 'utf8')) as {
      tables: { sessions: Record<string, unknown>; audit: Record<string, { finished?: unknown }> }
    }
    expect(Object.values(crashed.tables.audit).every(row => row.finished === undefined)).toBe(true)

    // Restart with no adapter (0-model restart). Startup publishes the stored
    // stable directly and the reconciler certifies the open row with a repair.
    // The restarted lifecycle must match the record's identity (same createdAt).
    const second = await mountComposition('sessions-2', false)
    const resumed = second.sessions.create(SessionId('domain-gap'), {
      meta: { cwd: root, createdAt },
    })
    expect(second.taskState.getStable(resumed.id)).toBeDefined()
    // The reconciler runs off the observer stack on a microtask, so the repair
    // credential lands asynchronously; poll the durable doc until it appears.
    await waitUntil(async () => {
      const repaired = JSON.parse(await readFile(domainPath, 'utf8')) as {
        tables: { audit: Record<string, unknown> }
      }
      return Object.values(repaired.tables.audit).some(row => {
        const finished = (row as { finished?: { outcome?: string } }).finished
        return finished?.outcome === 'repair'
      })
    }, 3_000)
    const repaired = JSON.parse(await readFile(domainPath, 'utf8')) as {
      tables: { audit: Record<string, unknown> }
    }
    const rows = Object.values(repaired.tables.audit)
    expect(rows.some(row => {
      const finished = (row as { finished?: { outcome?: string } }).finished
      return finished?.outcome === 'repair'
    })).toBe(true)
  })

  it('disposes cleanly and closes the domain', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-dispose-'))
    const ctx = await mountComposition()
    const session = ctx.sessions.create(SessionId('domain-dispose'), { meta: { cwd: root } })
    appendUser(session, 'commit before dispose')
    await waitUntil(() => ctx.taskState.getStable(session.id) !== undefined, 3_000)
    await ctx.fiber.dispose()
  })
})
