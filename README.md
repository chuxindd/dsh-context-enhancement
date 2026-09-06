# dsh-context-enhancement

`dsh-context-enhancement` is a context-management plugin for DeepSeek Harness (DSH),
listed under the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic. It builds on the `standard` agent preset, adds task state that survives turns and
restarts, and replaces the default compaction implementation. Long sessions retain
recent work and key decisions while older tool output is reduced earlier.

It is intended for multi-step, long-running, tool-heavy development tasks and work
that must continue after an interruption.

> Current version: `0.1.4`. Compatible with DeepSeek Harness `0.1.2-rc.1`.

[中文文档](./README.zh.md)

## Changes from standard

The `contextual` preset keeps the coding tools, planning, subagents, and workflows
from `standard`. It changes only task continuity and context management.

| Capability | `standard` | `contextual` |
| --- | --- | --- |
| Coding agent and tools | Included | Preserved |
| Task state | Depends on conversation history | Extracted and persisted automatically |
| Recovery after restart | No separate task state | Loads committed state without rebuilding it through an LLM call |
| Older tool output | Handled by default compaction | Reduced before semantic compaction |
| Long-session compaction | DSH default implementation | Keeps recent work at higher fidelity before summarizing older history |

In Web sessions, the **Enhanced features** header action reports four runtime effects:
task progress memory, request context sync, tool-result cleanup, and long-conversation
cleanup. The panel reports status; detailed events remain available in Trajectory.

## Installation

### Requirements

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `0.1.2-rc.1`
- A configured DSH model provider
- The Web installation uses `dsh --profile web`

### Install from a GitHub release

Pin a tag so later repository changes do not alter the deployment:

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.4'
dsh --profile web
```

Open `http://127.0.0.1:8080`, create a session, and select **上下文增强**.
The plugin preserves the other shipped presets and registers `contextual` as the
default preset.

### Install from a local checkout

Use this path for development or before a GitHub release exists:

```powershell
git clone https://github.com/chuxindd/dsh-context-enhancement.git
cd dsh-context-enhancement
pnpm install
pnpm run build
npm pack
dsh plugin --profile web add "file:$PWD/dsh-context-enhancement-0.1.4.tgz"
dsh --profile web
```

Pass an absolute tarball path if the DSH CLI does not accept the relative path on
Windows.

### Desktop compatibility step

The Desktop launcher rebuilds the agent-preset discovery roots. After installing the
bundle, materialize `contextual` into the user preset directory:

```powershell
pnpm run install:desktop-preset
```

The default target is `%DSH_HOME%\.agent-presets\contextual`, or
`%USERPROFILE%\.dsh\.agent-presets\contextual` when `DSH_HOME` is unset. The script
refuses to replace an existing preset. Replace it intentionally with:

```powershell
pnpm run install:desktop-preset -- --force
```

## Usage and verification

1. Start the Web profile and open or create a session.
2. Select **上下文增强** in the agent picker.
3. Work normally; task-state updates and context management are automatic.
4. Open **Enhanced features** in the session header to inspect enabled state and trigger counts.
5. Open Trajectory to inspect detailed pruning and compaction events.

Task state updates asynchronously after its event threshold is reached. A new session
may report that an effect has not triggered yet even though the feature is enabled.

## How it works

This bundle manages long sessions through two parallel paths:

1. **The main-thread compaction path** changes the Session surface used by the next model request and progressively reduces the granularity of older content.
2. **The checkpoint side path** collects task progress independently and makes the latest committed task state available to later model requests without blocking the main task on state maintenance.

### 1. Main-thread compaction path

The compaction flow does not wait until the context window is exhausted and then perform one indiscriminate summary. It applies increasingly stronger operations:

```text
Current Session surface
      |
      +-- Recent tail: preserve the current working context
      +-- Tool-group summaries: replace older complete tool groups with sourced notes
      +-- Deterministic pruning: reduce oversized older tool results
      +-- Semantic compaction: summarize older balanced history if pressure remains
```

#### Recent-tail protection

`compaction-basic` derives the retained tail from the routed model's context capacity and retention settings. Recent user messages, assistant actions, and tool results are not semantically summarized during ordinary pressure compaction. Tool-group selection is limited to the older range outside that tail.

Every boundary is checked by current Session-surface position rather than by assuming numeric sequence order. Tool calls and results must remain complete and balanced within their step or segment. A candidate that would cut through the middle of a tool segment is skipped.

#### Tool-group summarization

When the older range contains a qualifying sequence of complete tool activity, `tool-group-summarizer`:

- treats a complete tool segment as one group;
- filters groups by result count, result characters, estimated tokens, per-group token limits, and the maximum groups per pass;
- makes one structured JSON model call per selected group with `purpose: compaction`;
- requires coverage of every source sequence and call id;
- accepts only facts, paths, identifiers, errors, and unresolved items grounded in the source input;
- validates the schema and source coverage before appending one replacement for each original tool/result node;
- preserves message metadata and records `sourceEventSeqs` so the replacement remains traceable to its source events.

Before committing, the engine rechecks the Session lifecycle, surface generation, and source nodes. Route, stream, empty-output, JSON, schema, or source-validation failures do not block the turn. They are audited as fallback/failure and the deterministic pruner continues the reduction.

Tool-group audit records live in the independent `context_enhancement_tool_group_summary` storage domain. Records use `open`, `success`, `fallback`, and `failure` states together with a fingerprint and content digest. A successful fingerprint skips duplicate model work; an unfinished open record reuses its request id after recovery.

#### Deterministic pruning

After tool-group processing, `tool-result-pruner` remeasures the current surface and recomputes the older range. It reduces only older tool results outside the retained tail while preserving replay boundaries and useful head/tail structure. Summarization preserves structured meaning; pruning is the predictable size-reduction fallback. Neither operation deletes the original Session events: both use surface replacement or shadowing for subsequent model requests.

#### Semantic compaction

If tool-group summarization and deterministic pruning do not bring the request below the routed model threshold, `compaction-basic` selects an older history range that satisfies tool-pairing and step-boundary guards, invokes the compatible semantic compaction backend, and measures the result again. Retries are bounded. If no safe range exists or the pressure cannot converge, the engine reports the failure instead of cutting an unbalanced tool chain.

Context-overflow recovery is a separate emergency path: it performs whole-surface deterministic pruning first and then chooses a compaction range that can advance the surface for the current request.

### 2. Checkpoint side path

`task-state-basic` consumes Session events in the background. Once its configured event threshold is reached, it makes an independent model request for a structured candidate state. Size, schema, count, and semantic checks run before the candidate is committed as the stable state for that Session lifecycle.

`task-state-prompt` reads the latest committed stable state before later model requests and injects it within the configured `maxBytes` limit. Before a stable state exists, it injects nothing. A failed background update leaves the previous stable state in place and does not block the main task.

The durable state contains confirmed facts, decisions, constraints, risks, evidence references, TODO references, continuation information, source cursor, revision, and digest.

| Dimension | Main-thread compaction | Checkpoint side path |
| --- | --- | --- |
| Purpose | Control request size and historical noise | Preserve durable task context |
| Changes the Session surface | Yes, through replacement/shadowing | No, it writes to an independent storage domain |
| Deletes original events | No | No |
| Failure behavior | Deterministic fallback or bounded compaction failure | Keep the previous stable state and continue the task |
| Main implementation | `compaction-basic`, `tool-group-*`, `tool-result-pruner` | `task-state-basic`, `task-state-prompt` |

Task-state and tool-group audit data are stored outside the Session event vocabulary. The bundle does not add `SessionEventMap` event types, so ordinary Session logs remain readable when the plugin is unloaded or an official preset is selected again.

The `contextual` preset mounts this bundle's task-state and compaction components. The `standard` preset continues to use the official DSH compaction implementation. Removing the bundle restores the official composition without deleting stored task state or Session logs.

## Configuration

Defaults live in `cordis.patch.yml` and can be replaced through a profile or home patch.
A patch replaces the entire `config` object, so provide every required field.

### Task-state provider

| Field | Default | Purpose |
| --- | ---: | --- |
| `provider` / `model` | `deepseek-official` / `deepseek-v4-flash` | Model route for background state updates |
| `minEvents` | `20` | Eligible events required to start an update |
| `maxEvents` | `200` | Maximum events processed by one update |
| `maxInputBytes` | `60000` | UTF-8 input budget for one update |
| `maxOutputTokens` | `4000` | Background generation limit |
| `timeoutMs` | `120000` | Request deadline |
| `maxInfraRetries` | `2` | Additional retries for transient infrastructure failures |
| `maxEntriesPerKind` | `50` | Limit for each facts/decisions/constraints/risks collection |
| `maxEntryBytes` | `4000` | Limit for one state entry |
| `maxListItems` | `40` | Limit for one list field |

`task-state-prompt.maxBytes` defaults to `8000` and bounds the state injected into a
model request.

### Compaction

`contextual` retains the official configuration vocabulary, including
`thresholdRatio`, `retainRatio`, `retainTokens`, `summarizationProvider`,
`summarizationModel`, `maxTokens`, `compactionRetries`, `maxOverflowRetries`,
`modelPolicies`, and `auto`.

Tool-output reduction uses `thresholdChars`, `headChars`, and `tailChars`. Inspect real
sessions in Trajectory before lowering these values. Aggressive thresholds increase
processing frequency and may remove output needed for debugging.

## Data, upgrades, and removal

Task state is stored at:

```text
$DSH_HOME/storages/context_enhancement_task_state.json
```

Ordinary sessions remain under `$DSH_HOME/sessions`. Uninstalling the plugin does not
delete either location.

Upgrade:

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.4'
```

Roll back:

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.3'
```

Uninstall:

```powershell
dsh plugin --profile web remove dsh-context-enhancement
```

Restart the profile after every install, upgrade, rollback, or removal. Removal clears
the `contextual` default override and restores official compaction, but retains task
state and Session logs.

## Local development

```powershell
git clone https://github.com/chuxindd/dsh-context-enhancement.git
cd dsh-context-enhancement
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Built files under `lib/` are committed because installation from a GitHub tag does not
run `prepare` or `postinstall`. After changing `src/`, run the build and commit the
corresponding `lib/` changes.

| Command | Purpose |
| --- | --- |
| `pnpm run typecheck` | Strictly check sources and tests |
| `pnpm test` | Run the Vitest suite |
| `pnpm run test:watch` | Run tests continuously during development |
| `pnpm run build` | Generate declarations and runtime entries under `lib/` |
| `pnpm run release:check` | Validate dependencies, exports, patch, preset, and package contents |
| `pnpm run verify:install` | Install the tarball into an isolated DSH home and mount the preset |

## Extending the project

| Change | Primary entry points |
| --- | --- |
| Task-state schema or service contract | `src/task-state.ts`, `src/internal/task-state/` |
| Collection, validation, or commit behavior | `src/task-state-basic.ts`, `src/internal/task-state/basic/` |
| State rendered into model requests | `src/task-state-prompt.ts` |
| Compaction selection or execution | `src/compaction-basic.ts`, `src/internal/compaction/` |
| Tool-output reduction | `src/tool-result-pruner.ts` |
| Web status panel | `src/client/`, `src/effect-projection.ts` |
| Agent composition | `presets/contextual/agent.cordis.yml` |
| Profile installation behavior | `cordis.patch.yml` |

Development constraints:

- Do not add DSH `SessionEventMap` events for task state. Its separate storage-domain
  audit keeps old Session logs readable after the plugin is removed.
- Persistent-schema changes require a compatibility or migration plan and tests for
  restart, damaged data, and older data.
- Compaction changes should cover tool-call pairing, selection boundaries, zero-benefit
  behavior, overflow, and deterministic fallback.
- Client changes require synchronized locales, projection coverage, and `lib/client.js`.
- DSH-derived code in `src/internal/` must retain provenance and MIT attribution.

## Contributing

Issues: <https://github.com/chuxindd/dsh-context-enhancement/issues>

Before opening a pull request:

1. Work on a focused branch without unrelated formatting or generated-file churn.
2. Add or update tests for behavioral changes.
3. Run `pnpm run typecheck`, `pnpm test`, `pnpm run build`, and `pnpm run release:check`.
4. Commit source files and their corresponding `lib/` output.
5. Explain the problem, implementation choice, compatibility impact, and manual verification.
6. State upgrade and rollback implications when changing storage, agent composition, or compaction semantics.

See `CONTRIBUTING.md` for the full contribution workflow.

## Maintainer release process

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run release:check
npm pack
pnpm run verify:install -- .\dsh-context-enhancement-0.1.4.tgz
```

After all checks pass, commit the version change, create tag `v0.1.4`, and attach the
matching tarball to the GitHub release.

## Compatibility notes

- The current release is pinned to DSH `0.1.2-rc.1`; a DSH upgrade requires a newly
  verified plugin release.
- Runtime code never imports unpublished `@deepseek-ai/dsh-*` `src/*` subpaths.
- Some official compaction behavior is adapted under `src/internal/` under the MIT
  license; see `THIRD_PARTY_NOTICES.md`.
- A headless profile without the `agent-presets` roster receives only the host-side
  task-state provider and does not change its default agent preset.

## License

MIT. Portions are adapted from DeepSeek Harness under the MIT license. See
`THIRD_PARTY_NOTICES.md`.
