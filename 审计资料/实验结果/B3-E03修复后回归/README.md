# B3-E03 修复后回归实验

## 目标

用与 E03 完全相同的 fixture（W=100000、初始 82000、每周期 1 tool-call 1000 + 1 tool-result 4000、5 周期），
在 B3.1/B3.2 修复后的 pressure path 上运行，判断原 `thrashStreak>=3` 是否仍成立。

## 结论

**verdict = `fixed`**

| 指标 | 原 E03 | B3 修复后 |
|------|--------|-----------|
| thrashStreak | **5** | **1** |
| headroomGapStreak | **5** | **1** |
| verdict | reproduced | **fixed** |
| pressure 退出点 | 78%–79% | **68%–69%** |
| 退出后 headroom | 1000–2000 | **11000–12000** |
| 触发 pressure 的 tool/result 数 | 每 1 个 | 每 2–3 个 |
| stop reason | 无 typed stop | **pressure-exit** |

## 关键发现

### B3.1 exit target 修复是核心差异

原 E03 的抖动根因：pressure maintenance 退出至 78%–79%（接近 80% trigger），
headroom 不足一个典型 tool/result（4000 token），导致每次工具调用重触发维护。

B3.1 修复后：
1. `exitTokens = min(thresholdTokens, floor(W × pressureExitRatio)) = 70000`
2. pressure maintenance 退出至 68000–69000（低于 exit line 70000）
3. headroom = 11000–12000（远大于典型 tool/result 的 4000）
4. 需要 2–3 个 tool/result 周期才能重新触发 pressure tier

### 循环模式

| Cycle | Tier | Before | After | Headroom | Committed | Stop |
|-------|------|--------|-------|----------|-----------|------|
| 0 | pressure | 82000 | 68000 | 12000 | ✓ | pressure-exit |
| 1 | maintenance | 73000 | 73000 | 7000 | ✗ | — |
| 2 | maintenance | 78000 | 78000 | 2000 | ✗ | — |
| 3 | pressure | 83000 | 69000 | 11000 | ✓ | pressure-exit |
| 4 | maintenance | 74000 | 74000 | 6000 | ✗ | — |
| 5 | maintenance | 79000 | 79000 | 1000 | ✗ | — |

**模式**：pressure 退出 → 2 个 tool/result → 重新触发 pressure → 退出 → 2 个 tool/result → ...

### 为什么 thrashStreak = 1

thrashGap 定义：相邻维护之间恰好新增 1 个 tool/result 且后一次维护提交了 replacement。

- Cycle 0→1: 后一次未提交（maintenance tier, no commit）→ thrashGap = false
- Cycle 1→2: 后一次未提交（maintenance tier, no commit）→ thrashGap = false
- Cycle 2→3: 后一次提交了（pressure tier, committed）→ thrashGap = **true**
- Cycle 3→4: 后一次未提交（maintenance tier, no commit）→ thrashGap = false
- Cycle 4→5: 后一次未提交（maintenance tier, no commit）→ thrashGap = false

连续 thrashGap 最大长度 = 1（< 3），不满足原 E03 的 reproduced 判据。

## 实验约束

- L1 fixture：fake token meter + fake LLM + temporary Session
- 不修改生产源码、tests、历史 E03 文件或其他审计文档
- 共享 harness 未修改
- 审计目录新增文件不计入 source drift

## 产物

| 文件 | 说明 |
|------|------|
| `b3-e03-regression.spec.ts` | 实验 spec |
| `ledger.json` | 完整实验账本 |
| `result.json` | 结构化结果 |
| `vitest-output.txt` | 测试运行输出 |
| `post-run-hashes.json` | 运行后生产文件哈希 |
| `README.md` | 本文件 |
