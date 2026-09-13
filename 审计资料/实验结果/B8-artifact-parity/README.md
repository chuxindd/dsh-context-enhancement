# B8 · artifact parity 与宿主装配

> 状态：**已完成（`fixed`）**。`tests/artifact-parity.spec.ts` 全绿（6/6，基线 4 passed / 1 failed）；真正的构建链重建了 `lib/`，`npm pack` 重新打包 tgz，workspace lib 与 tgz 发布集**逐字节一致**；隔离 `$DSH_HOME` 真实 profile 安装 + standing mount 通过。
> 依据：`审计资料/42-文件级修复PLAN.md` §10（R-P2-9；E00 唯一失败项 `tests/artifact-parity.spec.ts:128`）。
> 基线：插件 HEAD `cf034b4bce6141bb95b590f5ed7fa66f8727daa2`（dirty 179 行）；构建用 DSH preset checkout `deepseek-harness-rc1-context` HEAD `a66e4702047846cdaa10c66c9d3df3951f5ea70d`（**只读**）。
> 边界：本批次只改构建/patch 脚本、`package.json` scripts 与 parity spec；**未改任何 `src/**` 业务源码**，未改既有业务测试，未改历史 E01–E10 / 40 / 41。B1 仍为 `blocked-upstream`。

---

## 1. 问题与根因

### 1.1 现象

工作区 `lib/client.js:2` 是 `id: "@deepseek-ai/dsh-client-ui-jobs"`（脚手架 id），而 `git show HEAD:lib/client.js:2` 与 `$DSH_HOME` 的两个安装副本都是 `id: "dsh-context-enhancement"`。parity spec 第 128 行因此失败；工作区 `lib/` 是 2026-09-11T01:49:09Z 的旧构建（`git status` 为 `M`），tgz 是 2026-09-10 的另一次构建。

### 1.2 loader id 的唯一来源（PLAN §10 第 1 项）

| 层 | 事实 |
| --- | --- |
| artifact 字节来源 | 共享 preset `packages/client/tsdown.client.ts` 把 `clientBundle(id, …)` 的 `id` 写进客户端 config 的 `outputOptions.banner`（`window.__ModuleLoader__.load({ id })`），并在内联 CSS 注入器里用作 `tag.dataset.plugin` |
| 为什么当时用脚手架 id | preset 通过 `workspaceManifest(id)` 查 `packages/<group>/<name>/package.json` 来决定该包的 client externals；本仓库不是该 workspace 的包，所以必须借一个真实存在的 DSH 包名 → `@deepseek-ai/dsh-client-ui-jobs`（该 checkout 内实际位置：`packages/client/ui-jobs/package.json`，version `0.1.2-rc.1`） |
| 当时如何改正 | `scripts/patch-client-id.mjs` **事后**把 emit 出来的 `lib/client.js` 里第一个 `id: "…"` 字面量改写为 `dsh-context-enhancement` |
| 缺陷类别 | **顺序性/过程性**：只要任何一次 `tsdown` 之后没有跑 patch，产物就带脚手架 id；工作区 `lib/client.js` + `lib/client.js.map` 正是这个状态。此外 `String.replace` 只替换第一个匹配，将来若客户端引入 `.css`（`src/css-modules.d.ts` 已声明 `*.module.css`），`data-plugin` 的脚手架 id 会残留 |

### 1.3 修复（PLAN §10 第 1、2 项）

1. **`scripts/client-bundle-ids.mjs`（新增）**：唯一来源模块 —— `SCAFFOLD_CLIENT_ID`（构建期脚手架常量，含"为什么必须是真实 DSH 包名"的说明）与 `PUBLISHED_CLIENT_ID`（读 `package.json#name`，缺失或等于脚手架 id 直接抛错）。`tsdown.config.ts` 与 `patch-client-id.mjs` 都从这里取 id，不再各写一份字面量。
2. **`tsdown.config.ts`**：在生成期把 published id 写进客户端 config 的 banner（`replaceAll`），banner 不含脚手架 id 时**抛错**（上游 preset 漂移不会被静默发布）。banner 因此**天生正确**，不再依赖事后步骤。
3. **`scripts/patch-client-id.mjs`**：改为**幂等 + fail-closed**：改写 `lib/client.js` 中**全部**出现（覆盖 CSS 注入器这类 banner 之外的路径），然后校验 published `id` 存在、`lib/**/*.js|*.map` 里**零**脚手架字节，任一条不成立即非零退出。已正确的产物上重跑是 no-op（本次输出：`0 scaffold occurrence(s) rewritten; 0 left anywhere under lib/`）。
4. **`scripts/clean-lib.mjs`（新增）**：构建前确定性清理整个生成半区。原因：preset 用 `clean: false`（node/client 两半共用 `lib/`），重建**不会**删除上一次构建留下的 chunk —— 实测 6 个死 chunk（`contract-BuVHI3zF.js`、`lib-Bj3jGSND.js`、`lib-DXy8Ramy.js`、`lib-biAw7Hvg.js`、`tool-groups-CJkqYVVc.js`、`tool-groups-l8pJ_H0h.js`）就是这样留在 `lib/` 并会被 `lib/*.js` 规则打进包里的。
5. **`package.json`**：`build`/`build:lib` = `clean:lib → tsc → tsdown → patch`；新增 `pack:artifact`（`npm pack`）与 `verify:artifact`。
6. **`scripts/verify-artifact-parity.mjs`（新增）**：身份 + parity + 孤儿 chunk + 宿主装配报告（见 §4）。
7. **`scripts/verify-profile-install.mjs`**：安装验证现在报告**被测 artifact 的路径与 sha256**，以及安装副本 `lib/client.js` 的路径、sha256、Loader id，并与 workspace 构建比对。
8. **`tests/artifact-parity.spec.ts`**：新增第 6 个用例 —— tgz 与 workspace `lib/` 的**双向字节一致**（packed ⊆ workspace 且 workspace 发布集 ⊆ packed）以及**无孤儿 chunk**（`lib/` 根 `*.js` 必须是 `package.json#files` 显式条目或被其他构建文件 import）。原 5 个用例断言未动。

---

## 2. 构建与打包（可复现命令）

```powershell
# 0) 基线
pnpm vitest run tests/artifact-parity.spec.ts          # 1 failed | 4 passed

# 1) 真构建（clean → tsc → tsdown → patch）
pnpm build                                             # exit 0
# 2) 重新打包
pnpm pack:artifact                                     # = npm pack --json
# 3) 产物身份 + parity 门禁（同时输出 JSON 报告）
pnpm verify:artifact
# 4) 隔离 profile 安装 + standing mount（只读用户 ~/.dsh 的闭包）
node scripts/verify-profile-install.mjs dsh-context-enhancement-0.1.10.tgz
```

原始输出全部在 `evidence/`：`baseline-artifact-parity.txt`、`build-final.txt`、`npm-pack.json`、`verify-artifact.txt`、`verify-profile-install.txt`。

构建链关键行：

```text
clean:lib - removed 253 generated file(s) (23 lib root .js)        # 首次：含 6 个死 chunk
clean:lib - removed 247 generated file(s) (17 lib root .js)        # 后续运行：只剩本次构建产出
ℹ [@deepseek-ai/dsh-client-ui-jobs/client] [CJS] lib\client.js  216.39 kB
patch:client-id - lib/client.js carries Loader id "dsh-context-enhancement" (0 scaffold occurrence(s) rewritten; 0 left anywhere under lib/)
```

---

## 3. 构建前后 hash、包清单与 source drift

### 3.1 关键 hash

| 文件 | before | after |
| --- | --- | --- |
| `lib/client.js` | `092384A0…3E231`（211941 B，mtime 2026-09-11T01:49:09Z，id=脚手架） | `D2DC6BBECDC034DADE0F0B363FC3A2C131B923877DA593E56CD49EA7EC0F49D3`（216387 B，id=`dsh-context-enhancement`） |
| `lib/client.js.map` | `088E84E1…F20451` | `C97DC594268C1BB57AD43A4970597A99690D1D34A3BAEF03967C61556BA1177D` |
| `lib/compaction-basic.js` | `4718F3AD7AC59FE89BC0D3ADC53BA41A163674D6F15B18DCC9A8BA2F0CBBC0D1`（391933 B） | `7C42DBC38EE7FC384E08508CA3017044F5082EBD0D5F3F5573C7FB2229F00E52`（425879 B） |
| `lib/task-state-basic.js` | `6BF1AD7171DC93FE8E764CE5C092C4C76E5F0507296155D7D510ABE7C060825A`（92090 B） | `FE7995AC9D4DBCAF32C83BECAE7A56762C9187B480CDC2F135BB5E36EC42DC10`（122088 B） |
| `dsh-context-enhancement-0.1.10.tgz` | `BE9DE3DE1F560E65B6E68E4A9B1647CA8CC042F98A8D58112C6961E6665A7E40`（1321348 B，83 members） | `5553D2A01EF55C970DCB6A952ADE95687740AF10E8297553192944CCC924C8A5`（1395917 B，86 members） |

完整清单：`evidence/hashes-pre-build.json`、`evidence/hashes-final.json`；两次构建的对照：`hashes-post-build-a.json` / `hashes-post-build-b.json`。

### 3.2 确定性

`pnpm build && npm pack` 连跑三次（`hashes-post-build-a`、`hashes-post-build-b`、最终一次完整链 `hashes-final.json`）：257 个文件（含 tgz）的 SHA-256 **全部相同**，新增/缺失/变化均为 0（`evidence/build-determinism.txt`）。

### 3.3 产物变化清单（生成物，非源码）

- **删除 6 个死 chunk**：`contract-BuVHI3zF.js`、`lib-Bj3jGSND.js`、`lib-DXy8Ramy.js`、`lib-biAw7Hvg.js`、`tool-groups-CJkqYVVc.js`、`tool-groups-l8pJ_H0h.js`（其中 2 个原本是未跟踪文件）。
- **新增 6 个 chunk**：`audit-DbO0V0N_.js`、`contract-C2nAZOQi.js`、`filter-CczOGkqh.js`、`lib-Bq6jN40l.js`、`lib-UkEFLxaM.js`、`source-index-BiRfSNPU.js`。
- **新增 8 个类型产物**：`lib/types/internal/task-state/basic/authority.{js,d.ts,d.ts.map,js.map}`、`…/inherited.{js,d.ts,d.ts.map,js.map}`。
- **内容变化 117 个**：106 个 `lib/types/**`（对齐当前 src）+ `lib/{client.js,client.js.map,compaction-basic.js,task-state-basic.js,task-state-prompt.js,task-state.js,tool-result-pruner.js}` + tgz + `package.json` + `tsdown.config.ts` + `scripts/patch-client-id.mjs`。

### 3.4 source drift（这也是必须重建的直接理由）

重建前的 `lib/` 是 2026-09-11 的旧构建：**缺** `src/internal/task-state/basic/authority.ts` 与 `inherited.ts` 的声明产物，并带 6 个早前构建的死 chunk。也就是说 `lib/` 与当前 `src` 已经不同构；旧 tgz（2026-09-10）更旧。`exports.types` 指向 `lib/types/index.d.ts`，因此旧发布包的**类型面也是陈旧的**。

### 3.5 包清单

- `package.json#files` 发布的 `lib/` 文件：**74**；tgz 成员：**86**（`evidence/tarball-members.txt`）。
- 未发布的 `lib/` 文件 173 个（`lib/client.js.map`、`lib/types/**/*.js`、`lib/types/**/*.map`、tsbuildinfo）—— 由 `files` 白名单决定，`verify:artifact` 会把这条边界打印成 note。

### 3.6 旧 loader id 搜索结果

`evidence/scaffold-id-search.txt`：脚手架 id 现在只出现在 3 类位置 ——
1. `scripts/client-bundle-ids.mjs`（唯一构建期常量）；
2. `tests/artifact-parity.spec.ts` 的两条**否定**断言；
3. 历史审计文档（`审计资料/01-*`、`41-*`、各批次实施记录）中对旧缺陷的描述。

`lib/` 命中 **0**，tgz 字节命中 **0**；`lib/client.js` 的 Loader id 为 `dsh-context-enhancement`。

---

## 4. 宿主装配（PLAN §10 第 4、5 项）

| 观测 | 事实 |
| --- | --- |
| 宿主页 | `C:\Users\chuxi\.dsh`（`$DSH_HOME`） |
| web profile 依赖 | `dsh-context-enhancement@file:C://Users//chuxi//Documents//trae_projects//code//dsh-context-enhancement//dsh-context-enhancement-0.1.10.tgz` —— **就是本次重打包的那个文件** |
| 已安装副本（web/desktop） | `…\profiles\<p>\node_modules\dsh-context-enhancement`，Loader id 正确，`lib/client.js` sha256 `63ECFC17449BBD59AFCEF78EEE6F4550F777821C63D28016CBB061880A0035B4`，mtime 2026-09-08 → **与本次构建不一致（旧构建）** |
| 本批次是否改动宿主 | **否**。`~/.dsh` 只读；让运行中的 profile 用上已验证字节需要宿主侧重装（`dsh plugin add` / profile 重装） |
| 隔离安装验证（本次执行，未触碰用户 profile） | temp `$DSH_HOME` 内 `dsh plugin add file:<tgz>` → 安装副本 `lib/client.js` sha256 `D2DC6BBE…F49D3`，**与 workspace 构建字节一致**，Loader id 正确；profile layers 含 `dsh-context-enhancement`；`agent-presets` 默认 `contextual`；roster `contextual, cordis, minimal, ptc, standard`；`standingKeyFor('contextual')` 通过（无 waiting row、无服务泄漏、无重复 provider）→ `isolated-profile install + standing-mount verification passed` |

`verify:artifact` 的 JSON 报告：`evidence/artifact-report.json`（含 artifact 路径/sha256/成员数、published lib 集、宿主装配行、孤儿 chunk、失败项）。

---

## 5. 验收结果

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| artifact parity（基线） | `pnpm vitest run tests/artifact-parity.spec.ts` | `1 failed / 4 passed`（唯一失败 = 第 128 行脚手架 id） |
| artifact parity（修复后） | 同上 | **`6 passed (6)`**，exit 0 |
| typecheck | `pnpm run typecheck` | exit 0 |
| release check | `pnpm run release:check` | `all release checks passed` |
| 产物门禁 | `pnpm verify:artifact` | `74 published lib/ files, 86 tarball members, byte-for-byte`，exit 0 |
| 安装装配 | `node scripts/verify-profile-install.mjs <tgz>` | exit 0（见 §4） |
| B3 focused | pressure exit/low-yield/reentry + envelope-budget + reentry-liveness + three-zone + retained-tail | **7 files / 101 passed** |
| B4 focused | startup-backlog + goal-authority + todo-authority + infeasible-progress + recovery-provenance + filter + worker + update + restart-recovery | **9 files / 130 passed** |
| B5 focused | prompt-fixed-slot + injection-budget + prompt + render + composition | **5 files / 54 passed** |
| B6 focused | tool-provenance-replay + tool-audit-recovery + tool-group-replacement + tool-group-audit-failure + served-provenance | **5 files / 37 passed** |
| B7 focused | fork-bootstrap + terminal-bootstrap + terminal-generation + unload + view + batch + audit | **7 files / 47 passed** |
| 全量业务测试 | `pnpm test` | **60 files / 551 passed**，exit 0（连续两次；第二次为无并发占用的最终运行） |

对比基线：修复前全量唯一失败项就是 artifact parity；修复后**零失败**，无新增失败。

**顺序性反证**（`evidence/tsdown-alone-id-check.txt`）：单独跑 `pnpm exec tsdown --config-loader tsx`（**不经过 patch 步骤**），`lib/client.js:2` 直接就是 `id: "dsh-context-enhancement"`，脚手架字节 0 处，`lib/client.js` sha256 与完整构建链一致（`D2DC6BBE…`），其后 `pnpm verify:artifact` 与 parity spec 仍全绿。这正是修复前失败的场景 —— 旧实现下同样的单独 tsdown 会留下脚手架 id，且 tgz 与 lib 的 id 分歧（`@deepseek-ai/dsh-client-ui-jobs` vs `dsh-context-enhancement`）由此而来。

---

## 6. 证据完整性

- 历史结果未被触碰：`E09-ForkResume` 的 16/16 文件 sha256 与其 `artifact-hashes.json` 逐项一致；`E00–E10`、`harness`、`X4` 的最新 mtime 均早于本批次开始时间（`evidence/historical-results-untouched.txt`）。
- `40-实验结果差异矩阵.md` / `41-缺陷与风险清单.md` **未修改**（本批次被明确禁止；R-P2-9 的状态更新留给主代理）。
- `git status` 前后逐行对照：`evidence/git-status-before.txt` vs `git-status-after.txt`；`src/**` 零改动（本批次只碰了 `tests/artifact-parity.spec.ts` 这一个测试文件）。
- 未使用 `git reset/clean/checkout/stash`；未知脏改动保留（HEAD 期间 179 行脏状态原样保留，新增脏行只来自本批次的产物与脚本）。
- 构建用的 DSH preset checkout 只读（33 条脏行均为先前的 README/i18n 与 compaction、test-support 的 package.json，与本构建读取的 preset 文件无关）。

---

## 7. 限制与保留风险

1. **宿主副本仍旧**：`~/.dsh/profiles/{web,desktop}` 里的安装副本是 2026-09-08 构建（`63ECFC17…`）。本次只证明"tgz 与 workspace 构建一致、且该 tgz 在隔离 profile 里能正确安装与挂载"；把运行中的宿主 profile 换成新字节是宿主侧动作，本批次刻意不做。
2. **sourcemap 不随包发布**：`lib/client.js` 末尾声明 `//# sourceMappingURL=client.js.map`，但 `package.json#files` 不含任何 `.map`，tgz 内 `.map` 成员为 0，安装副本也没有 map。这是既有的打包边界；本批次未改 `files`（避免无授权的打包语义变更），是否发布 sourcemap 由主代理/产品决定。
3. **B1 未变**：多实例 CAS/refresh/single-writer 仍 `blocked-upstream`。artifact parity 通过不代表多实例安全，也不得据此宣称为可用。
4. **E09/B7 实验 spec 未重跑**：其落盘路径是 B7 自己的证据目录（重跑会覆盖 B7 ledger），且其在当前树上的观测面已被 B5 fixed-slot 与 v2 clean-break 改变；B8 不改任何 src 语义，产物重建不影响该观测面。
5. **包内 `0.1.10` 版本号未升**：tgz 文件名不变（parity spec 与 README 均按该名引用），但**字节已不同**（sha256 `5553D2A0…`）。任何缓存了旧 tgz 的地方需要按 hash 区分，不能只看文件名。
