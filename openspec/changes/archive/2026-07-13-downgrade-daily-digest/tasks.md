## 1. 中文摘要 Agent — headline-only 轻量路径（src/agents/digest/）

- [x] 1.1 给 digest 能力加**只产 `headline_zh` 的轻量路径**：Zod schema 仅 `{ headline_zh }`（复用 `HEADLINE_MAX=80` 单一常量 + mojibake 守卫 + 有限重试），`generateObject` 输出 token 大减。
- [x] 1.2 轻量路径写库 `UPDATE ... WHERE event_id = ?` 的 `set` **仅含 `headline_zh`**（绝不写 `summary_zh`、绝不覆盖塌缩首建 `representative_title`/`*_score` 等列）。完整「summary+headline」路径**原样保留**（供实时告警链等）。

## 2. 日报 digest 阶段改调轻量路径（src/pipeline/run-daily-workflow.ts）

- [x] 2.1 日报 digest 阶段（stage 5）改调 headline-only 轻量路径（不再产 `summary_zh`）。
- [x] 2.2 已生成 guard（现按 `summary_zh` 非空跳过，`run-daily:704`）改按 **`headline_zh` 非空**跳过（与告警链的成本去重不破——告警链仍同产 summary+headline）；**同处 `toSummarizeCount`（`run-daily:699`，log-only denominator）也改测 `headlineZh`**（否则进度日志分母错）。
- [x] 2.3 断路器：digest 段 denominator（= Top-N）/阈值/`WorkflowAbortError` 抛错口径/BullMQ 整 job 重试**全不动**，只是所测调用变轻（headline 生成失败即该段降级计数）——**不动 `daily-intel-pipeline` 规范结构**。

## 3. KB 入库生成 summary_zh 并回写（src/kb/）

- [x] 3.1 KB 摘要 Agent grounding 改**原文**（`raw_items.content` / 代表标题），**不再假设 `ai_news_events.summary_zh` 已预置**（`kb/index.ts` 输入依赖翻转）。
- [x] 3.2 Agent 产出并经校验的 `summary_zh` **原子条件回写 `ai_news_events.summary_zh`**：`UPDATE ai_news_events SET summary_zh = ? WHERE event_id = ? AND summary_zh IS NULL`（`set` 仅含 `summary_zh`、绝不覆盖塌缩首建列；`WHERE ... IS NULL` 令幂等 + 抗并发 alert 写）；回写覆盖**所有已推送成功候选**、与 `>= 70` 准入 KB 写相互独立（`< 70` 未入 KB 者亦回写）。
- [x] 3.3 **Agent 对每条候选照常运行**（`long_term_value` 唯一来源、供准入闸）——**绝不能因 `summary_zh` 已存在而跳过 Agent 调用**（否则 P0/已摘要事件失分被误挡出 KB）；幂等只在回写的 `WHERE summary_zh IS NULL`。回写失败不阻塞已成功推送（best-effort、never throw 不变）；Agent 对某候选失败则该候选无回写（见 design Risks）。

## 4. 测试 & 验证

- [x] 4.1 digest 轻量路径：只产/写 `headline_zh`、不产 `summary_zh`（注入 generateObject 桩断言 schema 字段 + 写库 `set` 列）。
- [x] 4.2 日报**确定性面回归**：入选 event 排序、`push_records` 行与改造前一致（mock LLM、钉 `now`；prose 非确定不逐字节比）。
- [x] 4.3 KB 回写：入库后新闻事件 `ai_news_events.summary_zh` 被回写（`< 70` 未入 KB 者亦回写）、weekly 仍零 LLM 复用；**`summary_zh` 已存在时 Agent 仍跑**（产 `long_term_value` 供准入闸）、回写 `WHERE ... IS NULL` 不覆盖——**断言 P0/已摘要事件不被误挡出 KB（KB-admission 无回归）**。
- [x] 4.4 幂等回归：P0 alert（`target_type='alert'`）+ 日报 event（`target_type='event'`）各自命名空间互不吞（日报仍完整 recap、接受与 P0 重叠）。
- [x] 4.5 断路器回归：digest 段 headline 失败率超阈仍熔断（denominator/阈值/抛错不变）；judge 段不变；回填仍不入熔断分母。
- [x] 4.6 全量测试绿，守 `VITEST` 不真调 LLM/embedding（注入桩）、不真发。

## 5. 文档对账

- [x] 5.1 `docs/hangar-migration-plan-a.md` Phase A4 段落对齐已实现形态（新闻段降级 + `summary_zh` 去冗余收敛到 KB 入库 + 接受 P0 recap 重叠 + 幂等/锁/product/experience 不动）；**修正早稿「P0 即时推自动被日报去重」的错误前提**（alert/event 刻意分开命名空间、日报本就完整 recap）。
