## Why

PR #95（`e292753`）删除了 weekly-report 整条车道与 `SEMANTIC_DEDUP_ENABLED` 门控，但只动了代码，没同步 `openspec/specs/` 下的主规范。结果是**规范在要求一个已不存在的能力**：`weekly-report/spec.md` 整份描述已删除的周报车道，另有 8 份主规范把周报当作在役的独立调度入口 / 推送路径 / tombstone 下游消费者，`semantic-dedup/spec.md` 仍要求「系统必须提供 `SEMANTIC_DEDUP_ENABLED` 开关」+ 一个「开关关闭」场景。

规范是本仓的验收基线（`openspec-cn validate --strict` 与人工评审都据它判对错）。留着这批陈述会让下一个读规范的人（或 agent）按已删能力去实现、去断言，也让「规范即事实」这条约定失效。#95 已合并部署，漂移只会越攒越多，现在收。

## What Changes

- **移除 `weekly-report` 能力**：整份规范对应的实现（`weekly-report.ts` / `weekly-queue.ts` / `weekly-cron.ts` / 周报渲染器 / `isWeeklyReportEnabled` / `WEEKLY_REPORT_ENABLED`）已在 #95 删除，规范随之移除。
- **8 份主规范修正对周报与语义门控的过期陈述**：删除「周报由独立定时任务承载」类约束与其场景、把周报从 tombstone 下游消费者表 / 独立推送锁清单 / 飞书渲染器清单中移除、删除 `SEMANTIC_DEDUP_ENABLED` 开关需求与「开关关闭」场景（语义层现为无条件执行）。
- **`platform-foundation` 只改理由、不改枚举**：`target_type` 枚举含 `weekly` 这一陈述**在代码里仍为真**（`src/push/targets.ts:32,49` 保留该成员，删它需连带 DB CHECK 迁移），故只修正指向已删能力的理由说明，并标明 `weekly` 现为保留成员、无生产写入方。
- **`knowledge-base` 只改理由、不改行为**：`summary_zh` 回写仍必须发生，但「供 weekly 复用」的理由失效——改为其真实消费者（告警链渲染回退链 `alert-scan.ts:531-582`）。

本变更**不含任何运行时代码行为改动**，是纯规范同步。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `weekly-report`: **整份移除**——能力已随 #95 删除，规范无对应实现。
- `daily-intel-pipeline`: 删除「周报必须由独立定时/触发任务承载」约束及场景「告警/周报独立调度、产品并入日报新品段」中的周报项。
- `pipeline-run-context`: 删除 `trigger` 的 `weekly→weekly-report` 取值、driver 解耦需求中的 `weekly-report.ts`/`weekly-queue.ts` 条目与整段 weekly 拆分说明、run-event 需求中的「weekly 二阶段」与场景「weekly 时间线 + 逐 channel 结局」。
- `semantic-dedup`: 删除 `SEMANTIC_DEDUP_ENABLED` 开关要求与场景「开关关闭退回硬去重」（语义层无条件执行）；从 tombstone 下游消费者表与场景中移除周报聚合。
- `telegram-push`: 从「不共用日报单例锁的独立推送路径」清单中移除周报。
- `feishu-push`: 从避整点 cron 清单、稀疏度论证、卡片渲染器枚举中移除周报。
- `mcp-query`: 从「MCP 进程绝不参与主流程调度」的否定式枚举中移除周报。
- `knowledge-base`: 场景名与断言里的「供 weekly 复用」改为真实消费者。
- `platform-foundation`: 仅修正 `target_type` 枚举中 `weekly` 成员的理由说明（保留成员本身）。

## Impact

- **规范**：`openspec/specs/` 下 1 份移除 + 8 份修改；`openspec-cn validate --strict` 须保持全绿（当前 32/32）。
- **代码**：无运行时改动。可选顺带清理 `src/push/targets.ts:11-12,60`、`src/kb/index.ts:15`、`src/mcp/tools/get-today.ts:80` 等注释里把周报描述成在役路径的措辞（单列任务、与规范同批，不改任何逻辑）。
- **数据库**：无迁移。`push_records.target_type` 仍接受 `weekly`（无写入方）。
- **部署**：无。不需要重新部署或改 env。

## 非目标

- **不删 `src/push/targets.ts` 的 `TARGET_TYPE.weekly` 枚举成员，不做 DB CHECK 迁移**——#95 已显式登记为保留（删它要连带迁移，超出本变更范围）。
- **不改任何运行时代码行为**——本变更只同步规范；注释清理若做也只改注释文本。
- **不动 `openspec/changes/archive/` 下的历史归档**——历史记录按当时事实保留，不追溯改写。
- **不重新引入周报能力**——本变更只做事实对齐；未来若要恢复周报，走新的提案。
- **不把规范正确性交给 LLM 判定**——每条删改都以代码/文件是否存在为地面真相（`git show e292753 --stat` + 现存文件），逐条可机械核对；`validate --strict` 与 grep 断言是验收闸。
