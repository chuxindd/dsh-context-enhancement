import { describe as vitestDescribe, it as vitestIt } from 'vitest'
import { describe as nodeDescribe, it as nodeIt } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'

const __dirname = dirname(fileURLToPath(import.meta.url))

type TestFn = (name: string, fn: () => void | Promise<void>) => void
// Support both Vitest runner and direct node:test execution
const isVitest = Boolean(process.env.VITEST)
const describe: TestFn = isVitest ? (vitestDescribe as unknown as TestFn) : (nodeDescribe as unknown as TestFn)
const it: TestFn = isVitest ? (vitestIt as unknown as TestFn) : (nodeIt as unknown as TestFn)

/** Helper to extract all files from a .tgz archive buffer */
function extractTarball(tarGzBuffer: Buffer): Map<string, string> {
  const tarBuf = gunzipSync(tarGzBuffer)
  const files = new Map<string, string>()
  let offset = 0
  while (offset < tarBuf.length - 512) {
    const header = tarBuf.subarray(offset, offset + 512)
    if (header.every(b => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '')
    const sizeOctal = header.subarray(124, 136).toString('utf8').trim().replace(/\0+$/, '')
    const size = parseInt(sizeOctal, 8) || 0
    offset += 512
    const content = tarBuf.subarray(offset, offset + size).toString('utf8')
    offset += Math.ceil(size / 512) * 512
    if (name) {
      files.set(name, content)
    }
  }
  return files
}

/** Every file below `dir`, as paths relative to `base` with `/` separators. */
function walkFiles(dir: string, base: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

describe('Artifact Parity (lib/ and dsh-context-enhancement-0.1.11.tgz vs src)', () => {
  const rootDir = resolve(__dirname, '..')
  const tarballPath = resolve(rootDir, 'dsh-context-enhancement-0.1.11.tgz')

  it('verifies generated lib/ files and tarball exist on disk', () => {
    assert.ok(existsSync(tarballPath), 'tarball dsh-context-enhancement-0.1.11.tgz must exist')
    assert.ok(existsSync(resolve(rootDir, 'lib/index.js')), 'lib/index.js must exist')
    assert.ok(existsSync(resolve(rootDir, 'lib/compaction-basic.js')), 'lib/compaction-basic.js must exist')
    assert.ok(existsSync(resolve(rootDir, 'lib/tool-result-pruner.js')), 'lib/tool-result-pruner.js must exist')
    assert.ok(existsSync(resolve(rootDir, 'lib/client.js')), 'lib/client.js must exist')
    assert.ok(existsSync(resolve(rootDir, 'lib/types/index.d.ts')), 'lib/types/index.d.ts must exist')
  })

  it('verifies ToolResultPruner runtime behavior in lib/tool-result-pruner.js', async () => {
    // @ts-expect-error lib is excluded from tsconfig root types
    const prunerModule: any = await import('../lib/tool-result-pruner.js')
    const { ToolResultPruner } = prunerModule
    assert.ok(ToolResultPruner, 'ToolResultPruner class must be exported')

    const ctx = new Context()
    const pruner = new ToolResultPruner(ctx, {
      thresholdChars: 100,
      headChars: 10,
      tailChars: 10,
    })

    // 1. Whole-message Unicode code-point measurement and empty guard
    assert.equal(pruner.measureMessageText([]), 0, 'empty content array must measure 0')
    assert.equal(pruner.measureMessageText([{ type: 'text', text: 'abc' }]), 3)
    // Surrogate pair emoji counts as 1 code point
    assert.equal(pruner.measureMessageText([{ type: 'text', text: '🍎' }]), 1)
    // Multi-block nested tool-result measurement
    const multiBlock = [
      { type: 'tool-result', content: [{ type: 'text', text: 'hello' }] },
      { type: 'text', text: ' world' },
    ]
    assert.equal(pruner.measureMessageText(multiBlock), 11, 'measures across all nested/sibling text blocks')

    // 2. Empty-content guard and non-text guard on pruneContent
    assert.equal(pruner.pruneContent([]), null, 'empty content array never reduces')
    assert.equal(
      pruner.pruneContent([{ type: 'image', data: 'placeholder' }]),
      null,
      'non-text content never reduces',
    )

    // 3. Preserves rich/non-text blocks when reducing
    const longText = 'A'.repeat(200)
    const richInput = [
      { type: 'text', text: longText },
      { type: 'image', data: 'preserve_me' },
    ]
    const pruned = pruner.pruneContent(richInput)
    assert.ok(pruned !== null, 'pruned content must not be null')
    assert.equal(pruned.length, 2, 'both text and image block must survive')
    assert.equal(pruned[0]?.type, 'text')
    assert.equal(pruned[1]?.type, 'image')
    assert.equal((pruned[1] as { data: string }).data, 'preserve_me', 'image payload must be preserved untouched')
  })

  it('verifies BasicCompactionEngine runtime exports and schema in lib/compaction-basic.js', async () => {
    // @ts-expect-error lib is excluded from tsconfig root types
    const compactionModule: any = await import('../lib/compaction-basic.js')
    const BasicCompaction = compactionModule.default
    assert.ok(BasicCompaction, 'default BasicCompactionEngine must be exported')

    // 1. Config schema check: no envelopeBudget config switch, toolGroupSummarizer.maxGroupsPerPass present
    const configDict = (BasicCompaction.Config as unknown as { dict: Record<string, unknown> }).dict
    assert.ok(configDict, 'Config dict must exist')
    assert.equal(configDict['envelopeBudget'], undefined, 'must NOT contain envelopeBudget switch')

    const summarizerConfig = (configDict['toolGroupSummarizer'] as unknown as { dict?: Record<string, unknown> })?.dict
    assert.ok(summarizerConfig, 'toolGroupSummarizer config must exist')
    assert.ok(summarizerConfig['maxGroupsPerPass'], 'maxGroupsPerPass must be in schema')

    // 2. Prototype methods: tri-state debt and unified planner
    const proto = BasicCompaction.prototype as Record<string, unknown>
    assert.equal(typeof proto['hasPendingToolIntermediateWork'], 'function')
    assert.equal(typeof proto['toolGroupSelectionOptions'], 'function')
    assert.equal(typeof proto['envelopeBudget'], 'function', 'internal envelope budget calculator present')

    // 3. No legacy planBudgetPressureSpan
    assert.equal(proto['planBudgetPressureSpan'], undefined, 'legacy planBudgetPressureSpan must NOT exist')
    assert.equal((compactionModule as Record<string, unknown>)['planBudgetPressureSpan'], undefined)
  })

  it('verifies lib/client.js contains patched module id', () => {
    const clientSource = readFileSync(resolve(rootDir, 'lib/client.js'), 'utf8')
    assert.ok(clientSource.includes('dsh-context-enhancement'), 'client bundle must contain patched package id')
    assert.ok(!clientSource.includes('@deepseek-ai/dsh-client-ui-jobs'), 'unpatched package id must not remain')
  })

  it('verifies the packed lib/ bytes equal the workspace build, with no orphan chunk', () => {
    const files = extractTarball(readFileSync(tarballPath))
    const packedLib = [...files.keys()].filter(name => name.startsWith('package/lib/'))
    assert.ok(packedLib.length >= 17, `tarball must publish the whole lib/ half (found ${packedLib.length})`)

    // Forward parity: every packed lib byte must be the workspace build's byte.
    for (const name of packedLib) {
      const rel = name.slice('package/'.length)
      const abs = resolve(rootDir, rel)
      assert.ok(existsSync(abs), `tarball member ${rel} has no counterpart in the workspace lib/`)
      assert.equal(readFileSync(abs, 'utf8'), files.get(name), `${rel} differs between the tarball and the workspace lib/`)
    }

    // Reverse parity: everything package.json#files publishes under lib/ is packed.
    const manifest = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { files?: string[] }
    const declaredEntries = new Set(
      (manifest.files ?? []).filter(entry => entry.startsWith('lib/') && !/[*?]/.test(entry)),
    )
    for (const name of readdirSync(resolve(rootDir, 'lib'))) {
      if (!name.endsWith('.js')) continue
      assert.ok(files.has(`package/lib/${name}`), `lib/${name} is built but not packed`)
    }
    const emittedTypes = walkFiles(resolve(rootDir, 'lib', 'types'), rootDir).filter(rel => rel.endsWith('.d.ts'))
    assert.ok(emittedTypes.length > 0, 'lib/types must contain emitted declarations')
    for (const rel of emittedTypes) {
      assert.ok(files.has(`package/${rel}`), `${rel} is emitted but not packed`)
    }

    // No stale build output: a lib/ root chunk must be a declared entry or be
    // imported by another built file, so an artifact can never again ship a
    // chunk the current build did not emit (R-P2-9's "which file runs?" doubt).
    const imported = new Set<string>()
    for (const rel of walkFiles(resolve(rootDir, 'lib'), rootDir)) {
      if (!rel.endsWith('.js')) continue
      const text = readFileSync(resolve(rootDir, rel), 'utf8')
      for (const match of text.matchAll(/(?:from|import|require\()\s*["']\.\/([^"']+)["']/g)) {
        imported.add(match[1] ?? '')
      }
    }
    const orphans = readdirSync(resolve(rootDir, 'lib'))
      .filter(name => name.endsWith('.js'))
      .filter(name => !declaredEntries.has(`lib/${name}`) && !imported.has(name))
    assert.deepEqual(orphans, [], `lib/ carries chunks no entry imports (stale build output): ${orphans.join(', ')}`)
  })

  it('extracts and inspects dsh-context-enhancement-0.1.11.tgz for full parity', () => {
    const tarBuf = readFileSync(tarballPath)
    const files = extractTarball(tarBuf)

    assert.ok(files.size >= 80, `tarball must contain all distribution files (found ${files.size})`)

    // Verify critical file presence
    const critical = [
      'package/package.json',
      'package/cordis.patch.yml',
      'package/presets/contextual/agent.cordis.yml',
      'package/lib/index.js',
      'package/lib/compaction-basic.js',
      'package/lib/tool-result-pruner.js',
      'package/lib/client.js',
      'package/lib/types/index.d.ts',
      'package/lib/types/internal/compaction/zones.d.ts',
    ]
    for (const file of critical) {
      assert.ok(files.has(file), `tarball missing required file: ${file}`)
    }

    // Verify package.json in tarball
    const pkgJson = JSON.parse(files.get('package/package.json')!)
    assert.equal(pkgJson.name, 'dsh-context-enhancement')
    assert.equal(pkgJson.version, '0.1.11')

    // Inspect package/lib/compaction-basic.js in tarball
    const compactionJs = files.get('package/lib/compaction-basic.js')!
    assert.ok(!compactionJs.includes('planBudgetPressureSpan'), 'tarball compaction-basic.js must not contain planBudgetPressureSpan')
    assert.ok(!compactionJs.includes('maxGroups: selected.length'), 'tarball compaction-basic.js must not contain maxGroups: selected.length deadlock')
    assert.ok(compactionJs.includes('three-zone maintenance proceeding past inert tool-stage debt'), 'tarball must include inert maintenance debt handling')
    assert.ok(compactionJs.includes('three-zone pressure proceeding past inert tool-stage debt'), 'tarball must include inert pressure debt handling')
    assert.ok(compactionJs.includes('progress guarantee, not a deficit guarantee'), 'tarball must include progress guarantee semantics')
    assert.ok(compactionJs.includes('inner.type !== "text"'), 'tarball must preserve non-text tool blocks')

    // Inspect package/lib/tool-result-pruner.js in tarball
    const prunerJs = files.get('package/lib/tool-result-pruner.js')!
    assert.ok(prunerJs.includes('measureMessageText'), 'tarball tool-result-pruner.js must have measureMessageText')
    assert.ok(prunerJs.includes('originalContent.length === 0'), 'tarball tool-result-pruner.js must have empty content guard')

    // Inspect package/lib/client.js in tarball
    const clientJs = files.get('package/lib/client.js')!
    assert.ok(clientJs.includes('dsh-context-enhancement'), 'tarball client.js must have patched package id')
    assert.ok(!clientJs.includes('@deepseek-ai/dsh-client-ui-jobs'), 'tarball client.js must not retain placeholder id')

    // Inspect package/lib/types/internal/compaction/zones.d.ts in tarball
    const zonesDts = files.get('package/lib/types/internal/compaction/zones.d.ts')!
    assert.ok(zonesDts.includes('never a one-pass clearing guarantee'), 'tarball zones.d.ts must reflect progress-not-one-pass semantics')
    assert.ok(zonesDts.includes('progress guarantee, not a deficit guarantee'), 'tarball zones.d.ts must reflect deficit-sized progress semantics')
  })
})
