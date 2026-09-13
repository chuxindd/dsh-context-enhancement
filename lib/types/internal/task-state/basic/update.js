/**
 * One single-attempt auxiliary collect-and-merge update for a Session. The
 * module runs the complete update transaction sequence: durable open-phase
 * audit put, `ctx.llm.stream()` with an explicit route and deadline,
 * collection of complete untruncated raw output, JSON parsing, contract
 * schema validation, Host semantic checks, the authoritative sessions-table
 * put, and the paired finished-phase audit put. It never retries internally:
 * transient infrastructure classification is surfaced to the per-Session
 * worker, which re-invokes one whole attempt (a fresh request id) per retry
 * so every open row pairs with exactly one finished phase. Every pre-put
 * failure preserves the previous stable and cursor.
 *
 * Audit durability contract:
 * - The open-phase audit put is awaited BEFORE the model stream is even
 *   constructed; an open row that cannot become durable aborts the attempt
 *   with an `AUDIT` request-stage failure and never calls the model.
 * - The sessions-table put is the authority commit point and the published
 *   pointer is updated only after it resolves. The finished-phase audit put
 *   may then fail WITHOUT rolling back the committed stable: the attempt
 *   returns `auditGap: true` and the owning worker arranges a live repair
 *   that certifies the existing open row — never rerunning the model and
 *   never inventing raw output.
 *
 * `purpose` handling: rc.1's `GenerateOptions.purpose` union is closed
 * (`'compaction' | 'session-title'`). The task-state request must still mark
 * its purpose for replay/diagnostics, so this module builds a locally typed
 * request (`purpose: 'task-state'`) and casts ONLY at the single
 * `ctx.llm.stream(...)` boundary; no upstream type is modified and no fake
 * compaction purpose is used.
 * @module dsh-context-enhancement/internal/task-state/basic/update
 */
import { randomUUID } from 'node:crypto';
import { BlockAssembler, contentHasImage, createUserMessage, } from '@deepseek-ai/dsh-llm';
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { TaskStateRequestId, } from "../contract/index.js";
import { TASK_STATE_FILTER_VERSION } from "./filter.js";
import { resolveAuthorityViews } from "./authority.js";
import { commitStable, normalizeCandidate, parseCandidate } from "./host.js";
import { TASK_STATE_INPUT_SCHEMA_VERSION, TASK_STATE_STABLE_SCHEMA_VERSION } from "./prompt.js";
/** Stable Host-owned timeout code stamped on the deadline reason. */
export const TASK_STATE_UPDATE_TIMEOUT_CODE = 'task-state-basic/update-timeout';
/**
 * Run one complete update attempt. Deterministic failures return
 * `ok: false` without retrying; transient infrastructure failures also return
 * `ok: false` with a retryable code so the owning worker may re-run the whole
 * attempt under its bounded policy. A successful put whose finished audit put
 * fails returns `ok: true` with `auditGap: true`.
 * @param attempt - full attempt context.
 * @param hooks - provider-owned storage/audit/publish boundary.
 * @returns the committed stable, or structured failure facts.
 */
export async function runUpdateAttempt(attempt, hooks) {
    const requestId = TaskStateRequestId(`ts-${randomUUID()}`);
    const targetRevision = (attempt.base?.revision ?? 0) + 1;
    // The open-phase audit row must be durable before the adapter may run. A
    // failure here aborts the attempt with the request never dispatched.
    try {
        await hooks.putOpenAudit({
            requestId,
            revision: targetRevision,
            ...attempt.trigger === undefined ? {} : { trigger: attempt.trigger },
            base: attempt.base === null ? null : structuredClone(attempt.base),
            includedSeqs: [...attempt.includedSeqs],
            filterVersion: TASK_STATE_FILTER_VERSION,
            system: attempt.system,
            route: { provider: attempt.route.provider, model: attempt.route.model },
            maxTokens: attempt.maxOutputTokens,
            schema: { version: TASK_STATE_INPUT_SCHEMA_VERSION },
            truncation: [...attempt.truncation],
            ...attempt.inherited === undefined || attempt.inherited === null
                ? {}
                : { inherited: attempt.inherited },
        });
    }
    catch (error) {
        return {
            ok: false,
            failure: {
                stage: 'request',
                code: 'AUDIT',
                message: error instanceof Error
                    ? `task-state-basic: open-phase audit could not be made durable before dispatch: ${error.message}`
                    : 'task-state-basic: open-phase audit could not be made durable before dispatch',
            },
        };
    }
    const timed = deadline(attempt.signal, attempt.timeoutMs, TASK_STATE_UPDATE_TIMEOUT_CODE);
    try {
        let collected;
        try {
            collected = await streamAndCollect(attempt, timed.signal);
        }
        catch (error) {
            collected = classifyFailure(error, attempt.signal, timed.signal);
        }
        // A stream failure surfaces as the failure branch of the collected result.
        if (!collected.ok) {
            await appendFailureSafely(hooks, requestId, collected.failure);
            return { ok: false, failure: collected.failure };
        }
        const terminal = terminalFailure(collected.finish, attempt.signal, timed.signal);
        if (terminal !== undefined) {
            await appendFailureSafely(hooks, requestId, terminal);
            return { ok: false, failure: terminal };
        }
        const commitResult = await commitFromOutput(attempt, hooks, requestId, collected.blocks, targetRevision, collected.usage);
        return commitResult;
    }
    finally {
        timed[Symbol.dispose]();
    }
}
/**
 * Stream one model call and collect complete untruncated output blocks. The
 * request is built with the locally typed task-state purpose and cast once at
 * the runtime stream boundary; the adapter receives the exact same options
 * object fields (provider, model, messages, system, maxTokens, sessionId,
 * purpose, signal) it would receive from an upstream `GenerateOptions`.
 */
async function streamAndCollect(attempt, signal) {
    const options = {
        provider: attempt.route.provider,
        model: attempt.route.model,
        messages: [createUserMessage({
                content: [{ type: 'text', text: attempt.projection }],
                source: { kind: 'plugin', plugin: 'dsh-context-enhancement/task-state-basic' },
            })],
        system: attempt.system,
        maxTokens: attempt.maxOutputTokens,
        sessionId: attempt.sessionId,
        purpose: 'task-state',
        signal,
    };
    const assembler = new BlockAssembler();
    for await (const chunk of attempt.ctx.llm.stream(options))
        assembler.push(chunk);
    return {
        ok: true,
        blocks: assembler.blocks(),
        ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        finish: assembler.finish,
    };
}
/** Classify one thrown stream error into its failure facts. */
function classifyFailure(error, sessionSignal, deadlineSignal) {
    if (sessionSignal.aborted) {
        return { ok: false, failure: { stage: 'stream', code: 'ABORTED', message: errorMessage(error) } };
    }
    const timedOut = timeoutOfDeadline(deadlineSignal);
    if (timedOut) {
        return { ok: false, failure: { stage: 'stream', code: 'TIMEOUT', message: 'task-state update exceeded its configured timeout' } };
    }
    const thrown = error;
    const code = typeof thrown?.code === 'string' ? thrown.code : undefined;
    return {
        ok: false,
        failure: {
            stage: 'stream',
            code: code === 'ABORTED' ? 'ABORTED' : code !== undefined && isTransientCode(code) ? 'TRANSIENT_LLM' : 'UNEXPECTED',
            message: errorMessage(error),
        },
    };
}
/** Map a terminal finish to the corresponding failure, or undefined on `stop`. */
function terminalFailure(finish, sessionSignal, deadlineSignal) {
    switch (finish.kind) {
        case 'stop':
            return undefined;
        case 'error':
            return { stage: 'stream', code: codeFor(finish.failure.code), message: finish.failure.message };
        case 'aborted':
            return sessionSignal.aborted
                ? { stage: 'stream', code: 'ABORTED', message: finish.failure.message }
                : deadlineSignal.aborted
                    ? { stage: 'stream', code: 'TIMEOUT', message: 'task-state update exceeded its configured timeout' }
                    : { stage: 'stream', code: 'ABORTED', message: finish.failure.message };
        case 'max-tokens':
            return { stage: 'parse', code: 'PARSE', message: 'task-state update output reached maxOutputTokens (incomplete JSON)' };
        case 'tool-calls':
            return { stage: 'semantic', code: 'SEMANTIC', message: 'task-state update model unexpectedly requested a tool' };
        default:
            return { stage: 'stream', code: 'UNEXPECTED', message: `unsupported finish kind "${String(finish.kind)}"` };
    }
}
/** Translate a provider-neutral failure code into the batch code taxonomy. */
function codeFor(code) {
    return code === 'ABORTED' ? 'ABORTED' : isTransientCode(code) ? 'TRANSIENT_LLM' : 'UNEXPECTED';
}
/** Whether one provider-neutral code is transient infrastructure. */
function isTransientCode(code) {
    return code === 'EMPTY_RESPONSE' || code === 'RATE_LIMIT' || code === 'SERVER' || code === 'TIMEOUT' || code === 'TRANSPORT';
}
/** Render a thrown error message. */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Whether the deadline signal aborted with the owned timeout reason. */
function timeoutOfDeadline(signal) {
    return timeoutOf(signal, TASK_STATE_UPDATE_TIMEOUT_CODE) !== undefined;
}
/** Whether one streamed finish produced usable text output. */
function hasTextOutput(blocks) {
    return blocks.some(block => block.type === 'text' && block.text.trim().length > 0);
}
/** Append a failure finished audit, containing the failure facts if the append itself fails. */
async function appendFailureSafely(hooks, requestId, failure) {
    try {
        const outcome = failure.code === 'ABORTED' ? 'aborted' : 'failure';
        await hooks.putFinishedAudit({
            outcome,
            requestId,
            error: { stage: failure.stage, code: failure.code, message: failure.message },
        });
    }
    catch {
        // Swallows a finished-audit rejection: the attempt already carries its own
        // failure facts, and a failing audit put must not turn a classified
        // failure into an unhandled rejection.
    }
}
/** Commit the parsed stable from collected text blocks. */
async function commitFromOutput(attempt, hooks, requestId, blocks, targetRevision, usage) {
    if (contentHasImage(blocks)) {
        await appendFailureSafely(hooks, requestId, { stage: 'parse', code: 'PARSE', message: 'task-state update output cannot contain image content' });
        return { ok: false, failure: { stage: 'parse', code: 'PARSE', message: 'task-state update output cannot contain image content' } };
    }
    if (!hasTextOutput(blocks)) {
        await appendFailureSafely(hooks, requestId, { stage: 'parse', code: 'PARSE', message: 'task-state update model produced no text output' });
        return { ok: false, failure: { stage: 'parse', code: 'PARSE', message: 'task-state update model produced no text output' } };
    }
    const text = blocks
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('\n');
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        const failure = {
            stage: 'parse',
            code: 'PARSE',
            message: `task-state update output is not valid JSON: ${errorMessage(error)}`,
        };
        await appendFailureSafely(hooks, requestId, failure);
        return { ok: false, failure };
    }
    let candidate;
    try {
        candidate = parseCandidate(parsed);
    }
    catch (error) {
        const failure = {
            stage: 'schema',
            code: 'SCHEMA',
            message: `task-state candidate failed schema validation: ${errorMessage(error)}`,
        };
        await appendFailureSafely(hooks, requestId, failure);
        return { ok: false, failure };
    }
    const context = candidateContext(attempt);
    const quarantined = [];
    let normalized;
    try {
        normalized = normalizeCandidate(candidate, context, item => { quarantined.push(item); });
    }
    catch (error) {
        const failure = {
            stage: 'semantic',
            code: 'SEMANTIC',
            message: `task-state candidate failed Host semantic checks: ${errorMessage(error)}`,
        };
        await appendFailureSafely(hooks, requestId, failure);
        return { ok: false, failure };
    }
    if (quarantined.length > 0) {
        try {
            attempt.ctx.logger.warn(`task-state-basic: ${attempt.sessionId} quarantined ${quarantined.length} stale reference(s) outside the folded window `
                + `(${quarantined.map(item => `${item.kind} ${item.seq}`).join(', ')}); the references were dropped with the candidate, `
                + 'valid references and all other fields were preserved, and no sequence was fabricated');
        }
        catch {
            // Diagnostic warnings are best-effort and must never abort authority commit.
        }
    }
    const sourceCursor = attempt.includedSeqs[attempt.includedSeqs.length - 1] ?? 0;
    let stable;
    try {
        stable = commitStable(normalized, TASK_STATE_STABLE_SCHEMA_VERSION, targetRevision, TASK_STATE_FILTER_VERSION, sourceCursor, attempt.inherited ?? null);
    }
    catch (error) {
        // commitStable only rejects when the caller-supplied revision/cursor
        // violates the durable schema; every real attempt passes an in-range
        // computed revision and a real included cursor.
        /* v8 ignore start -- see the comment above the catch. */
        const failure = {
            stage: 'semantic',
            code: 'SEMANTIC',
            message: `committed stable failed its durable schema: ${errorMessage(error)}`,
        };
        await appendFailureSafely(hooks, requestId, failure);
        return { ok: false, failure };
        /* v8 ignore stop */
    }
    try {
        await hooks.putStable(stable);
    }
    catch (error) {
        const failure = {
            stage: 'storage',
            code: 'STORAGE',
            message: `task-state stable write failed: ${errorMessage(error)}`,
        };
        await appendFailureSafely(hooks, requestId, failure);
        return { ok: false, failure };
    }
    // The authority put resolved; the stable is committed and published even if
    // the finished audit below cannot be made durable. Rollback is forbidden —
    // a later repair fills the existing open row.
    hooks.onCommitted(stable);
    let auditGap = false;
    try {
        await hooks.putFinishedAudit({
            outcome: 'success',
            requestId,
            revision: stable.revision,
            sourceCursor: stable.sourceCursor,
            llmStreamCall: true,
            rawOutput: [...blocks],
            ...usage === undefined ? {} : { usage },
            finish: { kind: 'stop' },
        });
    }
    catch (error) {
        // The finished audit could not be put. The stable stays committed; report
        // the audit gap so the worker fills the open row with a repair credential.
        auditGap = true;
        try {
            attempt.ctx.logger.warn(`task-state-basic: ${attempt.sessionId} committed stable revision ${stable.revision} but its finished audit failed; repair will certify it: ${errorMessage(error)}`);
        }
        catch {
            // Diagnostic warnings are best-effort and must never bubble out of the committed update.
        }
    }
    return { ok: true, stable, requestId, auditGap, ...usage === undefined ? {} : { usage } };
}
/** Build the Host semantic-validation context from one attempt. */
function candidateContext(attempt) {
    const base = attempt.base;
    const authority = resolveAuthorityViews(attempt.windowEvents, base, {
        maxEntryBytes: attempt.limits.maxEntryBytes,
    });
    return {
        base: base === null
            ? null
            : {
                revision: base.revision,
                sourceCursor: base.sourceCursor,
                entryIds: new Set(allEntryIds(base)),
                entries: allEntries(base),
            },
        includedSeqs: new Set(attempt.includedSeqs),
        authority: {
            goalView: authority.goalView,
            todoView: authority.todoView,
            todoReferences: authority.todoReferences,
        },
        limits: attempt.limits,
    };
}
/** All Host-minted entry ids of one stable, for echoed-id verification. */
function allEntryIds(stable) {
    return allEntries(stable).map(entry => entry.id);
}
/** Every committed entry of one stable with its kind. */
function allEntries(stable) {
    return [
        ...stable.facts.map(entry => ({ id: String(entry.id), kind: 'fact', content: entry.content })),
        ...stable.decisions.map(entry => ({ id: String(entry.id), kind: 'decision', content: entry.content })),
        ...stable.constraints.map(entry => ({ id: String(entry.id), kind: 'constraint', content: entry.content })),
        ...stable.risks.map(entry => ({ id: String(entry.id), kind: 'risk', content: entry.content })),
    ];
}
//# sourceMappingURL=update.js.map