#!/usr/bin/env node
/**
 * B8 evidence helper: print a SHA-256 manifest of the distribution-critical
 * files (lib/**, the tarball, and the build/patch inputs) as JSON on stdout.
 *
 * Usage: node hash-manifest.mjs <label>
 * This is an evidence-only tool; it never writes into the repository.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const files = []
const libDir = join(repoRoot, 'lib')
if (existsSync(libDir)) files.push(...walk(libDir))

for (const rel of [
  'dsh-context-enhancement-0.1.10.tgz',
  'package.json',
  'tsdown.config.ts',
  'tsconfig.build.json',
  'tsconfig.json',
  'vitest.config.ts',
  'cordis.patch.yml',
  'scripts/patch-client-id.mjs',
]) {
  const full = join(repoRoot, rel)
  if (existsSync(full)) files.push(full)
}

const presetDir = join(repoRoot, 'presets')
if (existsSync(presetDir)) files.push(...walk(presetDir))

const entries = files
  .map(full => ({
    path: relative(repoRoot, full).split(sep).join('/'),
    bytes: statSync(full).size,
    sha256: createHash('sha256').update(readFileSync(full)).digest('hex').toUpperCase(),
    mtime: statSync(full).mtime.toISOString(),
  }))
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

process.stdout.write(`${JSON.stringify({
  label: process.argv[2] ?? 'unlabeled',
  repoRoot,
  fileCount: entries.length,
  files: entries,
}, null, 2)}\n`)
