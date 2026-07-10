## 为什么

本轮排查发现三个采集源长期静默失效却无任何告警：RSS 抛 `TypeError` 被单源 `allSettled` 隔离吞掉（死约一月，含 `openai` 官方源，GPT-5.6 官方公告整月漏采）、blogger 同因从未出数、product_hunt 因 PH API `postedAfter`+`VOTES` 日边界行为变化而**成功返回 0 条**（死约十天）。

现有系统级告警（`daily-intel-pipeline`）只在「采集返回总数 = 0」或「新闻类可处理数 = 0」即**全源皆挂**时触发；任一单源长期归零，只要其它源仍在产出，就完全静默。缺「按源」的存活可观测性，使"某源悄悄死掉"只能靠人肉发现，代价是数周的情报缺口。现在补这层监控，才能让下一次单源失效在天级而非月级被发现。

## 变更内容

- 新增**按源采集陈旧度检测**：对每个**已注册 collector 源**，以确定性 DB 查询按 `source` 聚合其 `raw_items` 最近入库时间（`max(fetched_at)`），若某源连续超过阈值天数零新增即经**既有 `AlertSink`** 告警。
- 阈值由 **env 配置**（`SOURCE_STALENESS_ALERT_DAYS`，给一个合理默认），并允许**按源覆盖**（各源节奏不同：arxiv/hacker_news 高频、product_hunt 每日、部分低频博客可数日一更）。
- 检测作为 **best-effort 阶段**接入既有每日工作流（与既有 `countAiGatedOut` 诊断同款：`try/catch` 包裹、仅告警、绝不影响 `outcome`/熔断/推送）。
- 陈旧度判定**全部由确定性 DB 查询得出，绝不交 LLM**。
- 「已注册源集合」取自 collector registry（`buildRegistry` 的 `source` 列表），使**新增源自动纳入**陈旧度监控，避免"加了源忘了监控"。

## 功能 (Capabilities)

### 新增功能
- `source-staleness-alert`: 按源采集陈旧度检测与告警。对每个已注册源基于 `raw_items` 的 `max(fetched_at)` 判定「连续 N 天零新增」并经 `AlertSink` 上报；阈值 env 可配、可按源覆盖；纯 DB 判定、best-effort、不改采集器、不改既有系统级告警。

### 修改功能
（无——既有 `daily-intel-pipeline` 的系统级「全源=0 / 新闻类可处理=0」告警与各采集器自身行为均不变，本变更为纯增量的新可观测能力。）

## 影响

- **代码**：新增一个陈旧度检测模块（按 `source` 聚合 `max(fetched_at)` 的只读查询 + 阈值判定 + 组装告警文案）；在 `src/pipeline/run-daily-workflow.ts` 以 best-effort 阶段调用（`try/catch` 隔离，参照既有 `countAiGatedOut` 诊断块）。
- **配置**：新增 env `SOURCE_STALENESS_ALERT_DAYS`（默认值）+ 可选**按源覆盖**机制（具体形态在 design.md 定）。
- **数据**：只读 `raw_items`（`source` + `fetched_at` 聚合），**不新增表/列/迁移**。
- **源集合来源**：collector registry（`src/collectors/index.ts` 的 `buildRegistry`），复用其 `source` 列表作为待监控源全集。
- **不改**：各 collector 采集逻辑、`daily-intel-pipeline` 既有系统级告警、无自动重试/自动修复（本变更只负责"发现并上报"，修复仍由人决策）。
