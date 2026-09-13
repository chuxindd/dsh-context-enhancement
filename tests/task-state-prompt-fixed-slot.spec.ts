/**
 * B5.1 · Stable Task State 固定槽位注入（fixed-slot replacement，无 append 累积）
 *
 * SCOPE (B5.1 only)
 * -----------------
 * The model-visible Stable task-state injection must move from the append-only
 * DSH runtime-context projection to ONE plugin-owned fixed slot per Session
 * lifecycle: the first committed stable CREATES the slot (surface append) and
 * every later revision REPLACES that exact node
 * (`surfaceOp: { op: 'replace', start, end }` + `sourceEventSeqs: [...]`), so a
 * Session can never carry two model-visible snapshots and the injection cost no
 * longer grows with the revision count. Injection budget `I`, X4 compaction
 * recovery, B6/B7/B8 are explicitly NOT part of this spec.
 *
 * WHAT IS REAL HERE (and what is deliberately emulated)
 * -----------------------------------------------------
 * REAL: `SessionStore` + real `Session` objects and their real surface fold,
 * real `SystemPrompt`, real `LlmRuntime` + a scripted adapter, real
 * `Storage`/`StorageJson`/`StorageDomain` durable domain, the real
 * `TaskStateBasicService` provider (scheduling, filter, fold, validation,
 * authoritative put, committed pointer), the real
 * `dsh-context-enhancement/task-state-prompt` consumer, and the real
 * `agent/pre-step` waterfall dispatch through Cordis.
 *
 * EMULATED (exactly two lines of `packages/core/agent-loop/src/agent.ts`): the
 * loop body appends the decision messages with `surfaceOp: 'append'` and derives
 * the request from `session.deriveMessages()`. Nothing else of the loop is
 * needed to observe the surface contract, and `runStep` below reproduces the
 * loop's ORDER faithfully (pre-step → append claimed → derive request), which is
 * the order the fixed-slot contract depends on. The end-to-end proof against the
 * real DSH `AgentLoop` lives in
 * `审计资料/实验结果/B5.1-E08修复后回归/` (E08 对照回归).
 *
 * WHY THE SLOT IS MAINTAINED AT `agent/pre-step`
 * ----------------------------------------------
 * DSH's loop is the only writer of the dynamic runtime-context projection and it
 * always appends; there is no boundary between its append and the request, and
 * shadowing its node makes it re-emit an unchanged snapshot on the next turn.
 * `agent/pre-step` is the step boundary that runs before `step/start`, before the
 * claimed messages are appended, and before the request is derived — and outside
 * every `Session.append()` publication, where a nested append is rejected by the
 * store as a reentrancy error.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { TaskStateBasicService } from '../src/task-state-basic.ts'
import type { TaskStateStable } from '../src/task-state.ts'
import * as TaskStatePrompt from '../src/task-state-prompt.ts'
import { buildSurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import {
  TASK_STATE_SLOT_ID,
  TASK_STATE_SLOT_SOURCE_KIND,
} from '../src/internal/task-state/contract/index.ts'
import type { TaskStateSlotSource } from '../src/internal/task-state/contract/index.ts'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Deployment byte budget of the prompt consumer in this spec. */
const MAX_BYTES = 8_000

/** Header line the production renderer emits first. */
const HEADER = /Durable task state \(revision (\d+), source event (\d+), digest ([0-9a-f]+)\)/

/** Scripted adapter emitting ONE valid task-state candidate per call, all different. */
class RevisionAdapter extends LlmAdapter {
  calls = 0

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    const text = JSON.stringify({
      facts: [{ content: `durable fact from auxiliary call ${this.calls}` }],
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: {
        currentObjective: `objective from auxiliary call ${this.calls}`,
        currentFocus: `focus from auxiliary call ${this.calls}`,
        openWork: [],
        nextActions: [],
      },
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One mounted real composition plus the step driver. */
interface Harness {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly adapter: RevisionAdapter
  readonly root: string
  promptFiber: { dispose: () => Promise<void> }
  turn: number
  step: number
}

let roots: string[] = []
let contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Mount the real composition; the prompt consumer can be re-mounted separately. */
async function mount(options: {
  root: string
  sessionId: string
  createdAt: number
  seed?: readonly SessionEvent[]
  mountPrompt?: boolean
}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(options.root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
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
  const adapter = new RevisionAdapter()
  ctx.llm.registerAdapter(['current-route'], adapter)
  const promptFiber = options.mountPrompt === false
    ? { dispose: async () => undefined }
    : await ctx.plugin(TaskStatePrompt, { maxBytes: MAX_BYTES })
  const session = ctx.sessions.create(SessionId(options.sessionId), {
    meta: { cwd: options.root, createdAt: options.createdAt },
    ...options.seed === undefined ? {} : { seed: options.seed },
  })
  return {
    ctx,
    session,
    agent: { session } as unknown as Agent,
    adapter,
    root: options.root,
    promptFiber: promptFiber as { dispose: () => Promise<void> },
    turn: 1,
    step: 1,
  }
}

/** Create a fresh composition root under the OS temp directory. */
async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-b51-fixed-slot-'))
  roots.push(root)
  return root
}

/** Poll one predicate until it holds or the deadline elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('composition did not settle in time')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/** Append one direct human user/message (the provider folds it). */
function appendHuman(session: Session, text: string): SessionEvent {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Commit ONE more stable revision through the real provider and adapter. */
async function commitRevision(h: Harness, prompt: string): Promise<TaskStateStable> {
  const before = h.ctx.taskState.getStable(h.session.id)?.revision ?? 0
  appendHuman(h.session, prompt)
  await waitUntil(() => (h.ctx.taskState.getStable(h.session.id)?.revision ?? 0) > before)
  const stable = h.ctx.taskState.getStable(h.session.id)
  if (stable === undefined) throw new Error('provider published no stable')
  return stable
}

/**
 * Drive ONE loop step boundary exactly as `agent.ts` does, and return the
 * model-visible request messages of that step.
 */
async function runStep(h: Harness, prompt?: string): Promise<readonly Message[]> {
  const claimed: UserMessage[] = prompt === undefined ? [] : [createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  })]
  const turn = h.turn
  const step = h.step
  h.step += 1
  const decision = await h.ctx.waterfall(
    'agent/pre-step',
    { agent: h.agent, messages: claimed, turn, step, signal: new AbortController().signal },
    async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: claimed }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      h.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
  h.turn += 1
  h.step = 1
  return h.session.deriveMessages()
}

/** Whether one event is a Stable task-state slot node. */
function isSlotEvent(event: SessionEvent): boolean {
  return event.type === 'user/message'
    && (event.data.source as { readonly kind?: unknown }).kind === TASK_STATE_SLOT_SOURCE_KIND
}

/** Every slot node in the Session log, in log order. */
function slotLog(session: Session): SessionEvent[] {
  return session.snapshotEvents().filter(isSlotEvent)
}

/** Every slot node still ON the surface, in surface order. */
function visibleSlots(session: Session): SessionEvent[] {
  const nodes: SessionEvent[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event !== undefined && isSlotEvent(event)) nodes.push(event)
  }
  return nodes
}

/** The rendered text of one slot node. */
function slotText(event: SessionEvent): string {
  const content = (event.data as { readonly content?: readonly { readonly text?: string }[] }).content
  return content?.[0]?.text ?? ''
}

/** The slot source of one slot node. */
function slotSourceOf(event: SessionEvent): TaskStateSlotSource {
  return (event.data as { readonly source: TaskStateSlotSource }).source
}

/**
 * The durable surface intent of one log event.
 *
 * `surfaceOp` / `sourceEventSeqs` are carried only by surface-eligible event
 * types, so the union type does not expose them on a general `SessionEvent`;
 * this view is how the spec reads the surface contract off the log.
 */
function surfaceIntentOf(event: SessionEvent): {
  readonly surfaceOp?: string | { readonly op?: unknown; readonly start?: unknown; readonly end?: unknown }
  readonly sourceEventSeqs?: readonly unknown[]
} {
  return event as unknown as {
    readonly surfaceOp?: string | { readonly op?: unknown; readonly start?: unknown; readonly end?: unknown }
    readonly sourceEventSeqs?: readonly unknown[]
  }
}

/** The revision a rendered slot text presents, or null. */
function revisionOf(text: string): number | null {
  const match = HEADER.exec(text)
  return match === null ? null : Number(match[1])
}

/** Every model-visible message that is a Stable task-state slot node. */
function slotMessages(messages: readonly Message[]): Message[] {
  return messages.filter(message =>
    (message.source as { readonly kind?: unknown }).kind === TASK_STATE_SLOT_SOURCE_KIND)
}

/** Model-visible texts of every user-role message. */
function messagesText(messages: readonly Message[]): string[] {
  return messages.flatMap(message => message.content.flatMap(block =>
    block.type === 'text' ? [block.text] : []))
}

/** Induce ONE failure in the next real slot append (real Session, real store). */
function failNextSlotAppend(session: Session): { restore: () => void; hits: () => number } {
  const original = session.append.bind(session) as Session['append']
  let remaining = 1
  let hits = 0
  const patched = ((type: never, data: never, opts?: never): unknown => {
    const source = (data as { readonly source?: { readonly kind?: unknown } }).source
    if (source?.kind === TASK_STATE_SLOT_SOURCE_KIND && remaining > 0) {
      remaining -= 1
      hits += 1
      throw new Error('induced slot append failure')
    }
    return (original as (t: never, d: never, o?: never) => unknown)(type, data, opts)
  }) as unknown as Session['append']
  session.append = patched
  return {
    restore: () => {
      delete (session as unknown as Record<string, unknown>)['append']
    },
    hits: () => hits,
  }
}

/** Hand-build one extra slot node, simulating a duplicate from another producer. */
function appendDuplicateSlot(session: Session, revision: number, generation: number): SessionEvent {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Durable task state (revision ${revision}, source event 0, digest ${'0'.repeat(64)}).\nduplicate slot node` }],
    source: {
      kind: TASK_STATE_SLOT_SOURCE_KIND,
      slotId: TASK_STATE_SLOT_ID,
      sessionId: String(session.id),
      lifecycleCreatedAt: session.header.createdAt,
      generation,
      revision,
      digest: '0'.repeat(64),
      sourceCursor: 0,
      coveredSeqs: [],
    },
  }), { surfaceOp: 'append' })
}

const SESSION = 'b51-fixed-slot'
const CREATED_AT = 1_700_000_000_000

// ---------------------------------------------------------------------------
// 1. first stable creates the ONE slot; the runtime context carries no stable
// ---------------------------------------------------------------------------

describe('B5.1 · Stable task-state fixed slot', () => {
  it('creates exactly one slot node on the first committed stable and never renders the stable into the runtime context', async () => {
    const root = await newRoot()
    const h = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    const stable = await commitRevision(h, 'first prompt')

    // The assembly contribution is registered but renders nothing: a non-empty
    // value here is exactly the append-only projection E08 measured.
    const assembly = await h.ctx.systemPrompt.assemble({ agent: h.agent })
    expect(assembly.contexts.some(entry => entry.name === 'task-state:snapshot')).toBe(true)
    expect(renderContextSnapshot(assembly)).toBe('')
    expect(renderContextSnapshot(assembly)).not.toContain('Durable task state')

    // Assembly performs no session side effect at all.
    expect(slotLog(h.session)).toHaveLength(0)

    const messages = await runStep(h)
    const visible = visibleSlots(h.session)
    expect(visible).toHaveLength(1)
    expect(surfaceIntentOf(visible[0]!).surfaceOp).toBe('append')
    const source = slotSourceOf(visible[0]!)
    expect(source.kind).toBe(TASK_STATE_SLOT_SOURCE_KIND)
    expect(source.slotId).toBe(TASK_STATE_SLOT_ID)
    expect(source.sessionId).toBe(String(h.session.id))
    expect(source.lifecycleCreatedAt).toBe(CREATED_AT)
    expect(source.generation).toBe(1)
    expect(source.revision).toBe(stable.revision)
    expect(source.digest).toBe(stable.digest)
    expect(source.sourceCursor).toBe(stable.sourceCursor)
    expect(source.coveredSeqs).toEqual([])
    expect(source.previousRevision).toBeUndefined()
    expect(source.previousGeneration).toBeUndefined()
    expect(surfaceIntentOf(visible[0]!).sourceEventSeqs).toBeUndefined()

    // The model-visible request of that step carries exactly one slot message,
    // presenting the committed revision.
    const slots = slotMessages(messages)
    expect(slots).toHaveLength(1)
    expect(messagesText(slots).join('')).toContain(`revision ${stable.revision},`)
  })

  // -------------------------------------------------------------------------
  // 2. twenty revisions: one visible slot, old revisions invisible
  // -------------------------------------------------------------------------

  it('keeps exactly ONE visible slot node across 20 revisions, hides every old revision, and stamps a monotone replacement chain', async () => {
    const root = await newRoot()
    const h = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })

    await commitRevision(h, 'prompt 1')
    const first = await runStep(h)
    expect(slotMessages(first)).toHaveLength(1)
    const firstBytes = Buffer.byteLength(messagesText(slotMessages(first)).join(''), 'utf8')

    for (let revision = 2; revision <= 20; revision += 1) {
      const stable = await commitRevision(h, `prompt ${revision}`)
      expect(stable.revision).toBe(revision)
      const messages = await runStep(h)

      const visible = visibleSlots(h.session)
      expect(visible).toHaveLength(1)
      expect(revisionOf(slotText(visible[0]!))).toBe(revision)

      const slots = slotMessages(messages)
      expect(slots).toHaveLength(1)
      const text = messagesText(slots).join('')
      expect(text).toContain(`revision ${revision},`)
      // No OLDER revision is model-visible anywhere in the request.
      for (let older = 1; older < revision; older += 1) {
        expect(text).not.toContain(`revision ${older},`)
      }
      // ... and no old revision is visible on the surface either.
      for (const node of visible) {
        expect(revisionOf(slotText(node))).toBe(revision)
      }
    }

    // 20 revisions, 20 slot nodes in the log, ONE on the surface, the newest.
    const log = slotLog(h.session)
    expect(log).toHaveLength(20)
    const surface = visibleSlots(h.session)
    expect(surface).toHaveLength(1)
    expect(surface[0]!.seq).toBe(log.at(-1)!.seq)

    // Generation is strictly increasing along the log.
    const generations = log.map(event => slotSourceOf(event).generation)
    expect(generations).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))

    // Every later node is a single-node replacement of its predecessor and
    // records oldRevision/newRevision, the covered surface range, the digest and
    // the slot generation.
    for (let index = 1; index < log.length; index += 1) {
      const previous = log[index - 1]!
      const current = log[index]!
      expect(surfaceIntentOf(current).surfaceOp).toEqual({ op: 'replace', start: previous.seq, end: previous.seq })
      expect(surfaceIntentOf(current).sourceEventSeqs).toEqual([previous.seq])
      const source = slotSourceOf(current)
      const previousSource = slotSourceOf(previous)
      expect(source.previousRevision).toBe(previousSource.revision)
      expect(source.previousGeneration).toBe(previousSource.generation)
      expect(source.coveredSeqs).toEqual([Number(previous.seq)])
      expect(source.generation).toBe(previousSource.generation + 1)
      expect(source.revision).toBe(previousSource.revision + 1)
    }

    // Injection size stays flat instead of growing with the revision count.
    const lastBytes = Buffer.byteLength(slotText(surface[0]!), 'utf8')
    expect(lastBytes).toBeLessThan(firstBytes * 2)
  })

  // -------------------------------------------------------------------------
  // 3. a failed replacement fails closed, and the next step retries
  // -------------------------------------------------------------------------

  it('appends nothing when the replacement throws, keeping the previous revision as the only visible snapshot, and retries on the next step', async () => {
    const root = await newRoot()
    const h = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    await commitRevision(h, 'prompt 1')
    await runStep(h)
    const before = visibleSlots(h.session)
    expect(before).toHaveLength(1)

    const next = await commitRevision(h, 'prompt 2')
    const injected = failNextSlotAppend(h.session)
    await runStep(h)
    injected.restore()

    expect(injected.hits()).toBe(1)
    // Fail closed: the failed replacement committed nothing, so the surface still
    // holds exactly ONE slot node — the previous revision, not a second one.
    expect(slotLog(h.session)).toHaveLength(1)
    const afterFailure = visibleSlots(h.session)
    expect(afterFailure).toHaveLength(1)
    expect(afterFailure[0]!.seq).toBe(before[0]!.seq)
    expect(revisionOf(slotText(afterFailure[0]!))).toBe(slotSourceOf(before[0]!).revision)
    expect(TaskStatePrompt.taskStateSlotDiagnostics(h.ctx)[0]?.failures).toBe(1)

    // The next step retries the same replacement and succeeds.
    const messages = await runStep(h)
    const visible = visibleSlots(h.session)
    expect(visible).toHaveLength(1)
    expect(visible[0]!.seq).not.toBe(before[0]!.seq)
    expect(surfaceIntentOf(visible[0]!).surfaceOp).toEqual({ op: 'replace', start: before[0]!.seq, end: before[0]!.seq })
    expect(revisionOf(slotText(visible[0]!))).toBe(next.revision)
    expect(slotMessages(messages)).toHaveLength(1)
    expect(TaskStatePrompt.taskStateSlotDiagnostics(h.ctx)[0]?.failures).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 4. a slot shadowed by another surface operation is safely rebuilt
  // -------------------------------------------------------------------------

  it('rebuilds the slot safely when another surface operation removed it, without leaving the old node visible', async () => {
    const root = await newRoot()
    const h = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    await commitRevision(h, 'prompt 1')
    await runStep(h)
    const first = visibleSlots(h.session)[0]!

    // A real third-party surface replacement (the compaction shape) shadows the
    // slot node. The original event stays in the log: nothing is deleted.
    h.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'history summary of the shadowed run' }],
      source: { kind: 'plugin', plugin: 'spec-compaction', form: 'notice', summary: 'compacted' },
    }), {
      surfaceOp: { op: 'replace', start: first.seq, end: first.seq },
      sourceEventSeqs: [first.seq],
    })
    expect(visibleSlots(h.session)).toHaveLength(0)

    const stable = await commitRevision(h, 'prompt 2')
    await runStep(h)

    const visible = visibleSlots(h.session)
    expect(visible).toHaveLength(1)
    // A plain append is the only correct rebuild: the node it would have
    // replaced is no longer on the surface.
    expect(surfaceIntentOf(visible[0]!).surfaceOp).toBe('append')
    expect(slotSourceOf(visible[0]!).generation).toBe(2)
    expect(slotSourceOf(visible[0]!).previousRevision).toBeUndefined()
    expect(revisionOf(slotText(visible[0]!))).toBe(stable.revision)
    // The shadowed slot is still in the log, and no visible node shows it.
    expect(h.session.snapshotEvents().some(event => event.seq === first.seq)).toBe(true)
    expect(TaskStatePrompt.taskStateSlotDiagnostics(h.ctx)[0]?.rebuilds).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 5. duplicate visible slots collapse; a non-contiguous run fails closed
  // -------------------------------------------------------------------------

  it('collapses two contiguous visible slot nodes into ONE through a single range replacement', async () => {
    const root = await newRoot()
    const h = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    await commitRevision(h, 'prompt 1')
    await runStep(h)
    const first = visibleSlots(h.session)[0]!
    // A second producer appended a duplicate slot node (the legacy/buggy shape).
    const duplicate = appendDuplicateSlot(h.session, 1, 2)
    expect(visibleSlots(h.session)).toHaveLength(2)

    const stable = await commitRevision(h, 'prompt 2')
    await runStep(h)

    const visible = visibleSlots(h.session)
    expect(visible).toHaveLength(1)
    expect(surfaceIntentOf(visible[0]!).surfaceOp).toEqual({ op: 'replace', start: first.seq, end: duplicate.seq })
    expect(surfaceIntentOf(visible[0]!).sourceEventSeqs).toEqual([first.seq, duplicate.seq])
    expect(slotSourceOf(visible[0]!).coveredSeqs).toEqual([Number(first.seq), Number(duplicate.seq)])
    expect(slotSourceOf(visible[0]!).generation).toBe(3)
    expect(revisionOf(slotText(visible[0]!))).toBe(stable.revision)
  })

  it('fails closed instead of shadowing real content when visible slot nodes are not contiguous', async () => {
    const root = await newRoot()
    const h = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    await commitRevision(h, 'prompt 1')
    await runStep(h)
    const first = visibleSlots(h.session)[0]!
    // Real conversation content between the two slot nodes: a range replacement
    // would have to shadow it, so the contract must refuse to collapse.
    const human = appendHuman(h.session, 'real work between the slot nodes')
    const duplicate = appendDuplicateSlot(h.session, 1, 2)
    expect(visibleSlots(h.session)).toHaveLength(2)
    const before = slotLog(h.session).length

    await commitRevision(h, 'prompt 2')
    await runStep(h)

    expect(slotLog(h.session)).toHaveLength(before)
    expect(visibleSlots(h.session)).toHaveLength(2)
    expect(TaskStatePrompt.taskStateSlotDiagnostics(h.ctx)[0]?.collisions).toBe(1)
    // The real content the collapse would have destroyed is untouched.
    expect(h.session.surface.nodes.includes(human.seq)).toBe(true)
    expect(h.session.surface.nodes.includes(first.seq)).toBe(true)
    expect(h.session.surface.nodes.includes(duplicate.seq)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 6. dispose, resume, fork
  // -------------------------------------------------------------------------

  it('drops the in-memory slot on dispose and adopts the logged node after a re-mount instead of adding a second one', async () => {
    const root = await newRoot()
    const h = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    await commitRevision(h, 'prompt 1')
    await runStep(h)
    const adopted = visibleSlots(h.session)[0]!
    expect(TaskStatePrompt.taskStateSlotDiagnostics(h.ctx)).toHaveLength(1)

    await h.promptFiber.dispose()
    expect(TaskStatePrompt.taskStateSlotDiagnostics(h.ctx)).toHaveLength(0)

    // Re-mount (the HMR / process-restart analogue): the fresh instance holds no
    // memory and must re-resolve the slot from the Session's own log.
    h.promptFiber = await h.ctx.plugin(TaskStatePrompt, { maxBytes: MAX_BYTES })
    const logBefore = slotLog(h.session).length
    await runStep(h)
    expect(slotLog(h.session)).toHaveLength(logBefore)
    expect(visibleSlots(h.session)[0]!.seq).toBe(adopted.seq)
    expect(TaskStatePrompt.taskStateSlotDiagnostics(h.ctx)).toHaveLength(1)

    // The first revision change after the re-mount is a REPLACEMENT of the
    // adopted node, never a second visible snapshot.
    const stable = await commitRevision(h, 'prompt 2')
    await runStep(h)
    const visible = visibleSlots(h.session)
    expect(visible).toHaveLength(1)
    expect(visible[0]!.seq).not.toBe(adopted.seq)
    expect(surfaceIntentOf(visible[0]!).surfaceOp).toEqual({ op: 'replace', start: adopted.seq, end: adopted.seq })
    expect(revisionOf(slotText(visible[0]!))).toBe(stable.revision)
  })

  it('verifies and reuses the resumed log of a same-id Session in a fresh composition, then replaces its node', async () => {
    const root = await newRoot()
    const first = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    await commitRevision(first, 'prompt 1')
    await runStep(first)
    const inherited = visibleSlots(first.session)[0]!
    const log = first.session.snapshotEvents()
    await first.ctx.fiber.dispose()
    contexts = contexts.filter(ctx => ctx !== first.ctx)

    // A restart: a NEW composition, a NEW Session object for the SAME id, with
    // the previous lifecycle identity and the restored log.
    const resumed = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT, seed: log })
    expect(resumed.session).not.toBe(first.session)
    expect(resumed.ctx.taskState.getStable(resumed.session.id)?.revision).toBe(1)

    // The fresh consumer holds no memory at all...
    expect(TaskStatePrompt.taskStateSlotDiagnostics(resumed.ctx)).toHaveLength(0)
    // ... and adopts the slot from THIS Session's own surface instead of adding
    // a second visible snapshot.
    const logBefore = slotLog(resumed.session).length
    await runStep(resumed)
    expect(slotLog(resumed.session)).toHaveLength(logBefore)
    const adopted = visibleSlots(resumed.session)
    expect(adopted).toHaveLength(1)
    expect(adopted[0]!.seq).toBe(inherited.seq)
    expect(TaskStatePrompt.taskStateSlotDiagnostics(resumed.ctx)[0]?.slotSeq).toBe(Number(inherited.seq))

    // The resumed lifecycle then replaces that adopted node (generation continues
    // monotonically across the resumed log).
    const stable = await commitRevision(resumed, 'prompt 2')
    await runStep(resumed)
    const visible = visibleSlots(resumed.session)
    expect(visible).toHaveLength(1)
    expect(surfaceIntentOf(visible[0]!).surfaceOp).toEqual({ op: 'replace', start: inherited.seq, end: inherited.seq })
    expect(slotSourceOf(visible[0]!).generation).toBe(2)
    expect(revisionOf(slotText(visible[0]!))).toBe(stable.revision)
  })

  it('injects nothing when the resumed same-id Session belongs to a different lifecycle', async () => {
    const root = await newRoot()
    const first = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    await commitRevision(first, 'prompt 1')
    await runStep(first)
    const log = first.session.snapshotEvents()
    await first.ctx.fiber.dispose()
    contexts = contexts.filter(ctx => ctx !== first.ctx)

    // Same id, DIFFERENT lifecycle identity: the provider fences the stored
    // stable off, so no stable is published for this Session and the consumer
    // must fabricate nothing.
    const resumed = await mount({
      root,
      sessionId: SESSION,
      createdAt: CREATED_AT + 1,
      seed: log,
    })
    expect(resumed.ctx.taskState.getStable(resumed.session.id)).toBeUndefined()
    const logBefore = slotLog(resumed.session).length
    await runStep(resumed)
    expect(slotLog(resumed.session)).toHaveLength(logBefore)
    expect(TaskStatePrompt.taskStateSlotDiagnostics(resumed.ctx)).toHaveLength(0)
  })

  it('never reuses the parent in-memory slot for a forked child, and replaces the inherited node in the child only', async () => {
    const root = await newRoot()
    const parent = await mount({ root, sessionId: 'b51-parent', createdAt: CREATED_AT })
    await commitRevision(parent, 'parent prompt 1')
    await runStep(parent)
    const parentSlot = visibleSlots(parent.session)[0]!
    const parentLogLength = slotLog(parent.session).length

    const child = parent.ctx.sessions.fork(parent.session, undefined, SessionId('b51-child'))
    expect(child).not.toBe(parent.session)
    expect(child.snapshotEvents().length).toBeGreaterThan(0)

    // The child inherits the log prefix (and therefore the NODE) but inherits NO
    // process memory. Its own committed revision is a different stable, so its
    // first step must replace the INHERITED node inside the child instead of
    // adopting the parent's in-memory slot record.
    const childAgent = { session: child } as unknown as Agent
    const childHarness: Harness = { ...parent, session: child, agent: childAgent }
    const childStable = await commitRevision(childHarness, 'child prompt')
    await runStep(childHarness)
    const childVisible = visibleSlots(child)
    expect(childVisible).toHaveLength(1)
    expect(surfaceIntentOf(childVisible[0]!).surfaceOp).toEqual({
      op: 'replace',
      start: parentSlot.seq,
      end: parentSlot.seq,
    })
    expect(slotSourceOf(childVisible[0]!).generation).toBe(slotSourceOf(parentSlot).generation + 1)
    expect(slotSourceOf(childVisible[0]!).sessionId).toBe(String(child.id))
    expect(slotSourceOf(childVisible[0]!).previousRevision).toBe(slotSourceOf(parentSlot).revision)
    expect(revisionOf(slotText(childVisible[0]!))).toBe(childStable.revision)

    // The parent is untouched: same log, same visible node, and the consumer
    // tracks one slot per Session, never one shared record.
    expect(slotLog(parent.session)).toHaveLength(parentLogLength)
    expect(visibleSlots(parent.session)[0]!.seq).toBe(parentSlot.seq)
    const diagnostics = TaskStatePrompt.taskStateSlotDiagnostics(parent.ctx)
    expect(diagnostics).toHaveLength(2)
    expect(new Set(diagnostics.map(entry => entry.sessionId)).size).toBe(2)
  })

  // -------------------------------------------------------------------------
  // 7. synchronous-stack safety
  // -------------------------------------------------------------------------

  it('appends nothing during assembly or inside an append publication, and has the slot in place before the request is derived', async () => {
    const root = await newRoot()
    const h = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    await commitRevision(h, 'prompt 1')

    // Instrument the REAL store append: count calls, and detect a call that is
    // nested inside another append's publication (the store rejects that shape
    // as a reentrancy error, so a nested attempt is a contract violation).
    const original = h.session.append.bind(h.session) as Session['append']
    let depth = 0
    let appends = 0
    let nestedSlotAppends = 0
    h.session.append = ((type: never, data: never, opts?: never): unknown => {
      depth += 1
      const source = (data as { readonly source?: { readonly kind?: unknown } }).source
      if (source?.kind === TASK_STATE_SLOT_SOURCE_KIND) {
        appends += 1
        if (depth > 1) nestedSlotAppends += 1
      }
      try {
        return (original as (t: never, d: never, o?: never) => unknown)(type, data, opts)
      } finally {
        depth -= 1
      }
    }) as unknown as Session['append']

    const beforeAssembly = appends
    await h.ctx.systemPrompt.assemble({ agent: h.agent })
    expect(appends).toBe(beforeAssembly)

    await runStep(h)
    expect(appends).toBe(1)
    expect(nestedSlotAppends).toBe(0)

    // The slot was established inside the pre-step await: deriving the request
    // right after the boundary already sees the current revision and only ONE
    // slot node, so no request can ever observe two snapshots at once.
    const surfaceGeneration = h.session.surface.replaceGeneration
    await commitRevision(h, 'prompt 2')
    const decision = await h.ctx.waterfall(
      'agent/pre-step',
      { agent: h.agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }),
    )
    expect(decision.kind).toBe('enter')
    expect(h.session.surface.replaceGeneration).toBe(surfaceGeneration + 1)
    const visible = visibleSlots(h.session)
    expect(visible).toHaveLength(1)
    expect(revisionOf(slotText(visible[0]!))).toBe(2)
    expect(slotMessages(h.session.deriveMessages())).toHaveLength(1)

    // A step the loop REJECTS owns no slot, and neither does an aborted turn:
    // both derive no request, so no node may be added for them.
    const logBefore = slotLog(h.session).length
    const rejected = await h.ctx.waterfall(
      'agent/pre-step',
      { agent: h.agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal },
      async (): Promise<PreStepDecision> => ({ kind: 'reject' }),
    )
    expect(rejected.kind).toBe('reject')
    expect(slotLog(h.session)).toHaveLength(logBefore)

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await h.ctx.waterfall(
      'agent/pre-step',
      { agent: h.agent, messages: [], turn: 3, step: 1, signal: controller.signal },
      async (): Promise<PreStepDecision> => ({
        kind: 'enter',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })],
      }),
    )
    expect(slotLog(h.session)).toHaveLength(logBefore)

    // An `enter` IS the model call, so even a boundary with no claimed message
    // keeps exactly one visible slot instead of dropping the state.
    const empty = await h.ctx.waterfall(
      'agent/pre-step',
      { agent: h.agent, messages: [], turn: 4, step: 1, signal: new AbortController().signal },
      async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }),
    )
    expect(empty.kind).toBe('enter')
    expect(slotLog(h.session)).toHaveLength(logBefore)
    expect(visibleSlots(h.session)).toHaveLength(1)
    delete (h.session as unknown as Record<string, unknown>)['append']
  })

  // -------------------------------------------------------------------------
  // 8. source provenance and compaction classification
  // -------------------------------------------------------------------------

  it('classifies the slot as a runtime/task-state source in the surface source index, never as an ordinary original', async () => {
    const root = await newRoot()
    const h = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    await commitRevision(h, 'prompt 1')
    await runStep(h)
    const creating = visibleSlots(h.session)[0]!

    // The CREATING node (append-origin) is a task-state source too: reporting it
    // as `original` would let history compaction fold durable state as dialogue.
    const firstIndex = buildSurfaceSourceIndex(h.session)
    expect(firstIndex.entry(creating.seq).kind).toBe('task-state-slot')
    expect(firstIndex.replacementCoverage(creating.seq)).toEqual({
      kind: 'task-state-slot',
      coveredSeqs: null,
    })
    // Not treated as an ordinary original, and not waivable by the pressure flag.
    expect(firstIndex.canCompactHistory(creating.seq, 1)).toBe(false)

    const stable = await commitRevision(h, 'prompt 2')
    await runStep(h)
    const replacement = visibleSlots(h.session)[0]!
    expect(surfaceIntentOf(replacement).surfaceOp).toEqual({ op: 'replace', start: creating.seq, end: creating.seq })

    // Three completed turns after the replacement: the known-replacement age rule
    // applies (unlike `original`, which is eligible immediately), while the
    // immediate-reentry waiver that compaction reserves for its own replacements
    // does NOT.
    for (let turn = 1; turn <= 3; turn += 1) {
      h.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const index = buildSurfaceSourceIndex(h.session)
    expect(index.entry(replacement.seq).kind).toBe('task-state-slot')
    expect(index.replacementCoverage(replacement.seq)).toEqual({
      kind: 'task-state-slot',
      coveredSeqs: [creating.seq],
    })
    expect(index.canCompactHistory(replacement.seq, 3)).toBe(true)
    expect(index.canCompactHistory(replacement.seq, 5)).toBe(false)
    expect(index.canCompactHistory(replacement.seq, 5, true)).toBe(false)

    // Positive control: a real human message is still an ordinary original.
    const human = h.session.snapshotEvents().find(event =>
      event.type === 'user/message' && (event.data.source as { readonly kind?: unknown }).kind === 'user')!
    expect(index.entry(human.seq).kind).toBe('original')
    expect(index.replacementCoverage(human.seq)).toEqual({ kind: 'original', coveredSeqs: null })
    expect(index.canCompactHistory(human.seq, 5)).toBe(true)
    expect(revisionOf(slotText(replacement))).toBe(stable.revision)
  })

  it('records the revision of the stable it presents, and renders within the deployment byte budget', async () => {
    const root = await newRoot()
    const h = await mount({ root, sessionId: SESSION, createdAt: CREATED_AT })
    const stable = await commitRevision(h, 'prompt 1')
    await runStep(h)
    const node = visibleSlots(h.session)[0]!
    const rendered = TaskStatePrompt.renderTaskStateSnapshot(stable, MAX_BYTES)
    expect(slotText(node)).toBe(rendered)
    expect(Buffer.byteLength(slotText(node), 'utf8')).toBeLessThanOrEqual(MAX_BYTES)
  })
})
