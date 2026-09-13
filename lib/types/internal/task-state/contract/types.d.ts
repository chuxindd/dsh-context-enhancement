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
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm/types';
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { TaskStateEntryId, TaskStateRequestId } from './brand.ts';
export type { TaskStateEntryId, TaskStateRequestId };
/**
 * The session identity a durable task-state record binds. A record is keyed by
 * the real Session id; the value carries the lifecycle fields that fence the
 * record to ONE log lifecycle, so a reused Session id cannot silently adopt a
 * record written by an earlier lifecycle with the same id.
 */
export interface TaskStateSessionIdentity {
    /** Epoch milliseconds when the owning Session was created. */
    readonly createdAt: number;
    /** Absolute working directory the Session was created in, when it had one. */
    readonly cwd?: string;
}
/** One stable entry kind assigned its own Host-minted id prefix. */
export type TaskStateEntryKind = 'fact' | 'decision' | 'constraint' | 'risk';
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
    readonly id?: TaskStateEntryId;
    /** The entry's proposed content. */
    readonly content: string;
}
/**
 * One durable entry inside a committed stable. Every entry carries the
 * Host-minted opaque branded UUID the stable assigned, prefixed by its kind
 * such as `fact-<uuid>`; the auxiliary model only echoes existing ids and
 * never mints them.
 */
export interface TaskStateStableEntry {
    /** Opaque kind-prefixed branded id assigned by the Host when the entry first committed. */
    readonly id: TaskStateEntryId;
    /** The entry's content. */
    readonly content: string;
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
    readonly currentObjective: string;
    /** What the session is currently working on at this stable. */
    readonly currentFocus: string;
    /** Concrete pieces of work still open at this stable. */
    readonly openWork: readonly string[];
    /** Concrete next actions planned at this stable. */
    readonly nextActions: readonly string[];
}
/**
 * A reference to one eligible durable Session event that supports a stable
 * entry. It points at the event sequence instead of copying the event, so the
 * stable stays bounded while the Session log keeps full source fidelity.
 */
export interface TaskStateEvidenceReference {
    /** Sequence of the referenced eligible Session event. */
    readonly seq: number;
    /** Bounded note explaining what the reference supports. */
    readonly note: string;
}
/**
 * A bounded reference to the independently owned whole-list TODO state: the
 * durable `todo/write` event sequence that carried the list plus bounded
 * readable content. It creates no stable TODO item identity and copies no
 * TODO ownership.
 */
export interface TaskStateTodoReference {
    /** Sequence of the durable `todo/write` event that carried the list. */
    readonly seq: number;
    /** Bounded readable content preserved from that list. */
    readonly content: string;
}
/**
 * Whether one authoritative named view currently holds a value, was explicitly
 * cleared by its own authority event, or was never established at all. The
 * three states are distinct: `none` means no authority fact ever existed,
 * `cleared` means the latest authority fact removed the value, and neither may
 * be collapsed into "no content" — a cleared Goal or TODO list must stay
 * distinguishable from an absent one.
 */
export type TaskStateAuthorityStatus = 'current' | 'cleared' | 'none';
/**
 * The authoritative Goal view of one committed stable, derived by the Host
 * from the newest durable `goal/change` fact in the folded window (or carried
 * forward from the previous stable when that window holds none). A new goal
 * revision REPLACES the previous view instead of appending to it, and a clear
 * tombstone removes it; the auxiliary model never authors this view.
 */
export interface TaskStateGoalView {
    /** Whether an authoritative goal currently exists, was cleared, or never existed. */
    readonly status: TaskStateAuthorityStatus;
    /** Goal identity of the current view; absent unless `status` is `current`. */
    readonly goalId?: string;
    /** Positive goal revision of the current view; absent unless `status` is `current`. */
    readonly goalRevision?: number;
    /** Durable goal phase of the current view, when the fact carried one. */
    readonly phase?: string;
    /** Human completion objective of the current view, when the fact carried one. */
    readonly objective?: string;
}
/** One entry of the authoritative TODO view, copied from the winning `todo/write` fact. */
export interface TaskStateTodoViewItem {
    /** What the item is, exactly as the durable whole-list write carried it. */
    readonly content: string;
    /** Durable lifecycle state of the item (`pending`, `in_progress`, or `completed`). */
    readonly status: string;
}
/**
 * The authoritative TODO view of one committed stable, derived by the Host
 * from the newest durable `todo/write` whole-list fact in the folded window
 * (or carried forward from the previous stable when that window holds none).
 * The list is replaced wholesale — a later write replaces the earlier items and
 * an empty write clears the view — so a superseded list can never survive.
 */
export interface TaskStateTodoView {
    /** Whether a list currently exists, was cleared by an empty write, or never existed. */
    readonly status: TaskStateAuthorityStatus;
    /** Sequence of the authoritative `todo/write` fact that produced this view. */
    readonly sourceSeq?: number;
    /** Items of the current list; empty unless `status` is `current`. */
    readonly items: readonly TaskStateTodoViewItem[];
}
/**
 * The content one candidate or committed task-state snapshot carries beyond
 * the kinded entry lists: the bounded evidence references. TODO references and
 * the authoritative Goal/TODO views are Host-owned and deliberately absent
 * here, because the auxiliary model never authors them.
 */
export interface TaskStateContentFields {
    /** References to eligible durable Session events that support the entries. */
    readonly evidence: readonly TaskStateEvidenceReference[];
}
/**
 * The structured content of one auxiliary-model candidate snapshot: the four
 * kinded entry lists with optional echoed ids, the continuation state, and the
 * bounded evidence references. A candidate is not committed: the Host mints ids
 * for new entries and verifies echoed ids before commit, and the Host derives
 * every authoritative Goal/TODO field separately.
 */
export interface TaskStateCandidateContent extends TaskStateContentFields {
    /** Ordered facts. */
    readonly facts: readonly TaskStateCandidateEntry[];
    /** Ordered decisions. */
    readonly decisions: readonly TaskStateCandidateEntry[];
    /** Ordered constraints. */
    readonly constraints: readonly TaskStateCandidateEntry[];
    /** Ordered risks. */
    readonly risks: readonly TaskStateCandidateEntry[];
    /** Durable continuation state proposed by the auxiliary model. */
    readonly continuation: TaskStateContinuation;
}
/** The complete next snapshot the auxiliary model proposes. */
export type TaskStateCandidate = TaskStateCandidateContent;
/**
 * The inherited fork boundary of one Session LIFECYCLE.
 *
 * DSH seeds a forked child Session with the parent's prefix: the child's log
 * starts with events it never observed, and `Session.inheritedEventCount` is the
 * durable statement of where its own events begin. `Session.firstLiveSeq` is NOT
 * that statement — it is the in-process constructor seed length, so it equals the
 * inherited count on a fresh fork and the WHOLE stored log length after a resume.
 * This record therefore carries the boundary that survives both cases, together
 * with the covered range a reader can cite.
 *
 * Coverage of an inherited lifecycle is bounded: no stable, no window, and no
 * audit row of the child may claim coverage BELOW `ownBoundarySeq`, because those
 * sequences are the parent's facts, delivered to the child as history rather than
 * as new live events.
 */
export interface TaskStateInheritedPrefix {
    /** Fixed source marker of the boundary. Only a fork prefix is defined today. */
    readonly source: 'fork-prefix';
    /**
     * The child's own-event boundary: the seq of its FIRST own event equals this
     * value, so its own coverage floor is `ownBoundarySeq - 1`.
     */
    readonly ownBoundarySeq: number;
    /**
     * Highest inherited seq of the prefix, or `null` when no inherited event
     * exists (an empty seed). `ownBoundarySeq - 1` is the covered range when the
     * prefix is contiguous, which a Session log always is.
     */
    readonly inheritedThroughSeq: number | null;
    /** Session id of the parent lifecycle the prefix was seeded from, when known. */
    readonly parentSession?: string;
}
/**
 * One committed authoritative stable: the four kinded entry lists with
 * Host-minted ids, the durable continuation state, the Host-derived
 * authoritative Goal/TODO views with the bounded TODO reference they imply, and
 * the Host-owned commit metadata. The storage record is its sole durable
 * authority.
 */
export interface TaskStateStable extends TaskStateContentFields {
    /** Content schema version of this exact stable. */
    readonly schemaVersion: number;
    /** Positive monotonic stable revision; every commit increments it. */
    readonly revision: number;
    /** Deterministic input-filter version that produced the folded projection. */
    readonly filterVersion: string;
    /** Sequence of the last eligible Session event folded into this stable. */
    readonly sourceCursor: number;
    /** Deterministic digest over the structured content of this stable. */
    readonly digest: string;
    /**
     * The inherited fork boundary this stable's coverage stops at, present only
     * for a lifecycle that BEGAN on an inherited prefix. Its absence means "this
     * lifecycle owns every seq its cursor covers", which is the only shape a
     * lifecycle without a fork cut can legitimately produce; a reader must treat
     * an absent marker as "no inherited prefix", never as "unknown".
     *
     * The marker is metadata: it is written beside the digest and is NOT part of
     * the digested content, so a stable's content identity is unchanged by it.
     */
    readonly inherited?: TaskStateInheritedPrefix;
    /** Ordered facts, each with its Host-minted id. */
    readonly facts: readonly TaskStateStableEntry[];
    /** Ordered decisions, each with its Host-minted id. */
    readonly decisions: readonly TaskStateStableEntry[];
    /** Ordered constraints, each with its Host-minted id. */
    readonly constraints: readonly TaskStateStableEntry[];
    /** Ordered risks, each with its Host-minted id. */
    readonly risks: readonly TaskStateStableEntry[];
    /** Durable continuation state committed with this stable. */
    readonly continuation: TaskStateContinuation;
    /**
     * Bounded reference to the authoritative TODO list, derived by the Host from
     * the committed {@link TaskStateTodoView}. It is at most one reference and is
     * EMPTY whenever the view is not `current`, so a cleared list never leaves a
     * stale reference behind.
     */
    readonly todoReferences: readonly TaskStateTodoReference[];
    /** Authoritative Goal view committed with this stable. */
    readonly goalView: TaskStateGoalView;
    /** Authoritative TODO view committed with this stable. */
    readonly todoView: TaskStateTodoView;
}
/**
 * The stable generation a durable terminal verdict was derived from. A verdict
 * is a statement about ONE base stable, one filter version, and one framed-input
 * budget; when any of them changes (a new commit with its own revision/digest, a
 * manually edited base, a reconfigured byte budget), the measured cause it names
 * may no longer hold and the window must be RE-EVALUATED instead of being
 * inherited as a permanent ban.
 *
 * The generation is stored durably with the verdict — never re-derived from
 * live memory — so a restart, a config change, or a later commit can decide
 * whether the same terminal state still applies by comparing it with the
 * CURRENT generation.
 */
export interface TaskStateTerminalGeneration {
    /** Source cursor of the base stable the verdict was derived from (-1 before the first commit). */
    readonly baseSourceCursor: number;
    /** Filter version of that base stable. */
    readonly baseFilterVersion: string;
    /** Digest of that base stable's content. */
    readonly baseDigest: string;
    /** Configured `maxInputBytes` in force when the verdict was measured. */
    readonly maxInputBytes: number;
}
/** Machine-routable terminal status code of one durable verdict. */
export type TaskStateTerminalCode = 'BUDGET';
/**
 * Terminal provenance of one QUARANTINED infeasible window: the fold proved
 * that the single FIRST projectable event above the committed cursor cannot fit
 * the complete framed-input budget even after deterministic truncation, and
 * that event was measured to be an ordinary, non-authority fact. Only that
 * measured culprit sequence is named, and the effective cursor advances to it.
 */
export interface TaskStateQuarantinedVerdict {
    readonly kind: 'quarantined';
    /** Branded request id of the terminal attempt; keys its diagnostic audit row. */
    readonly requestId: TaskStateRequestId;
    /** Stable generation the quarantine was measured against. */
    readonly generation: TaskStateTerminalGeneration;
    /** Advanced effective source cursor; strictly above the floor it was derived from. */
    readonly cursor: number;
    /** Exact eligible sequence numbers quarantined (at least the measured culprit). */
    readonly includedSeqs: readonly number[];
    /** Machine-routable failure code (`BUDGET`). */
    readonly code: TaskStateTerminalCode;
    /** Bounded human-readable reason for the terminal verdict. */
    readonly reason: string;
    /** Why this wave was admitted. */
    readonly trigger?: TaskStateUpdateTrigger;
    /** Epoch milliseconds when the terminal verdict was recorded. */
    readonly time: number;
}
/**
 * Terminal provenance of an infeasible window whose measured cause is NOT any
 * event of the log, so no event may be blamed, skipped, or advanced past.
 *
 * Two causes share this shape and both stay BLOCKED — no cursor advance, no
 * quarantine, no claim, repeated until the generation changes:
 *
 * - `blockBaseOverBudget`: the committed base stable ALONE already exceeds
 *   `maxInputBytes`, so the previous stable — not the log — is the cause.
 *   Quarantining eligible events would discard facts and still not make
 *   progress. The verdict lifts when the base generation changes (a new commit,
 *   a manual edit, a changed budget), and the same window is re-evaluated then.
 * - `blockAuthorityFact`: the first projectable event is an AUTHORITY fact
 *   (`goal/change`, `todo/write`) that cannot fit. Authority facts are never
 *   skipped, so the cursor stays put and the fact stays PENDING; the verdict
 *   lifts on a generation change (a new base revision, a replaced authority
 *   fact folded behind a new base, or a changed budget).
 *
 * A blocked verdict carries NO `includedSeqs`: nothing was quarantined, and a
 * reader must never read it as licence to skip the named sequence.
 */
export interface TaskStateBlockedVerdict {
    /** Which measured, non-event cause blocks the window. */
    readonly kind: 'blockBaseOverBudget' | 'blockAuthorityFact';
    /** Branded request id of the terminal attempt; keys its diagnostic audit row. */
    readonly requestId: TaskStateRequestId;
    /** Stable generation the block was measured against. */
    readonly generation: TaskStateTerminalGeneration;
    /**
     * Effective source cursor at the moment of the block. It is the committed
     * floor, never an advance: a blocked verdict structurally cannot move the
     * cursor forward.
     */
    readonly cursor: number;
    /** Sequence of the oversized authority fact that stays PENDING (`goal/change`, `todo/write`). */
    readonly blockSeq?: number;
    /** Durable event type of {@link blockSeq}, when one was measured. */
    readonly blockType?: string;
    /** Machine-routable failure code (`BUDGET`). */
    readonly code: TaskStateTerminalCode;
    /** Bounded human-readable reason for the terminal verdict. */
    readonly reason: string;
    /** Why this wave was admitted. */
    readonly trigger?: TaskStateUpdateTrigger;
    /** Epoch milliseconds when the terminal verdict was recorded. */
    readonly time: number;
}
/**
 * One durable terminal verdict of a Session lifecycle: what the provider has
 * already proven about a window it cannot fold. Exactly one verdict is kept —
 * the newest — and the record's effective cursor is its `cursor`, so a
 * quarantine can never be lost and a block can never advance anything.
 */
export type TaskStateTerminalRecord = TaskStateQuarantinedVerdict | TaskStateBlockedVerdict;
/**
 * One whole-Session durable task-state record: the lifecycle identity the
 * record is fenced to, the latest committed stable when one exists, and the
 * latest durable terminal verdict when one exists. The three fields live in ONE
 * record because ONE record put is the only atomic durable boundary this
 * storage contract offers (per-table puts are separate whole-document rewrites
 * — see the domain module).
 */
export interface TaskStateRecord {
    /** Session lifecycle identity this record binds. */
    readonly session: TaskStateSessionIdentity;
    /**
     * Latest committed stable for that lifecycle, ABSENT until the Session's
     * first successful commit. A terminal verdict does NOT require one: an
     * impossible window before the first commit is recorded on its own, and no
     * empty authority stable is ever fabricated to carry it.
     */
    readonly stable?: TaskStateStable;
    /**
     * Latest durable terminal verdict, when one was measured. When present, the
     * effective committed cursor is
     * `Math.max(stable?.sourceCursor ?? -1, terminal.cursor)`.
     *
     * A `quarantined` verdict always carries a cursor strictly above the floor it
     * was derived from. A `block…` verdict never advances anything: it records
     * the typed, generation-fenced reason why the pending window must be
     * re-evaluated rather than quarantined.
     */
    readonly terminal?: TaskStateTerminalRecord;
}
/**
 * Exact auxiliary route of one collect-and-merge request. The route and
 * reasoning effort are recorded verbatim so replay reconstructs the exact
 * call.
 */
export interface TaskStateAuxRoute {
    /** Registered provider route. */
    readonly provider: string;
    /** Provider-owned model id. */
    readonly model: string;
    /** Adapter-owned reasoning effort, when one applied. */
    readonly reasoningEffort?: ReasoningEffortId;
}
/** Schema evidence carried by one request. */
export interface TaskStateSchemaEvidence {
    /** Input schema version the framed output must satisfy. */
    readonly version: number;
    /** Dynamic schema material not pinned by `version`, when any was supplied. */
    readonly material?: JsonValue;
}
/** One deterministic, marked truncation applied while projecting. */
export interface TaskStateTruncationRecord {
    /** Field path truncated, e.g. `tool/result` content. */
    readonly path: string;
    /** Explicit UTF-8 byte limit applied to the field. */
    readonly limitBytes: number;
    /** UTF-8 bytes retained after truncation. */
    readonly keptBytes: number;
}
/**
 * Why one batch wave was admitted. The reasons are durable and mutually
 * exclusive so a replay can tell "startup found a backlog" from "a new event
 * crossed the threshold" without re-deriving the schedule:
 *
 * - `startup`: the wave was scheduled once when a Session runtime was first
 *   established (session creation, domain open, or stored-record hydration)
 *   and the projectable eligible backlog above the committed cursor already
 *   met `minEvents` — no new Session event was needed;
 * - `threshold`: an observed eligible event raised the pending count to
 *   `minEvents` (or higher) while no wave was running;
 * - `urgent`: an observed AUTHORITATIVE durable fact (a `goal/change` that
 *   changes the Goal view, or any `todo/write` whole-list fact including the
 *   empty clear) was admitted without waiting for `minEvents`, because the
 *   injected Goal/TODO view would otherwise stay stale for up to a full
 *   threshold window;
 * - `trailing`: the single follow-up wave admitted after a committed
 *   threshold/startup wave for events that arrived while that wave ran;
 * - `manual`: a user-authored stable edit, which never dispatches a model.
 */
export type TaskStateUpdateTrigger = 'startup' | 'threshold' | 'urgent' | 'trailing' | 'manual';
/**
 * The OPEN phase of one auxiliary task-state model request, written durably
 * BEFORE the request is dispatched. It carries an immutable copy of the base
 * stable (or `null`), the exact included eligible event sequences, and the
 * exact model-visible inputs so the call is reconstructable from the audit
 * table without consulting the authoritative sessions table during replay.
 */
export interface TaskStateUpdateRequestData {
    /** Host-minted opaque request id keying this audit row. */
    readonly requestId: TaskStateRequestId;
    /** Target stable revision this request commits on success. */
    readonly revision: number;
    /**
     * Why this wave was admitted. Absent only on rows written before the
     * trigger vocabulary existed; a reader treats an absent value as unknown
     * and must not infer `startup`.
     */
    readonly trigger?: TaskStateUpdateTrigger;
    /** Immutable committed base stable copy, or `null` before the first commit. */
    readonly base: TaskStateStable | null;
    /** Exact eligible Session event sequences folded into this request, ascending. */
    readonly includedSeqs: number[];
    /** Deterministic input-filter version that produced the projection. */
    readonly filterVersion: string;
    /** Exact auxiliary system instruction. */
    readonly system: string;
    /** Exact auxiliary route, including the reasoning effort when present. */
    readonly route: TaskStateAuxRoute;
    /** Exact maximum output tokens for the auxiliary request. */
    readonly maxTokens: number;
    /** Input schema version and any dynamic schema material for this request. */
    readonly schema: TaskStateSchemaEvidence;
    /** Deterministic truncation metadata required to reproduce the framed input. */
    readonly truncation: readonly TaskStateTruncationRecord[];
    /**
     * The inherited fork boundary this request's window was bounded by, present
     * only when the Session lifecycle began on an inherited prefix. It records the
     * same boundary the committed stable carries, so a replayed audit row can tell
     * "folded nothing inherited" apart from "had nothing inherited".
     */
    readonly inherited?: TaskStateInheritedPrefix;
}
/** Failure stages of one task-state update attempt. */
export type TaskStateFailureStage = 'route' | 'request' | 'stream' | 'parse' | 'schema' | 'semantic' | 'storage' | 'audit';
/** Structured, bounded failure facts of one failed update attempt. */
export interface TaskStateFailureFacts {
    /** Failure stage naming where the attempt stopped. */
    readonly stage: TaskStateFailureStage;
    /** Stable machine-routable error code. */
    readonly code: string;
    /** Bounded human-readable diagnostic. */
    readonly message: string;
}
/**
 * The FINISHED phase of one audit row, written durably AFTER the attempt
 * settles. A normal success records the complete `ctx.llm.stream()` call; a
 * normal failure records structured facts with no successful replay marker; a
 * repair certifies a stable already committed before a crash without claiming
 * a stream call or inventing raw output. Exactly one finished phase may follow
 * one open phase per request id.
 */
export type TaskStateUpdateFinishedData = {
    readonly outcome: 'success';
    /** Request id keying the audit row that carries the open phase. */
    readonly requestId: TaskStateRequestId;
    /** Committed stable revision — equals the open phase's target revision. */
    readonly revision: number;
    /** Committed source cursor — the last eligible sequence actually folded. */
    readonly sourceCursor: number;
    /** Marks one complete `ctx.llm.stream()` call. */
    readonly llmStreamCall: true;
    /** Complete untruncated raw output blocks of that call. */
    readonly rawOutput: readonly ContentBlock[];
    /** Provider-reported token usage, when the adapter reported it. */
    readonly usage?: TokenUsage;
    /** Required terminal finish metadata of the successful call. */
    readonly finish: {
        readonly kind: 'stop';
    };
} | {
    readonly outcome: 'failure';
    /** Request id keying the audit row that carries the open phase. */
    readonly requestId: TaskStateRequestId;
    /** Failure stage and bounded diagnostic; no successful replay marker. */
    readonly error: TaskStateFailureFacts;
} | {
    readonly outcome: 'manual';
    readonly requestId: TaskStateRequestId;
    readonly revision: number;
    readonly sourceCursor: number;
    readonly llmStreamCall?: never;
} | {
    readonly outcome: 'repair';
    /** Request id of the repaired update when its open phase is available. */
    readonly requestId?: TaskStateRequestId;
    /** Revision of the stable storage already holds. */
    readonly revision: number;
    /** Source cursor of the stable storage already holds. */
    readonly sourceCursor: number;
    /** A repair never claims another LLM stream call. */
    readonly llmStreamCall?: never;
} | {
    readonly outcome: 'terminal-infeasible';
    /** Request id keying the audit row that carries the open phase. */
    readonly requestId: TaskStateRequestId;
    /** Revision of the base stable the quarantined window was folded against. */
    readonly revision?: number;
    /** Advanced source cursor after quarantine. */
    readonly sourceCursor?: number;
    /** Bounded failure facts describing why the window was infeasible. */
    readonly error: TaskStateFailureFacts;
} | {
    readonly outcome: 'aborted';
    /** Request id keying the audit row that carries the open phase. */
    readonly requestId: TaskStateRequestId;
    /** Optional failure facts describing why the attempt was aborted. */
    readonly error?: TaskStateFailureFacts;
};
/**
 * The content of one committed stable — the Host-normalized counterpart of a
 * {@link TaskStateCandidate}. The auxiliary model proposes optional entry ids;
 * before commit the Host mints a branded id for every new entry and verifies
 * every echoed id exists and is unique.
 */
export interface TaskStateStableContent extends TaskStateContentFields {
    /** Ordered facts, each carrying its Host-minted id. */
    readonly facts: readonly TaskStateStableEntry[];
    /** Ordered decisions, each carrying its Host-minted id. */
    readonly decisions: readonly TaskStateStableEntry[];
    /** Ordered constraints, each carrying its Host-minted id. */
    readonly constraints: readonly TaskStateStableEntry[];
    /** Ordered risks, each carrying its Host-minted id. */
    readonly risks: readonly TaskStateStableEntry[];
    /** Durable continuation state committed with this stable. */
    readonly continuation: TaskStateContinuation;
    /** Host-derived bounded reference to the authoritative TODO list (empty unless `current`). */
    readonly todoReferences: readonly TaskStateTodoReference[];
    /** Host-derived authoritative Goal view. */
    readonly goalView: TaskStateGoalView;
    /** Host-derived authoritative TODO view. */
    readonly todoView: TaskStateTodoView;
}
/** The merge-extended message source kind of one plugin-owned Stable task-state slot. */
export type TaskStateSlotSourceKind = 'task-state-slot';
/** Staleness classification of a Stable task-state slot snapshot. */
export type TaskStateStaleness = 'fresh' | 'stale' | 'blocked';
/**
 * Durable provenance of ONE model-visible Stable task-state slot node.
 *
 * The slot is the plugin's own `user/message` surface node: the prompt consumer
 * CREATES it once per Session lifecycle and REPLACES it in place on every later
 * committed stable revision, so a Session never carries two model-visible task
 * states. Everything the classification, the replay, and a resumed or forked
 * log need to re-identify the node rides this source, never process memory:
 *
 * - {@link slotId} is the constant wire tag of the slot channel (the adoption
 *   key when a plugin remount or a resumed Session must re-find the node);
 * - {@link generation} is strictly increasing across the WHOLE Session log, so
 *   an inherited (fork) or resumed prefix can never produce a lower generation;
 * - {@link coveredSeqs} is the shadowed surface range of a replacement node and
 *   stays empty on the creating node (nothing was shadowed).
 *
 * The source participates in the merge-extensible `MessageSourceMap`, so DSH
 * consumers that do not know this kind degrade to an opaque injected row
 * (`packages/client/ui-chat` renders an unknown kind by its durable kind name)
 * instead of refusing the log.
 */
export interface TaskStateSlotSource {
    /** Merge-extended message source kind of the slot node. */
    readonly kind: TaskStateSlotSourceKind;
    /** Constant slot-channel identity recorded on every slot node. */
    readonly slotId: string;
    /** Logical Session identity the node was written for. */
    readonly sessionId: string;
    /** Epoch ms of the Session lifecycle that wrote this node (`Session.header.createdAt`). */
    readonly lifecycleCreatedAt: number;
    /** 1-based slot generation, strictly increasing across the Session log. */
    readonly generation: number;
    /** Committed stable revision this node presents. */
    readonly revision: number;
    /** Revision the shadowed slot node presented; absent on a creating node. */
    readonly previousRevision?: number;
    /** Generation of the shadowed slot node; absent on a creating node. */
    readonly previousGeneration?: number;
    /** Digest of the committed stable this node presents. */
    readonly digest: string;
    /** The presented stable's durable source cursor (end of its covered window). */
    readonly sourceCursor: number;
    /** Surface seqs this node shadowed, in surface order; empty on a creating node. */
    readonly coveredSeqs: readonly number[];
    /** Highest eligible session event sequence observed when this slot was evaluated. */
    readonly eligibleHighWater?: number;
    /** Staleness verdict of the snapshot: fresh, stale (lagging high-water), or blocked. */
    readonly staleness?: TaskStateStaleness;
    /** Evaluated injection tokens of this slot message under the active estimator. */
    readonly injectionTokens?: number;
    /** Configured or resolved injection token budget I in force. */
    readonly budgetTokens?: number;
    /** True when any non-authoritative content was dropped to fit the budget. */
    readonly truncation?: boolean;
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'task-state-slot': TaskStateSlotSource;
    }
}
//# sourceMappingURL=types.d.ts.map