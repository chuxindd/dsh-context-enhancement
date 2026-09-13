/**
 * E04 experiment fixture: an explicitly priced Session surface.
 *
 * Purpose
 * -------
 * Rebuild, without touching production code, the exact payload shape the static
 * audit asserts for `IB-11` / 遗忘矩阵 #12:
 *
 * - a `user/message` event whose `data` IS the `UserMessage` payload and
 *   therefore carries no `turn` / `step` fields;
 * - `assistant/message` and `tool/result` events of the SAME step that DO carry
 *   `turn` / `step`.
 *
 * Everything here is a fixture. The only production symbols consumed are the
 * public `Session`/message constructors and the exported zone planners.
 */

import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'

export { Session, SessionId, createUserMessage }
export type { SessionSeq }

/** Surface operation used by every fixture append: plain append. */
export const SURFACE = { surfaceOp: 'append' as const }

/** One fixture surface node as recorded by the harness itself. */
export interface LedgerNode {
  /** Surface index (position, not numeric seq). */
  readonly index: number
  /** Session sequence of the appended event. */
  readonly seq: SessionSeq
  /** Event type string. */
  readonly type: string
  /** Tokens this fixture priced the node at. */
  readonly tokens: number
  /** Payload `turn`, when the event data carries one. */
  readonly turn?: number
  /** Payload `step`, when the event data carries one. */
  readonly step?: number
  /** Whether the event payload exposes `turn` AND `step`. */
  readonly carriesTurnStep: boolean
  /** Short human-readable marker for the README evidence tables. */
  readonly label: string
}

/** Ledger produced by one fixture build. */
export interface SurfaceLedger {
  readonly session: Session
  readonly nodes: readonly LedgerNode[]
  readonly measurement: TokenMeasurement
}

/**
 * A fixture builder that prices every appended node explicitly, so a zone
 * boundary can be aimed at an exact surface position instead of being
 * discovered through a heuristic.
 */
export class PricedSurface {
  readonly session: Session
  /** Explicit token price per node, in surface order. */
  readonly prices: number[] = []

  constructor(id: string) {
    this.session = Session.create(SessionId(id))
  }

  /** Append a `user/message` (payload has no turn/step) priced at `tokens`. */
  user(text: string, tokens: number, extraData: Record<string, unknown> = {}): this {
    const event = this.session.append('user/message', {
      ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      ...extraData,
    } as never, SURFACE)
    this.record(`user:${text}`, tokens, event.seq, 'user/message', extraData)
    return this
  }

  /** Append an assistant text message of `turn`/`step` priced at `tokens`. */
  assistant(turn: number, step: number, text: string, tokens: number): this {
    const event = this.session.append('assistant/message', {
      turn,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, SURFACE)
    this.record(`assistant t${turn}s${step}:${text}`, tokens, event.seq, 'assistant/message', { turn, step })
    return this
  }

  /** Append a tool call of `turn`/`step` priced at `tokens`. */
  toolCall(turn: number, step: number, id: string, tokens: number): this {
    const event = this.session.append('assistant/message', {
      turn,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId(id), name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, SURFACE)
    this.record(`tool-call t${turn}s${step}:${id}`, tokens, event.seq, 'assistant/message', { turn, step })
    return this
  }

  /** Append the matching tool result of the same `turn`/`step`. */
  toolResult(turn: number, step: number, id: string, tokens: number): this {
    const event = this.session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({
        callId: ToolCallId(id),
        content: [{ type: 'text', text: `${id} result` }],
        isError: false,
      }),
    }, SURFACE)
    this.record(`tool-result t${turn}s${step}:${id}`, tokens, event.seq, 'tool/result', { turn, step })
    return this
  }

  private record(
    label: string,
    tokens: number,
    seq: SessionSeq,
    type: string,
    data: Record<string, unknown>,
  ): void {
    const carriesTurnStep = data['turn'] !== undefined && data['step'] !== undefined
    this.prices.push(tokens)
    this.items.push({
      // index and seq are filled in by `build()`.
      index: this.items.length,
      seq,
      type,
      tokens,
      ...(carriesTurnStep ? { turn: data['turn'] as number, step: data['step'] as number } : {}),
      carriesTurnStep,
      label,
    })
  }

  private readonly items: LedgerNode[] = []

  /** Freeze the priced measurement and return the ledger. */
  build(): SurfaceLedger {
    const nodes = this.items.map(item => ({ ...item }))
    const measurement = {
      totalTokens: this.prices.reduce((sum, value) => sum + value, 0),
      surfaceTokens: this.prices.reduce((sum, value) => sum + value, 0),
      nodes: nodes.map(node => ({ seq: node.seq, tokens: node.tokens, heuristicTokens: node.tokens })),
      logRevision: 0,
      baseline: 0,
      surfaceDeltaTokens: 0,
    } as unknown as TokenMeasurement
    return { session: this.session, nodes, measurement }
  }
}

/**
 * Read the `turn`/`step` a surface node's own Session event exposes.
 * Returns `null` for a payload that carries neither field (the `user/message`
 * shape).
 */
export function payloadTurnStep(
  session: Session,
  seq: SessionSeq,
): { turn: number; step: number } | null {
  const event = session.eventAt(seq)
  const data = event?.data as { turn?: unknown; step?: unknown } | undefined
  if (data === undefined || data.turn === undefined || data.step === undefined) return null
  return { turn: data.turn as number, step: data.step as number }
}

/** True when the node's own payload carries `turn` AND `step`. */
export function carriesTurnStep(session: Session, seq: SessionSeq): boolean {
  return payloadTurnStep(session, seq) !== null
}
