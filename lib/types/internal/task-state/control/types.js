/**
 * Wire vocabulary of the Host task-state Remote (`ctx.remote.taskState`): the
 * `control` stream carries every live Session's committed state, while `edit`
 * submits revision-checked user replacements.
 *
 * ## Contract
 *
 * Every stream generation opens with EXACTLY ONE `baseline` frame holding a
 * whole-set snapshot, then yields live replacement frames in commit order.
 * Consumers treat a `baseline` as authoritative for the whole set and each
 * later frame as a complete replacement of ONE Session's row, so a reconnect
 * never needs history: open a fresh generation, apply its baseline, and keep
 * applying frames.
 *
 * The three visible row states map to:
 * - a committed stable (`stable` present),
 * - a live Session with no committed stable yet (`stable: null`), and
 * - an absent key (a Session the Host does not currently know — never
 *   announced, already disposed, or not yet created).
 *
 * ## Compatibility
 *
 * This module declares NO `SessionEventMap` member and appends NO Session-log
 * event: the frames are delivered only over the Remote stream carrier and the
 * client keeps its own store. Stream values come from the read-only task-state
 * Service through the minimal {@link TaskStateCommitSource} seam. Manual edits
 * use the separate provider-owned {@link TaskStateEditSource} seam, write the
 * authoritative domain, and publish the resulting committed replacement. No
 * path writes the Session log.
 * @module dsh-context-enhancement/internal/task-state/control/types
 */
export {};
//# sourceMappingURL=types.js.map