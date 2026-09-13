/**
 * E10 · 双实例 storage host worker —— 一个**独立的操作系统进程**
 * ================================================================
 *
 * 这是 E10（双实例 storage 覆盖实验）的受控最小 storage host。它只做一件事：
 * 在自己的进程里挂载**真实的** `Storage` + `StorageJson` + `StorageDomain`，
 * 打开**真实的**生产域 `context_enhancement_task_state`（直接 import 本插件
 * `src/internal/task-state/basic/domain.ts` 的真实 spec 与真实 zod 记录
 * schema），然后在**文件命令协议**下逐条执行 put/get/inspect，并把每次操作后的
 * 进程内视图、磁盘文件哈希与记录 schema 校验结果写回响应文件。
 *
 * 为什么用文件命令协议而不是 server：
 * - 不占任何端口（部署 8080 与本实验无关，也绝不触碰）；
 * - 不需要 socket / 命名管道（受限环境下不可用）；
 * - 交错点由编排者（spec）在**命令粒度**显式控制，每一步都留痕（claim→exec 的
 *   时间戳），因此"谁先写、谁后写"是可证明的，不是猜测。
 *
 * 真实 / fake 边界：
 * - 真实：DSH `Context` 生命周期、真实 `@deepseek-ai/dsh-storage`(hub)、真实
 *   `@deepseek-ai/dsh-storage-json`(backend `json`，`single` layout，整文档原子
 *   改名发布)、真实 `@deepseek-ai/dsh-storage-domain`(域设施、内存权威、单条写
 *   链)、真实生产域 spec 与真实 zod 记录 schema（写入前、读回后都校验）。
 * - 无 fake LLM、无 adapter：本实验根本不调用模型（唯一问题只关于 storage 介质）。
 *
 * 安全边界（硬编码，不来自命令行参数）：
 * - storage/control 目录必须位于本 E10 实验目录内，否则立即以 exit 97 退出；
 *   绝不触碰真实 `$HOME/.dsh`、现有会话、现有 profile、8080 GUI。
 * - 不读任何环境变量决定路径。
 *
 * 本文件**不是** `*.spec.ts`，不会被任何 vitest include 收集；它由
 * `e10-dual-instance.spec.ts` 以子进程方式启动。
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { taskStateDomainSpec } from '../../../src/internal/task-state/basic/domain.ts'

// ---------------------------------------------------------------------------
// 0. 定位与硬安全校验
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
/** 允许写入的根：本 E10 实验目录。 */
const E10_ROOT = resolve(HERE)
const LOG_PATH = join(E10_ROOT, 'worker-process.log')

/** 本次运行的随机后缀（编排者用 `--run=` 传入）；同一运行的实例共用同一 storage 根。 */
const argvEarly = process.argv.slice(2)
const runIdOf = argvEarly.find(item => item.startsWith('--run='))
const RUN_ID = runIdOf === undefined ? 'adhoc' : runIdOf.slice('--run='.length)

/**
 * 本实例的"代"（`--gen=`）。同名实例在实验中途会被重启（阶段 1 的 A/B 与阶段 2
 * 重启后的 A/B），每一代使用**自己的命令通道与响应目录**：否则重启后的进程会把
 * 上一代残留在命令文件里的命令再执行一遍（首轮实测到的真实缺陷）。
 */
const genOf = argvEarly.find(item => item.startsWith('--gen='))
const GEN = genOf === undefined ? 1 : Number(genOf.slice('--gen='.length))

/**
 * 本次运行的临时目录（相对 E10 根）：storage 与 control 都在实验目录内，
 * 且每次运行一个随机子目录，避免上一轮残留（尤其 tmp-storage）污染结论。
 */
const RUN_STORAGE_ROOT = join(E10_ROOT, 'tmp-storage', `run-${RUN_ID}`)
const RUN_CONTROL_DIR = join(E10_ROOT, 'tmp-control', `run-${RUN_ID}`)

/**
 * 断言一个路径确实落在 E10 实验目录内。任何越界（真实 home、工作区本体、别处）
 * 立即退出，绝不"先试试看"。
 * @param path 待校验的绝对路径。
 * @param label 出错信息里的名字。
 * @returns 解析后的绝对路径。
 */
function assertInsideE10(path: string, label: string): string {
  const full = resolve(path)
  const rel = relative(E10_ROOT, full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    process.stderr.write(`E10 worker refused: ${label} ${full} is outside the E10 experiment directory\n`)
    process.exit(97)
  }
  return full
}

/** 真实 storage 根（single layout 的域文档就落在它下面）。 */
const STORAGE_ROOT = assertInsideE10(RUN_STORAGE_ROOT, 'storage root')
/** 命令/响应目录。 */
const CONTROL_DIR = assertInsideE10(RUN_CONTROL_DIR, 'control dir')
assertInsideE10(LOG_PATH, 'log path')

const commandPath = assertInsideE10(join(CONTROL_DIR, `commands-gen${GEN}.jsonl`), 'command file')
const responseDir = assertInsideE10(join(CONTROL_DIR, `responses-gen${GEN}`), 'response dir')
// 控制/storage 目录必须先存在：时间线日志就落在控制目录下面（appendFileSync 不会自建目录）。
mkdirSync(CONTROL_DIR, { recursive: true })
mkdirSync(STORAGE_ROOT, { recursive: true })
mkdirSync(responseDir, { recursive: true })

// ---------------------------------------------------------------------------
// 1. worker 身份与时间线
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)

/** 取 `--name=value` 形式的参数。 */
function argOf(name: string): string | undefined {
  const hit = argv.find(item => item.startsWith(`--${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 3)
}

const WORKER = argOf('worker') ?? 'X'
const startedAt = Date.now()

/** 追加一行 worker 侧时间线（用于证明"两个进程真的同时在跑"）。 */
function logLine(kind: string, detail: unknown): void {
  appendFileSync(LOG_PATH, `${JSON.stringify({ worker: WORKER, at: Date.now(), kind, detail })}\n`)
}

// ---------------------------------------------------------------------------
// 2. 真实域 spec / 真实记录 schema（直接来自工作区 src，未经复制）
// ---------------------------------------------------------------------------

/** 期望的生产域名：与 src 不一致时立即失败，避免"打开了另一个域"。 */
const EXPECTED_DOMAIN = 'context_enhancement_task_state'
if (taskStateDomainSpec.name !== EXPECTED_DOMAIN) {
  process.stderr.write(`E10 worker refused: imported spec is '${taskStateDomainSpec.name}', expected '${EXPECTED_DOMAIN}'\n`)
  process.exit(96)
}
const sessionsSchema = taskStateDomainSpec.tables.sessions.valueSchema
const auditSchema = taskStateDomainSpec.tables.audit.valueSchema
const specSourcePath = resolve(HERE, '../../../src/internal/task-state/basic/domain.ts')
const contractSourcePath = resolve(HERE, '../../../src/internal/task-state/contract/spec.ts')
const specIdentity = {
  name: taskStateDomainSpec.name,
  version: taskStateDomainSpec.version,
  layout: taskStateDomainSpec.layout ?? 'single',
  tables: Object.keys(taskStateDomainSpec.tables),
  importedFrom: relative(resolve(HERE, '../../..'), specSourcePath),
  domainSourceSha256: sha256File(specSourcePath),
  contractSourceSha256: sha256File(contractSourcePath),
  workerFile: relative(resolve(HERE, '../../..'), fileURLToPath(import.meta.url)),
}

/** 一个文件的 sha256，读不到返回 null。 */
function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 3. fixture 记录：从真实 schema 形状 + 本次运行的显式标记构造，并真实校验
// ---------------------------------------------------------------------------

/**
 * 一条 fixture 记录的 recipe（与 `command.marker` 组合后就是完整的稳定记录）。
 * 形状完全按真实 `taskStateRecordSchema` 构造，构造后立刻用真实 schema 校验；
 * 校验失败即抛错（绝不写一条不合法记录，也绝不静默降级）。
 */
function buildRecord(recipe: Record<string, unknown>): unknown {
  const marker = String(recipe.marker)
  const record = {
    session: {
      createdAt: Number(recipe.createdAt),
      ...(recipe.cwd === undefined ? {} : { cwd: String(recipe.cwd) }),
    },
    stable: {
      schemaVersion: 1,
      revision: Number(recipe.revision),
      filterVersion: 'e10-filter-v1',
      sourceCursor: Number(recipe.sourceCursor),
      digest: String(recipe.digest),
      facts: [
        { id: `fact-e10-${marker}-1`, content: `E10 ${marker} durable fact one.` },
        { id: `fact-e10-${marker}-2`, content: `E10 ${marker} durable fact two.` },
      ],
      decisions: [{ id: `decision-e10-${marker}-1`, content: `E10 ${marker} durable decision one.` }],
      constraints: [{ id: `constraint-e10-${marker}-1`, content: `E10 ${marker} durable constraint one.` }],
      risks: [{ id: `risk-e10-${marker}-1`, content: `E10 ${marker} durable risk one.` }],
      evidence: [{ seq: Number(recipe.sourceCursor), note: `E10 ${marker} evidence note.` }],
      todoReferences: [],
      continuation: {
        currentObjective: `E10 objective ${marker}`,
        currentFocus: `E10 focus ${marker}`,
        openWork: [`E10 ${marker} open work one.`],
        nextActions: [`E10 ${marker} next action one.`],
      },
    },
  }
  const parsed = sessionsSchema.safeParse(record)
  if (!parsed.success) {
    throw new Error(`E10 fixture ${marker} fails the REAL taskStateRecordSchema: ${JSON.stringify(parsed.error.issues)}`)
  }
  return parsed.data
}

/** 一条 audit 行：结构对齐真实 `taskStateAuditRecord`，并由真实 schema 校验。 */
function buildAuditRow(recipe: Record<string, unknown>): unknown {
  const marker = String(recipe.marker)
  const row = {
    requestId: String(recipe.requestId),
    time: Number(recipe.time),
    session: {
      createdAt: Number(recipe.createdAt),
      ...(recipe.cwd === undefined ? {} : { cwd: String(recipe.cwd) }),
    },
    request: {
      requestId: String(recipe.requestId),
      revision: Number(recipe.revision),
      base: null,
      includedSeqs: [1, 2, 3],
      filterVersion: 'e10-filter-v1',
      system: 'E10 audit evidence system instruction.',
      route: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      maxTokens: 4000,
      schema: { version: 1 },
      truncation: [],
    },
    finished: {
      outcome: 'success',
      requestId: String(recipe.requestId),
      revision: Number(recipe.revision),
      sourceCursor: Number(recipe.sourceCursor),
      llmStreamCall: true,
      rawOutput: [{ type: 'text', text: `E10 ${marker} audit raw output.` }],
      finish: { kind: 'stop' },
    },
  }
  const parsed = auditSchema.safeParse(row)
  if (!parsed.success) {
    throw new Error(`E10 audit fixture ${marker} fails the REAL taskStateAuditSchema: ${JSON.stringify(parsed.error.issues)}`)
  }
  // audit 行的"修订号"落在 request.revision 上（audit 行没有 stable 字段）——
  // 这一点与 sessions 表不同，必须分开取，不能统一读 `value.stable`。
  return { data: parsed.data, revision: Number(recipe.revision), digest: `E10-AUDIT-${marker}` }
}

// ---------------------------------------------------------------------------
// 4. 挂载真实 storage host（每个 worker 进程一个独立的 Cordis Context）
// ---------------------------------------------------------------------------

/** 一次挂载的句柄。 */
let mounted: {
  ctx: Context
  domain: unknown
  sessions: { keys(): IterableIterator<string>; get(key: string): unknown; put(key: string, value: unknown): Promise<void> }
  audit: { keys(): IterableIterator<string>; get(key: string): unknown; put(key: string, value: unknown): Promise<void> }
  openedAt: number
  disposeMs: number
} | null = null

/** 挂载真实 storage host 并打开真实域 —— 本 worker 存在的全部理由。 */
async function mountDomain() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: STORAGE_ROOT })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const openedAt = Date.now()
  // 真实 spec 对象（含真实 zod valueSchema）直接传给真实域设施：durable 边界的
  // schema 校验因此是生产的，不是仿造的。
  const domain = await ctx.storageDomain.open(taskStateDomainSpec as never)
  return {
    ctx,
    domain,
    sessions: domain.table('sessions') as never,
    audit: domain.table('audit') as never,
    openedAt,
    disposeMs: 0,
  }
}

// ---------------------------------------------------------------------------
// 5. 观测：进程内视图、磁盘文档、哈希
// ---------------------------------------------------------------------------

/** 稳定化 JSON：对象键排序（数组顺序保留），用于跨进程可比的哈希。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 一个值的 sha256（稳定化后）。 */
function sha256Of(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

/** 真实域文档在磁盘上的路径（single layout：`<root>/<name>.json`）。 */
const domainFile = join(STORAGE_ROOT, `${EXPECTED_DOMAIN}.json`)

/** 读磁盘上的真实域文档（别的进程也会写它）。 */
function readDocFromDisk() {
  if (!existsSync(domainFile)) return { present: false, sha256: null, size: null, mtimeMs: null, doc: null, parseError: null }
  const text = readFileSync(domainFile, 'utf8')
  const info = statSync(domainFile)
  let doc: unknown = null
  let parseError: string | null = null
  try { doc = JSON.parse(text) } catch (error) { parseError = String(error) }
  return {
    present: true,
    sha256: createHash('sha256').update(text).digest('hex'),
    size: info.size,
    mtimeMs: info.mtimeMs,
    doc,
    parseError,
  }
}

/** 一条 session 记录的精简视图，并带真实 schema 校验结论。 */
function recordView(record: unknown, key: string): Record<string, unknown> {
  if (record === undefined) return { key, present: false }
  const parsed = sessionsSchema.safeParse(record)
  const value = record as {
    session: { createdAt: number; cwd?: string }
    stable: {
      revision: number
      sourceCursor: number
      digest: string
      filterVersion: string
      schemaVersion: number
      continuation: { currentObjective: string }
      facts: { content: string }[]
    }
  }
  return {
    key,
    present: true,
    schemaValid: parsed.success,
    session: { createdAt: value.session.createdAt, cwd: value.session.cwd ?? null },
    stable: {
      revision: value.stable.revision,
      sourceCursor: value.stable.sourceCursor,
      digest: value.stable.digest,
      filterVersion: value.stable.filterVersion,
      schemaVersion: value.stable.schemaVersion,
      objective: value.stable.continuation.currentObjective,
      facts: value.stable.facts.map(fact => fact.content),
    },
    recordSha256: sha256Of(record),
  }
}

/** 一条 audit 行的精简视图，并带真实 schema 校验结论。 */
function auditView(row: unknown, key: string): Record<string, unknown> {
  const parsed = auditSchema.safeParse(row)
  const value = row as {
    requestId: string
    time: number
    session: { createdAt: number }
    request: { revision: number; base: { revision: number; sourceCursor: number } | null; includedSeqs: number[] }
    finished?: { outcome: string; revision?: number }
  }
  return {
    key,
    schemaValid: parsed.success,
    requestId: value.requestId,
    time: value.time,
    lifecycleCreatedAt: value.session.createdAt,
    targetRevision: value.request.revision,
    baseRevision: value.request.base?.revision ?? null,
    baseCursor: value.request.base?.sourceCursor ?? null,
    includedSeqs: [...value.request.includedSeqs],
    outcome: value.finished?.outcome ?? 'open',
    finishedRevision: value.finished?.revision ?? null,
    rowSha256: sha256Of(row),
  }
}

/**
 * 本进程**内存**里的完整域视图 —— "另一个实例的外部变更是否可见"的唯一判据：
 * 域读写都走内存，磁盘文件只被写、从不被读回。
 */
function inProcessView(m: NonNullable<typeof mounted>): Record<string, unknown> {
  const sessionKeys = [...m.sessions.keys()].map(String).sort()
  const auditKeys = [...m.audit.keys()].map(String).sort()
  const records: Record<string, unknown> = {}
  for (const key of sessionKeys) records[key] = recordView(m.sessions.get(key), key)
  const rows: Record<string, unknown> = {}
  for (const key of auditKeys) rows[key] = auditView(m.audit.get(key), key)
  return {
    sessionKeys,
    sessionCount: sessionKeys.length,
    auditKeys,
    auditCount: auditKeys.length,
    records,
    audit: rows,
    allRecordsSchemaValid: [...Object.values(records), ...Object.values(rows)].every(row => (row as { schemaValid: boolean }).schemaValid),
    viewSha256: sha256Of({ sessionKeys, records, rows }),
  }
}

/** 从磁盘文档构造同样的视图（"关闭后从介质读回"的对照）。 */
function diskView(doc: unknown): Record<string, unknown> {
  if (doc === null || typeof doc !== 'object') return { present: false }
  const tables = (doc as { tables?: { sessions?: Record<string, unknown>; audit?: Record<string, unknown> } }).tables ?? {}
  const sessions = tables.sessions ?? {}
  const audit = tables.audit ?? {}
  const sessionKeys = Object.keys(sessions).sort()
  const auditKeys = Object.keys(audit).sort()
  const records: Record<string, unknown> = {}
  for (const key of sessionKeys) records[key] = recordView(sessions[key], key)
  const rows: Record<string, unknown> = {}
  for (const key of auditKeys) rows[key] = auditView(audit[key], key)
  return {
    present: true,
    unit: (doc as { unit?: unknown }).unit ?? null,
    sessionKeys,
    sessionCount: sessionKeys.length,
    auditKeys,
    auditCount: auditKeys.length,
    records,
    audit: rows,
    viewSha256: sha256Of({ sessionKeys, records, rows }),
  }
}

// ---------------------------------------------------------------------------
// 6. 命令执行
// ---------------------------------------------------------------------------

/** 一次响应：既含结果，也含"我在哪一刻看、看到了什么"。 */
function respond(id: string, command: Record<string, unknown>, result: unknown, error?: string, errorStack?: string): void {
  const payload = {
    id,
    worker: WORKER,
    op: command['op'],
    ok: error === undefined,
    error: error ?? null,
    errorStack: errorStack ?? null,
    pid: process.pid,
    ppid: process.ppid,
    workerStartedAt: startedAt,
    respondedAt: Date.now(),
    result: result ?? null,
  }
  logLine('respond', { id, op: command['op'] })
  const target = join(responseDir, `${id}--${WORKER}.json`)
  const tmp = join(responseDir, `.${WORKER}-${id}.tmp`)
  // 原子发布：先写临时文件再改名，编排者不会读到半个文件。
  writeFileSync(tmp, JSON.stringify(payload, null, 2))
  renameSync(tmp, target)
}

/** 执行一条命令。 */
async function execute(command: Record<string, unknown>): Promise<unknown> {
  const op = String(command['op'])
  switch (op) {
    case 'ready':
      return {
        worker: WORKER,
        pid: process.pid,
        ppid: process.ppid,
        workerStartedAt: startedAt,
        node: process.version,
        cwd: process.cwd(),
        argv,
        storageRoot: STORAGE_ROOT,
        controlDir: CONTROL_DIR,
        specIdentity,
        domainFile,
        schemaCheck: {
          sessionsSchemaIsReal: typeof sessionsSchema.safeParse === 'function',
          auditSchemaIsReal: typeof auditSchema.safeParse === 'function',
        },
      }
    case 'open': {
      if (mounted !== null) throw new Error('already open')
      mounted = await mountDomain()
      const disk = readDocFromDisk()
      return {
        openedAt: mounted.openedAt,
        specIdentity,
        inProcess: inProcessView(mounted),
        disk: { present: disk.present, sha256: disk.sha256, size: disk.size, mtimeMs: disk.mtimeMs },
        diskView: diskView(disk.doc),
        domainFile,
      }
    }
    case 'inspect': {
      if (mounted === null) throw new Error('not open')
      const disk = readDocFromDisk()
      return {
        inProcess: inProcessView(mounted),
        disk: { present: disk.present, sha256: disk.sha256, size: disk.size, mtimeMs: disk.mtimeMs },
        diskView: diskView(disk.doc),
      }
    }
    case 'put': {
      if (mounted === null) throw new Error('not open')
      const tableName = String(command['table'] ?? 'sessions')
      const table = tableName === 'audit' ? mounted.audit : mounted.sessions
      const recipe = command['recipe'] as Record<string, unknown>
      if (recipe === undefined || recipe === null) throw new Error('put requires a recipe')
      // sessions 表返回记录本身；audit 表返回 `{ data, revision, digest }` —— audit
      // 行没有 stable 字段，修订号落在 request.revision 上。
      const built = tableName === 'audit' ? buildAuditRow(recipe) : { data: buildRecord(recipe), revision: Number(recipe['revision']), digest: String(recipe['digest']) }
      const value = built.data
      const valueSha256 = sha256Of(value)
      const key = String(command['key'])
      const before = inProcessView(mounted)
      const beforeDisk = readDocFromDisk()
      const t0 = Date.now()
      await table.put(key, value)
      const t1 = Date.now()
      const after = inProcessView(mounted)
      const afterDisk = readDocFromDisk()
      return {
        key,
        table: tableName,
        marker: recipe['marker'],
        payloadSha256: valueSha256,
        payloadRevision: built.revision,
        payloadDigest: built.digest,
        payloadObjective: tableName === 'audit'
          ? null
          : (value as { stable: { continuation: { currentObjective: string } } }).stable.continuation.currentObjective,
        putStartedAt: t0,
        putSettledAt: t1,
        putMs: t1 - t0,
        beforeInProcessKeys: before['sessionKeys'],
        beforeInProcessAuditKeys: before['auditKeys'],
        afterInProcess: after,
        beforeDiskSha256: beforeDisk.sha256,
        afterDiskSha256: afterDisk.sha256,
        diskSizeAfter: afterDisk.size,
        diskMtimeAfter: afterDisk.mtimeMs,
        diskSessionKeysAfter: afterDisk.doc === null
          ? null
          : Object.keys((afterDisk.doc as { tables: { sessions: Record<string, unknown> } }).tables.sessions).sort(),
        diskAuditKeysAfter: afterDisk.doc === null
          ? null
          : Object.keys((afterDisk.doc as { tables: { audit: Record<string, unknown> } }).tables.audit).sort(),
        wrotePayloadSurvivesInOwnMemory: (after['sessionKeys'] as string[]).includes(key)
          || (after['auditKeys'] as string[]).includes(key),
      }
    }
    case 'get': {
      if (mounted === null) throw new Error('not open')
      const tableName = String(command['table'] ?? 'sessions')
      const table = tableName === 'audit' ? mounted.audit : mounted.sessions
      const key = String(command['key'])
      const value = table.get(key)
      return {
        key,
        table: tableName,
        view: value === undefined
          ? { key, present: false }
          : (tableName === 'audit' ? auditView(value, key) : recordView(value, key)),
      }
    }
    case 'waitBarrier': {
      // 编排者在屏障里写 `<worker>.<nonce>.go`；两个 worker 停在同一个屏障上
      // 才是双进程并发点。到达/释放时间戳都记下来，交错顺序可证。
      const nonce = String(command['nonce'])
      const goFile = join(CONTROL_DIR, `${WORKER}.gen${GEN}.${nonce}.go`)
      const arrivedAt = Date.now()
      while (!existsSync(goFile)) await new Promise(resolve => setTimeout(resolve, 1))
      utimesSync(goFile, new Date(), new Date())
      return { nonce, goFile, arrivedAt, releasedAt: Date.now(), waitedMs: Date.now() - arrivedAt }
    }
    case 'close': {
      if (mounted === null) return { alreadyClosed: true }
      const handle = mounted
      const finalInProcess = inProcessView(handle)
      const diskAtClose = readDocFromDisk()
      const t0 = Date.now()
      await handle.ctx.fiber.dispose()
      const t1 = Date.now()
      mounted = null
      return {
        closedAt: t1,
        disposeMs: t1 - t0,
        finalInProcess,
        diskAtCloseSha256: diskAtClose.sha256,
        diskAtCloseSessionKeys: diskAtClose.doc === null
          ? null
          : Object.keys((diskAtClose.doc as { tables: { sessions: Record<string, unknown> } }).tables.sessions).sort(),
        domainClosed: true,
      }
    }
    case 'exit': {
      if (mounted !== null) {
        await mounted.ctx.fiber.dispose()
        mounted = null
      }
      return { exiting: true }
    }
    default:
      throw new Error(`unknown op '${op}'`)
  }
}

// ---------------------------------------------------------------------------
// 7. 命令循环（轮询命令文件；已处理命令 id 记在内存里）
// ---------------------------------------------------------------------------

const handled = new Set<string>()

logLine('worker-start', { pid: process.pid, ppid: process.ppid, gen: GEN, argv, node: process.version, cwd: process.cwd() })

// 启动即宣告就绪，编排者可据此确认进程真的起来了、且看到的是同一个 E10 目录。
respond('000-ready', { op: 'ready' }, {
  worker: WORKER,
  gen: GEN,
  pid: process.pid,
  ppid: process.ppid,
  workerStartedAt: startedAt,
  node: process.version,
  cwd: process.cwd(),
  storageRoot: STORAGE_ROOT,
  controlDir: CONTROL_DIR,
  domainFile,
  specIdentity,
})

const deadline = Date.now() + 8 * 60 * 1000
let idleSince = Date.now()

while (Date.now() < deadline) {
  let lines: string[] = []
  if (existsSync(commandPath)) {
    lines = readFileSync(commandPath, 'utf8').split('\n').filter(line => line.trim().length > 0)
  }
  for (const line of lines) {
    let command: Record<string, unknown>
    try { command = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (command['worker'] !== WORKER) continue
    const id = String(command['id'])
    if (handled.has(id)) continue
    handled.add(id)
    // claim 先落日志再执行：命令粒度的先后顺序因此可证。
    logLine('claim', { id, op: command['op'] })
    let result: unknown = null
    let error: string | undefined
    let errorStack: string | undefined
    try {
      result = await execute(command)
    } catch (caught) {
      error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
      errorStack = caught instanceof Error ? (caught.stack ?? null) ?? undefined : undefined
    }
    respond(id, command, result, error, errorStack)
    idleSince = Date.now()
    if (command['op'] === 'exit') {
      logLine('worker-exit', { id })
      process.exit(0)
    }
  }
  await new Promise(resolve => setTimeout(resolve, 2))
  if (Date.now() - idleSince > 30_000) {
    logLine('worker-idle-timeout', { handled: [...handled] })
    process.exit(98)
  }
}
logLine('worker-deadline-timeout', { handled: [...handled] })
process.exit(99)
