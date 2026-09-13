import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { openToolGroupAudit } from '../src/internal/compaction/tool-group-audit.ts'
import { openToolGroupAuditStore, type ToolGroupAuditStore } from '../src/internal/compaction/tool-group-audit-store.ts'
import type { ToolGroup } from '../src/internal/compaction/tool-groups.ts'

/**
 * The tool-group summary audit store opens its own durable storage domain
 * through `ctx.storageDomain`. The compaction engine runs inside a preset
 * isolate realm where the domain facility is NOT provided directly: the
 * declared `storageDomain` inject resolves through to the host plane's
 * process-global facility. Without the declaration the access throws
 * `cannot get property "storageDomain" without inject` and every tool-group
 * summarization audit is silently disabled.
 */

const group: ToolGroup = {
  sourceSeqs: [SessionSeq(2), SessionSeq(3)],
  toolResultSeqs: [SessionSeq(3)],
  callIds: ['c1'],
  startSeq: SessionSeq(2),
  endSeq: SessionSeq(3),
  estimatedTokens: 100,
  startPosition: 0,
  endPosition: 1,
  turn: 1,
}

const contexts: Context[] = []

let root: string | undefined

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose().catch(() => {})
  }
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('tool-group audit store storageDomain wiring', () => {
  it('declares storageDomain so the compaction realm resolves the host facility', () => {
    expect(BasicCompactionEngine.inject).toContain('storageDomain')
    // The remaining engine dependencies are unchanged.
    expect(BasicCompactionEngine.inject).toEqual(['llm', 'tokenMeter', 'sessions', 'storageDomain'])
  })

  it('constructs the audit store over a real storage-domain facility', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tg-audit-store-'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })

    // The exact accessor the engine's constructor uses, now against a real
    // facility: open, finish, and per-lifecycle reads all work and survive as
    // a durable domain document.
    const store = await openToolGroupAuditStore(ctx)
    try {
      const record = openToolGroupAudit('tg-spec-1', 'session-audit', group, 3, 'provider', 'model', 'fp-1', { createdAt: 42 })
      await store.open(record)
      await store.finish('tg-spec-1', current => ({ ...current, status: 'success' as const, replacementSeqs: [SessionSeq(9)] }))
      const rows = store.recordsForSession('session-audit', 42)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.status).toBe('success')
      expect(rows[0]?.sessionId).toBe('session-audit')
      expect(rows[0]?.replacementSeqs).toEqual([SessionSeq(9)])
      // A different lifecycle's rows stay filtered out.
      expect(store.recordsForSession('session-audit', 43)).toEqual([])
    } finally {
      await store.close()
    }
  })

  it('mounts BasicCompactionEngine inside a contextual group isolate and resolves host-plane storageDomain', async () => {
    // Faithful reproduction of the preset isolate realm:
    // In agent presets (e.g. standard/cordis), compaction rows run inside a
    // `cordis:group` with `isolate: { compaction: true }`. The host plane
    // provides process-global services (`storageDomain`, `llm`, `sessions`,
    // `tokenMeter`), while the isolated preset context provides `compaction`.
    // BasicCompactionEngine declares `storageDomain` in its static inject list
    // so Cordis allows `ctx.storageDomain` access across the isolate boundary.
    root = await mkdtemp(join(tmpdir(), 'dsh-tg-isolate-engine-'))
    const hostContext = new Context()
    contexts.push(hostContext)

    // Host-plane process-global services
    await hostContext.plugin(Storage)
    await hostContext.plugin(StorageJson, { root: join(root, 'storage') })
    await hostContext.plugin(StorageDomain, { backend: 'json' })
    await hostContext.plugin(LlmRuntime)
    await hostContext.plugin(SessionStore)
    await hostContext.plugin(SessionProjectionRegistry)
    await hostContext.plugin(TokenMeter)

    // Reproduce the preset isolate realm: ctx.isolate('compaction') creates a
    // child context whose 'compaction' service is scoped to this realm.
    const presetContext = hostContext.isolate('compaction')

    // Activate BasicCompactionEngine inside the preset isolate realm
    const engineFiber = await presetContext.plugin(BasicCompactionEngine, { auto: false })

    // 1. Prove the service is active in the isolate realm and absent from the host plane
    const engine = presetContext.get('compaction') as BasicCompactionEngine
    expect(engine).toBeInstanceOf(BasicCompactionEngine)
    expect(hostContext.get('compaction')).toBeUndefined()

    // 2. Prove the audit store opened successfully via host-plane storageDomain
    const auditPromise = (engine as unknown as { toolGroupAuditStorePromise?: Promise<void> }).toolGroupAuditStorePromise
    await auditPromise

    const store = (engine as unknown as { toolGroupAuditStore?: ToolGroupAuditStore }).toolGroupAuditStore
    expect(store).toBeDefined()

    // Verify the audit store is fully functional through the engine
    const record = openToolGroupAudit('tg-iso-1', 'session-iso', group, 5, 'provider', 'model', 'fp-iso', { createdAt: 100 })
    await store!.open(record)
    await store!.finish('tg-iso-1', current => ({
      ...current,
      status: 'success' as const,
      replacementSeqs: [SessionSeq(12)],
    }))
    const records = store!.recordsForSession('session-iso', 100)
    expect(records).toHaveLength(1)
    expect(records[0]?.status).toBe('success')
    expect(records[0]?.replacementSeqs).toEqual([SessionSeq(12)])

    // 3. Teardown: disposing the engine fiber disposes the store cleanly
    await engineFiber.dispose()
    expect(presetContext.get('compaction')).toBeUndefined()
    expect((engine as unknown as { toolGroupAuditStore?: ToolGroupAuditStore }).toolGroupAuditStore).toBeUndefined()
  })
})
