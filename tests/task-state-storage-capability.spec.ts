import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { descriptorOf, domainTable } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { taskStateDomainSpec } from '../src/internal/task-state/basic/domain.ts'
import { openAuditRow } from '../src/internal/task-state/contract/audit.ts'
import type { TaskStateAuditRecord } from '../src/internal/task-state/contract/audit.ts'
import { TaskStateRequestId } from '../src/internal/task-state/contract/index.ts'
import type { TaskStateRecord } from '../src/internal/task-state/contract/index.ts'
import { taskStateAuditSchema, taskStateRecordSchema } from '../src/internal/task-state/contract/index.ts'
import { commitStable } from '../src/internal/task-state/basic/host.ts'

/**
 * B1 capability characterization of the DSH storage stack as seen from this
 * plugin's assembly boundary.
 *
 * These tests do NOT claim multi-instance safety and they do NOT encode a
 * passing acceptance criterion for 42-B1. They pin the *capability gap* that
 * blocks 42-B1, measured against the real `dsh-storage` + `dsh-storage-json`
 * + `dsh-storage-domain` stack rather than against source comments:
 *
 * 1. two independent facilities can hold the SAME storage unit open at the
 *    same time (the "exactly one live handle" guard is per registry instance,
 *    so it is a same-process, same-context guard only);
 * 2. `KvTable` exposes no revision compare / conflict signal: a writer that
 *    commits from a stale base still resolves successfully;
 * 3. a writer's own view never re-reads the medium, so an external commit is
 *    invisible to it (`refresh`/`reopen` in place does not exist);
 * 4. a whole-document `single` layout write erases records the writer never
 *    saw — including records belonging to unrelated keys.
 *
 * If a future DSH revision adds record-level CAS, a table refresh, or a
 * single-writer/lease primitive, these tests fail on purpose: that failure is
 * the signal that 42-B1 can be implemented against the API instead of being
 * reported as blocked.
 */

/** The two facilities share one storage ROOT, so both open one unit file. */
let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose().catch(() => {})
  }
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

/**
 * Mount one INDEPENDENT storage stack (hub + JSON backend + domain facility)
 * over the shared root. Each returned context has its own backend registry and
 * its own domain facility, which is what makes it a faithful in-process stand
 * in for a second OS process at the storage API boundary: the only thing the
 * two stacks share is the medium.
 */
async function mountStorageStack(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: root as string })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  return ctx
}

/** Open the REAL production task-state domain spec on one stack. */
async function openTaskState(ctx: Context): Promise<Domain<typeof taskStateDomainSpec>> {
  return await ctx.storageDomain.open(taskStateDomainSpec) as Domain<typeof taskStateDomainSpec>
}

/** One schema-valid committed record: identity + stable, revision 1. */
function recordFor(createdAt: number, objective: string): TaskStateRecord {
  return {
    session: { createdAt, cwd: 'C:\\work' },
    stable: commitStable(
      {
        facts: [],
        decisions: [],
        constraints: [],
        risks: [],
        evidence: [],
        todoReferences: [],
        goalView: { status: 'none' },
        todoView: { status: 'none', items: [] },
        continuation: {
          currentObjective: objective,
          currentFocus: '',
          openWork: [],
          nextActions: [],
        },
      },
      2,
      1,
      'task-state-basic/filter-v3',
      0,
    ),
  }
}

/** The `sessions` table of one opened task-state domain. */
function sessionsOf(domain: Domain<typeof taskStateDomainSpec>): KvTable<string, TaskStateRecord> {
  return domain.table('sessions') as KvTable<string, TaskStateRecord>
}

describe('42-B1 storage capability characterization (blocks CAS/freshness)', () => {
  it('gap 1: two independent facilities hold the same unit open — no single-writer conflict', async () => {
    root = await mkdtemp(join(tmpdir(), 'b1-capability-'))
    const first = await mountStorageStack()
    const second = await mountStorageStack()

    const firstDomain = await openTaskState(first)
    // If the medium carried a cross-process single-writer guarantee this open
    // would reject; it does not, because the guard lives in one backend
    // instance's in-process map.
    const secondDomain = await openTaskState(second)

    expect(firstDomain.name).toBe('context_enhancement_task_state_v2')
    expect(secondDomain.name).toBe('context_enhancement_task_state_v2')
    expect(firstDomain).not.toBe(secondDomain)

    await firstDomain.close()
    await secondDomain.close()
  })

  it('gap 2+3+4: a stale writer commits successfully and erases an unseen unrelated record', async () => {
    root = await mkdtemp(join(tmpdir(), 'b1-capability-'))
    const first = await mountStorageStack()
    const second = await mountStorageStack()
    const firstDomain = await openTaskState(first)
    const secondDomain = await openTaskState(second)
    const firstSessions = sessionsOf(firstDomain)
    const secondSessions = sessionsOf(secondDomain)

    // Both stacks start from the same (empty) medium.
    expect(firstSessions.size).toBe(0)
    expect(secondSessions.size).toBe(0)

    // First writer commits and the put resolves — the only acknowledgement
    // the API offers.
    await firstSessions.put('b1-session-a', recordFor(1_000, 'first writer'))
    expect(firstSessions.get('b1-session-a')).toBeDefined()

    // gap 3: the second, already-open stack has NO way to observe the commit.
    // There is no refresh/reopen on Domain or KvTable, and `entries()` reads
    // the open-time snapshot, not the medium.
    expect(secondSessions.get('b1-session-a')).toBeUndefined()
    expect(secondSessions.size).toBe(0)

    // gap 2: the second writer derived its state from a base that predates the
    // first commit. No revision precondition exists, so this put resolves as
    // an ordinary success — there is no conflict signal to catch.
    await secondSessions.put('b1-session-b', recordFor(2_000, 'second writer'))
    expect(secondSessions.get('b1-session-b')).toBeDefined()

    // gap 4: whole-document last-write-wins. The first writer's committed,
    // unrelated key is gone from the medium. A FRESH stack (the only
    // refresh primitive that exists: open a new domain) proves it.
    const observer = await mountStorageStack()
    const observerDomain = await openTaskState(observer)
    const observerSessions = sessionsOf(observerDomain)
    expect(observerSessions.get('b1-session-a')).toBeUndefined()
    expect([...observerSessions.keys()]).toEqual(['b1-session-b'])

    await firstDomain.close()
    await secondDomain.close()
    await observerDomain.close()
  })

  it('gap 3 control: a whole-document write also drops the writer\'s own unseen keys of other tables', async () => {
    root = await mkdtemp(join(tmpdir(), 'b1-capability-'))
    const first = await mountStorageStack()
    const second = await mountStorageStack()
    const firstDomain = await openTaskState(first)
    const secondDomain = await openTaskState(second)

    // One stack commits an audit row; the other stack never saw it and then
    // commits a sessions record. Both tables live in ONE `single` document.
    const requestId = TaskStateRequestId('b1-audit-row')
    const auditRow: TaskStateAuditRecord = openAuditRow(
      requestId,
      { createdAt: 1_000, cwd: 'C:\\work' },
      {
        requestId,
        revision: 1,
        base: null,
        includedSeqs: [],
        filterVersion: 'task-state-basic/filter-v2',
        system: 'b1 capability characterization',
        route: { provider: 'b1', model: 'b1' },
        maxTokens: 1,
        schema: { version: 1, material: { source: 'b1' } },
        truncation: [],
      },
      1,
    )
    await (firstDomain.table('audit') as KvTable<string, TaskStateAuditRecord>).put(String(requestId), auditRow)
    await sessionsOf(secondDomain).put('b1-session-b', recordFor(2_000, 'second writer'))

    const observer = await mountStorageStack()
    const observerDomain = await openTaskState(observer)
    // The audit row the first stack committed is gone, even though the second
    // stack only ever wrote the other table.
    expect([...observerDomain.table('audit').keys()]).toEqual([])

    await firstDomain.close()
    await secondDomain.close()
    await observerDomain.close()
  })
})

describe('42-B1 clean-break primitives that DO exist (fail closed, no migration)', () => {
  it('a stored record that fails the current schema rejects the whole open', async () => {
    root = await mkdtemp(join(tmpdir(), 'b1-cleanbreak-'))
    // Write one structurally invalid record through the RAW unit, i.e. below
    // the domain layer, exactly like a document left by another build.
    const backend = new StorageJson.JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptorOf(taskStateDomainSpec))
    await unit.putRecord('sessions', 'b1-stale-session', {
      session: { createdAt: 1_000, cwd: 'C:\\work' },
      stable: { revision: 1 },
    })
    await unit.close()
    await backend.close()

    const ctx = await mountStorageStack()
    // Fail closed: the provider's activation path catches this and disables
    // task state for the whole overlay instead of serving an empty store.
    await expect(openTaskState(ctx)).rejects.toMatchObject({ code: 'invalid-record' })
  })

  it('a domain version mismatch rejects a differently stamped document at open (the clean-break lever)', async () => {
    root = await mkdtemp(join(tmpdir(), 'b1-cleanbreak-'))
    // The production declaration is the clean-break generation: a NEW identity
    // at version 2. The version is stamped at FIRST MATERIALIZATION, so the
    // document must actually be written — opening alone touches nothing.
    const ctx = await mountStorageStack()
    const domain = await openTaskState(ctx)
    expect(taskStateDomainSpec.version).toBe(2)
    expect(taskStateDomainSpec.name).toBe('context_enhancement_task_state_v2')
    await sessionsOf(domain).put('b1-current-session', recordFor(1_000, 'stamped by the current generation'))
    await domain.close()
    await ctx.fiber.dispose()

    // A declaration with the SAME name but the PREVIOUS version must refuse the
    // stamped document instead of reinterpreting it — which is why the clean
    // break needs no migration and no `compatibleVersions`.
    const previousGeneration = StorageDomain.defineDomain({
      name: taskStateDomainSpec.name,
      version: 1,
      layout: 'single',
      tables: {
        sessions: domainTable<string, TaskStateRecord>(taskStateRecordSchema),
        audit: domainTable<string, TaskStateAuditRecord>(taskStateAuditSchema),
      },
    })
    const probe = await mountStorageStack()
    // Assert on a plain captured value: the error itself carries a Cordis
    // context in its diagnostics, which the test printer cannot format.
    let thrown: unknown
    try {
      await probe.storageDomain.open(previousGeneration)
    } catch (error: unknown) {
      thrown = error
    }
    const code = (thrown as { code?: unknown } | undefined)?.code
    expect(`${String(thrown?.constructor?.name)}/${String(code)}`).toBe('StorageError/version-mismatch')
  })

  it('a first-generation empty medium still initializes normally', async () => {
    root = await mkdtemp(join(tmpdir(), 'b1-cleanbreak-'))
    const ctx = await mountStorageStack()
    const domain = await openTaskState(ctx)
    expect([...sessionsOf(domain).keys()]).toEqual([])
    expect([...domain.table('audit').keys()]).toEqual([])
    await domain.close()
  })
})
