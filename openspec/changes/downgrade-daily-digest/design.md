## Context

Plan A Phase A4（`docs/hangar-migration-plan-a.md`）。现状核实（`file:line` 见下）：

- 日报 `runDailyWorkflow`（`run-daily-workflow.ts:423`）7 主阶段；**digest 阶段**（stage 5，`:689-785`）对 Top-N（默认 8）逐条 `summarizeEvent`（`agents/digest/index.ts:107`），一次 `generateObject` **同产** `summary_zh`（~1000 字）+ `headline_zh`（一句话）。
- **`summary_zh` 在日报消息里不显示**：`message.ts:11`「summary_zh 仅落库不进消息」；日报只渲染 `headline_zh`（缺则回落 `summary_zh` 截断 / 代表标题）。`summary_zh` 的真实消费者是 **weekly**（`weekly-report.ts` 零 LLM 复用）+ **KB grounding**（`kb/index.ts:206` 现把 `summary_zh` 当**输入**喂 KB）。
- **告警(alert)与日报(event)幂等命名空间刻意分开**（`alert-scan.ts:32`）：P0 走 `target_type='alert'`、日报走 `'event'`；`computePendingSet`（`dispatcher.ts:101`）/`selectTopN`（`top-n.ts:202`）只查 `event`。**日报现在会完整 recap 已 P0 的事件**——无自动去重。
- digest 阶段是熔断 abort-ratio 的两个 denominator 之一（`run-daily:769-785`，另一个是 judge）。
- 幂等/锁：`push_records UNIQUE(target_type,target_id,channel,push_date)`（`schema.ts:201`）、`daily-digest:{push_date}` 单实例锁（`push/lock.ts`）、per-event alert 锁（`alert-lock.ts`）。

**定性：新闻段降级 + `summary_zh` 搬迁，纯减法/搬迁，不动幂等/锁。**

## Goals / Non-Goals

**Goals:** 日报 digest 只产/显示 `headline_zh`；昂贵 `summary_zh` 由 KB 入库 Agent（对**每条 push-success 候选**跑、非仅 KB-worthy——`>= 70` 只 gate `kb_documents` 写入）产出并回写 `ai_news_events`；净降 LLM 成本、不饿死 weekly / KB grounding；日报保持完整低频兜底。

**Non-Goals:** 见提案「非目标」。核心：不动 product/experience 两条 LLM 车道；不做 P0×日报去重（接受 recap 重叠）；绝不动幂等 4 元组 / 双锁 / `computePendingSet` / 时间源；不删 `summarizeEvent` 能力、不改 weekly 复用口径。

## Decisions

**D1. 日报 digest 阶段 = 只产 `headline_zh` 的轻量路径。** 给 digest 能力加一条**只产一句话**的路径（schema 仅 `{ headline_zh }`，无 `summary_zh` 字段 → 输出 token 大减）；日报 stage 5 改调它。保留既有**已生成 guard**（`run-daily:704`）：跳过 `headline_zh` 已非空的事件（与 P0 lane 的成本去重不破——P0 lane 仍同产两者）。完整 `summarizeEvent`（digest 全路径、同产 summary+headline）**不删**、保留供**告警链 / 手动全摘要调用方**（非日报）。**注意 KB 入库用的是另一函数 `generateKbMetadata`**（本就产 `summary_zh` + `long_term_value`），**非** `summarizeEvent`——D2「summary 产出收敛到 KB」指日报那次 summary 调用被 KB `generateKbMetadata` 的输出 + 回写取代（去两函数间的 summary 重复），而非把 `summarizeEvent` 搬进 KB。

**D2. `summary_zh` 迁到 KB 入库阶段生成、写回 `ai_news_events`（本质去冗余）。** 现状 KB 摘要 Agent（`generateKbMetadata`）本就在入库阶段对每条已推送候选产出 `{ kb_title, summary_zh, ... }`——与日报 digest 的 `summary_zh` **重复生成**。降级后 `summary_zh` 唯一产出点收敛到 KB 入库：Agent grounding 于**原文**（`raw_items.content` / 代表标题，不再假设日报预置 `summary_zh`）产出 `summary_zh`，**写回 `ai_news_events.summary_zh`** 供 weekly 零 LLM 复用 + 作 KB grounding。
- **写回幂等——只 gate 写回、绝不 gate Agent 调用**：Agent **对每条候选照常跑**（它是 `long_term_value` 唯一来源、须逐条跑供准入闸——若因 `summary_zh` 已存在而跳过 Agent，会让 P0/已摘要的高价值事件失 `long_term_value`、被误挡出 KB，**严重回归**）；回写用**原子条件写** `UPDATE ai_news_events SET summary_zh WHERE event_id = ? AND summary_zh IS NULL`——列已非空（如 P0 lane 已产）即不覆盖（幂等 + 抗并发 alert 写），非「跳过生成」。
- KB doc 构造从「消费预制 `summary_zh`」改为「grounding 原文自产 `summary_zh` 再入 KB」——`kb/index.ts:209` 输入依赖翻转（`content` 已同传，不再假设 `summary_zh` 预存在）。
- **落点**：KB 入库是 best-effort、push 成功后跑、never throw（现状不变）；`summary_zh` 回写失败不阻塞 push（已推）。

**D3. P0 重叠不去重——沿用现状。** 日报 `selectTopN`/`computePendingSet` **零改动**（仍只查 `event` 命名空间）；alert 命名空间独立。日报完整 recap（含已 P0 事件）是**接受的行为**，非缺陷。DoD 从计划早稿的「不与 P0 重叠」改为「**低频完整兜底、接受与 P0 内容重叠**」（早稿 DoD 建立在「P0 自动去重」错误前提）。**零新增去重代码**。

**D4. 断路器结构不变（`daily-intel-pipeline` 规范无需改）。** digest 阶段仍是 abort-ratio 的一个 denominator（= 本次 Top-N 数），**逐条失败 = headline 生成失败**（原为 summary+headline 生成失败）；分母/阈值/`WorkflowAbortError` 抛错口径/BullMQ 整 job 重试**全不动**——「中文摘要阶段逐条失败」语义照旧（headline 亦中文摘要契约字段）。judge denominator 不变。故不出 `daily-intel-pipeline` delta spec。

**D5. `summary_zh` 覆盖集从「全 Top-N」缩到「push-success 子集」——降级但优雅（非严格零丢失）。** 旧生产者 = 日报 digest（stage 5，覆盖**全 Top-N**、push 前写）；新生产者 = KB 回写（stage 7，只覆盖 **push-success**）。二者**非同一集合**：Top-N 中被跨段抑制 / 分发未成功的事件，旧口径有 `summary_zh`、新口径无。KB 回写覆盖所有 push-success 候选（含 `< 70`，回写独立于 `>= 70` 准入 KB 写）。**故非严格零丢失**：weekly 对「Top-N-但-未成功推送」事件回退 `headline_zh`（digest 轻量路径已在 stage 5 产、故非空、优雅回退）。影响低：回退优雅 + `WEEKLY_REPORT_ENABLED` 现为 false（`weekly-report.ts`）。**weekly / freshness / MCP 代码零改**（本就 null-tolerant，见 D7）。

**D6. 不动的不变量（钉死）。** `push_records` 4 元组唯一 + never-success `computePendingSet`；`daily-digest:{push_date}` 单锁 + per-event alert 锁；`target_type` 命名空间分割；`getPushDate`(Asia/Shanghai)；日报 `message.ts` 渲染（本就只显示 headline，**零改**）；product/experience 段；alert-scan 车道。

**D7. `summary_zh` 消费者全枚举（fan-out）+ 覆盖集/时序影响。** 本变更把 `ai_news_events.summary_zh` 产出从 **stage 5（digest，全 Top-N，push 前）** 移到 **stage 7（KB 回写，push-success 子集，push 后）**——覆盖集缩到 push-success（见 D5）、时序后移。全仓 `.summaryZh` 读点（grep 核实，**8 处**）：
- ① 日报 digest guard/用（stage 5，`run-daily:699/704`——本变更 guard 改测 `headlineZh`）；
- ② 日报消息 headline 回退（`message.ts:79-81` stage 6，见 Risks——headline 失败个例回退代表标题）；
- ③ **weekly**（`weekly-report.ts:215`，独立调度、远在 KB 回写之后读）→ 零影响；
- ④ **KB grounding**（`kb/index.ts:209`，stage 7，D2 改 grounding 原文自产）→ 自洽；
- ⑤ **mr/freshness/event-consumer**（`event-consumer.ts:103/141`，读 `[title, summary, headline]` 做新鲜度文本匹配、独立消费）；
- ⑥ **MCP search-events**（`search-events.ts:81/109`，`ilike(summaryZh)` 检索 + 返回、按需查询）；
- ⑦ **alert-scan**（`alert-scan.ts:219/414`，读**自己产**的 summary_zh 作「已摘要」skip-guard）→ 自产、不受本变更影响；
- ⑧ **MCP push_event_now**（`push-event-now.ts:119/137`，选 + 传 summary_zh 进 dispatch）→ 缺则经 `message.ts` 回退 headline、优雅。

8 个读点均 **null-tolerant**（RC/CR 逐一核实）：weekly 无 summary_zh 过滤谓词、回退 headline；freshness 过滤空 part + 多日 rescan；MCP search `ilike(null)` 不匹配但 OR 代表标题、余列照返；push_event_now 经 message.ts 回退；alert-scan 读自产。故覆盖集缩到 push-success（Top-N-未推成功事件失 summary_zh）**功能上优雅降级、无消费者被饿死**；⑤⑥⑧ 读取时点通常远在当日 KB 回写之后，「push~KB 回写」窄窗仅影响该间隙的按需查询、可接受。实现期加断言核实（见 Open Questions）。（另 `selection/top-n.ts:243` 亦 SELECT 该列，但 `WHERE`/rank 计分均不用它——空值无关的投影透传、喂 ①②，非独立空值敏感消费者。）

## Risks / Trade-offs

- **[Top-N-但-未推成功 / KB-Agent-失败 事件失 summary_zh]** → D5：新口径 summary_zh 只覆盖 push-success；被跨段抑制 / 分发未成功 / KB-Agent-失败的事件无 summary_zh（旧口径 digest 有）→ 消费者优雅回退 headline（digest 轻量路径已产）。**KB best-effort/never-throw**：Agent 对某候选失败即该候选无回写、下轮不再候选（候选 = 当日 push-success）→ 永久无 summary_zh；功能优雅、可接受。
- **[KB 入库现消费 summary_zh、翻转为自产]** → D2：`kb/index.ts:209` 输入依赖翻转（`content` 已同传），须核实无别处仍假设「入库前 summary_zh 必存在」。
- **[断路器语义漂移]** → D4：只换所测调用、denominator/阈值/抛错口径不变；测试钉熔断行为。
- **[日报与 P0 内容重叠观感]** → D3：接受（P0=即时、日报=低频兜底两种节奏），出口闸靠「你不再依赖日报获取高价值」。
- **[P0 lane 仍产 summary_zh]** → 有意：P0 事件即 KB-worthy、summary_zh 归其 grounding，成本合理；本变更只砍日报**广口 Top-N** 的 summary 生成。
- **[日报显示无回归——summary_zh 与 headline 共产]** `message.ts` 回退链 = `headline_zh → summary_zh 截断 → 代表标题`；但 `summary_zh` + `headline_zh` 由同一次 `generateObject` 共产（`persistence.ts`），故 headline 失败在**改造前也**同时失 summary、现状已回退代表标题。降级后 headline-only 路径同样在 stage 5（push 前）产 headline，日报显示与今日**逐字节同**、零回归（渲染代码零改）。

## Migration Plan

- 普通 PR，无 schema 迁移（`summary_zh` 列已存在，只改写它的**生产者**）。
- 回滚 = revert；`summary_zh` 生产回到日报阶段。
- 部署：无新 env、无新表；行为变化（日报更轻、summary 来源迁移）随代码上线。
- **上线前软确认**：A1 P0 即时推在跑（no-dedup 已使其非硬依赖——日报仍完整覆盖，可先行）。

## Open Questions

- **weekly 是否含非 KB-worthy 事件**：若含且 headline 回落体验差，未来可让 weekly 对缺 summary 的入选项按需补生成（本期不做，D5 回落足够）。
- **KB 入库 `summary_zh` 生成模型/长度**：复用现 KB agent 的中文摘要能力即可；长度沿用现 `summary_zh` 口径，实现期核。
- **D7 ⑤⑥ 时序确认**：实现期须核实 `mr/freshness/event-consumer` 与 MCP `search-events` 的读取时点确在当日 KB 回写之后（或对「push 后~KB 前」窄窗 summary_zh 短暂为空容忍）——两者本就对缺 summary_zh 的事件回退（freshness 用 title/headline、search 用其它列），预期零硬依赖，实现期加断言。
