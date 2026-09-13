# 42 文件级修复 PLAN

> 状态：实施计划，尚未修改生产源码。
> 作者与验收：主代理亲自编写；后续每个批次由主代理按本文件验收。
> 目标基线：插件 `cf034b4bce6141bb95b590f5ed7fa66f8727daa2`，DSH `a66e4702047846cdaa10c66c9d3df3951f5ea70d`。
> 证据来源：`审计资料/40-实验结果差异矩阵.md`、`审计资料/41-缺陷与风险清单.md`、`审计资料/实验结果/E01-工具预释放/`、`E03-压力抖动/`、`E07-重启积压/`、`E08-Stable注入累积/`、`E09-ForkResume/`、`E10-双实例/`。

## 0. 计划边界

本文件把已经有证据支持的问题转换为可执行的文件级批次。它不把未完成实验写成已证实缺陷，也不把 E09 的 `not-reproduced` 写成 fork/resume 数据损坏。

固定口径：

- fixture token 不等于 provider token；
- 受控实验通过不等于理想方案通过；
- E01 的两个 verdict 必须成对保留；
- E02 的 whole-zone/必跨区表述已被动态反证，后续实现和注释不得继续使用该表述；
- E08 只证明未挂压缩插件时的注入累积，压缩后的回收仍需独立回归；
- P0/P1/P2 是实施优先级，不是证据等级。

## 1. 总体处理顺序

```text
B0 证据与测试交付闭环
→ B1 存储多实例 fail-closed / CAS / fresh read
→ B2 Stable 生命周期键与提交 fence
→ B3 pressure 预算、退出线、低收益和回收账本
→ B4 startup backlog 与 Goal/TODO 权威触发
→ B5 Stable 固定槽位注入与回收
→ B6 工具摘要 provenance 与 audit 恢复
→ B7 fork child cursor/bootstrap 契约
→ B8 artifact parity 与宿主装配验证
```

B1、B2 完成并通过隔离回归前，不得把多实例支持宣称为可用；B3–B5 可在隔离单实例环境开发，但最终验收必须包含 B1 的存储约束，因为压力和长期状态都依赖权威提交与新鲜度。

## 2. 批次 B0：证据与测试交付闭环

### 目标

把 E02/E04/E05/E06 从阶段评审级补成可复算实验，并建立修复前回归基线；不改变业务行为。

### 文件范围

新增或补齐：

- `审计资料/实验结果/E02-压力回落/README.md`
- `审计资料/实验结果/E02-压力回落/result.json`
- `审计资料/实验结果/E02-压力回落/e02-ledger.json`
- `审计资料/实验结果/E04-Step边界/README.md`
- `审计资料/实验结果/E04-Step边界/result.json`
- `审计资料/实验结果/E04-Step边界/e04-ledger.json`
- `审计资料/实验结果/E05-Goal大改/README.md`
- `审计资料/实验结果/E05-Goal大改/result.json`
- `审计资料/实验结果/E05-Goal大改/e05-ledger.json`
- `审计资料/实验结果/E06-Todo清空/README.md`
- `审计资料/实验结果/E06-Todo清空/result.json`
- `审计资料/实验结果/E06-Todo清空/e06-ledger.json`

不得修改生产源码、既有 harness 或 E01/E03/E07/E08/E09/E10 结果。

### 验收

- 每项都有准确命令、环境、fixture、逐用例结果、判定和限制；
- E02 明确记录“按 deficit 选安全前缀”，不得写 whole-zone；
- E04 明确区分 design-confirmed 与真实影响未证实；
- E05/E06 明确 fake worker environment 限制；
- 结果可独立读取，`sourceDrift=false`；
- E00 artifact parity 失败继续单列，不纳入业务回归统计。

## 3. 批次 B1：存储多实例 fail-closed、CAS 与新鲜度

### 问题依据

R-P0-1、R-P0-2、R-P0-3、R-P0-4；E10 真实 OS 多进程实验已复现整文档 LWW 覆盖、同 revision 分叉、静默丢失和打开实例 stale view。

### 目标不变量

- 单写 JSON 模式必须显式 `singleWriterOnly`，第二写者不能静默运行；
- 多实例提交必须带 `expectedRevision/baseRevision`，同 revision 只有一方成功；
- 冲突必须返回结构化 conflict 或 fail closed，不能返回普通成功；
- 外部提交在约定时机可重新读取，内存快照不能继续作为无条件权威；
- 不丢 unrelated sessions，不接受整文档后写覆盖作为正常行为。

### 文件与边界

插件侧：

- `src/internal/task-state/basic/domain.ts`
- `src/internal/task-state/basic/service.ts`
- `src/internal/task-state/basic/worker.ts`
- `src/internal/compaction/tool-group-domain.ts`
- `src/internal/compaction/tool-group-audit-store.ts`
- `src/internal/task-state/contract/types.ts`
- `src/internal/task-state/contract/spec.ts`
- `src/internal/task-state/contract/index.ts`

DSH 侧依赖边界：

- `@deepseek-ai/dsh-storage-json` 的 single-unit 写入/刷新语义；
- `@deepseek-ai/dsh-storage-domain` 的 table put/revision 能力。

如果上游 API 没有记录级 CAS 或 refresh，必须在插件装配层选择明确的 single-writer lease/fail-closed 策略，或提出 DSH 上游变更；不得在插件内继续假装 table.put 具备 CAS。

### 实施内容

1. 确定运行模式字段和装配配置：single-writer 或支持 CAS 的 record-level backend；默认不允许隐式多实例。
2. 为 stable 提交携带并检查 base revision、lifecycle identity 和 worker token；冲突时不 publish、不推进本地权威指针。
3. 为 domain 增加受控 refresh/reopen 语义，或在无 refresh 能力时在每次提交前重新读取可验证的介质 revision。
4. 把 `sessions` 与 `audit` 的写入一致性边界写入 contract；audit 丢失不能伪装成 stable 提交成功。
5. 工具 audit 域也必须遵守同一多实例策略；不能仅修 task-state domain。
6. 本次修复不兼容旧版本插件数据：新版本使用新的 domain/version 或明确的新数据根目录，旧 v1 文档不参与新运行时读写；不得把旧文档按新 schema 静默解释。

### 测试与验收文件

新增：

- `tests/task-state-multi-instance-cas.spec.ts`
- `tests/task-state-storage-freshness.spec.ts`
- `tests/compaction-tool-audit-multi-instance.spec.ts`

回归：

- `审计资料/实验结果/E10-双实例/e10-dual-instance.spec.ts`
- E10 必须从 `reproduced` 变为不再满足 C1–C4，或在 single-writer 模式下第二实例明确 fail closed；
- 同 revision 竞争必须只有一方成功，另一方得到 conflict；
- unrelated session key 和多 audit key 均不得消失；
- 已打开实例在 refresh 后必须看到外部 revision；
- 不允许通过“测试只启动一个实例”规避验收。

### 停止条件

若 DSH storage API 无法提供 CAS/refresh，停止代码实现，先产出上游接口缺口；禁止在插件层用时间戳或本地 mutex 冒充跨进程 CAS。

### 当前状态（B1 首轮执行后）

`blocked-upstream`。B1 已完成 DSH API 能力核对，但未修改生产源码：当前 DSH HEAD `a66e4702` 没有跨进程 CAS、revision compare、已打开 domain/table refresh 或跨进程 single-writer。插件只获得 `ctx.storageDomain`，无法得到 JSON 介质 root，因此不能安全补充介质锁。能力缺口已由 `tests/task-state-storage-capability.spec.ts` 固定，详细记录见 `审计资料/B1-实施记录.md`。

B1 本轮结果：6 个能力/clean-break 测试通过；E10 复跑仍为 `reproduced`（C1–C4=true、C5/C6=false）；全量测试 410/411 通过，唯一失败仍为既有 artifact parity。上述通过不代表 B1 修复完成，也不代表多实例可用。

进入下一批的前置条件是 DSH 上游至少提供记录级 CAS、介质 refresh 或跨进程 single-writer/fail-closed 原语之一，并重新设计相应验收。未满足前，不得把 B2/B3 的结果解释为多实例安全。

## 4. 批次 B2：完整生命周期身份与提交 fence

### 问题依据

R-P0-5 是 design-confirmed，E09 未复现错误交叉引用但确认当前 key/identity 不能表达完整 seeded lifecycle；不能把它写成已经发生的数据损坏。

### 目标不变量

- stable/audit key 至少能区分 `sessionId + createdAt + cwd + isSeeded + inheritedEventCount`，或使用等价不可碰撞 lifecycle id；
- commit 前验证 live session、lifecycle、base revision 和 worker token；
- fork child 不读取父 stable 作为自己的权威 stable，除非显式 bootstrap 且带 `inherited` 来源。

### 文件范围

- `src/internal/task-state/basic/domain.ts`
- `src/internal/task-state/basic/service.ts`
- `src/internal/task-state/basic/worker.ts`
- `src/internal/task-state/contract/types.ts`
- `src/internal/task-state/contract/spec.ts`
- `src/internal/task-state/basic/filter.ts`
- `src/internal/task-state/prompt/render.ts`

### 实施内容

1. 设计稳定的 lifecycle key/version，不用裸 `SessionId` 作为唯一存储槽位；
2. 给 stable record 和 audit record 增加 schema version、covered range、lifecycle identity；
3. 新版本只读取新 schema/domain；旧版本插件记录不兼容、不迁移、不参与新运行时权威状态；缺少新字段的新记录直接 fail closed；
4. 明确 fork child 的 own-events cursor 起点；
5. 若产品选择父 stable bootstrap，必须显式写入一次性 `inherited` 来源和覆盖范围，否则保持“child 自己重建”的明确契约。

### 测试与验收

新增：

- `tests/task-state-lifecycle-key.spec.ts`
- `tests/task-state-fork-bootstrap.spec.ts`
- `tests/task-state-commit-fence.spec.ts`

回归：

- `tests/task-state-restart-recovery.spec.ts`
- `tests/task-state-unload.spec.ts`
- `tests/task-state-control-store.spec.ts`
- E09 原 spec。

E09 的 R1–R4 必须继续保持 false；新增验收专门证明碰撞不能读写错位、child cursor 不折叠不应处理的继承范围，并明确 bootstrap 选择。

## 5. 批次 B3：pressure 预算、退出线、低收益与账本

### 问题依据

R-P1-1、R-P1-2、R-P1-3、R-P1-4；E02 修正了 whole-zone 判断，E03 受控复现一工具一压缩、headroom 低于下一典型工具结果、维护后停在 78%–79%。

### 目标不变量

- 使用安全可用预算 `G`，而不是把原始 context window `C` 直接分区；
- pressure 使用固定 `pressureExitRatio`，不是只按当前 deficit 推到阈值下方一点；
- 每批重新测量、重新分区、重新检查收益；
- 普通区、工具区、遗忘区严格隔离；
- 每次维护若净释放低于 `minNetReleaseTokens` 或 `minNetReleaseRatio`，进入 low-yield/stop，不重复付费；
- 维护账本能说明选中范围、输入/输出、净释放、stop reason、recovery level 和 generation；
- 不把上一轮 checkpoint 在无新内容时再次作为新语义输入。

### 文件范围

- `src/compaction-basic.ts`
- `src/internal/compaction/zones.ts`
- `src/internal/compaction/config.ts`
- `src/internal/compaction/envelope-budget.ts`
- `src/internal/compaction/region.ts`
- `src/internal/compaction/source-index.ts`
- `src/internal/compaction/tool-group-audit-store.ts`
- `src/internal/compaction/tool-group-domain.ts`
- `src/types.ts` 或实际 compaction config/types 导出文件

### 实施内容

1. 在 config schema 中加入并校验 `pressureExitRatio`、`minNetReleaseTokens`、`minNetReleaseRatio`、`maxPressureBatches` 的明确语义。
2. 计算 `G = C - system/tools/runtime/output/framing reserve`，分区和候选 cap 都基于 G；不能把 envelope 置零时的 fixture 结论外推为生产 token。
3. 把 pressure planner 改成有界批次循环：每次 commit 后重新 measure；到 exit ratio 或低收益/无安全候选才停止。
4. 维护 `roundReplacements`、source provenance 和 completed-turn/step guard；同一 invoke 产生的 replacement 不得被同一 invoke 再折入。
5. 重新定义已产生 checkpoint 的 reentry：必须有新的可覆盖范围或明确 age/freshness 条件，不能单靠“下一 step 会允许重入”。
6. 更新 `src/compaction-basic.ts:574-594` 附近的过时 whole-zone 注释，使其与 E02 实际 deficit-prefix 语义一致；注释不得作为与代码冲突的设计声明。
7. 在 production diagnostics/ledger 中持久化结构化 stop reason 和 recovery level；默认关闭详细日志时不改变行为。

### 测试与验收

新增或扩展：

- `tests/compaction-pressure-exit.spec.ts`
- `tests/compaction-pressure-low-yield.spec.ts`
- `tests/compaction-pressure-reentry.spec.ts`
- `tests/compaction-token-ledger.spec.ts`

回归：

- `tests/compaction-envelope-budget.spec.ts`
- `tests/compaction-reentry-liveness.spec.ts`
- `tests/compaction-three-zone.spec.ts`
- `tests/compaction-retained-tail-turn-semantics.spec.ts`
- E02、E03。

验收至少包括：

- 82% pressure fixture 维护后达到固定 exit ratio；
- 单次典型工具结果不能连续触发三次以上维护，除非账本明确显示它确实超过新的安全预算；
- low-yield 不产生无限摘要付费；
- 最近 tail 和工具区隔离；
- provider usage 有值和无值两种路径都不越预算。

### B3 当前状态

`completed-single-instance`。主代理验收见 `审计资料/B3-主代理验收.md`：typecheck 通过，B3 相关 97/97 通过，全量仅剩既有 artifact parity；修复后 E03 对照 `thrashStreak` 从 5 降为 1，pressure headroom 从 1K–2K 提升到 11K–12K，typed stop 为 `pressure-exit`。该状态不包含多实例安全、真实 provider token 统计或 Web 频率。

## 6. 批次 B4：startup backlog、Goal/TODO 权威触发

### 问题依据

R-P1-5、R-P1-6、R-P1-7；E07 真实持久介质恢复后 backlog 静止，E05/E06 受控验证 Goal/TODO 当前触发和投影限制。

### 目标不变量

- resume/open 后主动计算 `cursor` 以上 eligible backlog；达到阈值时启动一次 startup wave；
- Goal revision/clear 与 TODO clear 是可观察、可提交的事实；
- Goal/TODO 权威 view 不由模型 continuation 单独决定；
- 空 TODO 写入可以清除旧 TODO；
- startup、urgent、normal、repair 触发原因可区分且可审计；
- infeasible window 不能无限卡住 cursor，也不能丢失清空事件。

### 文件范围

- `src/internal/task-state/basic/filter.ts`
- `src/internal/task-state/basic/worker.ts`
- `src/internal/task-state/basic/service.ts`
- `src/internal/task-state/basic/update.ts`
- `src/internal/task-state/contract/types.ts`
- `src/internal/task-state/contract/spec.ts`
- `src/internal/task-state/prompt/render.ts`
- `src/task-state-prompt.ts`
- `src/internal/task-state/prompt/index.ts`
- `src/internal/task-state/index.ts`

### 实施内容

1. 将 Goal view、TODO view、current objective、covered range、source cursor 和 staleness 纳入 stable contract；
2. filter 对 `todo/write([])` 生成显式 clear/tombstone，而不是返回 null；Goal clear 同样保留事实；
3. service 在 resume/open 完成 baseline hydration 后主动计算 backlog，并以 startup trigger 调度；
4. worker 增加 urgent/startup trigger 和去重规则，不能只依赖后续 `session/event`；
5. 对 infeasible 窗口记录终态和可降级 cursor 策略，不能无限重复同一窗口；
6. Host/render 以权威 Goal/TODO view 覆盖模型 continuation 中同名字段，明确 staleness；
7. 处理 recovery provenance：正常完成、飞行中退出、失败留尾分别可被恢复和重试。

### 测试与验收

新增或补齐：

- `tests/task-state-startup-backlog.spec.ts`
- `tests/task-state-goal-authority.spec.ts`
- `tests/task-state-todo-clear.spec.ts`
- `tests/task-state-infeasible-progress.spec.ts`
- `tests/task-state-trigger-ledger.spec.ts`

回归：

- `tests/task-state-filter.spec.ts`
- `tests/task-state-worker.spec.ts`
- `tests/task-state-update.spec.ts`
- `tests/task-state-restart-recovery.spec.ts`
- E05、E06、E07。

验收：

- E07 backlog fixture 在无新事件时启动处理；
- Goal B 或 clear 在规定事件延迟内覆盖旧视图；
- 空 TODO 后 stable/render 不再保留旧列表；
- restart、manual edit、worker update 的 revision/cursor 不回退；
- 所有触发 reason 可从账本区分。

### B4 当前状态

`completed-clean-break-single-instance`。主代理验收见 `审计资料/B4-主代理验收.md`：B4.1–B4.4 已完成；最终全部 task-state 27 文件、275/275 通过，typecheck 通过；E05/E06/E07 修复后对照均为 `fixed`。使用新 domain `context_enhancement_task_state_v2` version 2，旧 v1 数据不读、不迁移、不回退。B1 多实例无 CAS 风险仍为 `blocked-upstream`。预算不变时的 `blockBaseOverBudget` 为安全 typed block，留给 B5 的 Stable 注入预算/收缩解除。

## 7. 批次 B5：Stable 固定槽位注入与回收

### 问题依据

R-P2-1、R-P2-2；E08 在 12 个 revision 上复现 surface/runtime-context append 累积，旧快照从 1 条增长到 12 条且无 replacement。

### 目标不变量

- 模型可见 Stable Task State 只有一个固定槽位；
- 新 revision replacement 旧槽位，而不是追加新 snapshot；
- 注入有独立预算 `I`，并能从 token ledger 对账；
- stale、Goal/TODO 权威 view 和 covered range 可表达；
- history compaction 不会把旧 Stable snapshot 当成普通事实无限重复折叠。

### 文件范围

- `src/task-state-prompt.ts`
- `src/internal/task-state/prompt/index.ts`
- `src/internal/task-state/prompt/render.ts`
- `src/internal/task-state/basic/host.ts`
- `src/internal/task-state/basic/service.ts`
- `src/internal/task-state/contract/types.ts`
- `src/internal/task-state/contract/spec.ts`
- 与 DSH `runtime context` / `surfaceOp.replace` 接口的集成入口

### 实施内容

1. 为 Stable injection 分配稳定 slot identity 和 source kind；
2. 首次 assembly 创建 slot，后续 revision 使用 `surfaceOp.replace` 指向该 slot；
3. replacement 必须记录旧/新 revision、covered range 和 source event seqs；
4. 注入预算纳入 `G` 和 token ledger，超预算按明确优先级截断，不删除权威 Goal/TODO；
5. 在 dispose、resume、fork 时重建或验证 slot，不复用错误 lifecycle 的 slot；
6. 另立 X4 实验，在挂载 compaction 后确认 Stable slot 是否能被回收，不能用 E08 未挂压缩结果代替。

### 测试与验收

新增：

- `tests/task-state-prompt-fixed-slot.spec.ts`
- `tests/task-state-injection-budget.spec.ts`
- `tests/task-state-injection-compaction-recovery.spec.ts`

回归：

- `tests/task-state-prompt.spec.ts`
- `tests/task-state-render.spec.ts`
- `tests/task-state-composition.spec.ts`
- E08。

验收：连续 20 个 revision 后模型可见 Stable snapshot 节点仍为 1；旧 revision 不可见；replacement generation 单调；注入 token 不随 revision 线性累积；挂载压缩后重跑 X4。

### B5 当前状态

`completed-single-instance`。主代理验收见 `审计资料/B5-主代理验收.md`：E08 修复后 20 revisions 可见 slot 恒为 1；独立注入预算 I、staleness 与 compaction G 对账已实现；X4 真实 compaction 连续 4 次遮蔽→重建全部通过，主代理复跑 1/1，sourceDrift=0。B1 多实例风险和 artifact parity 保持不变。

## 8. 批次 B6：工具摘要 provenance 与 audit 恢复

### 问题依据

R-P2-3；E01 真实临时 audit domain 下确认工具摘要 replacement 和裁剪互斥，但 audit 既是诊断记录又是 replacement 类型权威，且危害未量化。

### 目标不变量

- replacement 类型不能只依赖易被整文档覆盖的诊断 audit；
- source provenance 应随 replacement 或 Session event 可独立恢复；
- 操作①成功的组不能被操作②重复处理；
- audit 丢失、损坏、重启和多实例冲突必须显式降级或 fail closed。

### 文件范围

- `src/internal/compaction/tool-group-replacement.ts`
- `src/internal/compaction/tool-group-audit-store.ts`
- `src/internal/compaction/tool-group-domain.ts`
- `src/internal/compaction/source-index.ts`
- `src/compaction-basic.ts`
- `src/tool-result-pruner.ts`

### 实施内容

1. 给 replacement event 写入可独立验证的 provenance/source kind，audit 作为诊断而非唯一权威；
2. 对 audit open/success/fallback/repair 做完整状态机和 revision fence；
3. 多实例沿用 B1 的 storage 策略；
4. audit 缺失时按 fail-closed 或明确 unknown 处理，不能静默把 tool-summary 当 original；
5. 操作①/②使用同一轮排除集合，但成功摘要在后续轮次也必须依赖可恢复 provenance；
6. 修复 message replacement 只改变 content 的构造约束，相关 fake/test 必须使用原 message identity。

### 测试与验收

新增或扩展：

- `tests/compaction-tool-provenance-replay.spec.ts`
- `tests/compaction-tool-audit-recovery.spec.ts`
- `tests/compaction-tool-group-replacement.spec.ts`
- `tests/compaction-tool-group-audit-failure.spec.ts`
- `tests/compaction-served-provenance.spec.ts`

验收：删除/损坏 audit 后，已落盘 replacement 仍能正确分类或明确 fail closed；E01 双 verdict 中方案 §5 缺陷仍保持未复现，不能因修复测试改写历史结果。

### B6 当前状态

`completed-single-instance`。主代理验收见 `审计资料/B6-主代理验收.md`：B6.1 provenance replay 与 B6.2 audit recovery 均已通过；相关复验 43/43、typecheck 通过。Session provenance 仍为唯一类型权威；audit 丢失/损坏只会诊断或收紧，不能伪造 replacement。B1 多实例 CAS 风险仍为 `blocked-upstream`。

## 9. 批次 B7：fork child cursor/bootstrap 契约

### 问题依据

E09 `not-reproduced`，但发现 child 无记录时 cursor 从 `-1` 开始，首批可能折叠继承前缀；没有父 stable 一次性 bootstrap/inherited marker。

### 计划决定

这不是现有数据损坏修复，而是契约补全。实施前必须选定一种产品语义：

- child 从 own-events 边界独立重建；或
- child 接受一次父 stable bootstrap，并记录 `inherited` source 和 covered range。

未选定前不得修改 cursor 语义。

### 文件与测试

- 文件范围同 B2，特别是 `service.ts`、`worker.ts`、contract types/schema、prompt render；
- 新增 `tests/task-state-fork-bootstrap.spec.ts`；
- 回归 E09 全部 R1–R4；
- 必须覆盖 `inheritedEventCount` 与 `firstLiveSeq` 不相等的 child；
- 覆盖被 replacement 遮蔽的 inherited eligible 事件；
- 覆盖 parent/child 相同 stable 内容和不同 stable 内容。

验收只证明选定契约一致，不把未选另一方案写成失败。

### B7 当前状态

`completed-single-instance`。主代理验收见 `审计资料/B7-主代理验收.md`：选定 own-events boundary 语义 A；B7 focused regression 60/60、typecheck 通过；E09 历史结果未改，当前 v2/fixed-slot 证据写入 counterpart。未选 parent stable bootstrap 不记为失败。B1 多实例风险不变。

## 10. 批次 B8：artifact parity 与宿主装配

### 问题依据

R-P2-9；E00 14/15 文件、205/206 用例，唯一失败为 `tests/artifact-parity.spec.ts:128`，`lib/client.js` 仍含脚手架 loader id。

### 文件范围

- `lib/client.js`
- `scripts/patch-client-id.mjs`
- `tsdown.config.ts`
- `package.json` 的 client exports/config
- `tests/artifact-parity.spec.ts`
- 需要时更新 `presets/` 或安装脚本，但不得直接手工改生成产物代替构建修复。

### 实施内容

1. 确定 loader id 的唯一来源；
2. 修复 build/patch 顺序，使 workspace `lib`、tgz、安装副本的 client id 一致；
3. 让 parity test 检查实际装配字节和包来源；
4. 明确宿主 `$DSH_HOME` 载入哪个 artifact，并记录 hash；
5. 业务实验不得使用未确认身份的宿主副本作结论。

### B8 当前状态

`completed`。主代理验收：artifact parity 6/6，通过真实 clean-build、npm pack、verify-artifact 和隔离 `$DSH_HOME` 安装；全量测试 60 文件、551/551 通过；typecheck 通过。workspace `lib/` 与 tgz 发布文件逐字节一致，脚手架 loader id 已消除，构建连续三次 hash 一致。随后版本升级为 `0.1.11` 并重新构建打包。运行中的用户 `~/.dsh` web/desktop 副本仍是旧字节，未自动重装，需宿主侧动作。

### 验收

- `tests/artifact-parity.spec.ts` 全绿；
- build 后 workspace `lib` 与 tgz 内容一致；
- 安装验证脚本能报告实际路径/hash；
- artifact parity 仍与业务实验统计分开。

## 11. 破坏式升级、运行时边界与回滚要求

> 用户已明确：本次不需要兼容旧版本插件数据。因此本计划采用 clean break，不设计旧数据迁移，也不要求新代码读取旧版本 domain/document。

### 存储 schema

- 新版本使用新的 domain/version 或明确的新数据根目录；
- 旧版本插件数据不读取、不迁移、不作为新运行时的 fallback；
- 新 schema 缺字段、版本不匹配或 domain 形状不符时必须 fail closed，不能按空 store 启动；
- 新 key/revision/lifecycle 规则只对新数据生效，并在新 domain/schema 中固定声明；
- 首次启动的空新 domain 可以正常初始化，旧 domain 被发现时必须明确忽略或拒绝，不能静默混读。

### Session surface

- replacement 事件必须可由当前版本的原始 Session log replay 得出；
- 不得删除原始事实来实现压缩；
- 新 source kind/slot kind 只需保证当前版本和当前 DSH 运行时可读；
- fork/resume 的当前版本 Session 必须保留 lifecycle fence。

### 配置与运行时

- 新增压力和注入预算配置必须有 schema 默认值、上下界和拒绝非法组合测试；
- 不保留旧插件配置的兼容默认；缺少新字段按当前版本明确默认或直接拒绝，不能静默扩大压力处理范围；
- provider usage 缺失与存在分别测试；
- 当前版本的 feature flag 可以用于分批启停，但不承担旧插件数据兼容职责。

### 回滚

- 每个批次可独立关闭 feature flag；
- 回滚只保证当前版本新 schema 内的安全回退，不保证旧插件版本能够读取新数据；
- 任何无法识别当前 schema 的运行时必须拒绝写入，不能把未知数据当作空数据或普通成功。

## 12. 每批实施流程

每一批必须按以下顺序执行：

```text
读取本批涉及源码与结果
→ 写文件级变更清单
→ 先新增/调整针对性测试
→ 实施最小生产改动
→ 跑本批测试
→ 跑相关 E 实验回归
→ 检查 clean-break 拒绝旧数据 / replay / fork / restart
→ 主代理检查 git diff、hash、结果账本
→ 更新 40/41 中受影响证据状态
```

任何一项发生以下情况必须停止该批：

- 生产源码之外出现未授权文件变化；
- 结果无法区分 fake 与真实路径；
- 测试通过但没有检查最终 surface/medium；
- 需要修改 DSH 上游但接口边界未决定；
- clean-break 对旧数据不能 fail closed；
- rollback 后旧代码可能覆盖新格式。

## 13. 首个实施批次

首个实施批次固定为 **B1 存储多实例 fail-closed/CAS/freshness**，原因是 E10 已经是真实进程级 P0，且其静默覆盖会污染后续 Stable、audit、Goal/TODO 和注入结论。

B1 已执行首轮能力核对，但因上游 API 缺少 CAS、refresh 和跨进程 single-writer 而在生产代码实施前停止，状态为 `blocked-upstream`。已落库：

- `tests/task-state-storage-capability.spec.ts`：6 个能力/clean-break 测试；
- `审计资料/B1-实施记录.md`：API 证据、阻塞项、未完成验收和全量回归。

在 DSH 上游能力落地前，B1 不得标记完成，E10 必须继续视为 `reproduced`，也不得宣称多实例可用。B2/B3 可以另行评估单实例逻辑，但其结论不能覆盖或降低 B1/E10 的 P0 风险。
