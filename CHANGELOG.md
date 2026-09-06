# Changelog

All notable changes to `dsh-context-enhancement` are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.6] - 2026-09-06

### Changed

- Ordinary 80% pressure compaction now remeasures and repartitions after every successful forget batch, continuing beyond the former two-batch cap while token pressure keeps decreasing.
- `maxPressureBatches` now acts only as the per-zone emergency overflow budget; normal 70% maintenance remains bounded by `maxMaintenanceBatches`.
- Tool-group summarization now allows one durable retry after a transient failure, then releases terminal failures and deterministic fallbacks to ordinary history compaction instead of permanently blocking the forget zone.

### Fixed

- Added explicit pressure-stop diagnostics for unavailable forget ranges, unsafe boundaries, oversized oldest units, re-entry/tool-stage deferral, no progress, and convergence guards.
- Isolated tool-summary audit provenance by exact Session lifecycle, counted only completed turns for re-entry, kept mismatched compaction-end markers from releasing the durable lock, and prevented overflow from skipping a protected zone with candidates remaining.
- Corrected the Enhanced features panel so request participation is not presented as successful task-state work.

## [0.1.5] - 2026-09-06

### Added

- Added positional three-zone compaction: recent (0-20% of routed capacity), tool (20-50%), and forget (>50%) zones with tool-pair and step-safe boundaries.
- Added bounded oldest-first forget batches, source-provenance classification, re-entry protection for history summaries, and pure three-zone regression coverage.

### Changed

- Split automatic maintenance into 40% tool maintenance, 70% one forget batch, and 80% pressure convergence with fresh measurement and zone partitioning after every replacement.
- Restricted deterministic pruning to explicit original tool-result candidates; tool summaries are excluded through replacement provenance rather than generated text.
- Changed overflow recovery order to original large results, forget zone, tool zone, then recent zone. Legacy `thresholdRatio`, `retainRatio`, and `retainTokens` remain supported with explicit conflict errors for ambiguous new-field combinations.


## [0.1.3] - 2026-05-28

### Changed

- Packaged the enhanced tool-group summarization pipeline, audit persistence, surface-safe replacement flow, and deterministic fallback behavior.
- Added a desktop compatibility installer for materializing the `contextual` preset into `$DSH_HOME/.agent-presets` when the Desktop launcher replaces bundle preset roots.

## [0.1.2] - 2026-05-28

### Changed

- Reworked the contextual-session header action into a compact system-style **Enhanced features** button.
- Replaced implementation-facing labels with user-facing descriptions and separated enabled state from per-session trigger counts.
- Added responsive panel sizing, an explicit close control, Escape handling, and improved dialog accessibility metadata.

## [0.1.4] - 2026-09-06

### Added

- Added complete user installation, local development, extension, contribution, and maintainer release documentation in English and Chinese.
- Added `CONTRIBUTING.md` with compatibility constraints, test expectations, build-output policy, and pull request requirements.
- Included the Desktop preset installer in the published package.
- Initial internal tool-group summarization pipeline: conservative group selection, source-validated structured summaries, per-result replacements, fingerprint/audit helpers, and deterministic-pruner fallback.
- Optional `toolGroupSummarizer` compaction configuration and independent summary audit domain.
- **Profile Bundle packaging.** `dsh-context-enhancement` is a single root
  npm package that is also a DSH Profile Bundle (`dsh.bundle.patch` →
  `cordis.patch.yml`). Release tags commit built `lib/`, so a pinned GitHub
  install needs no `prepare`/`postinstall` build.
- **`./task-state`** — read-only durable task-state Service Definition
  (`ctx.taskState`): durable value schemas, branded request/entry ids, and the
  storage-domain audit vocabulary. Declares no `SessionEventMap` members, so
  unloading the bundle never makes an old Session log unreadable by rc.1 code.
- **`./task-state-basic`** — the durable provider: owns the authoritative
  `context_enhancement_task_state` single-layout storage domain (`sessions` +
  `audit` tables), publishes lifecycle-fenced committed pointers, runs the
  versioned input filter, schedules per-Session background collect-and-merge
  batches through independent `ctx.llm` calls, validates model output, commits
  through `storageDomain.put`, and repairs open audit rows after a crash
  without rerunning a model.
- **`./task-state-prompt`** — `systemPrompt` consumer registering the fixed
  `{{task_state_snapshot}}` runtime-context template and a synchronous variable
  provider over the committed stable pointer.
- **`./compaction-basic`** — region-aware replacement for the official rc.1
  `@deepseek-ai/dsh-compaction-basic` provider: retention-aware older-head
  pruning, prune/remeasure/early-stop pressure ordering, the recursive
  empty-benefit guard on an isolated old-summary head, and overflow
  opt-out that re-compacts an isolated checkpoint as the last deterministic
  reduction. Consumes the official published `@deepseek-ai/dsh-compaction`
  Service Definition (never `src/*`).
- **`./tool-result-pruner`** — replay-safe, model-free tool-result pruning
  service providing the official `toolResultPruner` service identity, plus the
  region-aware `olderRange` three-state option and the experimental text-only
  `hardLimitChars` bound.
- **`presets/contextual`** — an agent preset copied from the rc.1 `standard`
  preset, adding the `task-state-prompt` row and pointing the compaction group
  at this bundle's replacement providers. `command-compact` stays the official
  row.
- **`cordis.patch.yml`** — host-plane `task-state-basic` insertion with an
  explicit deployment config, and a web-profile `agent-presets` patch making
  `contextual` the default while keeping the shipped and user preset roots plus
  this bundle's shipped preset root discoverable.
- **Storage audit table** — one row per auxiliary request (request id, base
  revision/cursor, included seqs, route/schema/truncation/system, complete
  raw output on success, failure and repair facts) with pure derivation
  helpers (`deriveAuditTimeline`, `highestCertifiedRevision`,
  `selectRepairRow`, `rowsForLifecycle`) so a replay helper can regenerate the
  canonical auxiliary stream without touching the official llm-replay package.
- **Verification assets** — loader-composition and standing-mount tests,
  keyless fake-adapter 30+ tool-heavy turn scenarios, storage restart and
  repair tests, `scripts/release-check.mjs`, and `THIRD_PARTY_NOTICES.md`.

### Changed

- Rewrote the `contextual` preset description to state that it is based on `standard`, identify the added task-state behavior and optimized default compaction, and describe suitable workloads.
- Added GitHub repository, homepage, issue tracker, and author metadata for `chuxindd`.
- Replaced placeholder installation URLs with the versioned `chuxindd/dsh-context-enhancement` release path.
- `sideEffects` is a per-entry allowlist (never `false`): every Loader-imported
  service entry keeps its registration side effects under tree-shaking.
- Built runtime entries are committed under `lib/` (mirroring official rc.1
  layout: tsc owns `lib/types/**`, tsdown owns one self-contained
  `lib/<entry>.js` per public subpath).
- Peers pinned to the rc.1 deployment versions (`@deepseek-ai/dsh-*` exactly
  `0.1.2-rc.1`, `@deepseek-ai/cordis` exactly `4.0.2`,
  `@deepseek-ai/schemastery` exactly `3.18.2`). `zod` is a plain dependency.
  No `workspace:*` ranges anywhere.

### Fixed

- `GenerateOptions.purpose` in rc.1 is a closed `'compaction' | 'session-title'`
  union; the task-state auxiliary call now types its own purpose through
  `Omit<GenerateOptions, 'purpose'>` and casts once at the stream boundary.

### Security / Compatibility

- No DSH `@deepseek-ai/dsh-*` `src/*` subpath is imported at runtime; where
  behavior must be replaced it is copied under `src/internal/` with provenance
  headers.
- Uninstalling the bundle restores the official compaction rows: the patch
  only inserts host `task-state-basic` and (on the web profile) repoints the
  preset default; it never disables an official host row.

### Known limitations

- The bundle targets the DSH **web profile** (`dsh --profile web`). Profiles
  whose composition lacks the `agent-presets` roster row still receive the
  host `task-state-basic` provider but gain no `contextual` preset and no
  default change.
- Task state is an opt-in host overlay: `task-state-basic` must be mounted
  with a reachable `storage-domain`, `sessions`, and `llm` host service and a
  configured provider/model route; the provider disables loudly when its
  authoritative domain cannot open.
- Compaction and task-state auxiliary calls require the deployment's own LLM
  route; keyless tests use scripted adapters only.
