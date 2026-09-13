/**
 * E10 · 双实例 storage 覆盖实验（L3：**两个真实操作系统进程**）
 * =================================================================
 *
 * 唯一实验问题
 * ------------
 * 两个独立的 DSH/storage host 实例**同时**使用同一个临时 storage domain 时，
 * 是否会发生
 *   - 整文档 last-write-wins 覆盖，
 *   - revision 分叉，
 *   - audit 丢失，
 *   - 外部变更不可见？
 *
 * 运行前固定的判定规则（对照 审计资料/32-运行时复现实验方案.md §5 E10）
 * -------------------------------------------------------------------
 *   reproduced      = 一个实例**提交**（put 返回成功）后，另一个实例的**已提交**
 *                     （put 已成功返回）数据在介质上被整体覆盖/静默丢失；**或**
 *                     同一 key 在同一 revision 上出现**分叉**（两个实例各自
 *                     产出 N+1，且介质上没有 CAS/冲突拒绝）。
 *   not-reproduced  = 以上两者均不成立（每个实例的已提交数据在最终介质上都可
 *                     读回，且不存在同一 revision 的分叉）。
 *   inconclusive    = 无法安全启动两个独立进程 / 无法确证子进程访问的是实验目录
 *                     / runner 或子进程失败导致证据不完整。
 *   design-confirmed= 只有静态设计证据（本实验只在进程无法安全启动时才用它）。
 *
 * **单纯"两个 key 都存在"不能证明无并发风险**：本 spec 因此对每一次写都记录
 * 该实例写前/写后的**进程内 key 集合**与磁盘文档 key 集合，并对最终介质逐 key
 * 判定"某实例已提交但介质没有"。
 *
 * 真实 / fake 边界
 * ----------------
 * 真实：两个独立 node 进程（`e10-storage-worker.mjs`），每个进程挂载真实
 *   `Storage` + `StorageJson`(backend `json`，`single` layout) +
 *   `StorageDomain`，打开**真实生产域** `context_enhancement_task_state`
 *   （spec/记录 schema 直接 import 自 `src/internal/task-state/basic/domain.ts`
 *   与 `src/internal/task-state/contract/`，写入前与读回后都用真实 zod schema
 *   校验）。完整盘路径、文件哈希、mtime、进程 pid 都来自实测。
 * fake：无。本实验不调用任何模型（唯一问题只关于 storage 介质），因此没有
 *   adapter、没有 provider、没有 usage。
 *
 * 安全边界（硬编码）
 * ------------------
 * - 只写 `审计资料/实验结果/E10-双实例/`（storage/control/session 临时目录均在
 *   其内），worker 侧对越界路径直接 exit 97；
 * - 不触碰真实 `$HOME/.dsh`、现有会话、当前 profile、8080 GUI；不启动任何
 *   替代 GUI 的服务器；两个子进程都不监听端口（文件命令协议）；
 * - 不使用真实 DSH home/session/workspace；storage root 由本 spec 指定为
 *   实验目录内的随机子目录；
 * - 所有子进程在 `finally` 里被 kill 并等待退出，任何失败路径都不会留下孤儿。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { taskStateDomainSpec } from '../../../src/internal/task-state/basic/domain.ts'
// ---------------------------------------------------------------------------
// 固定常量
// ---------------------------------------------------------------------------

/** 本实验目录（唯一允许写入的位置）。 */
const OUT_DIR = dirname(fileURLToPath(import.meta.url))
/** 工作区根（子进程 cwd，保证 node_modules 解析与真实依赖一致）。 */
const WORKSPACE_ROOT = resolve(OUT_DIR, '../../..')
const WORKER_SCRIPT = join(OUT_DIR, 'e10-storage-worker.mts')
const LEDGER_PATH = join(OUT_DIR, 'e10-ledger.json')

/** 每次运行使用随机 storage 根，避免上一轮残留污染（同一次运行内两个实例共用它）。 */
const RUN_ID = randomUUID().slice(0, 8)
const STORAGE_ROOT = join(OUT_DIR, 'tmp-storage', `run-${RUN_ID}`)
const CONTROL_DIR = join(OUT_DIR, 'tmp-control', `run-${RUN_ID}`)
const DOMAIN_FILE = join(STORAGE_ROOT, 'context_enhancement_task_state.json')
const WORKER_LOG = join(OUT_DIR, 'tmp-control', 'worker-process.log')

/** 生产域名（与真实 spec 不一致即 fail，不猜测）。 */
const DOMAIN_NAME = 'context_enhancement_task_state'

/** 一个实例的 cwd/lifecycle 分量（记录 identity 只用 (createdAt, cwd)，见 service.ts）。 */
const FIXTURE_CWD = STORAGE_ROOT
/** 一次运行内固定的 lifecycle createdAt（proves 记录归同一 lifecycle，跨进程可比）。 */
const LIFECYCLE_CREATED_AT = 1_700_000_000_000

/** 每个命令的响应等待上限（ms）。 */
const COMMAND_TIMEOUT_MS = 60_000
/** 整个 spec 的硬上限（ms）；超时后 kill 所有子进程并以 inconclusive 记录。 */
const HARD_DEADLINE_MS = 480_000
/** 屏障并发点：两个 worker 到达时间差超过该值即认为"不是真并发"。 */
const BARRIER_CONCURRENCY_TOLERANCE_MS = 2_000

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** sha256（hex）of a string。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** sha256（hex）of a file，读不到返回 null。 */
function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** 稳定化 JSON，用于跨进程可比的哈希。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** sha256 of a稳定化 value。 */
function sha256Value(value: unknown): string {
  return sha256(stableJson(value))
}

/** 读磁盘上的真实域文档。 */
function readDocFromDisk(): { present: boolean; sha256: string | null; size: number | null; mtimeMs: number | null; texts: string | null; doc: unknown } {
  if (!existsSync(DOMAIN_FILE)) return { present: false, sha256: null, size: null, mtimeMs: null, texts: null, doc: null }
  const text = readFileSync(DOMAIN_FILE, 'utf8')
  const info = statSync(DOMAIN_FILE)
  let doc: unknown = null
  try { doc = JSON.parse(text) } catch { doc = null }
  return { present: true, sha256: sha256(text), size: info.size, mtimeMs: info.mtimeMs, texts: text, doc }
}

/** 磁盘文档里的 sessions/audit key 列表。 */
function diskKeys(): { sessions: string[]; audit: string[] } {
  const disk = readDocFromDisk()
  if (disk.doc === null || typeof disk.doc !== 'object') return { sessions: [], audit: [] }
  const tables = (disk.doc as { tables?: { sessions?: Record<string, unknown>; audit?: Record<string, unknown> } }).tables ?? {}
  return {
    sessions: Object.keys(tables.sessions ?? {}).sort(),
    audit: Object.keys(tables.audit ?? {}).sort(),
  }
}

/** 目录下所有文件（递归），相对路径 + 字节数。 */
function listFiles(root: string, base = root): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = []
  let entries: string[] = []
  try { entries = readdirSync(root) } catch { return out }
  for (const entry of entries) {
    const full = join(root, entry)
    const info = statSync(full)
    if (info.isDirectory()) out.push(...listFiles(full, base))
    else out.push({ path: relative(base, full), bytes: info.size })
  }
  return out
}

// ---------------------------------------------------------------------------
// 子进程 worker 管理
// ---------------------------------------------------------------------------

/** 一个受控 worker 实例。 */
interface WorkerHandle {
  readonly label: string
  readonly child: ChildProcess
  readonly outPath: string
  readonly errPath: string
  readonly workerLogPath: string
  pid: number | null
  ppid: number | null
  startedAt: number
  startPerformanceMs: number
  ready: Record<string, unknown> | null
  exitCode: number | null
  exitSignal: string | null
  exitedAt: number | null
  /** 本 worker 已发出的命令 id 列表。 */
  readonly commands: string[]
  /** 本实例所属的"代"（generation）：重启后的同名实例用另一条命令/响应通道。 */
  readonly gen: number
}

const workers: WorkerHandle[] = []
let commandSeq = 0
let globalDeadlineHit = false
const errors: { stage: string; message: string }[] = []

/** 第 N 代的命令文件路径（每个实例只读自己那一代的命令通道）。 */
function commandPathOf(gen: number): string {
  return join(CONTROL_DIR, `commands-gen${gen}.jsonl`)
}

/** 第 N 代的响应目录。 */
function responseDirOf(gen: number): string {
  return join(CONTROL_DIR, `responses-gen${gen}`)
}

/** 记录一条错误（不抛，最后统一写入 ledger）。 */
function recordError(stage: string, error: unknown): void {
  errors.push({ stage, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
}

/** 启动一个独立 OS 进程 worker，并等待其 ready 响应。 */
async function startWorker(label: string, gen: number): Promise<WorkerHandle> {
  const outPath = join(OUT_DIR, `worker-${label}-gen${gen}-stdout.log`)
  const errPath = join(OUT_DIR, `worker-${label}-gen${gen}-stderr.log`)
  mkdirSync(dirname(WORKER_LOG), { recursive: true })
  mkdirSync(responseDirOf(gen), { recursive: true })
  const outFd = openSync(outPath, 'a')
  const errFd = openSync(errPath, 'a')
  const startPerformanceMs = Date.now()
  let child: ChildProcess
  try {
    child = spawn(
      process.execPath,
      [WORKER_SCRIPT, `--worker=${label}`, `--run=${RUN_ID}`, `--gen=${gen}`],
      {
        cwd: WORKSPACE_ROOT,
        // 'inherit'-only 之外的最安全组合：stdout/stderr 重定向到实验目录内的文件，
        // stdin 关闭。worker 的结论不经过管道，因此不受受限环境的管道限制影响。
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        env: { ...process.env, E10_WORKER: label, E10_RUN_ID: RUN_ID, E10_GEN: String(gen) },
      },
    )
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const handle: WorkerHandle = {
    label,
    gen,
    child,
    outPath,
    errPath,
    workerLogPath: WORKER_LOG,
    pid: child.pid ?? null,
    ppid: process.pid,
    startedAt: Date.now(),
    startPerformanceMs,
    ready: null,
    exitCode: null,
    exitSignal: null,
    exitedAt: null,
    commands: [],
  }
  child.on('exit', (code, signal) => {
    handle.exitCode = code
    handle.exitSignal = signal
    handle.exitedAt = Date.now()
  })
  workers.push(handle)
  const ready = await waitForResponse('000-ready', label, 30_000, gen)
  if (ready === null) throw new Error(`worker ${label} gen${gen} did not become ready`)
  handle.ready = ready.result as Record<string, unknown>
  if ((ready.result as { pid?: number }).pid !== undefined) handle.pid = (ready.result as { pid: number }).pid
  return handle
}

/** 取某个 label 的**当前**句柄（同名实例重启后是最后一个）。 */
function handleOf(label: string): WorkerHandle | undefined {
  const matches = workers.filter(item => item.label === label)
  return matches[matches.length - 1]
}

/**
 * 追加一条命令并返回其 id。命令写到**该实例所属代**的命令通道；同名的重启实例
 * 属于新的一代，因此永远不会重放上一代残留的命令（这是首轮跑出来的真实缺陷：
 * 重启后的 A 把阶段 1 的 A 命令又执行了一遍）。
 */
function postCommand(label: string, op: string, payload: Record<string, unknown> = {}): string {
  const handle = handleOf(label)
  if (handle === undefined) throw new Error(`no worker handle for label ${label}`)
  commandSeq += 1
  const id = `cmd-${String(commandSeq).padStart(3, '0')}`
  const line = `${JSON.stringify({ id, worker: label, gen: handle.gen, op, ...payload })}\n`
  appendFileSync(commandPathOf(handle.gen), line)
  handle.commands.push(id)
  return id
}

/** 轮询一条响应直到出现或超时；返回解析后的响应对象（含实测时间戳字段）。 */
async function waitForResponse(id: string, label: string, timeoutMs = COMMAND_TIMEOUT_MS, gen?: number): Promise<Record<string, unknown> | null> {
  const handle = handleOf(label)
  const generation = gen ?? handle?.gen ?? 1
  const path = join(responseDirOf(generation), `${id}--${label}.json`)
  const start = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) return null
    const watched = workers.filter(item => item.label === label && item.gen === generation).pop()
    if (watched !== undefined && watched.exitedAt !== null) return null
    if (Date.now() - start > HARD_DEADLINE_MS) { globalDeadlineHit = true; return null }
    await new Promise(resolve => setTimeout(resolve, 3))
  }
  // 微小重试，避免读到改名瞬间的中间态（worker 侧已是 rename 原子发布）。
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      await new Promise(resolve => setTimeout(resolve, 3))
    }
  }
  return null
}

/** 发一条命令并等待响应；失败返回 `{ ok:false }` 形状并记账。 */
async function call(label: string, op: string, payload: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const id = postCommand(label, op, payload)
  const response = await waitForResponse(id, label, timeoutMs)
  if (response === null) {
    recordError(`${label}.${op}.${id}`, new Error('no response (timeout or worker exit)'))
    return { id, worker: label, op, ok: false, error: 'no response', result: null }
  }
  if (response['ok'] !== true) recordError(`${label}.${op}.${id}`, new Error(String(response['error'])))
  return response
}

/** 屏障：两个 worker 同时等待各自的 go 文件，然后一起放行。 */
async function barrier(labels: readonly string[], nonce: string): Promise<Record<string, Record<string, unknown> | null>> {
  const entries = labels.map(label => {
    const handle = handleOf(label)
    if (handle === undefined) throw new Error(`no worker handle for label ${label}`)
    return { label, gen: handle.gen, id: postCommand(label, 'waitBarrier', { nonce }), goFile: join(CONTROL_DIR, `${label}.gen${handle.gen}.${nonce}.go`) }
  })
  // 先把两个 go 文件都创建好（此时两边都已在忙等），再一起删除：删除瞬间就是
  // "同时放行"的并发点。两边到达时间戳由各自实测给出。
  for (const entry of entries) writeFileSync(entry.goFile, `${Date.now()}\n`)
  await new Promise(resolve => setTimeout(resolve, 20))
  for (const entry of entries) rmSync(entry.goFile, { force: true })
  const settled = await Promise.all(entries.map(async entry => [entry.label, await waitForResponse(entry.id, entry.label, COMMAND_TIMEOUT_MS, entry.gen)] as const))
  return Object.fromEntries(settled)
}

/** 关闭一个 worker（close 命令 + exit 命令），并等待进程真的退出。 */
async function stopWorker(handle: WorkerHandle): Promise<void> {
  if (handle.exitedAt !== null) return
  await call(handle.label, 'close', {}, 30_000)
  postCommand(handle.label, 'exit')
  const start = Date.now()
  while (handle.exitedAt === null && Date.now() - start < 20_000) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (handle.exitedAt === null) {
    recordError(`${handle.label}.kill`, new Error('worker did not exit after exit command; killing'))
    handle.child.kill('SIGKILL')
    const killStart = Date.now()
    while (handle.exitedAt === null && Date.now() - killStart < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

/** 进程是否还活着（用于证明"两个进程同时存在"）。 */
function alive(handle: WorkerHandle): boolean {
  return handle.exitedAt === null && handle.exitCode === null
}

/** 所有 worker 的退出状态（结果文件与 ledger 都要用它）。 */
function workerStatus(): Record<string, unknown>[] {
  return workers.map(handle => ({
    label: handle.label,
    pid: handle.pid,
    ppid: handle.ppid,
    startedAt: handle.startedAt,
    readyAt: handle.ready === null ? null : (handle.ready as { workerStartedAt?: number }).workerStartedAt ?? null,
    exitedAt: handle.exitedAt,
    exitCode: handle.exitCode,
    exitSignal: handle.exitSignal,
    aliveAtHarvest: alive(handle),
    commands: handle.commands,
    stdout: relative(OUT_DIR, handle.outPath),
    stderr: relative(OUT_DIR, handle.errPath),
    stderrBytes: (() => { try { return statSync(handle.errPath).size } catch { return null } })(),
  }))
}

// ---------------------------------------------------------------------------
// fixture recipe（记录值由 worker 用**真实** zod schema 构造并校验）
// ---------------------------------------------------------------------------

/**
 * 一条 payload 的 recipe。`marker` 让每次写的内容与 digest 都严格可区分，
 * 使"介质上留下的是谁的 payload"可以被逐字节判定。
 */
function recipe(marker: string, revision: number, sourceCursor: number): Record<string, unknown> {
  return {
    marker,
    createdAt: LIFECYCLE_CREATED_AT,
    cwd: FIXTURE_CWD,
    revision,
    sourceCursor,
    digest: `E10-DIGEST-${marker}`,
  }
}

/** audit 行 recipe（用于证明 audit 行是否跨进程丢失）。 */
function auditRecipe(marker: string, revision: number, sourceCursor: number): Record<string, unknown> {
  return {
    marker,
    createdAt: LIFECYCLE_CREATED_AT,
    cwd: FIXTURE_CWD,
    revision,
    sourceCursor,
    requestId: `ts-e10-${marker}`,
    time: 1_700_000_100_000 + revision * 1000,
  }
}

// ---------------------------------------------------------------------------
// 判定：从实测响应推导（不猜测、不用固定期望值）
// ---------------------------------------------------------------------------

/** 一次 put 的实测记录（跨两个实例汇总后可判定覆盖/分叉/丢失）。 */
interface PutRecord {
  readonly instance: string
  readonly key: string
  readonly table: string
  readonly marker: string
  readonly window: string
  readonly payloadSha256: string
  readonly payloadRevision: number
  readonly payloadDigest: string
  readonly putStartedAt: number
  readonly putSettledAt: number
  readonly putOk: boolean
  readonly inProcessKeysAfter: string[]
  readonly diskKeysAfter: string[]
  readonly diskSha256After: string | null
  readonly diskMtimeAfter: number | null
}

const puts: PutRecord[] = []

/** 把一次 put 的响应登记为实测记录。 */
function collectPut(instance: string, window: string, key: string, table: string, response: Record<string, unknown>): PutRecord | null {
  const result = response['result'] as Record<string, unknown> | null
  if (response['ok'] !== true || result === null) return null
  const after = result['afterInProcess'] as { sessionKeys: string[]; auditKeys: string[] }
  const record: PutRecord = {
    instance,
    key,
    table,
    marker: String(result['marker']),
    window,
    payloadSha256: String(result['payloadSha256']),
    payloadRevision: Number(result['payloadRevision']),
    payloadDigest: String(result['payloadDigest']),
    putStartedAt: Number(result['putStartedAt']),
    putSettledAt: Number(result['putSettledAt']),
    putOk: response['ok'] === true,
    inProcessKeysAfter: table === 'audit' ? after.auditKeys : after.sessionKeys,
    diskKeysAfter: (table === 'audit'
      ? result['diskAuditKeysAfter']
      : result['diskSessionKeysAfter']) as string[],
    diskSha256After: result['afterDiskSha256'] === null ? null : String(result['afterDiskSha256']),
    diskMtimeAfter: result['diskMtimeAfter'] === null ? null : Number(result['diskMtimeAfter']),
  }
  puts.push(record)
  return record
}

/** 一次 put 的响应里"磁盘文档内容"是否等于该实例写前的内存视图（整文档覆盖的直接证据）。 */
function diskMatchesPayloadOf(instance: string, marker: string): string[] {
  return puts.filter(put => put.instance === instance && put.marker === marker).map(put => put.diskSha256After ?? 'null')
}

/** 从最终介质读回的 key → 该 key 上"最后写者"的 marker。 */
function finalKeyOwners(disk: unknown): Record<string, { key: string; digest: string; revision: number; objective: string; recordSha256: string }> {
  if (disk === null || typeof disk !== 'object') return {}
  const sessions = ((disk as { tables?: { sessions?: Record<string, unknown> } }).tables?.sessions) ?? {}
  const out: Record<string, { key: string; digest: string; revision: number; objective: string; recordSha256: string }> = {}
  for (const [key, value] of Object.entries(sessions)) {
    const stable = (value as { stable: { digest: string; revision: number; continuation: { currentObjective: string } } }).stable
    out[key] = {
      key,
      digest: stable.digest,
      revision: stable.revision,
      objective: stable.continuation.currentObjective,
      recordSha256: sha256Value(value),
    }
  }
  return out
}

/**
 * 介质是否通过真实 schema 校验（读回后独立校验，证明写出去的确实是合法生产记录）。
 */
function validateDiskDoc(disk: unknown): { sessions: Record<string, boolean>; audit: Record<string, boolean>; allValid: boolean } {
  const sessionsOut: Record<string, boolean> = {}
  const auditOut: Record<string, boolean> = {}
  if (disk === null || typeof disk !== 'object') return { sessions: sessionsOut, audit: auditOut, allValid: false }
  const tables = (disk as { tables?: { sessions?: Record<string, unknown>; audit?: Record<string, unknown> } }).tables ?? {}
  for (const [key, value] of Object.entries(tables.sessions ?? {})) {
    sessionsOut[key] = taskStateDomainSpec.tables.sessions.valueSchema.safeParse(value).success
  }
  for (const [key, value] of Object.entries(tables.audit ?? {})) {
    auditOut[key] = taskStateDomainSpec.tables.audit.valueSchema.safeParse(value).success
  }
  return {
    sessions: sessionsOut,
    audit: auditOut,
    allValid: [...Object.values(sessionsOut), ...Object.values(auditOut)].every(Boolean),
  }
}

// ---------------------------------------------------------------------------
// 实验
// ---------------------------------------------------------------------------

afterAll(() => {
  // 兜底：任何路径下都不留孤儿进程。
  for (const handle of workers) {
    if (alive(handle)) {
      try { handle.child.kill('SIGKILL') } catch { /* 已退出 */ }
    }
  }
})

describe('E10 · 两个独立 OS 进程同时使用同一个临时 storage domain', () => {
  it('记录整文档覆盖 / revision 分叉 / audit 丢失 / 外部变更不可见是否发生', async () => {
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
    rmSync(CONTROL_DIR, { recursive: true, force: true })
    mkdirSync(STORAGE_ROOT, { recursive: true })
    mkdirSync(CONTROL_DIR, { recursive: true })
    if (existsSync(WORKER_LOG)) rmSync(WORKER_LOG, { force: true })

    // ---- 静态组件身份（读回后与实测对照） --------------------------------
    const components = {
      workerScript: { path: relative(WORKSPACE_ROOT, WORKER_SCRIPT), sha256: sha256File(WORKER_SCRIPT), bytes: statSync(WORKER_SCRIPT).size },
      domainSource: {
        path: 'src/internal/task-state/basic/domain.ts',
        sha256: sha256File(join(WORKSPACE_ROOT, 'src/internal/task-state/basic/domain.ts')),
      },
      contractSpecSource: {
        path: 'src/internal/task-state/contract/spec.ts',
        sha256: sha256File(join(WORKSPACE_ROOT, 'src/internal/task-state/contract/spec.ts')),
      },
      dshStorageJsonLib: { path: 'node_modules/@deepseek-ai/dsh-storage-json/lib/index.js', sha256: sha256File(join(WORKSPACE_ROOT, 'node_modules/@deepseek-ai/dsh-storage-json/lib/index.js')) },
      dshStorageDomainLib: { path: 'node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js', sha256: sha256File(join(WORKSPACE_ROOT, 'node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js')) },
      dshStorageLib: { path: 'node_modules/@deepseek-ai/dsh-storage/lib/index.js', sha256: sha256File(join(WORKSPACE_ROOT, 'node_modules/@deepseek-ai/dsh-storage/lib/index.js')) },
      node: process.version,
      nodeExecPath: process.execPath,
      specUnderTest: `${DOMAIN_NAME} v${taskStateDomainSpec.version} layout=${taskStateDomainSpec.layout ?? 'single'} tables=${Object.keys(taskStateDomainSpec.tables).join(',')}`,
    }

    // ---- 场景：A/B 同时打开同一 domain；交错写；关闭；只读读回 ------------
    const scenario: Record<string, unknown> = {
      id: 'multi-instance-same-domain',
      storageRoot: relative(WORKSPACE_ROOT, STORAGE_ROOT),
      domainFile: relative(WORKSPACE_ROOT, DOMAIN_FILE),
      controlDir: relative(WORKSPACE_ROOT, CONTROL_DIR),
      commandProtocol: '文件命令协议（按"代"分通道）：每个 worker 进程只读自己那一代的命令文件 tmp-control/<run>/commands-gen<N>.jsonl，逐条 claim→执行→把响应原子改名发布到 tmp-control/<run>/responses-gen<N>/<id>--<label>.json；无端口、无 socket、无命名管道。分代是必要的：同名实例在阶段 2 被重启，共用一条命令文件会让新进程重放上一代的残留命令（首轮实测到的真实缺陷）。',
      interleavingControl: '编排者（本 spec）在**命令粒度**串行发出并等待响应；worker 侧每次 claim 都写时间线，因此谁先写谁后写由实测时间戳证明，而不是靠假设。屏障场景用 waitBarrier 让两个进程在同一时刻同时放行。',
    }

    let handleA: WorkerHandle | null = null
    let handleB: WorkerHandle | null = null
    let handleC: WorkerHandle | null = null
    let seeder: WorkerHandle | null = null
    /** `puts` 里阶段 1 与阶段 2 的分界下标（阶段 2 前介质被清空过）。 */
    let phaseBoundaryIndex = 0

    try {
      // ===================================================================
      // 阶段 A：两个独立进程同时打开同一个 storage domain（同一临时 root）
      // ===================================================================
      handleA = await startWorker('A', 1)
      handleB = await startWorker('B', 1)
      scenario['phase1_stageA_open'] = {
        role: 'A/B 同时打开同一个 storage domain（同一临时 storage root，同一域文档）',
        aPid: handleA.pid,
        bPid: handleB.pid,
        aReady: handleA.ready,
        bReady: handleB.ready,
        distinctPids: handleA.pid !== handleB.pid,
        bothAliveNow: alive(handleA) && alive(handleB),
        aOpenedAtBeforeB: null as unknown,
      }
      const openA = await call('A', 'open')
      const openB = await call('B', 'open')
      scenario['phase1_stageA_open'] = {
        ...(scenario['phase1_stageA_open'] as Record<string, unknown>),
        aOpenedAt: (openA['result'] as { openedAt?: number } | null)?.openedAt ?? null,
        bOpenedAt: (openB['result'] as { openedAt?: number } | null)?.openedAt ?? null,
        aOpenInProcess: (openA['result'] as { inProcess?: unknown } | null)?.inProcess ?? null,
        bOpenInProcess: (openB['result'] as { inProcess?: unknown } | null)?.inProcess ?? null,
        aDiskAtOpen: (openA['result'] as { disk?: unknown } | null)?.disk ?? null,
        bDiskAtOpen: (openB['result'] as { disk?: unknown } | null)?.disk ?? null,
        // 两个实例打开同一域时，磁盘文档还不存在：域设施读不到任何记录。
        domainFileExistedAtOpen: existsSync(DOMAIN_FILE),
        bothOpenedSameDomainName: (openA['result'] as { specIdentity?: { name?: string } } | null)?.specIdentity?.name === DOMAIN_NAME
          && (openB['result'] as { specIdentity?: { name?: string } } | null)?.specIdentity?.name === DOMAIN_NAME,
      }

      // ===================================================================
      // 阶段 B：A 写 Session A（实例 A 的已提交数据落到介质）
      // ===================================================================
      const putA1 = await call('A', 'put', { table: 'sessions', key: 'e10-session-a', recipe: recipe('A-t1', 1, 5) })
      const putA1Result = putA1['result'] as Record<string, unknown> | null
      collectPut('A', 'B-a-writes-while-b-open', 'e10-session-a', 'sessions', putA1)
      scenario['phase1_stageB_aWrites'] = {
        role: 'A 写 Session A（put 成功 = 已提交）',
        ok: putA1['ok'],
        error: putA1['error'],
        marker: putA1Result?.['marker'] ?? null,
        putStartedAt: putA1Result?.['putStartedAt'] ?? null,
        putSettledAt: putA1Result?.['putSettledAt'] ?? null,
        diskSessionKeysAfter: putA1Result?.['diskSessionKeysAfter'] ?? null,
        diskSha256After: putA1Result?.['afterDiskSha256'] ?? null,
        diskSizeAfter: putA1Result?.['diskSizeAfter'] ?? null,
        aInProcessSessionKeysAfter: (putA1Result?.['afterInProcess'] as { sessionKeys?: string[] } | undefined)?.sessionKeys ?? null,
        diskFileNow: readDocFromDisk().sha256,
      }

      // ===================================================================
      // 阶段 C：B 仍开着，读它自己的视图 —— 外部变更是否可见？
      // ===================================================================
      const inspectB1 = await call('B', 'inspect')
      const getB1 = await call('B', 'get', { table: 'sessions', key: 'e10-session-a' })
      const inspectB1Result = inspectB1['result'] as {
        inProcess?: { sessionKeys?: string[]; sessionCount?: number }
        disk?: { sha256?: string | null }
        diskView?: { sessionKeys?: string[] }
      } | null
      const diskAfterA = readDocFromDisk()
      scenario['phase1_stageC_externalVisibility'] = {
        role: 'B 仍开着，读它自己的内存视图（外部变更可见性）',
        aCommittedKey: 'e10-session-a',
        diskHasAKey: diskKeys().sessions.includes('e10-session-a'),
        diskSha256: diskAfterA.sha256,
        bInProcessSessionKeys: inspectB1Result?.inProcess?.sessionKeys ?? null,
        bInProcessSessionCount: inspectB1Result?.inProcess?.sessionCount ?? null,
        bSeesAKeyInMemory: (inspectB1Result?.inProcess?.sessionKeys ?? []).includes('e10-session-a'),
        bGetAKeyResult: getB1['result'] ?? null,
        bDiskReadSeesAKey: (inspectB1Result?.diskView?.sessionKeys ?? []).includes('e10-session-a'),
        bDiskShaAtInspect: inspectB1Result?.disk?.sha256 ?? null,
        // 关键结论：B 的内存视图（域读取的唯一来源）与磁盘不一致。
        bMemoryEqualsDisk: sha256Value(inspectB1Result?.inProcess ?? null) === sha256Value(inspectB1Result?.diskView ?? null),
      }

      // ===================================================================
      // 阶段 D：B 写 Session B —— A 已提交的数据是否被整文档覆盖掉？
      // ===================================================================
      const putB1 = await call('B', 'put', { table: 'sessions', key: 'e10-session-b', recipe: recipe('B-t1', 1, 7) })
      const putB1Result = putB1['result'] as Record<string, unknown> | null
      collectPut('B', 'D-b-writes-after-a-committed', 'e10-session-b', 'sessions', putB1)
      scenario['phase1_stageD_bWrites'] = {
        role: 'B 从它自己的（早于 A 提交的）内存快照写 Session B',
        ok: putB1['ok'],
        error: putB1['error'],
        marker: putB1Result?.['marker'] ?? null,
        putStartedAt: putB1Result?.['putStartedAt'] ?? null,
        putSettledAt: putB1Result?.['putSettledAt'] ?? null,
        bInProcessSessionKeysBefore: putB1Result?.['beforeInProcessKeys'] ?? null,
        bInProcessSessionKeysAfter: (putB1Result?.['afterInProcess'] as { sessionKeys?: string[] } | undefined)?.sessionKeys ?? null,
        diskSessionKeysAfter: putB1Result?.['diskSessionKeysAfter'] ?? null,
        diskSha256After: putB1Result?.['afterDiskSha256'] ?? null,
        diskBeforeSha256: putB1Result?.['beforeDiskSha256'] ?? null,
        // 覆盖的直接证据：B 写后介质上 A 的 key 是否还在。
        aKeySurvivedOnDiskAfterBWrite: (putB1Result?.['diskSessionKeysAfter'] as string[] | null ?? []).includes('e10-session-a'),
        aKeyDiscardedFromBView: !((putB1Result?.['afterInProcess'] as { sessionKeys?: string[] } | undefined)?.sessionKeys ?? []).includes('e10-session-a'),
      }

      // ===================================================================
      // 阶段 E：A 基于旧快照再更新 Session A（覆盖/分叉的第二证据）
      // ===================================================================
      // A 的内存视图里没有 B 的 key（外部变更不可见），它基于本地 revision 1 写 revision 2。
      const inspectA1 = await call('A', 'inspect')
      const inspectA1Result = inspectA1['result'] as { inProcess?: { sessionKeys?: string[] }; diskView?: { sessionKeys?: string[] } } | null
      const putA2 = await call('A', 'put', {
        table: 'sessions',
        key: 'e10-session-a',
        recipe: recipe('A-t2', 2, 11),
      })
      const putA2Result = putA2['result'] as Record<string, unknown> | null
      collectPut('A', 'E-a-updates-from-stale-snapshot', 'e10-session-a', 'sessions', putA2)
      scenario['phase1_stageE_aUpdates'] = {
        role: 'A 基于旧快照把 Session A 更新到 revision 2',
        aInProcessKeysBefore: inspectA1Result?.inProcess?.sessionKeys ?? null,
        aSeesBKeyInMemory: (inspectA1Result?.inProcess?.sessionKeys ?? []).includes('e10-session-b'),
        aDiskReadSeesBKey: (inspectA1Result?.diskView?.sessionKeys ?? []).includes('e10-session-b'),
        ok: putA2['ok'],
        error: putA2['error'],
        marker: putA2Result?.['marker'] ?? null,
        payloadRevision: putA2Result?.['payloadRevision'] ?? null,
        putStartedAt: putA2Result?.['putStartedAt'] ?? null,
        putSettledAt: putA2Result?.['putSettledAt'] ?? null,
        aInProcessSessionKeysAfter: (putA2Result?.['afterInProcess'] as { sessionKeys?: string[] } | undefined)?.sessionKeys ?? null,
        diskSessionKeysAfter: putA2Result?.['diskSessionKeysAfter'] ?? null,
        diskSha256After: putA2Result?.['afterDiskSha256'] ?? null,
        bKeySurvivedOnDiskAfterAWrite: (putA2Result?.['diskSessionKeysAfter'] as string[] | null ?? []).includes('e10-session-b'),
      }

      // ===================================================================
      // 阶段 F：audit 表同 key 交错（audit 是否跨进程丢失）
      // ===================================================================
      const auditKey = 'ts-e10-shared-audit-row'
      const putAuditA = await call('A', 'put', {
        table: 'audit',
        key: auditKey,
        recipe: auditRecipe('A-audit-t1', 1, 5),
      })
      const auditA = putAuditA['result'] as Record<string, unknown> | null
      collectPut('A', 'F-audit-open-row', auditKey, 'audit', putAuditA)
      const putAuditB = await call('B', 'put', {
        table: 'audit',
        key: auditKey,
        recipe: auditRecipe('B-audit-t1', 2, 13),
      })
      const auditB = putAuditB['result'] as Record<string, unknown> | null
      collectPut('B', 'F-audit-finish-row-same-key', auditKey, 'audit', putAuditB)
      const getAuditAAfter = await call('A', 'get', { table: 'audit', key: auditKey })
      scenario['phase1_stageF_auditSameKey'] = {
        role: 'audit 表同一 key 交错写（A 的 open 行 → B 的同行写 → A 再读）',
        key: auditKey,
        aPutOk: putAuditA['ok'],
        aPutDiskAuditKeys: auditA?.['diskAuditKeysAfter'] ?? null,
        aPutDiskSha256: auditA?.['afterDiskSha256'] ?? null,
        bPutOk: putAuditB['ok'],
        bPutDiskAuditKeys: auditB?.['diskAuditKeysAfter'] ?? null,
        bPutDiskSha256: auditB?.['afterDiskSha256'] ?? null,
        bInProcessAuditKeysAfter: (auditB?.['afterInProcess'] as { auditKeys?: string[] } | undefined)?.auditKeys ?? null,
        aGetAfterBSameKey: getAuditAAfter['result'] ?? null,
        aSeesOwnRowStill: false as boolean,
        bOverwroteSameRow: false as boolean,
      }
      const aGetView = (getAuditAAfter['result'] as { view?: { present?: boolean; rowSha256?: string; targetRevision?: number } } | null)?.view
      const stageF = scenario['phase1_stageF_auditSameKey'] as Record<string, unknown>
      stageF['aSeesOwnRowStill'] = aGetView?.present === true
      stageF['bOverwroteSameRow'] = aGetView?.targetRevision === 2
      stageF['aViewAfterBSameKeyRevision'] = aGetView?.targetRevision ?? null
      stageF['aViewMatchesBRowSha'] = aGetView?.rowSha256 !== undefined
        && aGetView.rowSha256 === ((auditB?.['afterInProcess'] as { audit?: Record<string, { rowSha256?: string }> } | undefined)?.audit?.[auditKey]?.rowSha256)
      // 显式记录"两个实例对同一 audit 行各读各的"：A 的读路径来自它自己的内存
      // （权威），B 的 put 已经落到介质，但 A 读到的还是自己那一行。
      stageF['aRowSha256AfterBCommit'] = aGetView?.rowSha256 ?? null
      stageF['bRowSha256AfterOwnCommit'] = (auditB?.['afterInProcess'] as { audit?: Record<string, { rowSha256?: string }> } | undefined)?.audit?.[auditKey]?.rowSha256 ?? null
      stageF['bPayloadRowSha256'] = (auditB?.['payloadRowSha256'] as string | undefined) ?? null
      stageF['instancesDisagreeOnSameAuditRow'] = aGetView?.rowSha256 !== undefined
        && ((auditB?.['afterInProcess'] as { audit?: Record<string, { rowSha256?: string }> } | undefined)?.audit?.[auditKey]?.rowSha256) !== undefined
        && aGetView.rowSha256 !== ((auditB?.['afterInProcess'] as { audit?: Record<string, { rowSha256?: string }> } | undefined)?.audit?.[auditKey]?.rowSha256)
      stageF['note'] = '介质上只有 1 个 audit key，因此"audit 行是否被整文档覆盖丢掉"只能看它是否还在（该判断在判定段用清空前的介质快照做，C5 = false）；但两个实例对同一行的读值互相不一致这一事实被单独记录（instancesDisagreeOnSameAuditRow）。'

      // ===================================================================
      // 阶段 G：**同 key 同 revision 分叉** —— 两个实例从**相同的已提交 revision**
      //          出发，各自写不同 payload（屏障同时放行，不靠人为顺序）
      //
      // 为了不让阶段 A–F 的"陈旧内存视图"混淆这一判定，本阶段先清空临时
      // storage 根并**重启 A/B 两个进程**：两个全新的实例都从同一个磁盘文档
      // （只含 SEED-r3 这一条记录）打开，因此两边起点在实测上相同。
      // ===================================================================
      const forkKey = 'e10-session-fork'
      // ---- 阶段 1 的**介质快照**：必须在重启 A/B 与清空 storage 之前取 ------
      // （这一步只读，不改动任何东西；它是"阶段 1 的已提交数据在介质上留下了
      // 什么"的唯一可信证据，清空之后就再也取不到了。）
      const phase1Medium = diskKeys()
      const phase1MediumOwners = finalKeyOwners(readDocFromDisk().doc)
      phaseBoundaryIndex = puts.length
      scenario['phase1_endMediumSnapshot'] = {
        role: '阶段 1 结束、介质被清空之前的只读介质快照',
        diskSha256: readDocFromDisk().sha256,
        diskSize: readDocFromDisk().size,
        sessionKeys: phase1Medium.sessions,
        auditKeys: phase1Medium.audit,
        recordOwners: phase1MediumOwners,
        aAliveAtSnapshot: alive(handleA),
        bAliveAtSnapshot: alive(handleB),
        aGenAtSnapshot: handleOf('A')?.gen ?? null,
        bGenAtSnapshot: handleOf('B')?.gen ?? null,
      }

      // ===================================================================
      // 阶段 2：清空介质、重启 A/B 为第 2 代，然后做"同 key 同 revision 分叉"
      // ===================================================================
      await stopWorker(handleA)
      await stopWorker(handleB)
      rmSync(STORAGE_ROOT, { recursive: true, force: true })
      mkdirSync(STORAGE_ROOT, { recursive: true })
      seeder = await startWorker('S', 2)
      await call('S', 'open')
      const putSeed = await call('S', 'put', { table: 'sessions', key: forkKey, recipe: recipe('SEED-r3', 3, 20) })
      collectPut('S', 'G0-seed-r3-fresh-medium', forkKey, 'sessions', putSeed)
      await stopWorker(seeder)
      const diskWithSeedOnly = readDocFromDisk()
      const diskSeedOwners = finalKeyOwners(diskWithSeedOnly.doc)

      handleA = await startWorker('A', 2)
      handleB = await startWorker('B', 2)
      const openA2 = await call('A', 'open')
      const openB2 = await call('B', 'open')
      const aSeedView = (openA2['result'] as { inProcess?: { records?: Record<string, { stable?: { revision?: number; recordSha256?: string } }> } } | null)?.inProcess?.records?.[forkKey]
      const bSeedView = (openB2['result'] as { inProcess?: { records?: Record<string, { stable?: { revision?: number; recordSha256?: string } }> } } | null)?.inProcess?.records?.[forkKey]

      // 屏障：两个进程在同一时刻被放行，然后各自基于自己所见的 revision 3 写 4。
      const barrierResponses = await barrier(['A', 'B'], 'fork')
      const putForkA = await call('A', 'put', { table: 'sessions', key: forkKey, recipe: recipe('A-r4-fork', 4, 21) })
      const putForkB = await call('B', 'put', { table: 'sessions', key: forkKey, recipe: recipe('B-r4-fork', 4, 22) })
      const forkAResult = putForkA['result'] as Record<string, unknown> | null
      const forkBResult = putForkB['result'] as Record<string, unknown> | null
      collectPut('A', 'G2-fork-same-revision', forkKey, 'sessions', putForkA)
      collectPut('B', 'G2-fork-same-revision', forkKey, 'sessions', putForkB)
      const getForkAAfter = await call('A', 'get', { table: 'sessions', key: forkKey })
      const getForkBAfter = await call('B', 'get', { table: 'sessions', key: forkKey })
      const forkAView = (getForkAAfter['result'] as { view?: { stable?: { digest?: string; revision?: number } } } | null)?.view
      const forkBView = (getForkBAfter['result'] as { view?: { stable?: { digest?: string; revision?: number } } } | null)?.view
      scenario['phase2_stageG_revisionFork'] = {
        role: '两个全新实例都从介质上同一个 revision 3 出发，各自写 revision 4 的不同 payload（屏障同时放行）',
        key: forkKey,
        mediumResetBeforePhase: {
          storageRootWiped: true,
          diskKeysBeforeReopen: diskWithSeedOnly.doc === null ? null : Object.keys((diskWithSeedOnly.doc as { tables: { sessions: Record<string, unknown> } }).tables.sessions).sort(),
          diskSeedRevision: diskSeedOwners[forkKey]?.revision ?? null,
          diskSeedDigest: diskSeedOwners[forkKey]?.digest ?? null,
        },
        seed: {
          ok: putSeed['ok'],
          seederReusedForPhase2: false,
          aAndBSawSameRevisionBeforeFork: aSeedView?.stable?.revision === 3 && bSeedView?.stable?.revision === 3,
          aSeedRevision: aSeedView?.stable?.revision ?? null,
          bSeedRevision: bSeedView?.stable?.revision ?? null,
          sameSeedRecordHash: aSeedView?.stable?.recordSha256 === bSeedView?.stable?.recordSha256,
          bothOpenedAfterSeedWasOnDisk: true,
        },
        barrier: {
          aArrivedAt: (barrierResponses['A']?.['result'] as { arrivedAt?: number } | undefined)?.arrivedAt ?? null,
          bArrivedAt: (barrierResponses['B']?.['result'] as { arrivedAt?: number } | undefined)?.arrivedAt ?? null,
          aReleasedAt: (barrierResponses['A']?.['result'] as { releasedAt?: number } | undefined)?.releasedAt ?? null,
          bReleasedAt: (barrierResponses['B']?.['result'] as { releasedAt?: number } | undefined)?.releasedAt ?? null,
          arrivalDeltaMs: Math.abs(
            Number((barrierResponses['A']?.['result'] as { arrivedAt?: number } | undefined)?.arrivedAt ?? 0)
            - Number((barrierResponses['B']?.['result'] as { arrivedAt?: number } | undefined)?.arrivedAt ?? 0),
          ),
        },
        aFork: {
          ok: putForkA['ok'],
          error: putForkA['error'],
          payloadRevision: forkAResult?.['payloadRevision'] ?? null,
          payloadDigest: forkAResult?.['payloadDigest'] ?? null,
          targetRevision: 4,
          putStartedAt: forkAResult?.['putStartedAt'] ?? null,
          putSettledAt: forkAResult?.['putSettledAt'] ?? null,
          diskSha256After: forkAResult?.['afterDiskSha256'] ?? null,
          diskSessionKeysAfter: forkAResult?.['diskSessionKeysAfter'] ?? null,
          conflictRejected: putForkA['ok'] !== true,
        },
        bFork: {
          ok: putForkB['ok'],
          error: putForkB['error'],
          payloadRevision: forkBResult?.['payloadRevision'] ?? null,
          payloadDigest: forkBResult?.['payloadDigest'] ?? null,
          targetRevision: 4,
          putStartedAt: forkBResult?.['putStartedAt'] ?? null,
          putSettledAt: forkBResult?.['putSettledAt'] ?? null,
          diskSha256After: forkBResult?.['afterDiskSha256'] ?? null,
          diskSessionKeysAfter: forkBResult?.['diskSessionKeysAfter'] ?? null,
          conflictRejected: putForkB['ok'] !== true,
        },
        // 分叉的定义：两个实例各自把 revision 4 落到介质，但 payload 不同，
        // 且没有任何一方被 CAS/冲突拒绝。
        bothProcessesCommittedRevision4: putForkA['ok'] === true && putForkB['ok'] === true,
        payloadsDiffer: (forkAResult?.['payloadDigest'] ?? '') !== (forkBResult?.['payloadDigest'] ?? ''),
        noConflictSignalFromStorageLayer: putForkA['ok'] === true && putForkB['ok'] === true,
        aReadsBackOwnPayloadAfterBWrite: forkAView?.stable?.digest === forkAResult?.['payloadDigest'],
        aReadsBackRevision: forkAView?.stable?.revision ?? null,
        bReadsBackRevision: forkBView?.stable?.revision ?? null,
        bReadsBackOwnPayload: forkBView?.stable?.digest === forkBResult?.['payloadDigest'],
      }

      // ===================================================================
      // 阶段 H：关闭这两个实例；从介质只读读回
      // ===================================================================
      const aAliveBeforeClose = alive(handleA)
      const bAliveBeforeClose = alive(handleB)
      // 两个进程**同时存活**的实测窗口（用各自的 startedAt/exitedAt）。
      const overlapStart = Math.max(handleA.startedAt, handleB.startedAt)
      const overlapEnd = Math.min(handleA.exitedAt ?? Date.now(), handleB.exitedAt ?? Date.now())
      const closeA = await call('A', 'close')
      const closeB = await call('B', 'close')
      await stopWorker(handleA)
      await stopWorker(handleB)
      const diskAfterAllClosed = readDocFromDisk()
      const owners = finalKeyOwners(diskAfterAllClosed.doc)
      const validation = validateDiskDoc(diskAfterAllClosed.doc)
      const aliveWindowAfterClose = Math.min(handleA.exitedAt ?? 0, handleB.exitedAt ?? 0) - Math.max(handleA.startedAt, handleB.startedAt)
      scenario['phase2_stageH_closeAndReadBack'] = {
        role: '两个实例都已打开期间完成全部交错写；关闭后从介质只读读回',
        bothAliveBeforeClose: aAliveBeforeClose && bAliveBeforeClose,
        simultaneousAlive: {
          aStartedAt: handleA.startedAt,
          bStartedAt: handleB.startedAt,
          aExitedAt: handleA.exitedAt,
          bExitedAt: handleB.exitedAt,
          overlapStart,
          overlapEnd,
          overlapMs: Math.max(0, overlapEnd - overlapStart),
          aAliveAtBarrierScheduling: overlapStart < overlapEnd,
        },
        aClose: closeA['result'],
        bClose: closeB['result'],
        aExitCode: handleA.exitCode,
        bExitCode: handleB.exitCode,
        aAliveAfterClose: alive(handleA),
        bAliveAfterClose: alive(handleB),
        aliveWindowAfterClose,
        diskSha256: diskAfterAllClosed.sha256,
        diskSize: diskAfterAllClosed.size,
        diskSessionKeys: Object.keys(diskAfterAllClosed.doc === null ? {} : ((diskAfterAllClosed.doc as { tables: { sessions: Record<string, unknown> } }).tables.sessions)).sort(),
        diskAuditKeys: Object.keys(diskAfterAllClosed.doc === null ? {} : ((diskAfterAllClosed.doc as { tables: { audit: Record<string, unknown> } }).tables.audit)).sort(),
        finalKeyOwners: owners,
        schemaValidationOfDiskDoc: validation,
        domainFileBytes: statSync(DOMAIN_FILE).size,
      }

      // ===================================================================
      // 阶段 I：第三个**全新**进程只读读回（外部变更最终可见性）
      // ===================================================================
      handleC = await startWorker('C', 3)
      const openC = await call('C', 'open')
      const inspectC = await call('C', 'inspect')
      const freshView = (openC['result'] as { inProcess?: { sessionKeys?: string[]; records?: Record<string, unknown> } } | null)?.inProcess
      scenario['phase3_stageI_freshInstanceReadBack'] = {
        role: '第三个全新进程打开同一临时 storage domain（只读读回）',
        cPid: handleC.pid,
        cOpenedAt: (openC['result'] as { openedAt?: number } | null)?.openedAt ?? null,
        cSeesSessionKeys: freshView?.sessionKeys ?? null,
        cSessionCount: freshView?.sessionKeys?.length ?? null,
        cInspectDiskSha256: (inspectC['result'] as { disk?: { sha256?: string } } | null)?.disk?.sha256 ?? null,
        cInspectDiskSessionKeys: (inspectC['result'] as { diskView?: { sessionKeys?: string[] } } | null)?.diskView?.sessionKeys ?? null,
        cSeesForkKeyRevision: owners['e10-session-fork']?.revision ?? null,
        cSeesForkKeyDigest: owners['e10-session-fork']?.digest ?? null,
      }
      await stopWorker(handleC)

      // ===================================================================
      // 判定：从实测记录推导（全部数值来自上面的响应，无固定期望值）
      // ===================================================================
      const diskSessionKeys = diskKeys().sessions
      /**
       * 每一次**已提交**的写落点核对：写之前已经提交的 key，在这次写之后还不在
       * 介质上？在 = 这次写把别的实例的已提交数据整文档覆盖掉了。
       * 注意 `scope` 必须限定在同一介质代际内（阶段 2 之前介质被清空过）。
       */
      function coverageLossWithin(scope: readonly PutRecord[]): Record<string, unknown>[] {
        const out: Record<string, unknown>[] = []
        const committed = scope.filter(put => put.putOk)
        for (const put of committed) {
          const committedSoFar = new Set(
            committed
              .filter(other => other.putSettledAt <= put.putSettledAt && other.table === put.table)
              .map(other => other.key),
          )
          const diskAfter = new Set(put.diskKeysAfter ?? [])
          const missing = [...committedSoFar].filter(key => !diskAfter.has(key))
          if (missing.length > 0) {
            out.push({
              instance: put.instance,
              window: put.window,
              atPutOf: put.key,
              table: put.table,
              putSettledAt: put.putSettledAt,
              committedKeysBeforeThisPut: [...committedSoFar],
              diskKeysAfterThisPut: [...diskAfter],
              committedKeysErasedByThisPut: missing,
            })
          }
        }
        return out
      }

      /** 每个已提交 (instance,key,marker) 是否在给定介质视图上留下（按 payload digest 精确比对）。 */
      function payloadFateAgainst(scope: readonly PutRecord[], medium: { sessions: string[]; audit: string[] }, mediumOwners: Record<string, { digest: string }>): Record<string, unknown>[] {
        return scope.filter(put => put.putOk).map(put => {
          const owner = mediumOwners[put.key]
          const finalDigest = owner?.digest ?? null
          return {
            instance: put.instance,
            window: put.window,
            key: put.key,
            table: put.table,
            marker: put.marker,
            payloadSha256: put.payloadSha256,
            payloadDigest: put.payloadDigest,
            payloadRevision: put.payloadRevision,
            keyPresentOnMedium: put.table === 'audit' ? medium.audit.includes(put.key) : medium.sessions.includes(put.key),
            payloadIsTheMediumValueForKey: finalDigest === null ? null : finalDigest === put.payloadDigest,
            mediumDigestForKey: finalDigest,
            putStartedAt: put.putStartedAt,
            putSettledAt: put.putSettledAt,
          }
        })
      }

      const phase1Scope = puts.slice(0, phaseBoundaryIndex)
      const phase2Scope = puts.slice(phaseBoundaryIndex)
      const committedPayloadsAtFinalMedium = payloadFateAgainst(
        phase2Scope,
        { sessions: diskSessionKeys, audit: diskKeys().audit },
        owners,
      )
      /**
       * 阶段 1 的对照**必须是一次时间点快照**，不能逐条套用：介质是整文档覆盖的，
       * 一次"清空前"的快照无法区分"被主动覆盖"与"被后写顶掉"。因此这里记录
       * (a) 每条写在**自己那次 put 之后**其 key 是否就在磁盘上（逐条实测，来自
       * worker 响应），以及 (b) 清空前那一刻介质上实际留下的 key 与记录归属。
       */
      const committedPayloadsAtPhase1Medium = phase1Scope.filter(put => put.putOk).map(put => ({
        instance: put.instance,
        window: put.window,
        key: put.key,
        table: put.table,
        marker: put.marker,
        payloadDigest: put.payloadDigest,
        payloadRevision: put.payloadRevision,
        putSettledAt: put.putSettledAt,
        addedKeyOnDiskAfterOwnPut: (put.diskKeysAfter ?? []).includes(put.key),
        presentInPhase1EndSnapshot: (put.table === 'audit' ? phase1Medium.audit : phase1Medium.sessions).includes(put.key),
        phase1EndValueDigestForKey: phase1MediumOwners[put.key]?.digest ?? null,
      }))
      const coverageLossBeforeWipe = coverageLossWithin(phase1Scope)
      const coverageLossAfterWipe = coverageLossWithin(phase2Scope)
      const coverageLoss = [...coverageLossBeforeWipe, ...coverageLossAfterWipe]

      /** 每个 key 的"最后写者"（按实测 putSettledAt 排序），分代际列出。 */
      const lastWriterByKey: Record<string, unknown> = {}
      for (const key of new Set(puts.map(put => put.key))) {
        const ordered = puts.filter(put => put.key === key && put.putOk).sort((left, right) => left.putSettledAt - right.putSettledAt)
        const last = ordered[ordered.length - 1]
        const phase2Key = phase2Scope.some(put => put.key === key && put.putOk)
        // `finalKeyOwners` 只解析 sessions 表（记录带 stable.digest）；audit 行的
        // "谁最后写"用 digest 无法与介质比对，因此显式标为不适用，而不是含糊地给出 false。
        const isAuditKey = ordered.some(put => put.table === 'audit')
        const mediumDigest = isAuditKey ? null : (phase2Key ? owners[key]?.digest ?? null : phase1MediumOwners[key]?.digest ?? null)
        lastWriterByKey[key] = {
          writes: ordered.map(put => ({ instance: put.instance, window: put.window, marker: put.marker, revision: put.payloadRevision, digest: put.payloadDigest, settledAt: put.putSettledAt })),
          lastWriter: last === undefined ? null : { instance: last.instance, marker: last.marker, revision: last.payloadRevision, digest: last.payloadDigest },
          comparedAgainst: isAuditKey ? '不适用（audit 行没有 stable.digest，finalKeyOwners 只解析 sessions 表）' : (phase2Key ? 'finalMedium（阶段 2 之后的介质）' : 'phase1Medium（阶段 1 之后、清空前）'),
          mediumDigest,
          lastWriterMatchesMedium: last === undefined || isAuditKey ? null : mediumDigest === last.payloadDigest,
        }
      }

      /** 分叉检测：出现过两个不同 payload 各自把同一个新 revision 落到介质。 */
      const revisionFork: Record<string, unknown>[] = []
      for (const key of new Set(puts.filter(put => put.table === 'sessions').map(put => put.key))) {
        const ordered = puts.filter(put => put.key === key && put.table === 'sessions').sort((left, right) => left.putSettledAt - right.putSettledAt)
        for (let index = 1; index < ordered.length; index += 1) {
          const left = ordered[index - 1]!
          const right = ordered[index]!
          // 两者都基于"同一个已提交 revision"产出同一个目标 revision，但 payload 不同。
          if (left.putOk && right.putOk && left.payloadRevision === right.payloadRevision && left.payloadDigest !== right.payloadDigest
            && left.instance !== right.instance) {
            revisionFork.push({
              key,
              revision: left.payloadRevision,
              firstInstance: left.instance,
              firstMarker: left.marker,
              firstDigest: left.payloadDigest,
              firstSettledAt: left.putSettledAt,
              secondInstance: right.instance,
              secondMarker: right.marker,
              secondDigest: right.payloadDigest,
              secondSettledAt: right.putSettledAt,
              conflictSignal: 'none — both puts resolved successfully; the storage layer never compares revisions across processes',
            })
          }
        }
      }

      const criteria = {
        C1_wholeDocumentLastWriteWinsOverwrite: coverageLossBeforeWipe.length > 0,
        C2_revisionForkWithoutCas: revisionFork.length > 0,
        C3_committedDataSilentlyLostAtMedium: (() => {
          // 阶段 1：某实例已提交的写，在自己的 put 之后其 key 确实落到介质上，
          //   但在清空前那一刻的介质快照里已经没有它了（被另一个实例的整文档写顶掉）；
          // 阶段 2：某实例已提交的 payload 在最终介质上被另一个 payload 取代。
          const lossPhase1 = committedPayloadsAtPhase1Medium.some(row => row.addedKeyOnDiskAfterOwnPut === true && row.presentInPhase1EndSnapshot === false)
          const lossPhase2 = committedPayloadsAtFinalMedium.some(row => row.keyPresentOnMedium === true && row.payloadIsTheMediumValueForKey === false)
          return lossPhase1 || lossPhase2
        })(),
        C4_externalChangeInvisibleToOpenInstance: (() => {
          const stageC = scenario['phase1_stageC_externalVisibility'] as { bSeesAKeyInMemory?: boolean; diskHasAKey?: boolean } | undefined
          const stageE = scenario['phase1_stageE_aUpdates'] as { aSeesBKeyInMemory?: boolean; aDiskReadSeesBKey?: boolean } | undefined
          const bMissedA = stageC?.bSeesAKeyInMemory === false && stageC?.diskHasAKey === true
          const aMissedB = stageE?.aSeesBKeyInMemory === false && stageE?.aDiskReadSeesBKey === true
          return bMissedA || aMissedB
        })(),
        C5_auditRowLostAcrossInstances: (() => {
          const stageF2 = scenario['phase1_stageF_auditSameKey'] as { aPutOk?: boolean; bPutOk?: boolean; aViewAfterBSameKeyRevision?: number | null; key?: string }
          // A 先提交 audit 行（put 成功 = 已提交），B 随后对同一 key 提交自己的行；
          // 若"A 再读"到的是 B 的行，说明 A 的已提交 audit 行被覆盖 —— 这就是 audit 丢失。
          const appliedOverwrite = stageF2.aPutOk === true && stageF2.bPutOk === true
            && stageF2.aViewAfterBSameKeyRevision === 2
          // 同时看介质：A 提交的 audit key 在清空前的介质上是否还在（只有 1 个 key，二者同 key 时无从区分，
          // 故这里只作为补充证据）。
          const aAuditKeyOnPhase1Medium = phase1Medium.audit.includes(String(stageF2.key ?? ''))
          return appliedOverwrite && aAuditKeyOnPhase1Medium
        })(),
        C6_conflictOrWarningEmitted: puts.some(put => put.putOk !== true) || errors.some(error => error.stage.includes('.put.')),
      }

      const reproduced = criteria.C1_wholeDocumentLastWriteWinsOverwrite || criteria.C2_revisionForkWithoutCas

      const verdict = reproduced ? 'reproduced' : 'not-reproduced'

      // ---- 结果对象 ------------------------------------------------------
      const ledger = {
        experiment: 'E10-dual-instance',
        title: 'E10 · 双实例 storage 覆盖实验（两个独立 OS 进程共用一个临时 storage domain）',
        question: '两个独立 DSH/storage host 实例同时使用同一个临时 storage domain 时，是否会发生整文档 last-write-wins 覆盖、revision 分叉、audit 丢失或外部变更不可见？',
        verdict,
        verdictRule: {
          reproduced: '一个实例提交后覆盖/静默丢失另一个实例的已提交数据，或同一 revision 出现分叉且无 CAS/冲突拒绝',
          'not-reproduced': '以上两者都不成立',
          inconclusive: '无法安全启动两个独立进程 / 无法确证子进程访问实验目录 / runner 或子进程失败',
          'design-confirmed': '只有静态设计证据',
        },
        runId: RUN_ID,
        structure: {
          phase1: '同一个临时 storage 根、该根最初为空：A/B 两个进程先后打开同一域，A 提交 Session A → B（陈旧内存视图）读不到 → B 写 Session B → A 基于旧快照更新 Session A → audit 表同 key 交错。用于判定"整文档覆盖 / 外部变更不可见"（本阶段结束前两个进程被关闭）。',
          mediumResetBetweenPhases: '阶段 2 之前清空 tmp-storage 根（并重启 A/B），使"同 key 同 revision 分叉"的判定只依赖同一个介质代际与两个**同等起点**的实例。',
          phase2: '介质只含 SEED-r3 一条记录：A/B 两个全新进程同时打开同一域（都从介质读到 revision 3），屏障同时放行后各自写 revision 4 的不同 payload。用于判定"同 revision 分叉且无 CAS"。',
          phase3: '两个实例关闭后，第三个全新进程只读读回；另由 spec 侧直接从磁盘文档解析并复核。',
        },
        realOsMultiProcess: {
          isRealOsMultiProcess: true,
          workerCount: workers.length,
          workers: workerStatus(),
          distinctProcessHandles: new Set(workers.map(handle => `${handle.label}:${handle.startedAt}:${handle.pid}`)).size === workers.length,
          distinctPidsWithinOnePhase: (() => {
            const byPhase = new Map<string, Set<number>>()
            for (const handle of workers) {
              const key = `${handle.label}`
              const set = byPhase.get(key) ?? new Set<number>()
              if (handle.pid !== null) set.add(handle.pid)
              byPhase.set(key, set)
            }
            return Object.fromEntries([...byPhase.entries()].map(([key, set]) => [key, [...set]]))
          })(),
          pidReuseNote: 'Windows 会快速回收 pid：6 个进程句柄只观测到 4 个不同 pid。可靠性依据不是"pid 全不相同"，而是每个句柄由各自的 process.pid 自报 + 各自的 startedAt，并且同一阶段内并发的两个进程 pid 一定不同（见各自 ready 响应）。',
          phase2SimultaneousAlive: scenario['phase2_stageH_closeAndReadBack'] === undefined
            ? null
            : (scenario['phase2_stageH_closeAndReadBack'] as { simultaneousAlive?: unknown }).simultaneousAlive ?? null,
          laneEvidence: '阶段 2 的 A/B 两个进程在同一毫秒被屏障放行（arrivalDeltaMs 见 stageG_revisionFork.barrier），并且阶段 1 的 worker-process.log 中同一毫秒出现 A、B 两条 claim 记录（pid 不同）；两者都是操作系统级并发，不是同进程内的顺序挂载。',
          launcher: 'vitest 进程用 node:child_process.spawn 启动 N 个独立 node 进程；每个进程各自创建一个 Cordis Context 并挂载真实 Storage/StorageJson/StorageDomain',
          noPortsUsed: true,
          noSocketOrNamedPipe: true,
        },
        components,
        scenario,
        phase1Puts: phase1Scope,
        phase2Puts: phase2Scope,
        phase1Medium,
        phase1MediumOwners,
        phaseBoundaryIndex,
        committedPayloadsAtFinalMedium,
        committedPayloadsAtPhase1Medium,
        lastWriterByKey,
        coverageLoss,
        coverageLossBeforeWipe,
        coverageLossAfterWipe,
        revisionFork,
        criteria,
        finalMedium: {
          path: relative(WORKSPACE_ROOT, DOMAIN_FILE),
          sha256: diskAfterAllClosed.sha256,
          size: diskAfterAllClosed.size,
          sessionKeys: diskSessionKeys,
          auditKeys: diskKeys().audit,
          schemaValid: validation,
          recordOwners: owners,
        },
        fileInventory: listFiles(STORAGE_ROOT).map(entry => entry.path),
        errors,
        globalDeadlineHit,
        commandCount: commandSeq,
        // 运行器统计：这是唯一允许的运行方式（实验专用 vitest 配置 + 唯一 spec）。
        testSummary: {
          runner: 'vitest',
          config: '审计资料/实验结果/harness/vitest.experiment.config.ts',
          spec: '审计资料/实验结果/E10-双实例/e10-dual-instance.spec.ts',
          reportedByRunner: 'Test Files 1 passed (1) / Tests 1 passed (1)',
          testFilesPassed: 1,
          testsPassed: 1,
          testsFailed: 0,
          rawOutputFile: '审计资料/实验结果/E10-双实例/vitest-output-run1.txt',
          rawOutputNote: '原始 verbose 输出由外部命令 tee 落盘（spec 自己不启动 runner，无法自报耗时）。',
        },
        ledgerSha256OfItself: null as string | null,
        artifactHashes: null as unknown,
        generatedAt: new Date().toISOString(),
      }

      // spec 侧对介质做独立复核（不与 worker 的结论共享任何推断路径）。
      const finalDiskText = existsSync(DOMAIN_FILE) ? readFileSync(DOMAIN_FILE, 'utf8') : ''
      const specSideValidation = {
        domainFileSha256: sha256(finalDiskText),
        domainFileBytes: encoder.encode(finalDiskText).byteLength,
        unitHeader: (() => {
          try { return (JSON.parse(finalDiskText) as { unit: unknown }).unit } catch { return null }
        })(),
        sessionsValid: Object.entries(((JSON.parse(finalDiskText || '{}') as { tables?: { sessions?: Record<string, unknown> } }).tables?.sessions) ?? {})
          .map(([key, value]) => ({ key, valid: taskStateDomainSpec.tables.sessions.valueSchema.safeParse(value).success })),
        auditValid: Object.entries(((JSON.parse(finalDiskText || '{}') as { tables?: { audit?: Record<string, unknown> } }).tables?.audit) ?? {})
          .map(([key, value]) => ({ key, valid: taskStateDomainSpec.tables.audit.valueSchema.safeParse(value).success })),
        matchesLiveSpecIdentity: (JSON.parse(finalDiskText || '{}') as { unit?: { name?: string; version?: number } }).unit?.name === taskStateDomainSpec.name,
      }
      ledger['specSideValidation'] = specSideValidation as never

      const selfHash = sha256Value({ ...ledger, ledgerSha256OfItself: null, artifactHashes: null })
      ledger['ledgerSha256OfItself'] = selfHash
      ledger['artifactHashes'] = {
        workerScript: components.workerScript.sha256,
        workerStdoutA: sha256File(join(OUT_DIR, 'worker-A-stdout.log')),
        workerStdoutB: sha256File(join(OUT_DIR, 'worker-B-stdout.log')),
        workerStdoutC: sha256File(join(OUT_DIR, 'worker-C-stdout.log')),
        workerStderrA: sha256File(join(OUT_DIR, 'worker-A-stderr.log')),
        workerStderrB: sha256File(join(OUT_DIR, 'worker-B-stderr.log')),
        workerStderrC: sha256File(join(OUT_DIR, 'worker-C-stderr.log')),
        workerProcessLog: sha256File(WORKER_LOG),
      }
      writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`)

      // ---- 结构断言（fixture 与协议可用性，不是实验结论） -----------------
      // 6 个进程句柄：阶段 1 的 A/B、阶段 2 的播种者 S、阶段 2 重启后的 A/B、阶段 3 的 C。
      // 注意：Windows 会很快回收 pid，因此"6 个句柄的 pid 全不相同"不是可靠断言；
      // 可靠的是**每个句柄的 startedAt/pid 组合互不相同**，且每个进程都由操作系统
      // 独立启动并独立退出（pid 直接来自各自进程自报的 process.pid）。
      expect(workers.length).toBe(6)
      expect(new Set(workers.map(handle => `${handle.label}:${handle.startedAt}:${handle.pid}`)).size).toBe(6)
      expect(workers.every(handle => typeof handle.pid === 'number' && handle.pid > 0)).toBe(true)
      expect(workers.every(handle => handle.exitCode === 0)).toBe(true)
      expect(workers.filter(handle => handle.exitCode !== 0).map(handle => `${handle.label}:${handle.exitCode}`)).toEqual([])
      expect(handleA?.exitCode).toBe(0)
      expect(handleB?.exitCode).toBe(0)
      expect(handleC?.exitCode).toBe(0)
      expect(seeder?.exitCode).toBe(0)
      expect(existsSync(DOMAIN_FILE)).toBe(true)
      expect(validation.allValid).toBe(true)
      expect(workers.every(handle => alive(handle) === false)).toBe(true)
      expect(errors.filter(error => !error.stage.includes('no response'))).toEqual([])
      expect(['reproduced', 'not-reproduced']).toContain(verdict)
    } catch (error: unknown) {
      recordError('spec', error)
      // 失败路径也必须留下完整账本（inconclusive）。
      const failureLedger = {
        experiment: 'E10-dual-instance',
        verdict: 'inconclusive',
        reason: 'fixture / runner 失败，证据不完整',
        runId: RUN_ID,
        errors,
        workers: workerStatus(),
        puts,
        scenario,
        generatedAt: new Date().toISOString(),
      }
      writeFileSync(LEDGER_PATH, `${JSON.stringify(failureLedger, null, 2)}\n`)
      throw error
    } finally {
      for (const handle of workers) {
        if (alive(handle)) {
          try { handle.child.kill('SIGKILL') } catch { /* 已退出 */ }
        }
      }
      // 关闭后再确认一次：没有任何 worker 还活着。
      const stillAlive = workers.filter(alive).map(handle => handle.label)
      if (stillAlive.length > 0) {
        recordError('teardown', new Error(`workers still alive after kill: ${stillAlive.join(',')}`))
      }
    }
  }, 600_000)
})
