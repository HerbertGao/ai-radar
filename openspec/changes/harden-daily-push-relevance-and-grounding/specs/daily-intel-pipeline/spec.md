## 新增需求

### 需求:日报链在 Value Judge 之前运行正文补全阶段

`runDailyWorkflow()` 的顺序链**必须**在硬去重塌缩**之后**、Value Judge 判分（`scoreUnscoredEvents`）**之前**插入一个正文补全阶段（source-content-enrichment），对**待判事件**代表 raw_item 中 `content` 为空且有可抓 URL 的行补抓正文写回 `raw_items.content`。该阶段**必须** best-effort、逐条隔离、永不向上抛错中止流水线，**禁止**计入任何降级率熔断分母（熔断分母仍只含 Value Judge 与中文摘要两阶段，既有口径不变）。补全阶段失败或整体跳过时，判分与摘要按各自的仅标题回退路径继续。

**位序须按阶段名锚定、非按行号**：塌缩之后、判分之前的窗口内**还含语义合并阶段（阶段 2.5，`semanticMergeEvents`）**，其灰区 LLM 合并判也消费 `raw_items.content`。补全阶段**放在语义合并之后、Value Judge 之前**（即链序为「塌缩 → 语义合并 → 正文补全 → Value Judge」）：此为**有意选择**——① 语义去重是明确非目标，合并判维持仅标题现状、本变更不改；② 补全放在合并之后只富化**存活代表事件**、不对随即被 tombstone 的事件浪费抓取。故语义合并的合并判**仍仅标题**，是已知且接受的取舍（须在 design 记录），**不**视作补全缺陷。

**补全工作集须与判分集同口径**：补全的待判集**必须**等于 `scoreUnscoredEvents` 将判的集合（`importance_score IS NULL AND merged_into IS NULL`，其中空 content + 可抓 URL 者），以保证「凡被判事件皆先补全（除非补全失败）」这一 value-judge-agent 普遍约束不被工作集口径差漏穿（见 source-content-enrichment「待判工作集」）。

放在判分之前的原因：`is_ai_related` 与各项评分、以及中文摘要都必须以真实正文而非仅标题为依据；补全先行才能同时 grounding 判分（value-judge-agent）与摘要（chinese-digest-agent）。

**作用域仅日报链、实时告警链不在本期范围（须显式记录）**：`scoreUnscoredEvents` 为日报链与**实时告警链（`alert-scan`）共用**，且评分为一生一次（`importance_score IS NULL` + 原子 claim 防双评分）。本补全阶段**只编排在日报链**内；被告警链**先**判分的事件将得到**仅标题**的 `is_ai_related`（日报补全无法再回灌，因评分不重跑）。此外告警推送候选走 `alert-scan` 自有查询、**本期不加 `is_ai_related` 闸门**。二者均为**本期显式非目标**：本变更只硬化**日报**要闻/新品段的「非 AI 泄漏」与错误简介；告警链的 grounding 缺口与非 AI 事件经告警泄漏属独立后续（如需，另起提案对告警候选加同一 fail-closed 闸门或在告警链前置补全）。此边界**必须**在 proposal 非目标与 design 显式记录，避免把「enrichment grounding 提升闸门质量」误呈为对所有入口普适。

#### 场景:正文补全阶段编排在语义合并后判分前
- **当** `runDailyWorkflow()` 执行到 Value Judge 判分之前
- **那么** 系统在语义合并阶段之后、判分之前运行正文补全阶段（对判分集内空 content 且有可抓 URL 的代表 raw_item 补抓），再进入判分；补全失败不阻塞后续阶段、不进熔断分母；语义合并判维持仅标题（有意取舍）

### 需求:要闻候选须 AI 相关

`selectTopN` 的要闻候选窗口**必须**在既有条件（`should_push=true` AND `published_at` 近 N 天闭区间 AND `merged_into IS NULL` AND 尚未投递给所有已配置通道 AND `importance_score >= 下限闸`）之上**追加谓词 `is_ai_related = true`**：`is_ai_related` 非 true（false 或 NULL）的事件**禁止**入选要闻段。此闸门为**确定性 SQL 过滤谓词**（读 Value Judge 已落库的 `ai_news_events.is_ai_related`），不改排序、组合分权重、幂等、跨天不重推口径，也不把「是否推送」交给 LLM——LLM 仅产出 `is_ai_related` 语义判定，是否入选仍由程序据该布尔列过滤。

`is_ai_related = false`（判为非 AI）与 `is_ai_related IS NULL`（尚未判分/历史老事件）**一律排除**（fail-closed，宁可漏一条也不推非 AI）；本闸门只作用于候选窗口内的事件，**不**追溯回填或重推历史事件。

**NULL 的真实波及面须如实陈述（勿低估）**：新闻侧 `scoreUnscoredEvents` 只判 `importance_score IS NULL` 的事件，故迁移落列后，**已评分（importance 非空）但 `is_ai_related` NULL** 的事件**永不被重判**——不仅是「已推/老事件」，也包括**候选窗口内、`should_push=true`、尚未投递给所有通道**（`notDeliveredToAllChannels`）的合法待推事件：它们迁移后被 fail-closed 静默排除、随窗口老化而**永久不再推送**。这是「不追溯回填 `is_ai_related`」非目标的直接后果、被明确接受，**但须与产品侧非对称一并显式记录**：产品侧判定工作集以 `is_ai_related IS NULL` 纳入、候选窗口内会被下一轮重判自愈（超 limit/窗外者在再采集刷新 `last_seen_at` 后随窗口滑动自愈；判定工作集为未闸门 top-N 而推送集已闸门，故被更近非 AI 产品挤出未闸门窗口的真 AI 产品当轮不被判、属**可接受 fail-closed 漏，非误推非死锁**——不宣称其"本不可推"；见 product-discovery），新闻侧**无对称重判路径**（新增重判会违反非目标，故本期不做）。若运维需极少数补救，手动重置该事件 `importance_score=NULL` 触发重判，不做自动回填。

#### 场景:非 AI 事件不入要闻段
- **当** 某事件 `should_push=true`、`importance_score` 达标、`published_at` 在窗口内，但 Value Judge 判 `is_ai_related=false`（如 `Physical disc production … PlayStation`）
- **那么** 该事件被 `is_ai_related = true` 谓词排除、不进入当日要闻段，即使当日入选总数因此少于 N 条

#### 场景:未判分事件因 is_ai_related NULL 被排除
- **当** 某事件 `is_ai_related` 为 NULL（该列新增前已评分未重判，或历史老事件）——即使其 `should_push=true` 且在窗口内尚未投递全通道
- **那么** 该事件被候选窗口的 `is_ai_related = true` 谓词排除（fail-closed），不被误推、不被追溯回填、无自动重判路径（接受的非目标后果）

#### 场景:AI 相关事件正常入选
- **当** 某事件 Value Judge 判 `is_ai_related=true` 且满足其余全部候选条件
- **那么** 该事件正常参与组合分排序与 Top N 选择，闸门不改变其排序与幂等口径
