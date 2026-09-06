#!/usr/bin/env node
/**
 * Materialize this bundle's contextual preset into the desktop discovery root.
 * The desktop launcher owns the final agent-presets roots and does not expose a
 * bundle post-install hook, so this explicit compatibility step is required.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(process.env.DSH_CONTEXT_ENHANCEMENT_PRESET_ROOT ?? join(repoRoot, 'presets', 'contextual'))
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const target = join(home, '.agent-presets', 'contextual')
const force = process.argv.includes('--force')

if (!existsSync(join(source, 'agent.cordis.yml')) || !existsSync(join(source, 'preset.yml'))) {
  throw new Error(`contextual preset source is incomplete: ${source}`)
}
if (existsSync(target) && !force) {
  throw new Error(`target already exists: ${target}; pass --force only to replace it intentionally`)
}
mkdirSync(join(home, '.agent-presets'), { recursive: true })
cpSync(source, target, { recursive: true, force: true, errorOnExist: false })
const metadata = readFileSync(join(target, 'preset.yml'), 'utf8')
writeFileSync(join(target, 'preset.yml'), `${metadata.trimEnd()}\n`)
console.log(`installed contextual preset to ${target}`)
