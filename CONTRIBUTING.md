# Contributing to dsh-context-enhancement

Thanks for contributing. This project changes persistent task state and conversation
compaction, so behavioral compatibility matters as much as passing unit tests.

## Development setup

Requirements:

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- A DeepSeek Harness `0.1.2-rc.1` installation for profile-level verification

```powershell
git clone https://github.com/chuxindd/dsh-context-enhancement.git
cd dsh-context-enhancement
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

## Repository model

The root package is both an npm package and a DSH Profile Bundle.

- `cordis.patch.yml` installs the host task-state provider and registers `contextual`.
- `presets/contextual/agent.cordis.yml` starts from the DSH `standard` composition,
  injects task state, and selects this project's compaction implementation.
- `src/task-state*.ts` and `src/internal/task-state/` implement durable task state.
- `src/compaction-basic.ts`, `src/tool-result-pruner.ts`, and
  `src/internal/compaction/` implement context management.
- `src/client/` and `src/effect-projection.ts` implement the Web status surface.
- `lib/` contains committed build output used directly by GitHub tag installs.

Read `README.md` or `README.zh.md` before changing the composition or persistent data.

## Making changes

Create a focused branch and keep unrelated formatting or generated-file changes out of
the pull request.

### Persistent task state

When changing schemas, collection, validation, or commit behavior:

- preserve committed-state authority across restart;
- document compatibility with existing storage;
- never silently rewrite or delete damaged data;
- keep audit data in the task-state storage domain rather than adding Session events;
- add tests for restart, retries, stale work, lifecycle fencing, and malformed data.

### Compaction and tool-output reduction

When changing selection or replacement behavior:

- preserve tool-call and tool-result pairing;
- keep source references and replay boundaries valid;
- cover empty-benefit and overflow behavior;
- retain deterministic fallback when summarization is unavailable or invalid;
- test recent-context retention and older-range boundaries.

### Client and preset changes

- Keep Chinese and English locale keys synchronized.
- Keep user-facing copy focused on observable behavior; implementation names belong in
  Trajectory or architecture documentation.
- Rebuild `lib/client.js` after client changes.
- Validate that `contextual` mounts without waiting rows or duplicate providers.
- Update both READMEs when installation or visible behavior changes.

### DSH-derived code

Code adapted from DSH lives under `src/internal/`. Keep its provenance header and update
`THIRD_PARTY_NOTICES.md` when importing additional upstream material. Do not import
unpublished `@deepseek-ai/dsh-*` `src/*` paths at runtime.

## Required checks

Run these before every pull request:

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run release:check
```

When changing package composition, the preset, installation, or runtime dependencies,
also build and verify the tarball:

```powershell
npm pack
pnpm run verify:install -- .\dsh-context-enhancement-0.1.4.tgz
```

`verify:install` uses a temporary `DSH_HOME`, installs the package into a fresh Web
profile, checks preset discovery, and validates the standing mount. It requires a local
DSH `0.1.2-rc.1` deployment.

## Build output

This repository intentionally commits `lib/`. GitHub tag installation does not run a
build script. After changing `src/`:

1. Run `pnpm run build`.
2. Review both source and generated changes.
3. Commit the matching `lib/` output in the same pull request.

Do not manually edit generated files in `lib/`.

## Pull requests

A pull request should include:

- the problem and expected behavior;
- the implementation approach and alternatives considered;
- tests added or updated;
- commands run and their results;
- compatibility impact on storage, Session logs, presets, and DSH versions;
- upgrade and rollback notes when behavior or persistent data changes;
- screenshots for visible Web changes.

Small fixes do not need a prior issue. For storage format, public exports, preset
composition, or major compaction changes, open an issue first so the compatibility
contract can be agreed before implementation.

## Commit scope

Use clear, imperative commit messages. One commit may contain source, tests,
documentation, and generated `lib/` output for one coherent change. Avoid bundling
unrelated refactors with behavioral changes.

## Reporting issues

Open an issue at:

<https://github.com/chuxindd/dsh-context-enhancement/issues>

Include the plugin version, DSH version, profile type, relevant configuration, expected
and observed behavior, and a minimal trajectory or log excerpt with secrets removed.
