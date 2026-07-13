## Why

Plan A Phase A4（定位见 `docs/hangar-migration-plan-a.md`「Phase A4 — 日报降级」）。A1 高频扫描 + P0 即时推在位后，每日 digest 不必再是「当日精选成稿」——高价值展开已活在 KB（A2）+ 对话 RAG（A3），日报退化为「扫一眼有没有漏」的低频兜底。本变更把日报**新闻段**降级为轻量集合推 + 把昂贵的 `summary_zh` 生成**迁出日报热路径**，净降 LLM 成本、不饿死 weekly 复用与 KB grounding。

**定性：大体是减法 + 一处搬迁。** 不加新功能、不动幂等/锁。

## What Changes

- **日报 digest 阶段只产 `headline_zh`（日报唯一显示字段），停产 `summary_zh`**：现 `summarizeEvent` 一次 `generateObject` 同产 `summary_zh`（~1000 字，**日报不显示**、仅落库，`message.ts:11` 载明）+ `headline_zh`（一句话、日报唯一显示）。日报阶段改走**只产 headline** 的轻量路径。
- **`summary_zh` 生成迁到 KB 入库阶段（去冗余）**：现 KB 摘要 Agent 本就对**每条已推送成功候选**跑一次（算 `long_term_value` 供准入闸、同调产 `summary_zh`），与日报 digest 的 summary 生成**重复**。降级后**日报路径不再产 `summary_zh`**、其产出收敛到 KB 入库（告警链仍为 P0 事件另产）：Agent grounding 原文产 `summary_zh`、**原子条件回写** `ai_news_events`（`WHERE summary_zh IS NULL`，只 gate 写回、**绝不 gate Agent 调用**）——weekly 复用 + KB grounding 不丢，净省日报那次 ~1000 字 summary 生成。
- **日报保持完整低频兜底、接受与 P0 内容重叠（不加跨命名空间去重）**：告警（`target_type='alert'`）与日报（`'event'`）是**刻意分开的幂等命名空间**（`alert-scan.ts:32`「日报已推同一事件不吞掉告警」），日报本就会 recap 已 P0 的事件。本变更**沿用**此现状、不加去重——日报=完整低频兜底、P0=即时高价值。（放弃计划早稿「不与 P0 重叠」DoD——该 DoD 建立在「P0 自动去重」的**错误前提**上。）
- **断路器结构不变**：digest 阶段仍是熔断 abort-ratio 的 denominator（阶段/分母 = Top-N/阈值/抛错口径全不动）；只是该段所测的**逐条调用从「summary+headline」变轻为「仅 headline」**——「中文摘要阶段逐条失败」语义照旧成立（headline 亦 `summary_zh` 契约里的中文摘要字段），故 `daily-intel-pipeline` 规范**无需改动**。

## Capabilities

### 修改能力(Modified)

- `chinese-digest-agent`：中文摘要契约新增**只产一句话 `headline_zh` 的轻量路径**——日报 digest 阶段 SHALL 用该轻量路径（只产/写 `headline_zh`、不产 `summary_zh`）；完整「summary+headline」路径保留（供告警链等）；新闻事件 `summary_zh` 不再由日报阶段产出。
- `knowledge-base`：KB 新闻事件入库 SHALL **grounding 于原文**（不再假设 `ai_news_events.summary_zh` 已由日报预置）、并把入库 Agent 产出的 `summary_zh` **原子条件回写 `ai_news_events.summary_zh`**（`WHERE summary_zh IS NULL`，供 weekly 零 LLM 复用）；**Agent 对每条候选照常运行产 `long_term_value`（供准入闸）——幂等只在回写 UPDATE、绝不跳过 Agent 调用**。

## 非目标(Non-Goals)

- **不动 `product` 中文化 + `experience` mining 两条 LLM 车道**：本提案聚焦**新闻段**降级；两段 LLM 展开的降级/迁移另起（避免 big-bang）。
- **绝不动幂等/锁结构**：`push_records UNIQUE(target_type,target_id,channel,push_date)` 4 元组、`daily-digest:{push_date}` 单实例锁、per-event alert 锁、`computePendingSet` never-success 语义、`getPushDate`(Asia/Shanghai) 时间源——全部不动。
- **不做 P0×日报跨命名空间去重**（见上，接受 recap 重叠；两命名空间各自独立幂等不变）。
- **不删写稿能力**：`summarizeEvent`（digest 全路径）完整能力保留、只改路由——日报不再调它，保留供**告警链 / 手动全摘要**复用（KB 入库用的是 `generateKbMetadata`，非 `summarizeEvent`）。
- **不改 weekly 的复用口径**：仍零 LLM 读 `summary_zh`，只是来源从「日报预生成」变「KB 入库生成」。

## Impact

- **改动代码**：`src/agents/digest/`（新增 headline-only 路径）、`src/pipeline/run-daily-workflow.ts`（digest 阶段改调 headline-only 路径）、`src/kb/`（入库 grounding 改原文 + `summary_zh` 回写 `ai_news_events`）。
- **不改**：`src/push/dispatcher.ts` 幂等、双锁、`computePendingSet`、`message.ts` 渲染（日报本就只显示 `headline_zh`）、熔断结构（`daily-intel-pipeline` 规范）、`product`/`experience` 段、`alert-scan` 车道（P0 仍产 summary+headline）、时间源。
- **成本（本质是去冗余）**：现状日报 digest（stage 5）与 KB 入库（stage 7）**各产一次 `summary_zh`**（重复）。降级后日报 digest 只产便宜的 `headline_zh`，新闻事件 `summary_zh` 的产出收敛到 KB 入库 Agent（日报路径不再产；告警链 P0 另算）——净省日报那次 ~1000 字 summary 生成。
- **weekly 覆盖降级但优雅（非严格零丢失）**：新 `summary_zh` 覆盖 **push-success**（非全 Top-N，见 design D5/D7）；Top-N-但-未推成功 / KB-Agent-失败的事件回退 `headline_zh`（digest 已产、非空）。全部 8 个 `summary_zh` 读点均 null-tolerant、代码零改（且 `WEEKLY_REPORT_ENABLED` 现为 false）。
- **前置（软）**：A1 P0 即时推已在位——no-dedup 选择已把它从**硬**依赖降为**软**前提（日报仍完整、不自断高价值路径，故可在 P0 完全被信任前先行）。
- **测试**：日报只显示 headline / 不产 summary_zh（确定性面：入选 event 排序不变）；KB 入库生成 summary_zh 写回（weekly 仍零 LLM 复用）；幂等回归（alert / event 各自命名空间互不吞）；断路器 headline denominator；守 VITEST 不触网、不真发。
