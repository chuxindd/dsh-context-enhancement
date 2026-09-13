#!/usr/bin/env node
/**
 * Artifact identity + parity gate for dsh-context-enhancement (R-P2-9 / B8).
 *
 * Three questions the audit could not answer from a single `lib/` reading, and
 * that this script answers mechanically:
 *   1. identity — does the Loader id stamped into `lib/client.js` equal the
 *      package name the Web host looks up, with no build scaffold id left in
 *      any published byte?
 *   2. parity — does the packed tarball carry exactly the `lib/` files
 *      `package.json#files` publishes, byte for byte, with no orphan chunk that
 *      no entry imports?
 *   3. assembly — which artifact does the host profile actually load
 *      (each `$DSH_HOME/profiles/<name>/package.json` dependency spec), what
 *      identity and hash does the installed copy have, and does it match the
 *      built one?
 *
 * Reports the concrete artifact path and SHA-256 of every one of those copies.
 * Exit code is non-zero when identity or parity fails; a stale host copy is
 * reported, not failed, because installing it is a host-side action
 * (`dsh plugin add`) this script deliberately does not perform.
 *
 * Usage: node scripts/verify-artifact-parity.mjs [--json <report-path>]
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { PUBLISHED_CLIENT_ID, SCAFFOLD_CLIENT_ID } from './client-bundle-ids.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const tarballPath = join(repoRoot, `${manifest.name}-${manifest.version}.tgz`)
const libDir = join(repoRoot, 'lib')

const failures = []
const notes = []
const ok = message => console.log(`ok - ${message}`)
const bad = message => { failures.push(message); console.log(`not ok - ${message}`) }
const note = message => { notes.push(message); console.log(`note - ${message}`) }

/** SHA-256 of a buffer or file path, upper-case hex. */
const sha256 = input => createHash('sha256').update(typeof input === 'string' ? readFileSync(input) : input).digest('hex').toUpperCase()

/** Every file below `dir` as repo-relative POSIX paths. */
function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/**
 * Translate one `package.json#files` entry into a matcher.
 * @param pattern - the raw entry.
 * @returns a regex source plus whether the entry contains glob magic.
 */
function filesGlob(pattern) {
  let source = ''
  let magic = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      magic = true
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') { source += '(?:[^/]+/)*'; index += 2 } else { source += '.*'; index += 1 }
      } else source += '[^/]*'
    } else if (char === '?') {
      magic = true
      source += '[^/]'
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return { source: `^${source}$`, magic }
}

/** The `lib/` files `package.json#files` publishes, repo-relative POSIX paths. */
function publishedLibFiles() {
  const matchers = (manifest.files ?? []).filter(entry => entry === 'lib' || entry.startsWith('lib/')).map(filesGlob)
  if (matchers.length === 0) throw new Error('package.json#files publishes no lib/ entry')
  return walk(libDir)
    .map(rel => `lib/${rel}`)
    .filter(candidate => matchers.some(matcher => (matcher.magic
      ? new RegExp(matcher.source).test(candidate)
      : candidate === matcher.source || candidate.startsWith(`${matcher.source}/`))))
}

/** Read the members of a .tgz as name -> exact content buffer (ustar + GNU/pax paths). */
function readTarball(path) {
  const tar = gunzipSync(readFileSync(path))
  const members = new Map()
  let offset = 0
  let pendingLongName
  let pendingPaxPath
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const cString = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '')
    const prefix = cString(345, 500)
    const size = parseInt(cString(124, 136).trim() || '0', 8) || 0
    const typeFlag = String.fromCharCode(header[156] || 0x30)
    const headerName = prefix === '' ? cString(0, 100) : `${prefix}/${cString(0, 100)}`
    offset += 512
    const body = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (typeFlag === 'L') { pendingLongName = body.toString('utf8').replace(/\0.*$/s, ''); continue }
    if (typeFlag === 'x' || typeFlag === 'g') {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      if (match !== null) pendingPaxPath = match[1]
      continue
    }
    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '') continue
    const name = pendingPaxPath ?? pendingLongName ?? headerName
    pendingPaxPath = undefined
    pendingLongName = undefined
    members.set(name, Buffer.from(body))
  }
  return members
}

/** Loader id stamped into a client bundle, or undefined. */
function loaderIdOf(path) {
  if (!existsSync(path)) return undefined
  const match = /\bid:\s*("(?:[^"\\]|\\.)*")/.exec(readFileSync(path, 'utf8'))
  return match === null ? undefined : JSON.parse(match[1])
}

/** Build scaffold ids surviving anywhere under lib/. */
function scaffoldSurvivors() {
  return walk(libDir)
    .filter(rel => rel.endsWith('.js') || rel.endsWith('.map'))
    .filter(rel => readFileSync(join(libDir, rel), 'utf8').includes(SCAFFOLD_CLIENT_ID))
    .map(rel => `lib/${rel}`)
}

/**
 * `lib/` root chunks that no entry declares in `package.json#files` and no
 * other built file imports: leftovers from an earlier build, never dead code
 * that the current build emitted.
 */
function orphanChunks() {
  const declared = new Set((manifest.files ?? []).filter(entry => entry.startsWith('lib/') && !/[*?]/.test(entry)))
  const rootChunks = walk(libDir).filter(rel => !rel.includes('/') && rel.endsWith('.js'))
  const imported = new Set()
  for (const rel of walk(libDir)) {
    if (!rel.endsWith('.js')) continue
    const text = readFileSync(join(libDir, rel), 'utf8')
    for (const match of text.matchAll(/(?:from|import|require\()\s*["']\.\/([^"']+)["']/g)) imported.add(match[1])
  }
  return rootChunks.filter(rel => !declared.has(`lib/${rel}`) && !imported.has(rel))
}

/** What the host profiles load for this package, with the installed copy's identity and hash. */
function hostAssembly() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profilesDir = join(dshHome, 'profiles')
  const report = { dshHome, profilesDir, profiles: [] }
  if (!existsSync(profilesDir)) {
    report.absent = true
    return report
  }
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const profileDir = join(profilesDir, entry.name)
    const manifestPath = join(profileDir, 'package.json')
    const installed = join(profileDir, 'node_modules', manifest.name)
    const installedClient = join(installed, 'lib', 'client.js')
    const row = {
      profile: entry.name,
      dependsOn: existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies?.[manifest.name] ?? null
        : null,
      installedPath: existsSync(installed) ? installed : null,
      installedLoaderId: loaderIdOf(installedClient),
      installedClientSha256: existsSync(installedClient) ? sha256(installedClient) : null,
      installedClientMtime: existsSync(installedClient) ? statSync(installedClient).mtime.toISOString() : null,
    }
    row.matchesBuiltArtifact = row.installedClientSha256 !== null
      && existsSync(join(libDir, 'client.js'))
      && row.installedClientSha256 === sha256(join(libDir, 'client.js'))
    report.profiles.push(row)
  }
  return report
}

const report = {
  generatedAt: new Date().toISOString(),
  package: { name: manifest.name, version: manifest.version },
  publishedClientId: PUBLISHED_CLIENT_ID,
  scaffoldClientId: SCAFFOLD_CLIENT_ID,
  artifact: { path: tarballPath, exists: existsSync(tarballPath) },
  workspaceClient: { path: join(libDir, 'client.js') },
  failures,
  notes,
}

// 1. Identity.
if (!existsSync(report.workspaceClient.path)) {
  bad('lib/client.js is missing; run the build before verifying')
} else {
  report.workspaceClient.sha256 = sha256(report.workspaceClient.path)
  report.workspaceClient.loaderId = loaderIdOf(report.workspaceClient.path)
  if (report.workspaceClient.loaderId !== PUBLISHED_CLIENT_ID) {
    bad(`lib/client.js Loader id is ${JSON.stringify(report.workspaceClient.loaderId)}, expected ${JSON.stringify(PUBLISHED_CLIENT_ID)}`)
  } else ok(`lib/client.js Loader id is ${JSON.stringify(PUBLISHED_CLIENT_ID)} (sha256 ${report.workspaceClient.sha256.slice(0, 16)}…)`)
  report.scaffoldSurvivors = scaffoldSurvivors()
  if (report.scaffoldSurvivors.length > 0) bad(`build scaffold id survives in ${report.scaffoldSurvivors.join(', ')}`)
  else ok(`no ${SCAFFOLD_CLIENT_ID} bytes under lib/`)
}

// 2. Parity between the packed artifact and the published lib/ set.
const published = publishedLibFiles()
const publishedSet = new Set(published)
report.publishedLib = { count: published.length, files: published }
const unpublished = walk(libDir).map(rel => `lib/${rel}`).filter(rel => !publishedSet.has(rel))
report.unpublishedLib = unpublished
if (unpublished.length > 0) {
  note(`lib/ files outside package.json#files, so deliberately not shipped (${unpublished.length}): ${unpublished.slice(0, 4).join(', ')}${unpublished.length > 4 ? ', …' : ''}`)
}
if (!report.artifact.exists) {
  bad(`tarball ${tarballPath} is missing; run \`npm pack\` after the build`)
} else {
  report.artifact.bytes = statSync(tarballPath).size
  report.artifact.sha256 = sha256(tarballPath)
  const members = readTarball(tarballPath)
  report.artifact.memberCount = members.size
  const packedLib = [...members.keys()].filter(name => name.startsWith('package/lib/')).map(name => name.slice('package/'.length))
  report.artifact.packedLibCount = packedLib.length
  const packedSet = new Set(packedLib)
  const missing = published.filter(rel => !packedSet.has(rel))
  const extra = packedLib.filter(rel => !publishedSet.has(rel))
  if (missing.length > 0) bad(`tarball is missing published lib files: ${missing.join(', ')}`)
  if (extra.length > 0) bad(`tarball carries unpublished lib files: ${extra.join(', ')}`)
  const differing = []
  for (const rel of published) {
    const member = members.get(`package/${rel}`)
    if (member === undefined) continue
    if (!member.equals(readFileSync(join(repoRoot, rel)))) differing.push(rel)
  }
  if (differing.length > 0) bad(`tarball bytes differ from the workspace build: ${differing.join(', ')}`)
  if (missing.length === 0 && extra.length === 0 && differing.length === 0) {
    ok(`tarball carries all ${published.length} published lib/ files byte-for-byte (${members.size} members total)`)
  }
  const packedManifest = members.get('package/package.json')
  if (packedManifest === undefined) bad('tarball has no package/package.json')
  else {
    const packed = JSON.parse(packedManifest.toString('utf8'))
    if (packed.name !== manifest.name || packed.version !== manifest.version) {
      bad(`tarball manifest is ${packed.name}@${packed.version}, workspace is ${manifest.name}@${manifest.version}`)
    } else ok(`tarball manifest is ${packed.name}@${packed.version}`)
  }
  const packedClient = members.get('package/lib/client.js')
  if (packedClient !== undefined) {
    const id = /\bid:\s*("(?:[^"\\]|\\.)*")/.exec(packedClient.toString('utf8'))
    if (id === null || JSON.parse(id[1]) !== PUBLISHED_CLIENT_ID) bad('packed lib/client.js has the wrong Loader id')
    else ok(`packed lib/client.js Loader id is ${JSON.stringify(PUBLISHED_CLIENT_ID)}`)
    if (packedClient.includes(SCAFFOLD_CLIENT_ID)) bad('packed lib/client.js still contains the build scaffold id')
  }
}

// 3. No orphan chunk can reach the artifact.
report.orphanChunks = orphanChunks()
if (report.orphanChunks.length > 0) {
  bad(`lib/ carries orphan chunks no entry imports: ${report.orphanChunks.join(', ')}; rebuild with scripts/clean-lib.mjs`)
} else ok('every lib/ root chunk is either a declared entry or imported by a built file')

// 4. Host assembly, reported (never mutated here).
report.hostAssembly = hostAssembly()
if (report.hostAssembly.absent === true) {
  note(`no DSH profiles directory at ${report.hostAssembly.profilesDir}; host assembly not observable`)
} else {
  for (const row of report.hostAssembly.profiles) {
    if (row.installedPath === null) {
      note(`profile ${row.profile}: ${manifest.name} is not installed (dependsOn ${JSON.stringify(row.dependsOn)})`)
      continue
    }
    note(`profile ${row.profile}: loads ${row.installedPath} (Loader id ${JSON.stringify(row.installedLoaderId)}, sha256 ${String(row.installedClientSha256).slice(0, 16)}…, `
      + `${row.matchesBuiltArtifact ? 'matches' : 'DIFFERS from'} the workspace build)`)
    if (row.matchesBuiltArtifact !== true) {
      note(`profile ${row.profile}: installed copy is stale; reinstall it with \`dsh plugin add\` against ${tarballPath} before trusting its runtime bytes`)
    }
  }
}

const jsonIndex = process.argv.indexOf('--json')
if (jsonIndex !== -1 && process.argv[jsonIndex + 1] !== undefined) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.argv[jsonIndex + 1], `${JSON.stringify(report, null, 2)}\n`)
  console.log(`note - json report written to ${process.argv[jsonIndex + 1]}`)
}

console.log(failures.length === 0
  ? `\nartifact parity verified: ${manifest.name}@${manifest.version}, ${published.length} published lib/ files`
  : `\n${failures.length} artifact parity failure(s)`)
if (failures.length > 0) process.exitCode = 1
