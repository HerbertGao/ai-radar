## Context

PR #95（`e292753`，2026-07-21 合并并已部署到生产）删除了 weekly-report 车道与 `SEMANTIC_DEDUP_ENABLED` 门控，但没同步 `openspec/specs/`。当前 9 份主规范（1 份整体 + 8 份局部）仍在描述已删能力。本变更是**纯文档对齐**，不含运行时改动，地面真相是「文件/符号是否存在」——每条删改都能用 `git show e292753 --stat` 或 `grep` 机械核对，不需要也不允许 LLM 判定规范正确性。

约束：`openspec-cn validate --specs --strict` 当前 32/32 全绿（`3a9e5e4` 刚回填过占位 Purpose），本变更不得让它变红。

## Goals / Non-Goals

**Goals:**
- 让主规范与 `e292753` 之后的代码事实一致：没有实现的需求不留在规范里。
- 修改保持**最小且可核对**：MODIFIED 块逐字节复制原需求后只做定点替换，diff 只落在真正过期的句子上。
- 保住「规范即验收基线」这条约定——下一个读规范的人（或 agent）不会照着已删能力去实现或断言。

**Non-Goals:**
- 不删 `TARGET_TYPE.weekly` 枚举成员、不做 DB CHECK 迁移（#95 已显式登记为保留）。
- 不改任何运行时行为；注释清理（若做）只改注释文本。
- 不改写 `openspec/changes/archive/` 下的历史归档。
- 不重新引入周报能力。

## Decisions

### D1：`weekly-report` 用 REMOVED 整份移除，而不是留空壳或标「已停用」

选 REMOVED（两条需求各带 Reason + Migration），归档时主规范目录随之删除。

替代方案 ①「保留规范 + 加『本能力已停用』标注」：被否——规范不是变更日志，留着仍会被 `--specs --strict` 计入、被检索命中，且「停用」暗示可一键恢复，而实现已删干净、恢复要重写。替代方案 ②「直接删主规范文件不走 delta」：被否——绕过 OpenSpec 流程，归档记录里查不到为什么删。

### D2：MODIFIED 块用脚本逐字节抽取，再定点替换（每处 `assert count == 1`）

8 份规范里最长的需求块近百行（`daily-intel-pipeline` 的「每日定时单队列顺序编排」）。delta 的 MODIFIED 语义要求整块复制，手抄必然引入静默漂移（丢一句、改一个标点，归档时就把主规范改坏）。故：脚本按 `^### ` 切块原样抽取 → 对目标句子做 `replace`，每处断言恰好命中 1 次，命中 0 次或多次即中止。

替代方案「人工逐块复制粘贴」：被否——不可核对，且这类漂移的代价是**静默的**（validate 抓不到内容丢失）。

### D3：`platform-foundation` 只改理由、`knowledge-base` 只改消费者，都不改断言本身

两处的规范陈述**在代码里仍为真**，过期的只是理由：

- `target_type` 枚举确实仍含 `weekly`（`src/push/targets.ts:32,49`）。改法：保留枚举陈述，补「`weekly` 为保留成员、无生产写入方、MUST NOT 被新推送路径复用」，并把「见 weekly-report」这一指向已删规范的引用去掉。
- `summary_zh` 回写确实仍必须发生。原理由「供 weekly 复用」失效，但**回写不是没人用了**——`alert-scan.ts:531-582` 的渲染回退链（`headline_zh` → `summary_zh` 截断 → `representative_title`）在读它。改法：把消费者换成告警链，行为断言一字不动。

反面教训：如果只按「grep 到 weekly 就删」的机械规则做，这两处会被误删成「枚举不含 weekly」和「取消 summary_zh 回写」——前者与代码矛盾，后者会让告警渲染回退链失去数据源。故凡 grep 命中都要回代码确认「陈述失效」还是「只有理由失效」。

### D4：`mcp-query` 这类否定式枚举也一并清理

「不嵌入 `runDailyWorkflow()`/告警/周报」删掉「周报」后语义不变（对不存在的东西的禁令恒真）。清理它的收益不是纠错，而是不给「周报是在役路径」留暗示。改动一个词，风险为零，一并做。

## Risks / Trade-offs

- **[MODIFIED 块复制出错 → 归档时把主规范改坏]** → 脚本抽取 + 每处 `assert count == 1`；实现后用 `git diff` 逐份人工过一遍「diff 只落在周报/门控句子上」；`validate --strict` 兜底结构合法性。
- **[漏网的过期陈述]** → 验收用 `grep -rn "weekly\|周报" openspec/specs/` 全量复核，并**逐条判定**保留项是否合理（`model-radar-recommender` 的 `weekly_messages` 是额度 limitType、与周报无关，MUST NOT 改）。
- **[归档时 delta 与主规范需求名不匹配 → 静默不生效]** → 需求名来自脚本抽取，与主规范逐字节同源，天然匹配；归档后再跑一次 `--specs --strict` 确认 31/31（少掉 weekly-report 一谱）。
- **[代码注释仍把周报描述成在役路径]** → 单列为独立任务，不与规范同 commit 混淆；纯注释、无逻辑改动。

## Migration Plan

无部署动作、无 DB 迁移、无 env 改动。合并后走 `/opsx:archive`，delta 并入主规范、`openspec/specs/weekly-report/` 随归档删除。回滚 = revert 该 commit（纯文档，无生产影响）。

## Open Questions

无。范围与每处改法均已按代码事实定死。
