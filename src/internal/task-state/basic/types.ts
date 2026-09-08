/**
 * Pure types of the task-state-basic provider: validated deployment config,
 * the versioned-filter vocabulary, the Host semantic-check results, and the
 * background worker state. Type-only module: no runtime code lives here.
 * @module dsh-context-enhancement/internal/task-state/basic/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TaskStateEntryId, TaskStateStable, TaskStateTruncationRecord } from '../contract/types.ts'

/** One committed-stable observer notified after the provider's authority put. */
export type TaskStateCommittedListener = (sessionId: SessionId, stable: TaskStateStable) => void

/** Validated deployment policy of one task-state-basic mount. */
export interface TaskStateBasicConfig {
  /** Fallback provider used before a Session has a routed request. */
  readonly provider: string
  /** Fallback model used before a Session has a routed request. */
  readonly model: string
  /** Minimum eligible Session events since the committed cursor that automatically start a batch. */
  readonly minEvents: number
  /** Maximum eligible Session events folded into one batch; never by itself triggers a batch. */
  readonly maxEvents: number
  /** Maximum UTF-8 bytes of the deterministic framed projection for one batch. */
  readonly maxInputBytes: number
  /** Generation cap of one auxiliary request. */
  readonly maxOutputTokens: number
  /** End-to-end deadline of one auxiliary request, in milliseconds. */
  readonly timeoutMs: number
  /** Maximum extra attempts after a transient auxiliary-request failure; deterministic failures never retry. */
  readonly maxInfraRetries: number
  /** Maximum entries of one kind (facts, decisions, constraints, or risks) a committed stable may hold. */
  readonly maxEntriesPerKind: number
  /** Maximum UTF-8 bytes of one entry or continuation field after Host validation. */
  readonly maxEntryBytes: number
  /** Maximum count of one list field (openWork, nextActions, evidence, todoReferences). */
  readonly maxListItems: number
}

/** One eligible Session event projected for the auxiliary input. */
export interface TaskStateFilteredEvent {
  /** Exact eligible Session event sequence this projection derives from. */
  readonly seq: number
  /** Exact event type of the source Session event. */
  readonly type: string
  /** Owned deterministic JSON projection of the durable event fields. */
  readonly fields: unknown
}

/** Complete deterministic projection of one batch window. */
export interface TaskStateBatchProjection {
  /** Exact eligible sequences folded into the projection, ascending. */
  readonly includedSeqs: number[]
  /** Sequence of the last eligible event actually folded; equals the committed cursor endpoint. */
  readonly sourceCursor: number
  /** Owned JSON event projections, ordered by source sequence. */
  readonly events: readonly TaskStateFilteredEvent[]
  /** Explicit UTF-8 byte limits applied while projecting. */
  readonly truncation: readonly TaskStateTruncationRecord[]
  /** UTF-8 bytes of the serialized projection input. */
  readonly inputBytes: number
}

/** The durable state the Host verifies a model candidate against. */
export interface CandidateHostContext {
  /** Immutable committed base stable, or `null` before the first commit. */
  readonly base: {
    readonly revision: number
    readonly sourceCursor: number
    readonly entryIds: ReadonlySet<string>
    readonly entries: readonly {
      readonly id: string
      readonly kind: string
      readonly content: string
    }[]
  } | null
  /** Exact eligible sequences folded by this batch. */
  readonly includedSeqs: ReadonlySet<number>
  /** Validated stable byte and item limits. */
  readonly limits: {
    readonly maxEntriesPerKind: number
    readonly maxEntryBytes: number
    readonly maxListItems: number
  }
}

/** Result of minting and verifying one candidate into committed content. */
export interface TaskStateHostNormalization {
  /** Kinded committed entry lists with a Host-minted id on every entry. */
  readonly facts: readonly { readonly id: TaskStateEntryId; readonly content: string }[]
  readonly decisions: readonly { readonly id: TaskStateEntryId; readonly content: string }[]
  readonly constraints: readonly { readonly id: TaskStateEntryId; readonly content: string }[]
  readonly risks: readonly { readonly id: TaskStateEntryId; readonly content: string }[]
  /** Bounded evidence references, all pointing into `includedSeqs`. */
  readonly evidence: readonly { readonly seq: number; readonly note: string }[]
  /** Bounded TODO references, all pointing into `includedSeqs`. */
  readonly todoReferences: readonly { readonly seq: number; readonly content: string }[]
  /** Durable continuation state. */
  readonly continuation: {
    readonly currentObjective: string
    readonly currentFocus: string
    readonly openWork: readonly string[]
    readonly nextActions: readonly string[]
  }
}

/** Discriminant codes of one failed update attempt. */
export type TaskStateBatchErrorCode =
  | 'NO_ELIGIBLE_EVENTS'
  | 'NO_SESSION'
  | 'SERVICE_DISPOSED'
  | 'NO_ROUTE'
  | 'BUDGET'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'TRANSIENT_LLM'
  | 'PARSE'
  | 'SCHEMA'
  | 'SEMANTIC'
  | 'STORAGE'
  | 'AUDIT'
  | 'UNEXPECTED'

/** Structured failure facts of one batch attempt. */
export interface TaskStateBatchFailure {
  readonly stage: 'route' | 'request' | 'stream' | 'parse' | 'schema' | 'semantic' | 'storage' | 'audit'
  readonly code: TaskStateBatchErrorCode
  readonly message: string
}
