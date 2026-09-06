/**
 * Pure types of the durable task-state domain: the committed stable record,
 * the auxiliary-model candidate, the lifecycle-bound session identity, the
 * audit vocabulary (open/finished phases keyed by request id), and the
 * branded request and entry ids.
 *
 * The task-state family deliberately declares NO SessionEventMap members: the
 * pre-dispatch request audit and the finished outcome are rows of the
 * provider-owned `sessions`/`audit` storage domain, never Session events, so a
 * composition unloading task-state leaves old Sessions fully readable by
 * rc.1 code that has never heard of these types.
 * @module dsh-context-enhancement/internal/task-state/contract/types
 */

import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  TaskStateEntryId,
  TaskStateRequestId,
} from './brand.ts'

export type { TaskStateEntryId, TaskStateRequestId }

/**
 * The session identity a durable task-state record binds. A record is keyed by
 * the real Session id; the value carries the lifecycle fields that fence the
 * record to ONE log lifecycle, so a reused Session id cannot silently adopt a
 * record written by an earlier lifecycle with the same id.
 */
export interface TaskStateSessionIdentity {
  /** Epoch milliseconds when the owning Session was created. */
  readonly createdAt: number
  /** Absolute working directory the Session was created in, when it had one. */
  readonly cwd?: string
}

/** One stable entry kind assigned its own Host-minted id prefix. */
export type TaskStateEntryKind = 'fact' | 'decision' | 'constraint' | 'risk'

/**
 * One fact, decision, constraint, or risk proposed by the auxiliary model.
 * Its kind is the Host-minted id prefix it will receive at commit (`fact-`,
 * `decision-`, `constraint-`, or `risk-`) plus the list it is merged into.
 * New entries carry no id (the Host mints an opaque branded UUID before
 * commit); an entry carried forward from the previous stable echoes its
 * existing id.
 */
export interface TaskStateCandidateEntry {
  /** Echoed id of an entry carried forward; absent for a new entry. */
  readonly id?: TaskStateEntryId
  /** The entry's proposed content. */
  readonly content: string
}

/**
 * One durable entry inside a committed stable. Every entry carries the
 * Host-minted opaque branded UUID the stable assigned, prefixed by its kind
 * such as `fact-<uuid>`; the auxiliary model only echoes existing ids and
 * never mints them.
 */
export interface TaskStateStableEntry {
  /** Opaque kind-prefixed branded id assigned by the Host when the entry first committed. */
  readonly id: TaskStateEntryId
  /** The entry's content. */
  readonly content: string
}

/**
 * Durable continuation state of one committed stable. The field names are
 * consistent across stables so a resumed Session loads its objective, focus,
 * open work, and next actions directly from the record instead of relearning
 * them from conversation. TODO stays an independently owned whole-list state
 * and is referenced by {@link TaskStateTodoReference}, never merged into
 * these fields.
 */
export interface TaskStateContinuation {
  /** Short human statement of the task objective in force at this stable. */
  readonly currentObjective: string
  /** What the session is currently working on at this stable. */
  readonly currentFocus: string
  /** Concrete pieces of work still open at this stable. */
  readonly openWork: readonly string[]
  /** Concrete next actions planned at this stable. */
  readonly nextActions: readonly string[]
}

/**
 * A reference to one eligible durable Session event that supports a stable
 * entry. It points at the event sequence instead of copying the event, so the
 * stable stays bounded while the Session log keeps full source fidelity.
 */
export interface TaskStateEvidenceReference {
  /** Sequence of the referenced eligible Session event. */
  readonly seq: number
  /** Bounded note explaining what the reference supports. */
  readonly note: string
}

/**
 * A bounded reference to the independently owned whole-list TODO state: the
 * durable `todo/write` event sequence that carried the list plus bounded
 * readable content. It creates no stable TODO item identity and copies no
 * TODO ownership.
 */
export interface TaskStateTodoReference {
  /** Sequence of the durable `todo/write` event that carried the list. */
  readonly seq: number
  /** Bounded readable content preserved from that list. */
  readonly content: string
}

/**
 * The content one candidate or committed task-state snapshot carries beyond
 * the kinded entry lists: the durable continuation state and the bounded
 * evidence and TODO references.
 */
export interface TaskStateContentFields {
  /** References to eligible durable Session events that support the entries. */
  readonly evidence: readonly TaskStateEvidenceReference[]
  /** Bounded references to durable `todo/write` lists. */
  readonly todoReferences: readonly TaskStateTodoReference[]
}

/**
 * The structured content of one auxiliary-model candidate snapshot: the four
 * kinded entry lists with optional echoed ids, the continuation state, and
 * the bounded evidence and TODO references. A candidate is not committed: the
 * Host mints ids for new entries and verifies echoed ids before commit.
 */
export interface TaskStateCandidateContent extends TaskStateContentFields {
  /** Ordered facts. */
  readonly facts: readonly TaskStateCandidateEntry[]
  /** Ordered decisions. */
  readonly decisions: readonly TaskStateCandidateEntry[]
  /** Ordered constraints. */
  readonly constraints: readonly TaskStateCandidateEntry[]
  /** Ordered risks. */
  readonly risks: readonly TaskStateCandidateEntry[]
  /** Durable continuation state proposed by the auxiliary model. */
  readonly continuation: TaskStateContinuation
}

/** The complete next snapshot the auxiliary model proposes. */
export type TaskStateCandidate = TaskStateCandidateContent

/**
 * One committed authoritative stable: the four kinded entry lists with
 * Host-minted ids, the durable continuation state, the bounded evidence and
 * TODO references, and the Host-owned commit metadata. The storage record is
 * its sole durable authority.
 */
export interface TaskStateStable extends TaskStateContentFields {
  /** Content schema version of this exact stable. */
  readonly schemaVersion: number
  /** Positive monotonic stable revision; every commit increments it. */
  readonly revision: number
  /** Deterministic input-filter version that produced the folded projection. */
  readonly filterVersion: string
  /** Sequence of the last eligible Session event folded into this stable. */
  readonly sourceCursor: number
  /** Deterministic digest over the structured content of this stable. */
  readonly digest: string
  /** Ordered facts, each with its Host-minted id. */
  readonly facts: readonly TaskStateStableEntry[]
  /** Ordered decisions, each with its Host-minted id. */
  readonly decisions: readonly TaskStateStableEntry[]
  /** Ordered constraints, each with its Host-minted id. */
  readonly constraints: readonly TaskStateStableEntry[]
  /** Ordered risks, each with its Host-minted id. */
  readonly risks: readonly TaskStateStableEntry[]
  /** Durable continuation state committed with this stable. */
  readonly continuation: TaskStateContinuation
}

/**
 * One whole-Session durable task-state record: the lifecycle identity the
 * record is fenced to plus the latest committed stable.
 */
export interface TaskStateRecord {
  /** Session lifecycle identity this record binds. */
  readonly session: TaskStateSessionIdentity
  /** Latest committed stable for that lifecycle. */
  readonly stable: TaskStateStable
}

/**
 * Exact auxiliary route of one collect-and-merge request. The route and
 * reasoning effort are recorded verbatim so replay reconstructs the exact
 * call.
 */
export interface TaskStateAuxRoute {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Adapter-owned reasoning effort, when one applied. */
  readonly reasoningEffort?: ReasoningEffortId
}

/** Schema evidence carried by one request. */
export interface TaskStateSchemaEvidence {
  /** Input schema version the framed output must satisfy. */
  readonly version: number
  /** Dynamic schema material not pinned by `version`, when any was supplied. */
  readonly material?: JsonValue
}

/** One deterministic, marked truncation applied while projecting. */
export interface TaskStateTruncationRecord {
  /** Field path truncated, e.g. `tool/result` content. */
  readonly path: string
  /** Explicit UTF-8 byte limit applied to the field. */
  readonly limitBytes: number
  /** UTF-8 bytes retained after truncation. */
  readonly keptBytes: number
}

/**
 * The OPEN phase of one auxiliary task-state model request, written durably
 * BEFORE the request is dispatched. It carries an immutable copy of the base
 * stable (or `null`), the exact included eligible event sequences, and the
 * exact model-visible inputs so the call is reconstructable from the audit
 * table without consulting the authoritative sessions table during replay.
 */
export interface TaskStateUpdateRequestData {
  /** Host-minted opaque request id keying this audit row. */
  readonly requestId: TaskStateRequestId
  /** Target stable revision this request commits on success. */
  readonly revision: number
  /** Immutable committed base stable copy, or `null` before the first commit. */
  readonly base: TaskStateStable | null
  /** Exact eligible Session event sequences folded into this request, ascending. */
  readonly includedSeqs: number[]
  /** Deterministic input-filter version that produced the projection. */
  readonly filterVersion: string
  /** Exact auxiliary system instruction. */
  readonly system: string
  /** Exact auxiliary route, including the reasoning effort when present. */
  readonly route: TaskStateAuxRoute
  /** Exact maximum output tokens for the auxiliary request. */
  readonly maxTokens: number
  /** Input schema version and any dynamic schema material for this request. */
  readonly schema: TaskStateSchemaEvidence
  /** Deterministic truncation metadata required to reproduce the framed input. */
  readonly truncation: readonly TaskStateTruncationRecord[]
}

/** Failure stages of one task-state update attempt. */
export type TaskStateFailureStage =
  | 'route'
  | 'request'
  | 'stream'
  | 'parse'
  | 'schema'
  | 'semantic'
  | 'storage'
  | 'audit'

/** Structured, bounded failure facts of one failed update attempt. */
export interface TaskStateFailureFacts {
  /** Failure stage naming where the attempt stopped. */
  readonly stage: TaskStateFailureStage
  /** Stable machine-routable error code. */
  readonly code: string
  /** Bounded human-readable diagnostic. */
  readonly message: string
}

/**
 * The FINISHED phase of one audit row, written durably AFTER the attempt
 * settles. A normal success records the complete `ctx.llm.stream()` call; a
 * normal failure records structured facts with no successful replay marker; a
 * repair certifies a stable already committed before a crash without claiming
 * a stream call or inventing raw output. Exactly one finished phase may follow
 * one open phase per request id.
 */
export type TaskStateUpdateFinishedData =
  | {
    readonly outcome: 'success'
    /** Request id keying the audit row that carries the open phase. */
    readonly requestId: TaskStateRequestId
    /** Committed stable revision — equals the open phase's target revision. */
    readonly revision: number
    /** Committed source cursor — the last eligible sequence actually folded. */
    readonly sourceCursor: number
    /** Marks one complete `ctx.llm.stream()` call. */
    readonly llmStreamCall: true
    /** Complete untruncated raw output blocks of that call. */
    readonly rawOutput: readonly ContentBlock[]
    /** Provider-reported token usage, when the adapter reported it. */
    readonly usage?: TokenUsage
    /** Required terminal finish metadata of the successful call. */
    readonly finish: { readonly kind: 'stop' }
  }
  | {
    readonly outcome: 'failure'
    /** Request id keying the audit row that carries the open phase. */
    readonly requestId: TaskStateRequestId
    /** Failure stage and bounded diagnostic; no successful replay marker. */
    readonly error: TaskStateFailureFacts
  }
  | {
    readonly outcome: 'repair'
    /** Request id of the repaired update when its open phase is available. */
    readonly requestId?: TaskStateRequestId
    /** Revision of the stable storage already holds. */
    readonly revision: number
    /** Source cursor of the stable storage already holds. */
    readonly sourceCursor: number
    /** A repair never claims another LLM stream call. */
    readonly llmStreamCall?: never
  }

/**
 * The content of one committed stable — the Host-normalized counterpart of a
 * {@link TaskStateCandidate}. The auxiliary model proposes optional entry ids;
 * before commit the Host mints a branded id for every new entry and verifies
 * every echoed id exists and is unique.
 */
export interface TaskStateStableContent extends TaskStateContentFields {
  /** Ordered facts, each carrying its Host-minted id. */
  readonly facts: readonly TaskStateStableEntry[]
  /** Ordered decisions, each carrying its Host-minted id. */
  readonly decisions: readonly TaskStateStableEntry[]
  /** Ordered constraints, each carrying its Host-minted id. */
  readonly constraints: readonly TaskStateStableEntry[]
  /** Ordered risks, each carrying its Host-minted id. */
  readonly risks: readonly TaskStateStableEntry[]
  /** Durable continuation state committed with this stable. */
  readonly continuation: TaskStateContinuation
}
