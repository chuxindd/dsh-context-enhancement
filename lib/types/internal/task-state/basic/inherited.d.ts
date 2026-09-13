/**
 * The inherited fork boundary of one Session lifecycle, and the coverage fence
 * that keeps a forked child from re-claiming its parent's facts.
 *
 * DSH seeds a forked child with the parent's prefix. Those events are durable
 * HISTORY of the child: they are already part of the state the child inherited,
 * they were never observed by the child's own lifecycle, and folding them again
 * would report the parent's eligible events as new live facts of the child.
 *
 * The durable boundary is `Session.inheritedEventCount` — the length of the seed
 * the child was created with, restored from the persisted `seedLength` header
 * field. `Session.firstLiveSeq` is NOT a substitute: it is the in-process
 * constructor seed length, so it equals the inherited count on a fresh fork and
 * the WHOLE stored log length after a resume. This module therefore reads the
 * boundary from `inheritedEventCount` alone.
 *
 * Two rules follow, and both are fail-closed:
 *
 * 1. A coverage claim below the boundary is impossible. The effective committed
 *    cursor is `max(stored cursor, ownBoundarySeq - 1)`, so a record written
 *    before this boundary existed (or damaged to claim coverage inside the
 *    prefix) can never make the next window fold an inherited event.
 * 2. A coverage claim whose recorded marker DISAGREES with the live boundary is
 *    refused wholesale: the lifecycle re-derives from its own events above the
 *    boundary instead of trusting a claim it cannot verify. The record's
 *    content is still served — refusing a claim is not losing state — but its
 *    provenance is not trusted for coverage.
 *
 * For every lifecycle that did not begin on an inherited prefix
 * (`inheritedEventCount === 0`, which is every Session that was not forked) both
 * rules are identity: the floor is `-1` and no marker can exist, so behavior is
 * exactly what it was before the boundary contract existed.
 * @module dsh-context-enhancement/internal/task-state/basic/inherited
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { TaskStateInheritedPrefix } from '../contract/index.ts';
/**
 * Read one Session's inherited fork boundary, or `null` when its lifecycle began
 * on its own events.
 *
 * The boundary is the durable seeding length. An unseeded Session reports `0`,
 * which is not a boundary but the absence of one: its own first event is seq 0,
 * so there is nothing to exclude.
 * @param session - live Session whose durable seeding length is read.
 * @returns the inherited prefix record, or `null` for an unseeded lifecycle.
 */
export declare function sessionInheritedPrefix(session: Session): TaskStateInheritedPrefix | null;
/**
 * The lowest cursor one lifecycle may hold: its own boundary minus one.
 *
 * A lifecycle with no inherited prefix floors at `-1`, which is the same
 * "nothing folded yet" value the provider used before this contract.
 * @param prefix - the Session's inherited prefix, or `null`.
 * @returns the inclusive cursor floor for every coverage claim of that lifecycle.
 */
export declare function inheritedCursorFloor(prefix: TaskStateInheritedPrefix | null): number;
/**
 * Whether one recorded coverage claim must be REFUSED because its inherited
 * marker disagrees with the live boundary.
 *
 * An absent marker is not a disagreement: it only means the record predates the
 * marker (or the lifecycle is unseeded), and rule 1's floor already bounds it.
 * A marker that names a different boundary, a different source, or a non-empty
 * prefix on a lifecycle that has none is a claim this lifecycle cannot verify,
 * and it is refused rather than merged.
 * @param prefix - the LIVE inherited prefix of the Session, or `null`.
 * @param marker - the inherited marker recorded on the stored coverage claim.
 * @returns true when the claim's coverage provenance must not be trusted.
 */
export declare function inheritedCoverageRefused(prefix: TaskStateInheritedPrefix | null, marker: TaskStateInheritedPrefix | undefined): boolean;
/**
 * Whether one sequence belongs to the inherited prefix of a lifecycle, i.e. it
 * is one of the parent's facts rather than one of this lifecycle's own events.
 * @param prefix - the Session's inherited prefix, or `null`.
 * @param seq - the Session sequence to classify.
 * @returns true when the sequence is inherited.
 */
export declare function isInheritedSeq(prefix: TaskStateInheritedPrefix | null, seq: number): boolean;
//# sourceMappingURL=inherited.d.ts.map