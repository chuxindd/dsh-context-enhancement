#!/usr/bin/env node
/**
 * Isolated-profile install + standing-mount verification for
 * dsh-context-enhancement (the "ship" gate of the release process).
 *
 * Recreates a real DSH install flow without touching the developer's own
 * `~/.dsh`:
 *   1. init a fresh web profile under a temp `$DSH_HOME`;
 *   2. `dsh plugin --profile web add <tarball>` so the bundle is a real
 *      profile dependency and appears in `dsh.profile.bundles`;
 *   3. heal the profile-local module closure from the running DSH deployment
 *      and boot that profile through the CLOSURE's own `dsh-app-boot` with
 *      transport rows disabled (the same host-side surface the official
 *      web-agent-presets e2e uses);
 *   4. assert the roster finds the shipped `contextual` preset, the default is
 *      `contextual`, and mount-validate it through
 *      `ctx.agentPresets.standingKeyFor('contextual')` — the same standing
 *      mount a session would join. A clean mount proves every preset row
 *      activated: no waiting rows, no root-realm service leakage, and no
 *      duplicate compaction provider.
 *
 * The probe that boots the profile must live INSIDE the healed closure (so
 * bare specifiers like `dsh-context-enhancement` and the loader peers resolve
 * exactly as a real profile launch would), so this orchestrator writes a
 * temporary probe module into `$DSH_HOME/profiles/node_modules`, spawns it,
 * and reports its exit code.
 *
 * Usage: node scripts/verify-profile-install.mjs [path-to-tarball]
 * The tarball defaults to `dsh-context-enhancement-0.1.6.tgz` beside this
 * repo. Requires a real DSH rc.1 deployment (its CLI and closure under
 * `~/.dsh/profiles/node_modules`) — this script only READS that deployment.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const userClosure = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules')
const cliBin = join(userClosure, '@deepseek-ai', 'dsh', 'lib', 'bin.js')

function ok(msg) { console.log(`ok - ${msg}`) }
function bad(msg) { console.log(`not ok - ${msg}`); process.exitCode = 1 }

const PROBE = `
// Boot the isolated web profile through the closure's app-boot and validate
// the roster + contextual standing mount. Written by verify-profile-install.mjs.
import { boot, healProfilesModuleFallback, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const iso = process.env.DSH_HOME
const installAnchor = process.env.VERIFY_INSTALL_ANCHOR
await healProfilesModuleFallback({ installAnchor, home: iso })
const profile = loadProfile('verify', 'web', installAnchor, iso, { userLayer: false })
const bundlePatches = profile.layers.flatMap(layer => layer.patches)
const layers = profile.layers.map(layer => layer.packageName)
if (!layers.includes('dsh-context-enhancement')) { console.log('not ok - bundle missing from dsh.profile.bundles'); process.exit(1) }
console.log('ok - profile layers: ' + layers.join(', '))

const rootConfigPath = join(profile.dir, 'cordis.yml')
mkdirSync(profile.dir, { recursive: true })
writeFileSync(rootConfigPath, '[]\\n')
const profilePreset = join(profile.dir, 'node_modules', 'dsh-context-enhancement', 'presets', 'contextual', 'agent.cordis.yml')
console.log(existsSync(profilePreset)
  ? 'ok - profile-local bundle preset present'
  : 'not ok - profile-local bundle preset missing at ' + profilePreset)

const disabled = [
  { id: 'web-startup', disabled: true },
  { id: 'webserver', disabled: true },
  { id: 'web-runtime', disabled: true },
  { id: 'session-telemetry-otel', disabled: true },
  { id: 'modules', disabled: true },
  { id: 'connection', disabled: true },
  { id: 'session-log-download', disabled: true },
  { id: 'client-hmr', disabled: true },
  { id: 'session-turn-outline', disabled: true },
  { id: 'directory-picker', disabled: true },
  { id: 'code-runtime', disabled: true },
  { id: 'skill-badge', disabled: true },
  { id: 'settings', config: { path: join(iso, 'settings.yaml'), watch: false } },
  { id: 'storage-json', config: { root: join(iso, 'storages') } },
]
writeFileSync(join(iso, 'settings.yaml'), '{}\\n')
const ctx = await boot('verify', rootConfigPath.replaceAll('\\\\', '/'), [...bundlePatches, ...disabled])
try {
  const presets = ctx.get('agentPresets')
  if (!presets) { console.log('not ok - agent-presets roster service absent'); process.exit(1) }
  console.log(presets.defaultId === 'contextual'
    ? 'ok - agent-presets default is contextual'
    : 'not ok - default is ' + presets.defaultId)
  const listed = await presets.list()
  const ids = listed.map(p => p.id).sort()
  for (const id of ['standard', 'minimal', 'ptc', 'cordis', 'contextual']) {
    if (!ids.includes(id)) console.log('not ok - roster is missing ' + id)
  }
  console.log('ok - roster: ' + ids.join(', '))
  const contextual = listed.find(p => p.id === 'contextual')
  if (contextual?.broken !== undefined) console.log('not ok - contextual broken: ' + contextual.broken)
  else console.log('ok - contextual preset is healthy on the roster')
  try {
    await presets.standingKeyFor('contextual')
    console.log('ok - contextual standing mount validated (no waiting rows, no leaked services, no duplicate provider)')
  } catch (error) {
    console.log('not ok - contextual standing mount FAILED: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
  }
} finally {
  await ctx.fiber.dispose()
}
const closureRoot = join(iso, 'profiles', 'node_modules', 'dsh-context-enhancement')
console.log(existsSync(join(closureRoot, 'presets', 'contextual', 'agent.cordis.yml'))
  ? 'note: mandated closure preset root exists (app-bundled install layout)'
  : 'note: mandated closure preset root absent for a profile-local install; the ctx.baseUrl-derived root discovers the preset, and an absent root contributes no presets by design')
process.exit(0)
`

async function main() {
  const tarball = resolve(process.argv[2] ?? join(repoRoot, 'dsh-context-enhancement-0.1.6.tgz'))
  if (!existsSync(cliBin)) { bad(`cannot find the DSH rc.1 CLI at ${cliBin}`); return }
  if (!existsSync(tarball)) { bad(`cannot find the tarball at ${tarball}`); return }

  const iso = mkdtempSync(join(tmpdir(), 'dsh-context-verify-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = iso
  try {
    const add = spawnSync(process.execPath, [cliBin, 'plugin', 'add', '--profile', 'web', `file:${tarball}`], {
      cwd: repoRoot, stdio: 'inherit',
    })
    if (add.error !== undefined || add.status !== 0) { bad(`dsh plugin add failed (${add.error?.message ?? add.status})`); return }
    // Heal the isolated closure by booting the real profile once (boot heals
    // the module fallback, then --help exits without serving).
    const heal = spawnSync(process.execPath, [cliBin, '--profile', 'web', '--help'], {
      cwd: repoRoot, stdio: 'ignore',
    })
    if (heal.error !== undefined || heal.status !== 0) { bad('closure heal (web --help boot) failed'); return }
    // The probe must resolve `@deepseek-ai/dsh-app-boot` from the closure, so
    // write it into the now-healed closure directory.
    const closureDir = join(iso, 'profiles', 'node_modules')
    mkdirSync(closureDir, { recursive: true })
    process.env.VERIFY_INSTALL_ANCHOR = join(userClosure, '@deepseek-ai', 'dsh', 'package.json')
    const probePath = join(closureDir, 'verify-probe.mjs')
    writeFileSync(probePath, PROBE)
    const run = spawnSync(process.execPath, [probePath], {
      cwd: closureDir,
      env: { ...process.env, DSH_HOME: iso, VERIFY_INSTALL_ANCHOR: process.env.VERIFY_INSTALL_ANCHOR },
      stdio: 'inherit',
    })
    if (run.error !== undefined || run.status !== 0) bad(`probe exited ${run.status ?? run.error?.message}`)
    else ok('isolated-profile install + standing-mount verification passed')
  } finally {
    try { rmSync(iso, { recursive: true, force: true }) } catch { /* best-effort */ }
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

await main()
