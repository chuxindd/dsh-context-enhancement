#!/usr/bin/env node
/**
 * Pre-release checks for dsh-context-enhancement.
 *
 * Runs from a clean checkout and verifies everything a GitHub/tag install
 * depends on, without touching the registry:
 *   - no `workspace:*` ranges anywhere in the manifest;
 *   - every peer is pinned to the exact rc.1 deployment versions;
 *   - every `exports` target and every patch/preset path exists in the
 *     committed tree (a tag install has no prepare/postinstall build);
 *   - `cordis.patch.yml` parses as the include patch dialect;
 *   - the packed tarball contains the Loader-imported runtime entries, the
 *     patch, and the shipped preset.
 *
 * The final "ship" gate (a real isolated-profile install and preset mount)
 * lives in the verification scripts, not here: this is the fast mechanical
 * check that runs before tagging.
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const ok = (msg) => console.log(`ok - ${msg}`)
const bad = (msg) => { failures.push(msg); console.log(`not ok - ${msg}`) }

/** Parse JSON, recording a failure instead of throwing. */
function loadJson(rel) {
  const abs = join(root, rel)
  if (!existsSync(abs)) { bad(`missing ${rel}`); return undefined }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'))
  } catch (error) {
    bad(`${rel} is not valid JSON: ${error.message}`)
    return undefined
  }
}

/** Recursively list files below `dir`, absolute paths. */
function readDirRecursive(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    const abs = join(dir, entry)
    let st
    try { st = statSync(abs) } catch { continue }
    if (st.isDirectory()) out.push(...readDirRecursive(abs))
    else out.push(abs)
  }
  return out
}

const pkg = loadJson('package.json')
if (pkg) {
  ok('package.json parses')
  if (pkg.name !== 'dsh-context-enhancement') bad(`package name is ${pkg.name}`)
  if (pkg.version !== '0.1.10') bad(`package version is ${pkg.version}`)
  if (pkg.type !== 'module') bad('package.type must be module')
  if (!pkg.dsh?.bundle?.patch) bad('package is missing dsh.bundle.patch')
  if (pkg.repository?.url !== 'git+https://github.com/chuxindd/dsh-context-enhancement.git') bad('package.repository.url is missing or incorrect')
  if (pkg.homepage !== 'https://github.com/chuxindd/dsh-context-enhancement#readme') bad('package.homepage is missing or incorrect')

  // 1. No workspace:* anywhere (a GitHub checkout has no sibling workspaces).
  const allRanges = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies }
  const workspace = Object.entries(allRanges).filter(([, range]) => String(range).includes('workspace:'))
  if (workspace.length) bad(`workspace:* ranges present: ${workspace.map(([n, r]) => `${n}@${r}`).join(', ')}`)
  else ok('no workspace:* ranges in the manifest')

  // 2. Exact rc.1 deployment pins for every peer.
  const peers = pkg.peerDependencies ?? {}
  const expected = {
    '@deepseek-ai/cordis': '4.0.2',
    '@deepseek-ai/schemastery': '3.18.2',
    '@deepseek-ai/dsh-agent': '0.1.2-rc.1',
    '@deepseek-ai/dsh-brand': '0.1.2-rc.1',
    '@deepseek-ai/dsh-commands': '0.1.2-rc.1',
    '@deepseek-ai/dsh-compaction': '0.1.2-rc.1',
    '@deepseek-ai/dsh-llm': '0.1.2-rc.1',
    '@deepseek-ai/dsh-session': '0.1.2-rc.1',
    '@deepseek-ai/dsh-storage-domain': '0.1.2-rc.1',
    '@deepseek-ai/dsh-system-prompt': '0.1.2-rc.1',
    '@deepseek-ai/dsh-timeout': '0.1.2-rc.1',
    '@deepseek-ai/dsh-token-meter': '0.1.2-rc.1',
    '@deepseek-ai/dsh-util-values': '0.1.2-rc.1',
  }
  let peerProblems = 0
  for (const [name, range] of Object.entries(expected)) {
    if (peers[name] === undefined) { bad(`peer ${name} missing from peerDependencies`); peerProblems += 1 }
    else if (peers[name] !== range) { bad(`peer ${name} is ${peers[name]}, expected exact ${range}`); peerProblems += 1 }
  }
  // Official providers this bundle re-implements must NOT be declared peers.
  for (const forbidden of ['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction-tool-result-pruner']) {
    if (peers[forbidden] !== undefined) bad(`peer ${forbidden} must not be declared (only referenced in provenance)`)
  }
  if (peerProblems === 0) ok('every expected peer is pinned to the exact rc.1 deployment version')

  // 3. No built entry imports an official package's unshipped src subpath.
  const libFiles = readDirRecursive(join(root, 'lib'))
  const srcImport = libFiles.filter(file => file.endsWith('.js'))
    .flatMap(file => {
      const content = readFileSync(file, 'utf8')
      const re = /from\s+["'](@deepseek-ai\/dsh-[^"']*\/src\/[^"']+)["']/g
      const found = []
      let m
      while ((m = re.exec(content))) found.push(`${file}: ${m[1]}`)
      return found
    })
  if (srcImport.length) bad(`built runtime imports @deepseek-ai/*/src/*: ${srcImport.join(', ')}`)
  else ok('no @deepseek-ai/*/src/* imports in the built runtime')

  // 4. exports targets exist.
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target === 'string') {
      if (!existsSync(join(root, target))) bad(`export ${subpath} -> ${target} is missing`)
      continue
    }
    for (const file of Object.values(target)) {
      if (!existsSync(join(root, file))) bad(`export ${subpath} -> ${file} is missing`)
    }
  }
  ok('every exports target exists')

  // 5. sideEffects must cover every Loader-imported service entry.
  const sideEffects = Array.isArray(pkg.sideEffects) ? pkg.sideEffects : []
  for (const entry of ['task-state', 'task-state-basic', 'task-state-prompt', 'compaction-basic', 'tool-result-pruner']) {
    if (!sideEffects.some(glob => glob.includes(`${entry}.js`))) {
      bad(`sideEffects does not list ./lib/${entry}.js`)
    }
  }
  ok('sideEffects covers every Loader-imported service entry')
}

// 6. The bundle patch parses with the include plugin's own YAML dialect.
try {
  const patch = load(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(patch)) bad('cordis.patch.yml is not a top-level list')
  else ok('cordis.patch.yml parses with the include YAML dialect')
} catch (error) {
  bad(`cordis.patch.yml does not parse: ${error.message}`)
}

// 7. The shipped preset parses with the same dialect.
try {
  const rows = load(readFileSync(join(root, 'presets/contextual/agent.cordis.yml'), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(rows)) bad('presets/contextual/agent.cordis.yml is not a top-level list')
  else ok('presets/contextual/agent.cordis.yml parses with the include YAML dialect')
} catch (error) {
  bad(`presets/contextual/agent.cordis.yml does not parse: ${error.message}`)
}

// 8. npm pack contents: the tarball must carry lib entries, patch, preset.
// The sandbox forbids capturing a child's piped stdout, so the child writes
// straight into a pre-opened file descriptor (not a pipe) and the parent reads
// that file afterwards.
const packDir = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
const reportFile = join(packDir, 'pack.json')
const outFd = openSync(reportFile, 'w')
// npm ships as a .cmd shim on Windows, which spawnSync cannot exec directly;
// route through the shell so stdout lands in the pre-opened descriptor.
const pack = spawnSync(
  process.platform === 'win32' ? 'cmd' : 'sh',
  process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm pack --dry-run --json`]
    : ['-c', 'npm pack --dry-run --json'],
  {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', outFd, 'ignore'],
    shell: false,
  },
)
closeSync(outFd)
let packReport
try { packReport = JSON.parse(readFileSync(reportFile, 'utf8')) } catch { /* reported below */ }
try { rmSync(packDir, { recursive: true, force: true }) } catch { /* best-effort */ }
if (pack.error !== undefined) {
  bad(`npm pack --dry-run failed: ${pack.error.message}`)
} else if (packReport === undefined) {
  bad('npm pack --dry-run produced no readable JSON report')
} else {
  const files = (packReport[0]?.files ?? []).map(f => f.path)
  const required = [
    'lib/index.js', 'lib/task-state.js', 'lib/task-state-basic.js',
    'lib/task-state-prompt.js', 'lib/compaction-basic.js', 'lib/tool-result-pruner.js',
    'lib/types/index.d.ts', 'cordis.patch.yml',
    'presets/contextual/agent.cordis.yml', 'presets/contextual/preset.yml',
    'scripts/install-desktop-preset.mjs', 'CONTRIBUTING.md',
  ]
  for (const req of required) {
    if (!files.includes(req)) bad(`packed tarball is missing ${req}`)
  }
  const stray = files.filter(f => f.includes('node_modules') || f.endsWith('.tsbuildinfo'))
  if (stray.length) bad(`packed tarball carries stray files: ${stray.join(', ')}`)
  else ok('packed tarball contains every Loader-imported entry, patch, and preset')
}

if (failures.length) {
  console.error(`\n${failures.length} release-check failure(s)`)
  process.exitCode = 1
} else {
  console.log('\nall release checks passed')
}
