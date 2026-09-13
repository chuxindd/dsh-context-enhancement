/**
 * Versioned Host semantic validation of one auxiliary task-state candidate
 * against the committed base and the batch window. It parses nothing (the
 * caller parses with `JSON.parse` and the contract schema), mints Host-owned
 * branded ids for new entries, verifies echoed ids exist in the base, applies
 * the complete-candidate update rules, bounds every retained value with the
 * configured UTF-8 byte and item limits, keeps every evidence reference that
 * points into the folded batch window while quarantining (dropping, with a
 * diagnostic) any reference that points outside it, commits the authoritative
 * Goal/TODO views the window resolved (never a model-proposed value), and
 * computes the stable digest over the normalized content. A semantic failure
 * still rejects the complete candidate; the previous stable and cursor stay
 * untouched.
 * @module dsh-context-enhancement/internal/task-state/basic/host
 */

import { randomUUID, createHash } from 'node:crypto'
import {
  TaskStateEntryId,
  taskStateCandidateSchema,
  taskStateStableSchema,
  type TaskStateCandidate,
  type TaskStateInheritedPrefix,
  type TaskStateStable,
  type TaskStateStableContent,
} from '../contract/index.ts'
import { boundUtf8 } from './bytes.ts'
import type { CandidateHostContext, TaskStateReferenceQuarantine } from './types.ts'

/** Kinded list names in committed order, each paired with its entry-id kind prefix. */
const KINDS = [
  ['facts', 'fact'],
  ['decisions', 'decision'],
  ['constraints', 'constraint'],
  ['risks', 'risk'],
] as const

type KindList = typeof KINDS[number][0]
type KindPrefix = typeof KINDS[number][1]

/**
 * Verify one candidate parses against the contract candidate schema.
 * @param raw - the parsed model output to validate.
 * @returns the schema-validated candidate content.
 * @throws when the value does not satisfy the contract candidate schema.
 */
export function parseCandidate(raw: unknown): TaskStateCandidate {
  const parsed = taskStateCandidateSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`task-state-basic: candidate failed the durable schema: ${parsed.error.message}`)
  }
  return parsed.data
}

/** Mint one opaque kind-prefixed branded id (`fact-<uuid>`). */
function mintId(prefix: KindPrefix): TaskStateEntryId {
  return TaskStateEntryId(`${prefix}-${randomUUID()}`)
}

/** Bound one retained entry or continuation field to the configured byte limit. */
function boundEntry(text: string, limitBytes: number): string {
  const bounded = boundUtf8(text, limitBytes)
  return bounded.text
}

/**
 * Normalize one parsed candidate into committed content. Steps, in order:
 * check per-kind count and per-list item limits; bound every retained entry,
 * continuation field, and evidence note; verify every echoed id exists in the
 * base, is used in the list whose kind matches its prefix, echoes the base
 * content VERBATIM, and is unique across the complete candidate; mint ids for
 * every new entry; keep every evidence reference whose sequence is one of the
 * exact folded eligible sequences while QUARANTINING (dropping, with a
 * diagnostic) any reference pointing outside the window — a stale reference
 * carried forward from a previous window can never become eligible again, so
 * failing the whole candidate on it would freeze every future update at the
 * last committed revision; commit the Host-resolved authoritative Goal/TODO
 * views and their derived TODO reference from `context.authority`; then
 * validate the fully id-ed content against the committed-content schema. No
 * sequence is ever fabricated for a quarantined reference: only the invalid
 * reference is dropped, valid references and every other summary field are
 * preserved.
 * @param candidate - parsed and schema-validated candidate content.
 * @param context - durable base and folded-window facts.
 * @param onQuarantine - optional observer of each dropped stale reference.
 * @returns the normalized committed content.
 */
export function normalizeCandidate(
  candidate: TaskStateCandidate,
  context: CandidateHostContext,
  onQuarantine?: (quarantined: TaskStateReferenceQuarantine) => void,
): TaskStateStableContent {
  const { limits } = context
  const checkCount = (kind: KindList): void => {
    const list = candidate[kind]
    if (list.length > limits.maxEntriesPerKind) {
      throw new Error(
        `task-state-basic: candidate ${kind} has ${list.length} entries, exceeding maxEntriesPerKind ${limits.maxEntriesPerKind}`,
      )
    }
  }
  checkCount('facts')
  checkCount('decisions')
  checkCount('constraints')
  checkCount('risks')

  /** The exact base entry one echoed id names, or `undefined`. */
  const baseEntryById = new Map<string, { readonly id: string; readonly kind: string; readonly content: string }>()
  for (const entry of context.base?.entries ?? []) baseEntryById.set(entry.id, entry)

  // Echoed-id dedupe is global across every kinded list: an id must name at
  // most one committed entry in the whole candidate.
  const seenEchoed = new Set<string>()
  const kinded: Record<KindList, { readonly id: TaskStateEntryId; readonly content: string }[]> = {
    facts: [],
    decisions: [],
    constraints: [],
    risks: [],
  }
  for (const [list, prefix] of KINDS) {
    const out = kinded[list]
    for (const entry of candidate[list]) {
      const content = boundEntry(entry.content, limits.maxEntryBytes)
      if (entry.id === undefined) {
        // Host-minted ids draw from the full UUID space, so a collision with a
        // base entry id is impossible; the entry simply receives a fresh id.
        out.push({ id: mintId(prefix), content })
        continue
      }
      const id = String(entry.id)
      const baseEntry = baseEntryById.get(id)
      if (baseEntry === undefined) {
        throw new Error(`task-state-basic: candidate echoes unknown entry id "${id}"`)
      }
      if (seenEchoed.has(id)) {
        throw new Error(`task-state-basic: candidate echoes entry id "${id}" more than once`)
      }
      seenEchoed.add(id)
      // The echoed id's kind prefix must match the list it appears in: an
      // entry carried into the wrong kinded list would change its meaning
      // while pretending to be unchanged.
      if (baseEntry.kind !== prefix) {
        throw new Error(`task-state-basic: candidate echoes "${id}" in ${list}, but the base holds it as a ${baseEntry.kind}`)
      }
      // Echoing an id commits to the base content verbatim. A materially
      // different proposal must drop the id and appear as a new no-id entry.
      if (content !== baseEntry.content) {
        throw new Error(
          `task-state-basic: candidate echoes "${id}" with changed content; drop the id and add a new ${prefix} without an id when the content changes`,
        )
      }
      out.push({ id: TaskStateEntryId(id), content })
    }
  }

  const boundNote = (note: string): string => boundEntry(note, limits.maxEntryBytes)
  // A reference outside the folded window is quarantined, not fatal: the stale
  // seq (typically carried forward from the previous stable, like a durable
  // todo event already committed under the cursor) can never re-enter the
  // eligible set, so rejecting the candidate here would permanently freeze the
  // Session at its last committed revision. The invalid reference is dropped
  // with a diagnostic; valid references and all other fields are preserved,
  // and no sequence is fabricated for the dropped one.
  const quarantine = onQuarantine ?? (() => {})
  const evidence: { readonly seq: number; readonly note: string }[] = []
  for (const reference of candidate.evidence) {
    if (!context.includedSeqs.has(reference.seq)) {
      quarantine({ kind: 'evidence', seq: reference.seq })
      continue
    }
    evidence.push({ seq: reference.seq, note: boundNote(reference.note) })
  }
  if (evidence.length > limits.maxListItems) {
    throw new Error(`task-state-basic: candidate evidence exceeds maxListItems ${limits.maxListItems}`)
  }
  // Goal and TODO are authoritative named views, not candidate content: the
  // Host commits the views it resolved from the folded window's own authority
  // facts, so a model that repeats a superseded objective or a cleared list
  // cannot merge it back. The bounded TODO reference is derived from that same
  // resolution, which is why a cleared list leaves no reference behind.
  const { goalView, todoView, todoReferences } = context.authority
  if (todoReferences.length > limits.maxListItems) {
    throw new Error(`task-state-basic: derived todoReferences exceeds maxListItems ${limits.maxListItems}`)
  }

  const openWork = candidate.continuation.openWork.map(item => boundEntry(item, limits.maxEntryBytes))
  const nextActions = candidate.continuation.nextActions.map(item => boundEntry(item, limits.maxEntryBytes))
  if (openWork.length > limits.maxListItems || nextActions.length > limits.maxListItems) {
    throw new Error(`task-state-basic: continuation lists exceed maxListItems ${limits.maxListItems}`)
  }
  const continuation = {
    currentObjective: boundEntry(candidate.continuation.currentObjective, limits.maxEntryBytes),
    currentFocus: boundEntry(candidate.continuation.currentFocus, limits.maxEntryBytes),
    openWork,
    nextActions,
  }

  // Every kinded list slot was filled by the KINDS loop above.
  const facts = kinded.facts
  const decisions = kinded.decisions
  const constraints = kinded.constraints
  const risks = kinded.risks
  // Every field below was schema-validated on the candidate and rebuilt from
  // bounded strings, so the assembled content needs no second whole-object
  // validation here; commitStable re-validates the complete committed stable.
  return {
    facts,
    decisions,
    constraints,
    risks,
    evidence,
    todoReferences: todoReferences.map(reference => ({ seq: reference.seq, content: reference.content })),
    goalView,
    todoView,
    continuation,
  }
}

/**
 * Compute the SHA-256 digest over one stable's normalized structured content.
 * @param content - normalized committed content to digest.
 * @returns lowercase hex digest of the content's JSON serialization.
 */
export function digestOf(content: TaskStateStableContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

/**
 * Build the committed stable from normalized content and Host-owned metadata.
 * @param content - normalized committed content.
 * @param schemaVersion - stable content schema version.
 * @param revision - next monotonic revision (base revision + 1, or 1 first).
 * @param filterVersion - deterministic input-filter version that produced the projection.
 * @param sourceCursor - last eligible sequence actually folded.
 * @param inherited - the inherited fork boundary this coverage stops at, or
 *   `null`/absent when the lifecycle began on its own events. Metadata only: it
 *   rides beside the digest and never enters the digested content.
 * @returns the immutable committed stable.
 */
export function commitStable(
  content: TaskStateStableContent,
  schemaVersion: number,
  revision: number,
  filterVersion: string,
  sourceCursor: number,
  inherited?: TaskStateInheritedPrefix | null,
): TaskStateStable {
  const digest = digestOf(content)
  const stable: TaskStateStable = {
    schemaVersion,
    revision,
    filterVersion,
    sourceCursor,
    digest,
    ...inherited === undefined || inherited === null ? {} : { inherited },
    ...content,
  }
  const check = taskStateStableSchema.safeParse(stable)
  if (!check.success) {
    throw new Error(`task-state-basic: committed stable failed its durable schema: ${check.error.message}`)
  }
  return stable
}

export type { CandidateHostContext }
