/**
 * Prompt consumer for durable task state (`dsh-context-enhancement/task-state-prompt`).
 *
 * MODEL-VISIBLE DELIVERY IS A PLUGIN-OWNED FIXED SLOT
 * ---------------------------------------------------
 * One Session lifecycle carries AT MOST ONE model-visible Stable task-state
 * slot: a `user/message` surface node whose `source.kind` is
 * `task-state-slot`. The first committed stable CREATES the slot with a plain
 * surface append; every later committed revision REPLACES that exact node with
 * `surfaceOp: { op: 'replace', start, end }` plus `sourceEventSeqs: [start]`,
 * so the previous revision stops being model-visible instead of accumulating.
 *
 * Why the delivery is not the dynamic runtime context anymore
 * ----------------------------------------------------------
 * The `{{task_state_snapshot}}` runtime-context contribution is still
 * registered (the template and the variable name stay reserved, and an
 * unregistered variable would make assembly throw), but its value is the empty
 * string. DSH's agent loop is the only writer of that projection and it appends
 * (`packages/core/agent-loop/src/agent.ts`: `surfaceOp: 'append'`), with no
 * plugin-visible boundary between its append and the request derived from the
 * surface; shadowing its node does not converge either, because
 * `RuntimeContextProjection` re-emits an unchanged snapshot once its retained
 * node is replaced. Any non-empty value here therefore re-enters the
 * append-only projection that E08 measured (one visible snapshot per revision).
 * The legal replacement channel is the plugin's own append, which is what this
 * module uses.
 *
 * WHERE THE SLOT IS MAINTAINED, AND WHY IT IS SAFE HERE
 * -----------------------------------------------------
 * Maintenance runs on the `agent/pre-step` waterfall — the step boundary the
 * host dispatches before `step/start`, before the claimed messages are
 * appended, and before the request is derived. That is outside every
 * `Session.append()` publication, so the append is legal: an observer of
 * `session/event` may NOT append (the store rejects a reentrant append while
 * another append is being published). Nothing is appended during prompt
 * assembly, so an assembly-only consumer performs no session side effect, and a
 * step the loop rejects (or an aborted turn) is left untouched, because no
 * request would ever read the node.
 *
 * INDEPENDENT INJECTION BUDGET I & STALENESS
 * ------------------------------------------
 * - Injection tokens are bounded by independent token budget I (maxTokens).
 * - maxBytes and maxTokens act as independent dual bounds; neither fakes the other.
 * - Authoritative Goal and TODO views render first and verbatim. If even the
 *   authoritative representation cannot fit within budget I or maxBytes, slot
 *   maintenance fails closed (typed blocked) and injects nothing misleading.
 * - When durable cursor lags eligible session events, text carries an explicit
 *   stale marker and source metadata records staleness: 'stale'. Once a catch-up
 *   revision is committed, staleness returns to 'fresh'.
 *
 * FAIL-CLOSED RULES
 * -----------------
 * - a replacement that throws is caught locally, counted, and appends nothing:
 *   the surface keeps exactly the node it had, so the model never sees two
 *   snapshots at once;
 * - a slot node shadowed by another surface operation (compaction) is rebuilt
 *   with a fresh generation instead of a stale replacement;
 * - two or more visible slot nodes collapse into ONE node through a single
 *   range replacement, and only when the shadowed run is contiguous; a
 *   non-contiguous run would force a range replacement over real content, so it
 *   fails closed and appends nothing;
 * - in-memory bookkeeping is fenced to the exact Session object AND lifecycle,
 *   so a resumed same-id Session re-resolves the slot from ITS OWN log, and a
 *   forked child never reuses its parent's record.
 * @module dsh-context-enhancement/internal/task-state/prompt/index
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS,
  TASK_STATE_SLOT_ID,
  TASK_STATE_SLOT_SOURCE_KIND,
  isTaskStateSlotSource,
} from '../contract/index.ts'
import type {
  TaskStateSlotSource,
  TaskStateStable,
  TaskStateStaleness,
} from '../contract/types.ts'
import { isEligibleType } from '../basic/filter.ts'
import {
  renderTaskStateSlot,
  resolveInjectionBudget,
} from './render.ts'
import type { RenderTaskStateSlotResult } from './render.ts'
import type { ResolvedInjectionBudget, TaskStatePromptConfig } from './types.ts'

export {
  TASK_STATE_STALE_MARKER,
  TASK_STATE_TRUNCATION_MARKER,
  estimateSlotTokens,
  renderTaskStateSlot,
  renderTaskStateSnapshot,
  resolveInjectionBudget,
} from './render.ts'
export type { RenderTaskStateSlotOptions, RenderTaskStateSlotResult } from './render.ts'
export type { ResolvedInjectionBudget, TaskStatePromptConfig } from './types.ts'
// The slot vocabulary belongs to this consumer's public surface: a host or a
// sibling plugin that must recognise (or reconstruct) the slot node reads it
// from the logged `source`, never from process memory.
export {
  DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS,
  TASK_STATE_SLOT_ID,
  TASK_STATE_SLOT_SOURCE_KIND,
  isTaskStateSlotSource,
} from '../contract/index.ts'
export type {
  TaskStateSlotSource,
  TaskStateSlotSourceKind,
  TaskStateStaleness,
} from '../contract/types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'task-state-prompt'

/**
 * Register the runtime-context contribution while `systemPrompt` is available.
 * No service key is injected for `taskState` or `sessions`: a composition
 * without a task-state provider, or without a session store, must still mount
 * cleanly (injecting nothing) rather than wait on a service.
 */
export const inject = ['systemPrompt']

/** Schemastery validation for {@link TaskStatePromptConfig}. */
export const Config: z<TaskStatePromptConfig> = z.object({
  maxBytes: z.number().step(1).min(1).required(),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS),
})

/**
 * The reserved runtime-context template. It stays registered (with its variable
 * name, which assembly requires to exist) while rendering nothing: the
 * model-visible stable rides the fixed slot, never the append-only
 * runtime-context projection. See the module header.
 */
const SNAPSHOT_CONTEXT = '{{task_state_snapshot}}'

/** The reserved variable's value: the slot carries the text, not this context. */
const RESERVED_EMPTY = ''

/** One live Session's in-memory slot bookkeeping, never shared across lifecycles. */
interface TaskStateSlotRecord {
  /** The exact Session object the record was resolved from (object-level fence). */
  readonly session: Session
  /** Epoch ms of that Session's lifecycle (`Session.header.createdAt`). */
  readonly lifecycleCreatedAt: number
  /** Surface seq of the current slot node. */
  slotSeq: SessionSeq
  /** Generation stamped on the current slot node. */
  generation: number
  /** Revision the current slot node presents. */
  revision: number
  /** Digest the current slot node presents. */
  digest: string
  /** Exact model-visible text of the current slot node. */
  text: string
  /** Replacements that threw: the surface was left untouched (fail closed). */
  failures: number
  /** Fresh slot nodes appended after the previous node was lost. */
  rebuilds: number
  /** Visible slot sets that could not be collapsed (fail closed, nothing added). */
  collisions: number
  /** Highest eligible session event sequence observed. */
  eligibleHighWater: number
  /** Staleness verdict. */
  staleness: TaskStateStaleness
  /** Evaluated injection tokens. */
  injectionTokens: number
  /** Budget tokens I. */
  budgetTokens: number
  /** Truncation flag. */
  truncation: boolean
}

/** One slot node as it exists on the Session surface. */
interface TaskStateSlotNode {
  readonly seq: SessionSeq
  readonly generation: number
  readonly revision: number
  readonly digest: string
  readonly text: string
  readonly source: TaskStateSlotSource
}

/** Read-only diagnostics of the slot bookkeeping (host introspection and tests). */
export interface TaskStateSlotDiagnostics {
  readonly sessionId: string
  readonly lifecycleCreatedAt: number
  readonly slotSeq: number
  readonly generation: number
  readonly revision: number
  readonly digest: string
  readonly textBytes: number
  readonly failures: number
  readonly rebuilds: number
  readonly collisions: number
  readonly eligibleHighWater: number
  readonly staleness: TaskStateStaleness
  readonly injectionTokens: number
  readonly budgetTokens: number
  readonly truncation: boolean
}

/**
 * Per-root slot registries: one entry per mounted consumer, keyed by the root
 * context every child context shares. The registry is never module-global state
 * shared across mounts, so two mounted consumers cannot see each other's
 * bookkeeping, disposing one leaves the other intact, and a disposed consumer
 * leaves none behind.
 */
const slotRegistries = new WeakMap<Context, Set<Map<string, TaskStateSlotRecord>>>()

/**
 * Read the in-memory slot bookkeeping of every prompt consumer mounted in one
 * context's root.
 * @param ctx - Any context of the application (a plugin context works).
 * @returns One entry per Session a mounted consumer currently holds a slot for;
 *   empty for an unmounted or disposed consumer.
 */
export function taskStateSlotDiagnostics(ctx: Context): readonly TaskStateSlotDiagnostics[] {
  const registries = slotRegistries.get(ctx.root)
  if (registries === undefined) return []
  return [...registries].flatMap(registry => [...registry.values()].map(record => ({
    sessionId: String(record.session.id),
    lifecycleCreatedAt: record.lifecycleCreatedAt,
    slotSeq: Number(record.slotSeq),
    generation: record.generation,
    revision: record.revision,
    digest: record.digest,
    textBytes: record.text.length,
    failures: record.failures,
    rebuilds: record.rebuilds,
    collisions: record.collisions,
    eligibleHighWater: record.eligibleHighWater,
    staleness: record.staleness,
    injectionTokens: record.injectionTokens,
    budgetTokens: record.budgetTokens,
    truncation: record.truncation,
  })))
}

/** Best-effort diagnostic logging that never throws into the step. */
function warn(ctx: Context, message: string): void {
  try {
    ctx.logger.warn(message)
  } catch {
    // Diagnostics are best effort; a logging failure must not break a step.
  }
}

/** The model-visible text of one `user/message` slot node, or `undefined`. */
function slotTextOf(data: unknown): string | undefined {
  const content = (data as { readonly content?: unknown } | undefined)?.content
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block = content[0] as { readonly type?: unknown; readonly text?: unknown }
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined
}

/** Resolve one surface seq to a slot node of this Session, or `undefined`. */
function slotNodeAt(session: Session, seq: SessionSeq): TaskStateSlotNode | undefined {
  const event = session.eventAt(seq)
  if (event?.type !== 'user/message' || !isTaskStateSlotSource(event.data.source)) return undefined
  const text = slotTextOf(event.data)
  if (text === undefined) return undefined
  return {
    seq: event.seq,
    generation: event.data.source.generation,
    revision: event.data.source.revision,
    digest: event.data.source.digest,
    text,
    source: event.data.source,
  }
}

/** Every slot node currently ON the surface, in surface order. */
function visibleSlotNodes(session: Session): TaskStateSlotNode[] {
  const nodes: TaskStateSlotNode[] = []
  for (const seq of session.surface.nodes) {
    const node = slotNodeAt(session, seq)
    if (node !== undefined) nodes.push(node)
  }
  return nodes
}

/**
 * Scan the session's log for the highest sequence number of an eligible event.
 * Excludes slot nodes themselves to prevent slot self-feedback.
 */
function sessionEligibleHighWater(session: Session): number {
  let highest = 0
  for (const event of session.snapshotEvents()) {
    if (!isEligibleType(event.type)) continue
    if (event.type === 'user/message' && isTaskStateSlotSource((event.data as { source?: unknown } | undefined)?.source)) {
      continue
    }
    const seq = Number(event.seq)
    if (seq > highest) highest = seq
  }
  return highest
}

/**
 * Whether one logged slot node belongs to THIS Session lifecycle.
 *
 * A slot node is durable evidence of one lifecycle's own delivery, so it names
 * the Session id and lifecycle epoch that wrote it. Both must match the live
 * Session: a node inherited through a fork prefix names the PARENT's id and the
 * PARENT's epoch, and adopting it would make the child's in-memory bookkeeping
 * claim a node its own lifecycle never wrote — the child would then never
 * publish its own snapshot, and a later collapse would report the parent's node
 * as the child's own revision.
 *
 * Matching is by the durable `(sessionId, lifecycleCreatedAt)` pair alone, never
 * by content: an identical revision/digest/text is not ownership, because a
 * child that inherited the parent's prefix can legitimately hold a node whose
 * content its own stable also renders.
 * @param session - the live Session whose ownership is being decided.
 * @param source - the logged slot source of one candidate node.
 * @returns true when this exact lifecycle wrote the node.
 */
export function isOwnSlotNode(
  session: Session,
  source: Pick<TaskStateSlotSource, 'sessionId' | 'lifecycleCreatedAt'>,
): boolean {
  return source.sessionId === String(session.id)
    && source.lifecycleCreatedAt === session.header.createdAt
}

/**
 * The next slot generation: one past the highest generation anywhere in this
 * Session's own log. Generation therefore increases strictly along the log,
 * including across an inherited fork prefix or a resumed log, and never restarts
 * from process memory.
 */
function nextGeneration(session: Session, floor: number): number {
  let highest = floor
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message' || !isTaskStateSlotSource(event.data.source)) continue
    if (event.data.source.generation > highest) highest = event.data.source.generation
  }
  return highest + 1
}

/** Whether the surface run of slot nodes is contiguous (no content between them). */
function contiguous(session: Session, nodes: readonly TaskStateSlotNode[]): boolean {
  const surface = session.surface.nodes
  const first = surface.indexOf(nodes[0]!.seq)
  if (first < 0) return false
  return nodes.every((node, offset) => surface[first + offset] === node.seq)
}

/** The durable source of one slot node. */
function slotSource(
  session: Session,
  stable: TaskStateStable,
  renderResult: RenderTaskStateSlotResult,
  generation: number,
  coveredSeqs: readonly SessionSeq[],
  previous: { readonly revision: number; readonly generation: number } | undefined,
): TaskStateSlotSource {
  return {
    kind: TASK_STATE_SLOT_SOURCE_KIND,
    slotId: TASK_STATE_SLOT_ID,
    sessionId: String(session.id),
    lifecycleCreatedAt: session.header.createdAt,
    generation,
    revision: stable.revision,
    ...previous === undefined
      ? {}
      : { previousRevision: previous.revision, previousGeneration: previous.generation },
    digest: stable.digest,
    sourceCursor: stable.sourceCursor,
    coveredSeqs: coveredSeqs.map(Number),
    eligibleHighWater: renderResult.eligibleHighWater,
    staleness: renderResult.staleness,
    injectionTokens: renderResult.injectionTokens,
    budgetTokens: renderResult.budgetTokens,
    truncation: renderResult.truncation,
  }
}

/** Commit one slot node: a plain append, or a single-node/range replacement. */
function commitSlotNode(
  session: Session,
  stable: TaskStateStable,
  renderResult: RenderTaskStateSlotResult,
  generation: number,
  coveredSeqs: readonly SessionSeq[],
  previous: { readonly revision: number; readonly generation: number } | undefined,
): SessionSeq {
  const message = createUserMessage({
    content: [{ type: 'text', text: renderResult.text }],
    source: slotSource(session, stable, renderResult, generation, coveredSeqs, previous),
  })
  if (coveredSeqs.length === 0) {
    return session.append('user/message', message, { surfaceOp: 'append' }).seq
  }
  return session.append('user/message', message, {
    // The shadowed run is exactly the covered set: a single node for an ordinary
    // revision replacement, the whole contiguous run when duplicates collapse.
    surfaceOp: { op: 'replace', start: coveredSeqs[0]!, end: coveredSeqs[coveredSeqs.length - 1]! },
    // Every shadowed surface node must be cited (surface replacement contract).
    sourceEventSeqs: [...coveredSeqs],
  }).seq
}

/**
 * Resolve, create, replace, or safely rebuild the ONE model-visible Stable slot
 * of one live Session. Never leaves two visible snapshots behind: every failure
 * path appends nothing, so the surface keeps the node it already had.
 */
function maintainSlot(
  ctx: Context,
  slots: Map<string, TaskStateSlotRecord>,
  session: Session,
  budget: ResolvedInjectionBudget,
): void {
  const provider = ctx.get('taskState')
  if (provider === undefined) return
  // Liveness fence: only the Session the store currently serves for this id may
  // carry the slot, so a resumed same-id Session that is not the live entry is
  // never written through.
  const store = ctx.get('sessions')
  if (store !== undefined && store.get(session.id) !== session) return
  const stable = provider.getStable(session.id)
  if (stable === undefined) return

  const eligibleHighWater = sessionEligibleHighWater(session)
  const render = renderTaskStateSlot(stable, {
    maxBytes: budget.maxBytes,
    maxTokens: budget.maxTokens,
    eligibleHighWater,
    meter: ctx.get('tokenMeter') ?? undefined,
  })

  const key = String(session.id)
  let record = slots.get(key)
  if (record !== undefined
    && (record.session !== session || record.lifecycleCreatedAt !== session.header.createdAt)) {
    // A resumed or re-created Session with this id is a DIFFERENT lifecycle: the
    // in-memory predecessor is dropped and the slot is re-resolved from THIS
    // Session's own log instead of trusting a seq from another log.
    slots.delete(key)
    record = undefined
  }

  // Typed fail closed when authoritative representation exceeds budget I
  if (render.blocked) {
    if (record !== undefined) {
      record.staleness = 'blocked'
      record.budgetTokens = render.budgetTokens
      record.eligibleHighWater = render.eligibleHighWater
    }
    warn(ctx, `task-state-prompt: authoritative state exceeds injection budget I (${render.budgetTokens}) in Session "${key}"; typed blocked`)
    return
  }

  // An unrenderable stable contributes nothing
  if (render.text === '') return

  const visible = visibleSlotNodes(session)

  if (visible.length > 1) {
    if (!contiguous(session, visible)) {
      // A range replacement would have to shadow real content between the slot
      // nodes. Fail closed: add nothing, keep whatever is there, report it.
      if (record !== undefined) {
        record.collisions += 1
        slots.set(key, record)
      }
      warn(ctx, `task-state-prompt: ${visible.length} non-contiguous Stable slots in Session "${key}"; refusing to collapse them`)
      return
    }
    const covered = visible.map(node => node.seq)
    const generation = nextGeneration(session, Math.max(...visible.map(node => node.generation)))
    const seq = commitSlotNode(session, stable, render, generation, covered, {
      revision: visible[visible.length - 1]!.revision,
      generation: visible[visible.length - 1]!.generation,
    })
    slots.set(key, {
      session,
      lifecycleCreatedAt: session.header.createdAt,
      slotSeq: seq,
      generation,
      revision: stable.revision,
      digest: stable.digest,
      text: render.text,
      failures: record?.failures ?? 0,
      rebuilds: (record?.rebuilds ?? 0) + 1,
      collisions: record?.collisions ?? 0,
      eligibleHighWater: render.eligibleHighWater,
      staleness: render.staleness,
      injectionTokens: render.injectionTokens,
      budgetTokens: render.budgetTokens,
      truncation: render.truncation,
    })
    return
  }

  const current = visible[0]

  // No visible slot node: create the slot, or safely rebuild one whose node was
  // shadowed by another surface operation (compaction).
  if (current === undefined) {
    const generation = nextGeneration(session, record?.generation ?? 0)
    try {
      const seq = commitSlotNode(session, stable, render, generation, [], undefined)
      slots.set(key, {
        session,
        lifecycleCreatedAt: session.header.createdAt,
        slotSeq: seq,
        generation,
        revision: stable.revision,
        digest: stable.digest,
        text: render.text,
        failures: record?.failures ?? 0,
        rebuilds: record === undefined ? 0 : record.rebuilds + 1,
        collisions: record?.collisions ?? 0,
        eligibleHighWater: render.eligibleHighWater,
        staleness: render.staleness,
        injectionTokens: render.injectionTokens,
        budgetTokens: render.budgetTokens,
        truncation: render.truncation,
      })
    } catch (error: unknown) {
      const failures = (record?.failures ?? 0) + 1
      if (record !== undefined) {
        record.failures = failures
        slots.set(key, record)
      }
      warn(ctx, `task-state-prompt: creating the Stable slot of Session "${key}" failed: ${String(error)}`)
    }
    return
  }

  // Exactly one visible slot node. Adopt it when it is unchanged AND this exact
  // lifecycle wrote it: an inherited node (a fork child's parent prefix) is never
  // adopted, because the child's own delivery must be its own durable statement.
  if (isOwnSlotNode(session, current.source)
    && current.revision === stable.revision
    && current.digest === stable.digest
    && current.text === render.text
    && current.source.staleness === render.staleness) {
    if (record === undefined || record.slotSeq !== current.seq
      || record.revision !== stable.revision || record.text !== render.text) {
      slots.set(key, {
        session,
        lifecycleCreatedAt: session.header.createdAt,
        slotSeq: current.seq,
        generation: current.generation,
        revision: current.revision,
        digest: current.digest,
        text: current.text,
        failures: record?.failures ?? 0,
        rebuilds: record?.rebuilds ?? 0,
        collisions: record?.collisions ?? 0,
        eligibleHighWater: current.source.eligibleHighWater ?? render.eligibleHighWater,
        staleness: current.source.staleness ?? render.staleness,
        injectionTokens: current.source.injectionTokens ?? render.injectionTokens,
        budgetTokens: current.source.budgetTokens ?? render.budgetTokens,
        truncation: current.source.truncation ?? render.truncation,
      })
    }
    return
  }

  const generation = nextGeneration(session, Math.max(current.generation, record?.generation ?? 0))
  try {
    const seq = commitSlotNode(session, stable, render, generation, [current.seq], {
      revision: current.revision,
      generation: current.generation,
    })
    slots.set(key, {
      session,
      lifecycleCreatedAt: session.header.createdAt,
      slotSeq: seq,
      generation,
      revision: stable.revision,
      digest: stable.digest,
      text: render.text,
      failures: record?.failures ?? 0,
      rebuilds: record?.rebuilds ?? 0,
      collisions: record?.collisions ?? 0,
      eligibleHighWater: render.eligibleHighWater,
      staleness: render.staleness,
      injectionTokens: render.injectionTokens,
      budgetTokens: render.budgetTokens,
      truncation: render.truncation,
    })
  } catch (error: unknown) {
    // Fail closed: the failed replacement committed nothing, so the previously
    // visible revision stays the only model-visible snapshot and the next step
    // retries. The old record is kept as-is for exactly that retry.
    if (record !== undefined) {
      record.failures += 1
      slots.set(key, record)
    }
    warn(ctx, `task-state-prompt: replacing the Stable slot of Session "${key}" failed: ${String(error)}`)
  }
}

/**
 * Register the reserved `{{task_state_snapshot}}` context and variable, and the
 * step-boundary slot maintenance that owns the single model-visible Stable slot.
 * @param ctx - plugin context; the registrations dispose with it.
 * @param config - the deployment byte and token budgets for one rendered snapshot.
 */
export function apply(ctx: Context, config: TaskStatePromptConfig): void {
  const budget = resolveInjectionBudget(config)
  const slots = new Map<string, TaskStateSlotRecord>()
  const root = ctx.root
  const registries = slotRegistries.get(root) ?? new Set<Map<string, TaskStateSlotRecord>>()
  registries.add(slots)
  slotRegistries.set(root, registries)
  ctx.effect(() => () => {
    // In-memory bookkeeping dies with the consumer: a later mount ADOPTS the
    // still-visible node from the Session log instead of trusting stale memory.
    // Only THIS consumer's registry is dropped, so a sibling mount is untouched.
    slots.clear()
    registries.delete(slots)
    if (registries.size === 0) slotRegistries.delete(root)
  })

  ctx.systemPrompt.context({
    // The reserved template rides after the policy contexts. Its value is empty
    // by design: the model-visible stable is the plugin-owned fixed slot.
    name: 'task-state:snapshot',
    order: 125,
    text: SNAPSHOT_CONTEXT,
  })
  ctx.systemPrompt.variable('task_state_snapshot', () => RESERVED_EMPTY)

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    // An `enter` decision IS the model call: the loop appends this decision's
    // messages and derives the request from the surface on this same stack. A
    // `reject` decision and an aborted turn derive no request, so appending there
    // would add a node no request ever reads.
    if (decision.kind !== 'enter' || signal.aborted) return decision
    try {
      maintainSlot(ctx, slots, agent.session, budget)
    } catch (error: unknown) {
      // Slot maintenance is delivery, never a turn gate: an unexpected failure
      // must not break the step, and it appends nothing.
      warn(ctx, `task-state-prompt: Stable slot maintenance in Session "${String(agent.session.id)}" failed: ${String(error)}`)
    }
    return decision
  })
}
