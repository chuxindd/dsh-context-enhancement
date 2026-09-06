# dsh-context-enhancement

`dsh-context-enhancement` is a context-enhancement plugin tailored for DeepSeek Harness (DSH). It manages context within a single long-running session and provides tool-result distillation, forget-zone compaction, and an independent session checkpoint.

> Current version: `0.1.6`. Compatible with DeepSeek Harness `0.1.2-rc.1`.
> This project is still in testing. The code was developed with GPT-5.6 Sol, and feedback is welcome.

## How It Works

A coding Agent may perform dozens or hundreds of tool calls during a long-running task. Keeping the complete history in the main context creates several hard constraints:

* The context window is finite. Tool output, code excerpts, and error logs will eventually fill it and must be compacted or discarded.
* As input grows, useful constraints are increasingly diluted by low-value tool output, making it harder for the main Agent to decide what to do next.
* The model has difficulty distinguishing the current working state, historical facts, and work that has already been completed.
* A single compaction near exhaustion receives an oversized input and can easily lose both low-level detail and the overall structure.

Long-running tasks also need a continuously updated task summary that records established facts, decisions, and important context.

Alongside common TODO orchestration, long-running Goal verification, and other state-loop mechanisms, this plugin manages long-session memory through two parallel paths: main-thread zoned compaction and an independent checkpoint side path.

#### 2.1 Main-Thread Compaction Path

As new conversation content is added, older main-thread content moves through three non-overlapping zones:

```text
Oldest                                                     Newest
+------------------+------------------------+------------------+
| Forget zone      | Tool compaction zone   | Recent zone      |
|                  |                        |                  |
| Operation 3      | Operations 1 and 2     | Original content |
| Batched semantic | Tool distillation or   | preserved in full|
| compaction       | deterministic pruning  | Active work state|
+------------------+------------------------+------------------+
```

Every piece of content follows the same lifecycle:

```text
Original content in the recent zone
    | ages as new content is added
    v
Tool compaction zone
    | tool results are distilled or pruned
    | user messages, assistant responses, and tool notes
    | continue participating in later conversation
    | and can be corrected by the user, model judgment,
    | or evidence from later tool calls
    v
Forget zone
    | oldest-first bounded batches undergo semantic compaction
    v
Forget summary
```

Tool distillation, tool-result pruning, and forget-zone compaction are three independent operations.

#### 2.2 Checkpoint Side Path

An independent task-state service reads the main-thread event stream and continuously updates one checkpoint in the background.

```text
Main-thread event stream
    |
    +-- Independent checkpoint service
          +-- Reads events after the previous committed position
          +-- Merges them with the previous stable state
          +-- Validates and commits a new stable revision
```

The checkpoint uses its own model request, input budget, output budget, timeout, and retry policy. The main Agent always reads the latest successfully committed stable revision. Background updates and failures never block the main task.

## Changes from `standard`

The `contextual` preset preserves the coding tools, planning, subagents, and workflows provided by `standard`. It changes only task continuity and context management.

| Capability | `standard` | `contextual` |
| --- | --- | --- |
| Coding Agent and tools | Fully included | Fully preserved |
| Task state | Depends on the current conversation | Automatically extracts and persists task facts, decisions, constraints, risks, and next steps |
| Recovery after service restart | No independent state | Loads committed state directly from storage without another model call |
| Older tool output | Handled by the default compactor | Reduced before semantic history compaction |
| Long-session compaction | Default DSH implementation | Preserves recent work first, then compacts older history |

In Web sessions, the **Enhanced features** action in the session header shows four runtime capabilities: task progress memory, request context synchronization, tool-result cleanup, and long-conversation cleanup. The panel reports status; detailed events remain available in Trajectory.

## Installation

### Requirements

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `0.1.2-rc.1`
- A configured DSH model provider
- Web installations use `dsh --profile web`

### Install from a GitHub Release

Install a fixed tag so later commits do not change the deployed version:

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.6'
dsh --profile web
```

Open `http://127.0.0.1:8080`, create a session, and select **上下文增强**. The plugin preserves the shipped `standard`, `minimal`, `ptc`, and `cordis` modes while registering `contextual` as the default.

### Install from a Local Checkout

Use this method for development, debugging, or before a GitHub Release exists:

```powershell
git clone https://github.com/chuxindd/dsh-context-enhancement.git
cd dsh-context-enhancement
pnpm install
pnpm run build
npm pack
dsh plugin --profile web add "file:$PWD/dsh-context-enhancement-0.1.6.tgz"
dsh --profile web
```

On Windows PowerShell, pass the absolute tarball path if the DSH CLI does not accept the relative path containing `/`.

### Desktop Compatibility Step

The Desktop launcher rebuilds Agent preset discovery roots. After installing the Bundle, materialize the `contextual` preset in the user directory by running the following command from this repository or an extracted source directory:

```powershell
pnpm run install:desktop-preset
```

The default target is `%DSH_HOME%\.agent-presets\contextual`, or `%USERPROFILE%\.dsh\.agent-presets\contextual` when `DSH_HOME` is unset. The script refuses to overwrite an existing preset. To replace it intentionally, run:

```powershell
pnpm run install:desktop-preset -- --force
```

## Usage and Verification

1. Start the Web profile and open or create a session.
2. Select **上下文增强** in the Agent picker.
3. Work normally; task-state updates and context management run automatically.
4. Open **Enhanced features** in the session header to inspect enabled capabilities and their trigger counts for the current session.
5. Open Trajectory to inspect detailed compaction and pruning events.

Task state updates asynchronously after its event threshold is reached. A new session may report that an effect has not triggered yet even though the capability is enabled.

## Configuration

The Bundle defaults are defined in `cordis.patch.yml` and can be overridden through profile or home patch layers. A patch replaces the entire `config` object, so provide every required field rather than only changed values.

### Task-State Provider

| Field | Default | Purpose |
| --- | ---: | --- |
| `provider` / `model` | `deepseek-official` / `deepseek-v4-flash` | Model route used for background task-state updates |
| `minEvents` | `20` | Minimum number of events after the committed position before an update starts automatically |
| `maxEvents` | `200` | Maximum number of events processed by one update |
| `maxInputBytes` | `60000` | UTF-8 input budget for one structured update |
| `maxOutputTokens` | `4000` | Output limit for one background generation |
| `timeoutMs` | `120000` | Request timeout |
| `maxInfraRetries` | `2` | Additional retries for transient infrastructure failures |
| `maxEntriesPerKind` | `50` | Limit for each facts, decisions, constraints, and risks collection |
| `maxEntryBytes` | `4000` | Byte limit for one state entry |
| `maxListItems` | `40` | Item limit for one list field |

`task-state-prompt.maxBytes` defaults to `8000` and limits the task state injected into a model request.

### Context Compaction

`contextual` retains the official DSH configuration fields, including `thresholdRatio`, `retainRatio`, `retainTokens`, `summarizationProvider`, `summarizationModel`, `maxTokens`, `compactionRetries`, `maxOverflowRetries`, `modelPolicies`, and `auto`.

Tool-output reduction uses `thresholdChars`, `headChars`, and `tailChars`. Inspect real sessions in Trajectory before changing these thresholds. Lower thresholds increase processing frequency, while retaining too little output can remove details needed for debugging.

## Data, Upgrades, and Removal

Task state is stored at:

```text
$DSH_HOME/storages/context_enhancement_task_state.json
```

Ordinary Sessions remain under `$DSH_HOME/sessions`. Uninstalling the plugin does not delete either location.

Upgrade:

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.6'
```

Roll back to the previous version:

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.3'
```

Uninstall:

```powershell
dsh plugin --profile web remove dsh-context-enhancement
```

Restart the profile after every installation, upgrade, rollback, or removal. Removing the Bundle clears the `contextual` default override and restores the official compaction composition, but it does not delete task-state data or Session logs.

## Local Development

```powershell
git clone https://github.com/chuxindd/dsh-context-enhancement.git
cd dsh-context-enhancement
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Built files under `lib/` are committed because installation from a GitHub tag does not run `prepare` or `postinstall`. After modifying `src/`, run `pnpm run build` and commit the corresponding `lib/` changes.

Common commands:

| Command | Purpose |
| --- | --- |
| `pnpm run typecheck` | Strictly check source and test types |
| `pnpm test` | Run the Vitest test suite |
| `pnpm run test:watch` | Continuously run tests during development |
| `pnpm run build` | Generate `lib/types` and runtime entries |
| `pnpm run release:check` | Validate dependencies, exports, patches, presets, and package contents |
| `pnpm run verify:install` | Install the tarball into an isolated DSH home and verify preset mounting |

## Extending the Project

Primary entry points:

| Goal | Entry points |
| --- | --- |
| Change the task-state schema or service contract | `src/task-state.ts`, `src/internal/task-state/` |
| Change task-state collection, validation, or commit behavior | `src/task-state-basic.ts`, `src/internal/task-state/basic/` |
| Change the state injected into model requests | `src/task-state-prompt.ts` |
| Change compaction selection or execution | `src/compaction-basic.ts`, `src/internal/compaction/` |
| Change tool-output reduction | `src/tool-result-pruner.ts` |
| Change the Web status panel | `src/client/`, `src/effect-projection.ts` |
| Change Agent composition | `presets/contextual/agent.cordis.yml` |
| Change Profile installation behavior | `cordis.patch.yml` |

Development constraints:

- Do not add DSH `SessionEventMap` events for task state. The audit data lives in a separate storage domain so official code can still read old Session logs after the plugin is removed.
- Persistent-schema changes require a compatibility or migration plan and tests covering restart, damaged data, and older data.
- Compaction changes should cover tool-call pairing, selection boundaries, zero-benefit behavior, overflow, and deterministic fallback.
- Client changes require synchronized locales, projection tests, and `lib/client.js`.
- DSH-derived code under `src/internal/` must preserve provenance and MIT attribution.

## Contributing

Issues: <https://github.com/chuxindd/dsh-context-enhancement/issues>

Before opening a Pull Request:

1. Work on a focused branch without unrelated formatting or generated-file churn.
2. Add or update tests for behavioral changes.
3. Run `pnpm run typecheck`, `pnpm test`, `pnpm run build`, and `pnpm run release:check`.
4. Commit source files and the corresponding `lib/` build output.
5. Explain the problem, implementation choice, compatibility impact, and manual verification.
6. State upgrade and rollback implications when changing persistent data, Agent composition, or compaction semantics.

See `CONTRIBUTING.md` for the complete contribution workflow.

## Maintainer Release Process

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run release:check
npm pack
pnpm run verify:install -- .\dsh-context-enhancement-0.1.6.tgz
```

After all checks pass, commit the version changes, create the `v0.1.6` tag, and attach the matching tarball to the GitHub Release.

## Compatibility Notes

- The current release is compatible specifically with DSH `0.1.2-rc.1`; a DSH upgrade requires a newly verified plugin release.
- Runtime code does not import unpublished `@deepseek-ai/dsh-*` `src/*` subpaths.
- A headless profile, or one without an `agent-presets` roster, receives only the host-side task-state provider and does not change its default Agent preset.

## License

MIT.
