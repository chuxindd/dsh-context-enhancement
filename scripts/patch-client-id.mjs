#!/usr/bin/env node
/**
 * Rewrite the build scaffold id out of the generated client artifact, then
 * verify that no published file still carries it.
 *
 * The shared client preset is called with a scaffold package id (see
 * `scripts/client-bundle-ids.mjs`), and that id reaches the output in two
 * places:
 *   - the `__ModuleLoader__.load({ id })` banner, which `tsdown.config.ts`
 *     already stamps with the published id at generation time;
 *   - any inlined CSS style injector (`tag.dataset.plugin`), which lives in the
 *     bundle body and can only be corrected after the emit.
 * So this step rewrites *every* occurrence and then fails closed: an artifact
 * that still mentions the scaffold id, or one that lost the published Loader
 * id, cannot pass the build. Re-running it on an already-correct artifact is a
 * no-op — the step no longer depends on running before any other tsdown pass,
 * it just refuses to let a wrong artifact through.
 *
 * Usage: node scripts/patch-client-id.mjs
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import { PUBLISHED_CLIENT_ID, SCAFFOLD_CLIENT_ID } from './client-bundle-ids.mjs'

const libDir = new URL('../lib/', import.meta.url)
const clientPath = new URL('client.js', libDir)
const loaderId = `id: ${JSON.stringify(PUBLISHED_CLIENT_ID)}`

/** Every file below `dir` whose name ends in one of `suffixes`. */
async function listBySuffix(dir, suffixes) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
    if (entry.isDirectory()) found.push(...await listBySuffix(full, suffixes))
    else if (suffixes.some(suffix => entry.name.endsWith(suffix))) found.push(full)
  }
  return found
}

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

const source = await readFile(clientPath, 'utf8')
const rewritten = countOccurrences(source, SCAFFOLD_CLIENT_ID)
const client = rewritten === 0 ? source : source.replaceAll(SCAFFOLD_CLIENT_ID, PUBLISHED_CLIENT_ID)
if (rewritten > 0) await writeFile(clientPath, client)

if (!client.includes(loaderId)) {
  throw new Error(`lib/client.js does not declare the Loader id ${loaderId}; the client bundle is unidentifiable`)
}
if (client.includes(SCAFFOLD_CLIENT_ID)) {
  throw new Error(`lib/client.js still contains the build scaffold id ${SCAFFOLD_CLIENT_ID}`)
}

const survivors = []
for (const file of await listBySuffix(libDir, ['.js', '.map'])) {
  const text = await readFile(file, 'utf8')
  if (text.includes(SCAFFOLD_CLIENT_ID)) survivors.push(relative(fileURLToPath(libDir), fileURLToPath(file)))
}
if (survivors.length > 0) {
  throw new Error(`build scaffold id ${SCAFFOLD_CLIENT_ID} survives in: ${survivors.join(', ')}`)
}

console.log(`patch:client-id - lib/client.js carries Loader id ${JSON.stringify(PUBLISHED_CLIENT_ID)}`
  + ` (${rewritten} scaffold occurrence(s) rewritten; 0 left anywhere under lib/)`)
