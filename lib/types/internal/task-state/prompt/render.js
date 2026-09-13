/**
 * Deterministic UTF-8-byte-bounded and token-bounded rendering of one committed
 * task-state stable for the main model. The renderer is a pure function of the
 * stable plus the deployment's byte and token budgets: it never reads storage,
 * consults a Session, appends an event, or awaits, and it never mutates or
 * re-authorizes the stable.
 *
 * The authoritative Goal and TODO views render first and verbatim from the
 * committed views, so the model always sees the state the Session is committed
 * to; a cleared view renders as an explicit clear rather than as an absent
 * section. Truncation drops whole lines from the tail (evidence first, then
 * facts/decisions/risks, then continuation) and appends a fixed marker, so no
 * UTF-8 codepoint is ever split and the returned text always fits both budgets.
 * If even the authoritative minimum representation cannot fit within budget I
 * or maxBytes, it fails closed (typed block) and injects nothing misleading.
 * @module dsh-context-enhancement/internal/task-state/prompt/render
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS, TASK_STATE_STALE_MARKER, } from "../contract/index.js";
const encoder = new TextEncoder();
/** Fixed model-visible marker appended when a bounded render dropped any line. */
export const TASK_STATE_TRUNCATION_MARKER = '[Task-state snapshot truncated; the committed durable state remains authoritative.]';
/** Fixed model-visible marker displayed when the stable cursor lags session eligible high-water. */
export { TASK_STATE_STALE_MARKER };
/** Resolve the single injection budget from deployment config with conservative defaults. */
export function resolveInjectionBudget(config) {
    const maxBytes = Math.max(1, Math.floor(config.maxBytes));
    const maxTokens = Math.max(1, Math.floor(config.maxTokens ?? DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS));
    return { maxBytes, maxTokens };
}
/**
 * Estimate tokens for a slot message text using the real tokenMeter when available,
 * with an audited conservative fallback (CJK and structural overhead aware).
 */
export function estimateSlotTokens(text, meter) {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    if (meter !== undefined && typeof meter.estimateMessage === 'function') {
        return meter.estimateMessage(message);
    }
    // Conservative fallback when tokenMeter service is absent:
    // Role framing (4) + Text block overhead (4)
    const ROLE_OVERHEAD = 4;
    const BLOCK_OVERHEAD = 4;
    let cjkCount = 0;
    let otherCount = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if ((code >= 0x4e00 && code <= 0x9fff)
            || (code >= 0x3400 && code <= 0x4dbf)
            || (code >= 0x20000 && code <= 0x2a6df)
            || (code >= 0xf900 && code <= 0xfaff)) {
            cjkCount += 1;
        }
        else {
            otherCount += 1;
        }
    }
    const textTokens = Math.max(Math.ceil(text.length / 4), cjkCount + Math.ceil(otherCount / 4));
    return ROLE_OVERHEAD + BLOCK_OVERHEAD + textTokens;
}
/** Ordered list sections of one stable, each with its header line. */
const KINDED = [
    ['Facts:', 'facts'],
    ['Decisions:', 'decisions'],
    ['Constraints:', 'constraints'],
    ['Risks:', 'risks'],
];
/** Whether any list section of the stable carries content. */
function hasListContent(stable) {
    return stable.facts.length > 0 || stable.decisions.length > 0
        || stable.constraints.length > 0 || stable.risks.length > 0
        || stable.evidence.length > 0;
}
/** Whether the stable carries an authoritative Goal or TODO view to render. */
function hasAuthorityContent(stable) {
    return stable.goalView.status !== 'none' || stable.todoView.status !== 'none';
}
/**
 * The authoritative Goal lines of one stable. A `current` view renders its
 * objective plus the identity it belongs to; a `cleared` view renders the
 * explicit fact that no authoritative goal exists — which is exactly what stops
 * a superseded objective from being re-injected as if it were still in force.
 */
function goalLines(stable) {
    const view = stable.goalView;
    if (view.status === 'none')
        return [];
    if (view.status === 'cleared')
        return ['Current goal: cleared (no authoritative goal is set).'];
    const lines = [`Current goal: ${view.objective ?? '(no objective recorded)'}`];
    const identity = [];
    if (view.goalId !== undefined)
        identity.push(`goal ${view.goalId}`);
    if (view.goalRevision !== undefined)
        identity.push(`revision ${view.goalRevision}`);
    if (view.phase !== undefined)
        identity.push(`phase ${view.phase}`);
    if (identity.length > 0)
        lines.push(`Goal identity: ${identity.join(', ')}`);
    return lines;
}
/**
 * The authoritative TODO lines of one stable, rendered from the view and never
 * from a stale reference: a `cleared` view states the list is gone, so no item
 * of a superseded list can keep rendering as live work.
 */
function todoLines(stable) {
    const view = stable.todoView;
    if (view.status === 'none')
        return [];
    if (view.status === 'cleared')
        return ['TODO list: cleared (the authoritative list is empty).'];
    const header = view.sourceSeq === undefined
        ? 'TODO list:'
        : `TODO list (session event ${view.sourceSeq}):`;
    const lines = [header];
    for (const item of view.items)
        lines.push(`- [${item.status}] ${item.content}`);
    return lines;
}
/**
 * Build the complete ordered lines of one stable, along with the count of lines
 * belonging to the authoritative minimum representation (Header + Goal + TODO).
 */
function buildLines(stable, isStale) {
    const lines = [
        `Durable task state (revision ${stable.revision}, source event ${stable.sourceCursor}, digest ${stable.digest}).`,
    ];
    if (isStale) {
        lines.push(TASK_STATE_STALE_MARKER);
    }
    lines.push(...goalLines(stable));
    lines.push(...todoLines(stable));
    const authoritativeLineCount = lines.length;
    const continuation = stable.continuation;
    const hasContinuation = continuation.currentObjective !== ''
        || continuation.currentFocus !== ''
        || continuation.openWork.length > 0
        || continuation.nextActions.length > 0;
    if (stable.goalView.status === 'none' && continuation.currentObjective !== '') {
        lines.push(`Current objective: ${continuation.currentObjective}`);
    }
    if (continuation.currentFocus !== '') {
        lines.push(`Current focus: ${continuation.currentFocus}`);
    }
    if (continuation.openWork.length > 0) {
        lines.push('Open work:');
        for (const item of continuation.openWork)
            lines.push(`- ${item}`);
    }
    if (continuation.nextActions.length > 0) {
        lines.push('Next actions:');
        for (const item of continuation.nextActions)
            lines.push(`- ${item}`);
    }
    if (!hasContinuation && !hasListContent(stable) && !hasAuthorityContent(stable)) {
        return { lines, authoritativeLineCount };
    }
    if (hasListContent(stable)) {
        lines.push('');
        for (const [header, key] of KINDED) {
            const entries = stable[key];
            if (entries.length === 0)
                continue;
            lines.push(header);
            for (const entry of entries)
                lines.push(`- ${entry.content}`);
        }
        if (stable.evidence.length > 0) {
            lines.push('Evidence:');
            for (const reference of stable.evidence) {
                lines.push(`- ${reference.note} (session event ${reference.seq})`);
            }
        }
    }
    return { lines, authoritativeLineCount };
}
/**
 * Render one committed stable as a bounded slot snapshot.
 *
 * Checks both byte budget (maxBytes) and token budget I (maxTokens).
 * Enforces authoritative minimum representation priority: Goal and TODO views
 * render first and verbatim. If even the authoritative minimum cannot fit within
 * both budgets, fails closed (blocked). Truncation drops low-priority sections
 * (evidence first, then facts/decisions/risks, then continuation) and appends
 * the fixed truncation marker.
 */
export function renderTaskStateSlot(stable, options) {
    const maxBytes = Math.max(1, Math.floor(options.maxBytes));
    const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS));
    const eligibleHighWater = options.eligibleHighWater ?? stable.sourceCursor;
    const isStale = eligibleHighWater > stable.sourceCursor;
    const staleness = isStale ? 'stale' : 'fresh';
    const { lines, authoritativeLineCount } = buildLines(stable, isStale);
    const full = lines.join('\n');
    const fullBytes = encoder.encode(full).byteLength;
    const fullTokens = estimateSlotTokens(full, options.meter);
    // Fast path: entire text fits within both maxBytes and maxTokens
    if (fullBytes <= maxBytes && fullTokens <= maxTokens) {
        return {
            text: full,
            staleness,
            truncation: false,
            injectionTokens: fullTokens,
            budgetTokens: maxTokens,
            eligibleHighWater,
            blocked: false,
        };
    }
    // Full text does not fit: truncation required.
    // Authoritative minimum representation lines (Header + Staleness + Goal + TODO)
    const authLines = lines.slice(0, authoritativeLineCount);
    const authText = authLines.join('\n');
    const authBytes = encoder.encode(authText).byteLength;
    const authTokens = estimateSlotTokens(authText, options.meter);
    // If even the authoritative minimum representation alone exceeds either budget,
    // typed fail closed / block immediately.
    if (authBytes > maxBytes || authTokens > maxTokens) {
        return {
            text: '',
            staleness: 'blocked',
            truncation: false,
            injectionTokens: 0,
            budgetTokens: maxTokens,
            eligibleHighWater,
            blocked: true,
        };
    }
    // If there are no additional lines beyond the authoritative representation,
    // and the authoritative representation fits, return it without a truncation marker.
    if (lines.length === authoritativeLineCount) {
        return {
            text: authText,
            staleness,
            truncation: false,
            injectionTokens: authTokens,
            budgetTokens: maxTokens,
            eligibleHighWater,
            blocked: false,
        };
    }
    // Test if authoritative representation + truncation marker fits
    const minTruncatedCandidate = `${authText}\n${TASK_STATE_TRUNCATION_MARKER}`;
    if (encoder.encode(minTruncatedCandidate).byteLength > maxBytes
        || estimateSlotTokens(minTruncatedCandidate, options.meter) > maxTokens) {
        // Cannot even fit authoritative representation plus truncation marker:
        // fail closed to prevent misleading truncated presentation.
        return {
            text: '',
            staleness: 'blocked',
            truncation: false,
            injectionTokens: 0,
            budgetTokens: maxTokens,
            eligibleHighWater,
            blocked: true,
        };
    }
    // Pack lines from the head until adding another line would exceed either budget
    let acceptedPrefix = authText;
    for (let i = authoritativeLineCount; i < lines.length; i += 1) {
        const candidate = `${acceptedPrefix}\n${lines[i]}`;
        const withMarker = `${candidate}\n${TASK_STATE_TRUNCATION_MARKER}`;
        if (encoder.encode(withMarker).byteLength <= maxBytes
            && estimateSlotTokens(withMarker, options.meter) <= maxTokens) {
            acceptedPrefix = candidate;
        }
        else {
            break;
        }
    }
    const finalText = `${acceptedPrefix}\n${TASK_STATE_TRUNCATION_MARKER}`;
    const finalTokens = estimateSlotTokens(finalText, options.meter);
    return {
        text: finalText,
        staleness,
        truncation: true,
        injectionTokens: finalTokens,
        budgetTokens: maxTokens,
        eligibleHighWater,
        blocked: false,
    };
}
/**
 * Bounded rendering of one committed stable deterministically within a UTF-8 byte budget.
 * Retained for backward compatibility with existing tests and callers.
 */
export function renderTaskStateSnapshot(stable, maxBytes) {
    const result = renderTaskStateSlot(stable, {
        maxBytes,
        maxTokens: DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS,
    });
    return result.text;
}
//# sourceMappingURL=render.js.map