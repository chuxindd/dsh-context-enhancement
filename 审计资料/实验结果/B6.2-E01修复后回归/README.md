# B6.2-E01 修复后回归 · 证据目录

> 范围：**只执行 B6.2**（工具摘要 audit 的 `open/success/fallback/repair` 状态机、丢失/损坏/重启降级）。
> 上游权威：**B6.1 的 Session provenance 是唯一类型权威，本批次不撤销、不削弱它**。
> 结论：B6.2 目标达成；**B6 整体不因本批次而完成**（本目录不得被引用为 B6 完成的证据）。

---

## 1. 这个目录是什么（以及不是什么）

本目录名 `B6.2-E01修复后回归` 指的是：**E01（工具预释放）实验所暴露的 audit 语义，在 B6.2 修复之后的回归证据**。

它**不是** E01 harness 的重跑：

| E01 相关材料 | 本批次处置 | 原因 |
| --- | --- | --- |
| `审计资料/实验结果/E01-工具预释放/e01-tool-pre-release.spec.ts` | **未重跑、未修改** | 该文件属历史实验材料（禁改）；其 fake pruner 不写 provenance，按 B6.1 起的 fail-closed 契约其观测会**合法漂移**（`tool-pruned` → `unknown-replacement`） |
| `审计资料/实验结果/E01-工具预释放/result.json` | **未改写** | 历史结果不得被本批次覆盖；如需重测应在新的实验编号下进行（即本目录） |
| E01 harness 的 audit 断言语义 | 由本目录 §3 的**真实介质**测试替代覆盖 | E01 用内存 fake audit store；B6.2 的关键性质（重启后可判、LWW 覆盖、损坏文档）必须在真实 `Session` + 真实 JSONL + 真实 `dsh-storage` domain 上才能成立 |

默认测试配置 `include: ['tests/**/*.spec.ts']` 本就不包含 `审计资料/实验结果/**`，因此 E01 历史 spec 从未、也不再参与本包全量；本目录的 spec 位于 `tests/`，参与全量。

---

## 2. 本批次覆盖的 8 类要求 → 证据位置

| # | 任务要求 | 证据（`tests/compaction-tool-audit-recovery.spec.ts`） |
| --- | --- | --- |
| 1 | audit 是诊断/调度，不是类型权威 | 全部 10 例；特别是 T6/T7 在 audit 被删除/被他人整体覆盖后，`buildSurfaceSourceIndex` 仍从 Session provenance 得出 `tool-summary` |
| 2 | `open→success/fallback/repair` 状态机可持久恢复；重启后 `open` 必须可判为 `aborted`/可修复，**绝不能伪造为已提交** | T1（真实 JSONL + 真实 audit domain 重启：`open` → 持久 `aborted` → 增量采纳 `attempt:2` → `success`）、T2 |
| 3 | audit 丢失但 Session provenance 完整 ⇒ 分类不变、调度按安全策略运行 | T6（含正向对照：新原始 run 照常被摘要）、T7 |
| 4 | audit 损坏/与 Session 冲突 ⇒ `unknown`/fail closed；repair 不得提升类型或跳过源校验 | T4（冲突裁决 + 撤回认领后 Session 真相恢复）、T5（无证据拒绝 repair）、T8（文档损坏 → 拒绝打开） |
| 5 | 写入失败/LWW 覆盖/进程中断必须有终态或显式诊断；"audit 缺失"绝不可读作 `tool-pruned`/`original` | T6/T7（`audit-landing-unrecorded`）、T9（retry 成功）、T10（`audit-write-failed` + `attempts-exhausted`） |
| 6 | 轮内 op1/op2 互斥、重启后仍成立；已落地 summary 不被 pruner 二次处理 | T6（候选集 = 非 original 才被排除，精确而非一刀切）、T10（同 span 第二次 pass 0 次模型调用） |
| 7 | 多实例沿用 B1 风险，不伪造 CAS；需要上游 API 时记 `blocked-specific-api` | T2（他人 `open` 行只判 `aborted`，绝不判提交）、T7（真实双写者 LWW 丢行）；见 §5 |
| 8 | 先做真实 StorageDomain/JSONL 能力核查；不得用内存互斥/时间戳伪造修复 | 全部用例均落在真实 `Context` + `StorageJson` + `StorageDomain` + `SessionStore` + `JsonlSessionPersistence` 上；重启 = dispose 一个 Context、在同一介质上另开一个 |

---

## 3. 本目录的测试与命令（可复跑）

| 命令 | 结果 | 原始输出 |
| --- | --- | --- |
| `npx vitest run tests/compaction-tool-audit-recovery.spec.ts` | **10/10 通过** | `evidence/vitest-tool-audit-batch.txt`（含该文件） |
| `npx vitest run`（11 个工具/审计相关 spec 同批） | **70/70 通过** | `evidence/vitest-tool-audit-batch.txt` |
| `npx vitest run`（17 个压缩/压力/回归 spec 同批） | **164/164 通过** | `evidence/vitest-compaction-pressure-batch.txt` |
| `npx tsc -p tsconfig.json --noEmit` | **0 错误** | `evidence/tsc.txt` |
| `npx vitest run`（全量） | **59 文件 / 541 例：540 通过 / 1 失败** | `evidence/vitest-full-suite.txt` |
| `npx vitest run tests/artifact-parity.spec.ts` | 5 例中 1 例失败（**既有陈旧产物，单列**） | `evidence/artifact-parity.txt` |

### 3.1 唯一失败项（与本批次无关，单列）

`tests/artifact-parity.spec.ts:128` `verifies lib/client.js contains patched module id`：
断言 `lib/client.js` 不含 `@deepseek-ai/dsh-client-ui-jobs`。实测：

- `lib/client.js` mtime `2026-09-11T01:49:09.9083010Z`、sha256 `092384a0471281947960499787ea0ca438c9ea12b2c9524bf722d14d7033e231`；
- `dsh-context-enhancement-0.1.10.tgz` mtime `2026-09-10T12:51:02Z`；`package.json` mtime `2026-09-08T02:48:36Z`；
- 本批次全部编辑发生在 `2026-09-13T08:27Z` 之后，且**未**重建 `lib/`/`.tgz`（禁止修改）。

该 spec 完全不读 `src/`，物理上不可能受本批次影响。按任务要求单列，不计入 B6.2 业务回归结论。

---

## 4. 变异校验（证明测试有效，而非仅"恰好通过"）

`evidence/mutation-checks.json` 记录两次受控变异：

1. 去掉 audit 写入的有界重试（`TOOL_GROUP_AUDIT_WRITE_ATTEMPTS: 2 → 1`）→ 瞬时写入失败用例**失败**（envelope：无任何持久行）；
2. 让 `abortToolGroupAudit` 返回 `success`（伪造提交）→ **3 例失败**（所有"绝不伪造已提交"的用例）。

两次变异均已回滚，回滚后 sha256 与变异前**逐字节相同**，且新 spec 恢复 10/10 通过。

---

## 5. 诚实边界（blocked / 未验证）

1. **`blocked-specific-api`：上游存储契约没有 CAS/版本/刷新原语。** 实测 `@deepseek-ai/dsh-storage` 的 `KvUnit`（`loadAll`/`putRecord`/`deleteRecord`/`setGlobal`/`close`）与 `KvTable`（`get`/`put`/`update`/`delete`/`entries`）**没有** revision、etag、compare-and-swap 或 reload；`layout:'single'` 是整篇文档 LWW，且域内存是权威、无过期检测。因此：
   - "同一进程内另一个写者覆盖了我的行"**无法被检测**，只能在其**重启后**表现为"Session provenance 证明落地、而 audit 无对应行"（`audit-landing-unrecorded`，T7 用**真实双写者**复现该 LWW）；
   - `open` 行属于"重启"还是"并发写者"**在本进程内不可区分**，所以唯一诚实的裁决是 `aborted`（可修复、绝不当作已提交，T2）；
   - 要真正仲裁需要上游提供版本/CAS/刷新 API；本批次**不伪造**（不使用内存互斥、时间戳或进程内锁冒充）。该缺口沿用 B1 的 `blocked-specific-api` 记录，本批次不视为已解决。
2. **未做**：B1（多实例 CAS）、B7/B8、`lib/`/`.tgz` 重建与对账。
3. **未改**：DSH checkout（HEAD `a66e4702047846cdaa10c66c9d3df3951f5ea70d`，`git status --porcelain` 0 行）；task-state 语义与存储；历史 `E01–E10` 结果与 `40/41` 审计文档；未执行任何 `reset/clean/checkout/stash`。
4. **B6 整体未完成**：本批次完成的是 **B6.2**；B6.1 由前一批次完成并保持有效。任何引用本目录的结论**只限 B6.2 范围**。

---

## 6. evidence 目录清单

| 文件 | 内容 |
| --- | --- |
| `evidence/vitest-tool-audit-batch.txt` | 11 个工具/审计 spec（含新 spec）原始输出：70/70 |
| `evidence/vitest-compaction-pressure-batch.txt` | 17 个压缩/压力/回归 spec 原始输出：164/164 |
| `evidence/vitest-full-suite.txt` | 全量原始输出：540/541（唯一失败为 artifact parity） |
| `evidence/tsc.txt` | `tsc --noEmit` 输出（0 错误） |
| `evidence/artifact-parity.txt` | artifact parity 单列原始输出 |
| `evidence/source-hashes.json` | 本批次变更文件与禁改文件的 sha256/bytes/mtime/行尾/BOM 实测 |
| `evidence/git-head.txt` | 插件仓库 HEAD |
| `evidence/git-status-src-tests.txt` | 插件仓库 `src/`、`tests/`、`docs/` 累积改动清单（含前序批次遗留，非本批次全部） |
| `evidence/mutation-checks.json` | 两次受控变异与回滚证明 |
