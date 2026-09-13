import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { buildToolGroupSummaryInput, parseToolGroupSummary } from './tool-group-summary.ts'
import type { ToolGroupSummary } from './tool-group-summary.ts'
import type { ToolGroup } from './tool-groups.ts'
import type { SessionRead } from './tool-pairing.ts'

export interface ToolGroupSummaryRoute {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
}

export interface ToolGroupSummaryCallResult {
  readonly summary: ToolGroupSummary
  readonly rawOutput: readonly ContentBlock[]
  readonly usage?: TokenUsage
  readonly provider: string
  readonly model: string
}

export class ToolGroupSummaryFallbackError extends Error {
  constructor(readonly reason: ToolGroupSummaryFailureReason, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export type ToolGroupSummaryFailureReason =
  | 'route'
  | 'stream'
  | 'empty'
  | 'json'
  | 'schema'
  | 'source'

const INSTRUCTION = `You are summarizing one complete group of tool calls and results for a coding assistant.
Return ONLY valid JSON matching this exact shape:
{"version":1,"groupSummary":"...","items":[{"sourceSeq":0,"callId":"...","summary":"...","facts":[],"files":[],"identifiers":[],"errors":[],"unresolved":[]}],"groupErrors":[],"unresolved":[]}
Rules:
- Include exactly one item for every sourceSeq in the input, including tool-call and tool-result nodes.
- Copy only facts, paths, identifiers, errors, and statuses that appear verbatim in that source item.
- Never infer success, completion, paths, IDs, or test results.
- Keep unknown information in unresolved.
- Preserve exact sourceSeq and callId values.
- Do not include Markdown fences or any text outside the JSON object.`

export function buildToolGroupSummaryMessage(
  session: SessionRead,
  group: ToolGroup,
): UserMessage {
  const input = buildToolGroupSummaryInput(session, group)
  return createUserMessage({
    content: [{ type: 'text', text: `${INSTRUCTION}\n\nINPUT:\n${JSON.stringify(input)}` }],
    source: { kind: 'plugin', plugin: 'dsh-context-enhancement/tool-group-summarizer' },
  })
}

export function estimateToolGroupAuxiliaryRequestTokens(
  session: SessionRead,
  group: ToolGroup,
  reserveTokens: number,
  estimateMessage: (message: UserMessage) => number,
): number {
  const message = buildToolGroupSummaryMessage(session, group)
  return estimateMessage(message) + Math.max(0, reserveTokens)
}

export async function summarizeToolGroup(
  ctx: Context,
  session: SessionRead,
  group: ToolGroup,
  agent: Agent,
  route: ToolGroupSummaryRoute,
  signal?: AbortSignal,
  inputCapTokens?: number,
): Promise<ToolGroupSummaryCallResult> {
  if (route.provider.length === 0 || route.model.length === 0) {
    throw new ToolGroupSummaryFallbackError('route', 'tool-group-summary: provider/model route is empty')
  }
  if (inputCapTokens !== undefined) {
    const fullTokens = estimateToolGroupAuxiliaryRequestTokens(
      session,
      group,
      route.maxTokens,
      msg => ctx.tokenMeter.estimateMessage(msg),
    )
    if (fullTokens > inputCapTokens) {
      throw new ToolGroupSummaryFallbackError(
        'stream',
        `tool-group-summary: complete auxiliary request (${fullTokens} tokens) exceeds input cap (${inputCapTokens} tokens)`,
      )
    }
  }
  const input = buildToolGroupSummaryInput(session, group)
  const assembler = new BlockAssembler()
  try {
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages: [buildToolGroupSummaryMessage(session, group)],
      maxTokens: route.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const rawOutput = assembler.blocks()
    const text = rawOutput.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text).join('')
    if (text.trim().length === 0) throw new ToolGroupSummaryFallbackError('empty', 'tool-group-summary: model returned no text')
    let parsed: unknown
    try {
      parsed = JSON.parse(stripCodeFence(text))
    } catch (error) {
      throw new ToolGroupSummaryFallbackError('json', 'tool-group-summary: model output is not valid JSON', { cause: error })
    }
    let summary: ToolGroupSummary
    try {
      summary = parseToolGroupSummary(parsed, input)
    } catch (error) {
      const reason = error instanceof Error && /source|claim/.test(error.message) ? 'source' : 'schema'
      throw new ToolGroupSummaryFallbackError(reason, error instanceof Error ? error.message : String(error), { cause: error })
    }
    return { summary, rawOutput, ...(assembler.usage === undefined ? {} : { usage: assembler.usage }), provider: route.provider, model: route.model }
  } catch (error) {
    if (error instanceof ToolGroupSummaryFallbackError) throw error
    throw new ToolGroupSummaryFallbackError('stream', error instanceof Error ? error.message : String(error), { cause: error })
  }
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}
