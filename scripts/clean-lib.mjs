#!/usr/bin/env node
/**
 * Deterministic pre-build clean for the generated `lib/` half.
 *
 * Why this exists: `lib/` is committed and packed, and the shared client preset
 * builds with `clean: false` (both halves share one output dir), so a rebuild
 * never removes chunks that an earlier build emitted. Those orphans are dead
 * weight in the published artifact, and a stale chunk sharing a chunk's role
 * with the live one makes "which file does the host actually execute" — the
 * exact question behind R-P2-9 — unanswerable from the artifact alone.
 *
 * Removing the whole generated half before `tsc` + `tsdown` makes the shipped
 * set exactly the current build's output. `tsc` re-emits every `lib/types`
 * declaration (the incremental cache lives under `lib/types` too, so it is
 * rebuilt from scratch) and `tsdown` re-emits `lib/*.js`.
 *
 * Usage: node scripts/clean-lib.mjs
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const libDir = new URL('../lib/', import.meta.url)

/** Recursively count files below `dir`. */
function countFiles(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
    total += entry.isDirectory() ? countFiles(full) : 1
  }
  return total
}

if (!existsSync(libDir)) {
  console.log('clean:lib - lib/ is absent, nothing to remove')
} else {
  const before = countFiles(libDir)
  const rootJs = readdirSync(libDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js')).length
  rmSync(libDir, { recursive: true, force: true })
  console.log(`clean:lib - removed ${before} generated file(s) (${rootJs} lib root .js) from ${fileURLToPath(libDir)}`)
  console.log('clean:lib - tsc and tsdown re-emit the whole generated half; run them next, not tsdown alone')
}
