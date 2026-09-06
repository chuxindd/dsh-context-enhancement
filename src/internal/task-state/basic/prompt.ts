/**
 * Exact auxiliary model instruction and deterministic framing for one
 * collect-and-merge request. The instruction text is pinned verbatim in the
 * request audit row so replay reconstructs the identical model input; the
 * per-request projection frame is JSON that the filter rebuilds from the
 * exact included event sequences and the retained filter implementation.
 * @module dsh-context-enhancement/internal/task-state/basic/prompt
 */

import type {
  TaskStateStable,
  TaskStateTruncationRecord,
} from '../contract/types.ts'
import { TASK_STATE_FILTER_VERSION } from './filter.ts'
import type { TaskStateFilteredEvent } from './types.ts'

/** Input schema version the framed output must satisfy (pinned v1). */
export const TASK_STATE_INPUT_SCHEMA_VERSION = 1

/** One parsed content-value schema version this provider writes. */
export const TASK_STATE_STABLE_SCHEMA_VERSION = 1

/**
 * The pinned auxiliary system instruction. It describes the exact expected
 * output as JSON (facts, decisions, constraints, risks, evidence, TODO
 * references, and continuation state), the Host-owned id rules, and the
 * constraints the Host enforces.
 */
export const TASK_STATE_SYSTEM_INSTRUCTION = [
  'You are the durable task-state updater for one AI coding-assistant session. Update the previous durable task state from the supplied projection of recent session events.',
  '',
  'Return ONLY one JSON object with EXACTLY these fields:',
  '{',
  '  "facts": [{ "content": "string" } | { "id": "fact-<uuid>", "content": "string" }],',
  '  "decisions": [{ "content": "string" } | { "id": "decision-<uuid>", "content": "string" }],',
  '  "constraints": [{ "content": "string" } | { "id": "constraint-<uuid>", "content": "string" }],',
  '  "risks": [{ "content": "string" } | { "id": "risk-<uuid>", "content": "string" }],',
  '  "evidence": [{ "seq": <number>, "note": "string" }],',
  '  "todoReferences": [{ "seq": <number>, "content": "string" }],',
  '  "continuation": {',
  '    "currentObjective": "string",',
  '    "currentFocus": "string",',
  '    "openWork": ["string"],',
  '    "nextActions": ["string"]',
  '  }',
  '}',
  '',
  'Rules:',
  '- A NEW fact, decision, constraint, or risk OMITS the id: the Host mints one with the matching prefix.',
  '- An entry CARRIED FORWARD from the previous state ECHOES its exact existing id verbatim. Do not invent, rename, or change any id prefix.',
  '- An entry you remove entirely disappears; never edit the content of an entry whose id you echo — drop it and add a new entry without an id when the content changes materially.',
  '- Keep the four kinded lists authoritative and deduplicated: same fact in several lists is wrong.',
  '- `evidence` references the exact `seq` values listed as eligible in the projection; every note explains what the reference supports in one short sentence. Never reference a seq the projection did not list.',
  '- `todoReferences` records only durable todo lists already shown in the projection, by their exact `seq`, with bounded readable content.',
  '- `continuation.currentObjective` is the human task objective in force; `currentFocus` what is being worked on; `openWork` concrete unfinished work; `nextActions` concrete next steps. TODO stays separate and is only referenced, never merged into these fields.',
  '- Empty lists are `[]`. Preserve exact file paths, commands, queries, error strings, identifiers, and numeric values.',
  '- Keep every string short enough that the total output fits the reported byte budget. Output ONLY the JSON object: no Markdown fence, no commentary, no tool call.',
].join('\n')

/**
 * Build the deterministic model-visible input frame for one batch. The frame
 * is the owned JSON that filter v2 reconstructs from the exact included
 * sequences: previous stable content (or null), the filter version, the input
 * schema version, the deterministic event projections, and the truncation
 * records. The caller bounds the serialized frame to the batch input budget.
 * @param input - base stable, projected events, and truncation records.
 * @returns the serialized deterministic model-visible frame.
 */
export function frameProjection(input: {
  readonly base: TaskStateStable | null
  readonly events: readonly TaskStateFilteredEvent[]
  readonly truncation: readonly TaskStateTruncationRecord[]
}): string {
  const frame = {
    previousStable: input.base === null ? null : contentOfStable(input.base),
    filterVersion: TASK_STATE_FILTER_VERSION,
    inputSchemaVersion: TASK_STATE_INPUT_SCHEMA_VERSION,
    events: input.events.map(event => ({
      seq: event.seq,
      type: event.type,
      fields: event.fields,
    })),
    truncation: input.truncation,
  }
  return JSON.stringify(frame)
}

/** Stable content view (without Host commit metadata) handed to the model. */
function contentOfStable(stable: TaskStateStable): {
  facts: readonly { readonly id: string; readonly content: string }[]
  decisions: readonly { readonly id: string; readonly content: string }[]
  constraints: readonly { readonly id: string; readonly content: string }[]
  risks: readonly { readonly id: string; readonly content: string }[]
  evidence: readonly { readonly seq: number; readonly note: string }[]
  todoReferences: readonly { readonly seq: number; readonly content: string }[]
  continuation: {
    readonly currentObjective: string
    readonly currentFocus: string
    readonly openWork: readonly string[]
    readonly nextActions: readonly string[]
  }
} {
  return {
    facts: stable.facts,
    decisions: stable.decisions,
    constraints: stable.constraints,
    risks: stable.risks,
    evidence: stable.evidence,
    todoReferences: stable.todoReferences,
    continuation: stable.continuation,
  }
}
