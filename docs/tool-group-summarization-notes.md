# Tool Group Summarization Working Notes

本文件记录工具组语义要点化的持续调研结论，供跨上下文继续实现时直接读取。

## 2026-05-28：方案基线

- 设计基线：先保护近期 surface，再选择旧连续工具组；对候选组执行一次组级辅助 LLM 摘要；成功后按原始 tool/result 节点生成 replacement；失败后交给确定性 tool-result-pruner；重新测量后仍超限才进入 compaction-basic 的遗忘区语义压缩。
- 新能力边界：新增 `tool-group-summarizer` 内部能力，不立即作为公共 export；发现工具组、候选选择、模型调用、结构化校验、source references、fingerprint 和失败降级都归它负责。
- 复用原则：优先使用现有 `tool-pairing`、`tool-segments`，不另建 Session 解析器；所有范围判断以当前 surface 位置为准，不使用裸 seq 数值区间。
- 初始配置：`enabled`、`minGroupResults`、`minGroupChars`、`minGroupTokens`、`maxGroupTokens`、`maxGroupsPerPass`、`maxSummaryTokens`。
- 输出协议：版本化 JSON，包含 `groupSummary`、逐 source seq 的 summary/facts/files/identifiers/errors/unresolved，以及 groupErrors/unresolved；模型只能提取输入事实，不能把计划当完成或无错误当成功。
- replacement 约束：每个原始 tool/result 对应一个 replacement；保留 call id、合法 message 结构、`sourceEventSeqs`、非文本 content block 和 tool pairing；只替换当前 surface，不删除原始 event。
- 幂等：记录 lifecycle、group fingerprint、source seqs、surface revision/cursor、request id、provider/model、schema version、raw output、parsed summary、status、replacement seqs、error；提交前重新检查 lifecycle、source 内容 digest、当前 surface 和已有成功 replacement。
- 失败路径：timeout、取消、模型错误、JSON/schema/source 校验失败、surface 变化都不能阻塞主线程，必须降级 deterministic pruner；失败记录应阻止同一内容在同一 pass 无限重试。

## 已确认的代码入口（待下一轮读取）

- `src/compaction-basic.ts`：主压缩 provider 入口，负责区域选择、tool-result-pruner 和 semantic compaction 的编排。
- `src/tool-result-pruner.ts`：确定性工具结果裁剪服务及当前 replacement 相关逻辑。
- `src/internal/`：从官方 rc.1 复制的 compaction/tool pairing/tool segment 内部能力，应优先复用。
- `src/task-state-basic.ts`：已有 auxiliary LLM、请求 id、审计和生命周期围栏模式，可作为摘要调用/幂等存储实现参考。
- `tests/compaction-*.spec.ts`：已有工具段、配对、选择保护和 coverage 测试，应在此基础上增加摘要成功、fallback、幂等和 surface 变化测试。

## 2026-05-28：0.1.2 发布校验

- `package.json` 已升级到 `0.1.2`，`release-check.mjs` 的版本断言和安装验证默认包名同步更新。
- 产物：`dsh-context-enhancement-0.1.2.tgz`。
- `pnpm run release:check` 通过。
- `node scripts/verify-profile-install.mjs .\\dsh-context-enhancement-0.1.2.tgz` 通过：profile layers 包含 bundle，`contextual` 默认 preset、roster 和 standing mount 均通过。
- `pnpm run verify:install -- ...` 不应作为带路径调用方式，因为当前 pnpm script 会把 `--` 作为脚本参数；直接使用上面的 Node 命令。

## 2026-05-28：压缩链代码读取结论

- `BasicCompactionEngine.compactIfNeeded()` 当前顺序是：测量 -> tool-result-pruner -> 重新测量 -> `selectCompactableRange()` -> `compactRegion()`；工具组摘要应插入在旧 head 的确定性 pruner 之前，且只处理 `splitRetainedTail().olderRange`。
- `ToolResultPruner.pruneSession()` 对当前 surface 做稳定快照，按 surface position 判断 olderRange，逐个 `tool/result` 生成合法 replacement；replacement 保留完整 message 数据，仅替换 result content，并使用 `sourceEventSeqs: [seq]`。工具组成功摘要必须沿用同样的 surface replacement API，不能删除原始 event。
- `toolSegments()` 已能发现同一 turn 内从 assistant tool-call 到完整 tool/result 的最大连续、成对、平衡 segment；不跨 turn、不跨普通消息、不包含未完成尾部。它没有语义依赖判断，因此摘要器只能在此确定性 segment 上做保守选择。
- `toolPairingBalancedBefore/After()` 维护按 surface replaceGeneration 失效重建的缓存，所有边界判断均基于当前 surface 位置；不能使用 seq 数值排序推断范围。
- `region.ts` 的 compaction transaction 会用 `compaction/start` 锁住异步过程，并在 summary 失败时写 `compaction/end` error。工具组摘要属于前置的模型辅助 pass，不能直接复用 compaction summary event 伪装成全局 compaction；应有独立 audit 或至少在失败时只返回 fallback，不破坏主 transaction。
- 现有 `summarizeWithLlm()` 专门输出 Markdown checkpoint，不能直接复用作组级 JSON 协议；需要独立的结构化 prompt、JSON 解析和 source 校验，但可以复用其 routed target 解析与 `ctx.llm.stream()` 调用方式。
- 最小接入方案：新增纯函数 `tool-group-summarizer.ts`（发现/候选/协议校验/替换辅助）和 engine 内部 orchestration；第一版可先做无持久 audit 的单 pass，随后补充幂等记录。不得先改写 `tool-result-pruner` 的职责。

## 2026-05-28：阶段 1 已实现

- 新增 `src/internal/compaction/tool-groups.ts`：基于现有 `toolSegments()` 生成 `ToolGroup`，按当前 surface position、旧区域、最少结果数、字符/估算 token 收益、最大组 token 和每次最大组数筛选候选。
- 工具组只接受完整、平衡、同一 turn 的 segment；不跨普通消息或 turn，不把部分 segment 强行纳入组；`olderRange` 的边界使用 `indexOf`，不依赖 seq 数值单调性。
- 当前模块是纯选择层，不调用 LLM、不写 Session、不改变 surface，符合方案阶段 1 边界。
- 新增 `tests/compaction-tool-groups.spec.ts`，覆盖旧区域筛选、完整 segment、surface position 语义和阈值拒绝；阶段 1 定向测试通过，类型检查通过。
- 发现一个重要实现约束：如果 olderRange 落在单个 segment 中间，候选必须保守排除，而不是截断 segment；后续 engine 应先按 segment 边界构造旧区域或跳过该组。

## 2026-05-28：阶段 2 已实现

- 新增 `src/internal/compaction/tool-group-summary.ts`：定义版本 1 的 JSON 输出协议，构造带 role/callId/sourceSeq 的组级输入，并执行结构化解析。
- 校验规则：版本必须为 1；每个输入 source seq 必须恰好有一个输出 item；禁止未知、重复或缺失 source；callId 必须与输入一致；facts/files/identifiers/errors 中的声明必须原文出现在对应 source 内容中；所有字段必须是非空字符串或字符串数组。
- 新增 `tests/compaction-tool-group-summary.spec.ts`，覆盖合法输出、缺失/重复/外部 source 和伪造事实拒绝；类型检查和定向测试通过。
- 当前 summary parser 保守处理 rich tool-result content：将非字符串内容 JSON 序列化进输入快照；后续模型 prompt 必须明确不得丢失非文本块，replacement 阶段仍需保留原始 content blocks。

## 2026-05-28：阶段 3 接入约束

- 独立 `tool-group-summarizer.ts` 已通过一次调用和非法 JSON fallback 测试，但暂未接入 `BasicCompactionEngine`。
- 尝试接入后确认：只调用摘要器而不立即提交逐节点 replacement 是错误的，会导致 pruner 继续处理同一组，违反“摘要成功后不重复裁剪”。因此 engine 接入必须与 replacement、source references 和成功/失败状态一起提交，不能先做半成品调用。
- 现有 compaction 的 `summarizeWithLlm()` 使用 `purpose: compaction` 和 `BlockAssembler`，可复用调用方式；组摘要仍需独立协议和失败分类。

## 2026-05-28：阶段 3/4 已实现

- 新增 `src/internal/compaction/tool-group-summarizer.ts`：单组只发起一次 `ctx.llm.stream()`，使用 `purpose: compaction`，解析纯 JSON，非法 JSON、空输出、schema/source 校验和 stream 错误统一转换为可分类 `ToolGroupSummaryFallbackError`。
- 新增 `src/internal/compaction/tool-group-replacement.ts`：按每个 tool/result source seq 生成合法 `tool/result` replacement，保留原始 call id 和非文本原始 message 元数据，摘要文本使用固定可识别格式，并用 `sourceEventSeqs: [sourceSeq]` 回指原始 event。
- 新增 3 个定向测试文件，阶段 1–4 当前共 14 个新增测试通过，类型检查通过。
- engine 尚未接入，原因是 durable audit/idempotence 仍未实现；接入前必须补充成功/fallback 状态和同组重复保护，不能仅把调用器串在 pruner 前面。

## 2026-05-28：阶段 5 审计基础已实现

- 新增 `src/internal/compaction/tool-group-audit.ts`：定义 `open/success/fallback/failure` 状态、SHA-256 group fingerprint、内容 digest、成功记录复用查询和提交前 lifecycle/surface generation/source seq 稳定性检查。
- 新增 `tests/compaction-tool-group-audit.spec.ts`，覆盖成功记录阻止重复、非法二次 finish、生命周期变化、surface generation 变化和 source surface 变化。
- 当前 audit 模块仍是纯内存/纯函数层，尚未绑定 storage-domain；下一步需要新增独立 domain 或将 audit table 扩展到 context-enhancement domain，必须保持 task-state 的 authoritative stable 与摘要 audit 职责分离。

## 2026-05-28：摘要 audit domain 基础

- 新增 `src/internal/compaction/tool-group-domain.ts`：独立 `context_enhancement_tool_group_summary` single-layout domain，audit 表存 open/success/fallback/failure 记录；不复用 task-state authoritative domain。
- 新增 `src/internal/compaction/tool-group-audit-store.ts`：封装 domain open、put、atomic update、按 Session 读取和 close；类型检查通过。
- 当前 store 尚未挂载到 `BasicCompactionEngine`，也尚未实现 domain open 失败降级、未完成 open 记录恢复和 engine 成功/fallback 原子流程；这是下一轮必须完成的接入点。

## 2026-05-28：阶段 5/6 初步接入

- `BasicCompactionConfig` 新增 `toolGroupSummarizer` 配置，默认值与方案一致：enabled、2 个结果、12000 chars、2000/12000 tokens、每 pass 2 组、1200 summary tokens。
- `BasicCompactionEngine` 现在在旧区域 deterministic pruner 前尝试组摘要：domain 打开失败时仅禁用摘要；成功摘要立即逐 result replacement 并写 success audit；摘要/稳定性/replacement 失败写 fallback/failure 后继续 pruner；已有 success fingerprint 跳过重复调用。
- 新增配置测试；完整类型检查和测试通过：25 个测试文件、214 个测试。
- 构建和 `pnpm run release:check` 通过，`lib/compaction-basic.js` 已包含摘要逻辑和 storage-domain 依赖。
- 尚未完成的风险验证：真实 BasicCompactionEngine + Agent + token meter 的端到端摘要成功/失败链、domain 重启恢复 open 记录、部分 replacement 崩溃恢复和真实 profile 中的运行时触发；下一轮必须补测试或明确实现缺口后再发布。
- 当前 0.1.2 产物已重新打包为 `dsh-context-enhancement-0.1.2.tgz`，并再次通过 `node scripts/verify-profile-install.mjs .\\dsh-context-enhancement-0.1.2.tgz` 隔离安装验证。

## 2026-05-28：恢复与提交一致性修正

- `replaceToolGroup()` 现在先快照并校验所有 tool/result 目标，再追加任何 replacement，避免缺失目标时产生部分 replacement。
- engine 对同 fingerprint 的 `open` audit 记录复用原 request id，不重复写 open；成功记录仍直接跳过，保证进程恢复后不会无限重新发起同组调用。
- 新增 audit open-reuse 和 replacement preflight 测试；当前定向测试通过。
- 仍需真实 engine harness 验证 token pressure、Agent 运行时和 storage domain 重启；纯模块与 release/profile 验证不能替代该端到端证据。
- 本轮完整回归第一次运行出现既有 `task-state-long-session` 重启用例 30 秒超时；单独复跑后重启用例通过，但另一长会话用例出现既有 `repair`/`success` 时序断言差异。摘要相关测试均通过，故该失败记录为现有 task-state 测试的非确定性残余风险，不能标记完整回归全绿。
- 本轮构建、release check、重新打包和隔离安装验证均通过；产物仍为 `dsh-context-enhancement-0.1.2.tgz`。

## 2026-05-28：主链 surface range 修正

- 发现并修复一个主链 bug：摘要成功会先对旧 tool/result 做 replacement，原先代码随后仍使用摘要前的 `olderRange` 调用 pruner；replacement 后原始 seq 可能已不在当前 surface，导致 pruner 使用 stale range。
- 修复方式：摘要 pass 后重新 `meter.measure()`，重新执行 `splitRetainedTail()`，再把新的 surface-position range 交给 pruner。
- 修复后完整回归通过：25 个测试文件、215 个测试。
- 本轮最终构建、`pnpm run release:check`、重新打包和 `node scripts/verify-profile-install.mjs .\\dsh-context-enhancement-0.1.2.tgz` 均通过；此前长会话非确定性测试本轮完整运行已恢复全绿。
- 当前尚未补充的证据仅剩真实 `BasicCompactionEngine + Agent + token meter` harness 下的压力触发、摘要失败 fallback、domain 重启恢复和部分 replacement 崩溃恢复；现有纯模块测试、完整回归和 profile standing mount 已覆盖其余发布门槛。

## 2026-05-28：0.1.3 打包验证

- 包版本升级为 `0.1.3`；项目版本引用、release check 断言、README 安装示例和 verify 默认 tarball 名称已同步，DSH 依赖仍保持 `0.1.2-rc.1`。
- 类型检查通过。
- 完整测试首次运行出现既有 `task-state-long-session` 的 `repair`/`success` 时序波动；单独复跑该测试的 2 个用例均通过。
- `pnpm run build` 通过，`pnpm run release:check` 通过。
- 产物 `dsh-context-enhancement-0.1.3.tgz` 已生成，并通过隔离 profile 安装验证：contextual preset、默认配置、roster 和 standing mount 均通过。

## 2026-05-28：桌面端 preset 兼容与弹窗层级

- 桌面端 `dsh-plugin-desktop-master` 会在启动时重写 `agent-presets` roots，仅保留内置 preset、`$DSH_HOME/.agent-presets` 和桌面端兼容目录；插件 Bundle 内的 `presets/contextual` 不会自动被桌面端发现。
- 按用户要求未修改桌面端代码；新增 `scripts/install-desktop-preset.mjs` 和 `pnpm install:desktop-preset`，将 Bundle 的 `contextual` preset 显式 materialize 到 `$DSH_HOME/.agent-presets/contextual`。脚本默认拒绝覆盖已有用户 preset，只有 `--force` 才替换。
- 弹窗层级修复保留在插件自身：`ContextEnhancementAction` 使用高层级 fixed panel、触发按钮 viewport 定位，并监听 resize/scroll，脱离 header 的局部 stacking context 和 overflow 裁剪。
- 本轮 typecheck、完整测试（25 文件、215 测试）和 build 均通过；兼容脚本已在当前用户 DSH home 写入 `C:\Users\chuxi\.dsh\.agent-presets\contextual`，重复执行默认覆盖保护已验证。

## 2026-05-28：README 工作原理更新

- 读取并对照上级目录 `C:\\Users\\chuxi\\Documents\\trae_projects\\code\\压缩方案3.md`：文档将长会话拆为主线程压缩链和 Checkpoint 旁路链。
- README 的“工作原理”现已按仓库实际代码重写：明确近区保护、工具组候选筛选、结构化 source-grounded 摘要、独立 audit domain、确定性 tool-result-pruner fallback、重新测量 surface、旧历史语义 compaction，以及 task-state 的独立 checkpoint 注入。
- 删除了把未实现机制写成当前行为的表述；文档不再声称当前 Bundle 已实现原始事件归档、三次递进 checkpoint 或灾难重建。
- 中英文 README 已同步核心术语和处理顺序；`pnpm run release:check` 通过。

## 下一步读取顺序

1. `src/task-state-basic.ts` 的 auxiliary call、request id、audit 与 lifecycle 围栏。
2. `src/internal/compaction/config.ts` 的配置合并模式。
3. `tests/compaction-*.spec.ts` fixtures、Session 构造和 replacement 断言。
4. 设计文档后半段的失败降级、审计和测试要求。
