## 新增需求

### 需求:新品候选须 AI 相关

产品段当前完全绕过价值判断、无任何 AI 相关性闸门（Product Hunt / Show HN 为通用源，扫雷游戏、通用日志库等非 AI 产品照推）。系统**必须**为产品补一道 AI 相关性判定并据此闸门推送候选。

**AI 相关性判定与依据（产品为名判，不经补抓 grounding）**：`ai_products` 新增可空布尔列 `is_ai_related`。判定**必须复用产品已有的中文化 LLM 调用**（`product-chinese-digest` 的 `summarizeProduct`，扩产 `is_ai_related` 字段，与 `name_zh`/`tagline_zh` 同一次调用产出），**禁止新增独立的产品判分 LLM 调用**。判定**以产品名 + 产品塌缩时采集器已存的 `content`（若有）为依据，不经 source-content-enrichment 补抓**：该富化阶段只作用于**新闻事件代表 raw_item**、且运行在**产品塌缩之前**（此时 `ai_products` 行与其 `representative_raw_item_id` 尚不存在，见 daily-intel-pipeline「正文补全阶段」与 `collapseProductsOnce` 位序），故产品**无 enrichment grounding 路径**，链接型产品（如 Show HN 恒 `content=null`）按产品名判定。为名判定时**必须**受与新闻摘要对称的护栏约束：**注入当前日期 + 禁止编造产品名未含的具体事实 + 禁止据训练知识断言产品是否存在/是否已发布**（见 chinese-digest-agent 同类护栏、task 6.1）。判定输出仍经 Zod 校验，失败按既有中文化对称零件降级（回退 `is_ai_related` 保持 NULL），**永不向上抛、不进熔断分母、不拖垮新闻**。

**判定结果必须落库（绝不可像旧新闻 mapping 那样丢弃）**：`is_ai_related` 与 `name_zh`/`tagline_zh` 同一次调用产出后，**必须**经产品持久化写入 `ai_products.is_ai_related`——即产品中文化写入（`updateProductZh` 或等价路径）的 `set` **必须**新增 `is_ai_related`、其调用点**必须**透传 `summarizeProduct` 产出的该字段。补判已中文化产品（见下「陷阱二」）时，写 `name_zh`/`tagline_zh` **必须** COALESCE 保留既有非空译名、不得覆盖。**禁止**只加列 + 加闸门谓词而不接持久化写入——否则判定产出被静默丢弃、所有产品落 NULL、fail-closed 后新品段永久空，正是本变更要为新闻消除的「产出即丢弃」缺陷。

**迁移前置校验**：既有 `assertProductZhColumns` 启动探针（迁移先于代码的 fail-fast）**必须**扩展为同时断言 `ai_products.is_ai_related`（以及 `ai_news_events.is_ai_related`）列存在。否则代码先于 `0011` 迁移部署时，产品闸门读缺列的异常会被静默吞进 `selectProductsForChannelSafe` → 新品段**静默变空（假绿）**，而新闻侧 `selectTopN`（无 try/catch 包裹）直接崩溃——响声不一致、缺列在产品侧不可见。

**判定工作集不得被 AI 闸门自我锁死（绝不可违背）**：产生 `is_ai_related` 的判定步骤，其待判工作集**必须**从「AI 闸门之前」的候选集选取，且须同时避开两个陷阱：

- **陷阱一——工作集派生自被闸门的同一函数**：现实现里判定工作集由 `digestPendingProducts` **复用 `selectProductCandidates` 构建**（每 channel 一次取并集）。若把 `is_ai_related = true` 直接加进 `selectProductCandidates`，工作集随之被闸门 → `is_ai_related IS NULL` 产品永进不了工作集 → 永不判分 → 永久 NULL → 死锁。故 `selectProductCandidates` **必须参数化 AI 闸门**（如 `applyAiGate` 开关，默认 `true`）：**判定工作集以 `applyAiGate=false` 取无闸门候选集**，仅**最终 per-channel 推送候选**以默认 `applyAiGate=true` 加闸门。
- **陷阱二——既有 `name_zh IS NULL` 待判谓词**：现工作集以 `name_zh IS NULL` 判「未中文化」。补判 `is_ai_related` 的待判谓词**必须**改为 `is_ai_related IS NULL`（**替换或并入 `OR`，绝不与 `name_zh IS NULL` 取 AND**）——否则迁移前已中文化（`name_zh` 非空、`is_ai_related` NULL）的产品被 AND 排除、永不补判、永久 NULL 死锁。以 `is_ai_related IS NULL` 纳入意味着对这些历史产品重跑一次 `summarizeProduct`（同一次调用、无第二次判分调用），并 COALESCE 保留既有译名（陷阱可接受的一次性成本）。
- **已知例外须记录**：占位名产品（`name = UNNAMED_PRODUCT_NAME`）本就被现工作集 `ne(name, UNNAMED_PRODUCT_NAME)` 排除、不会调用 `summarizeProduct` → `is_ai_related` 永久 NULL → 永久 fail-closed 排除。这是可接受的既有行为、非本闸门新增死锁，但**必须**在 spec/注释显式记录。

**推送候选闸门**：`selectProductCandidates`（最终 per-channel 推送候选，`applyAiGate=true`）**必须**在既有谓词之上追加 `is_ai_related = true`：`is_ai_related` 非 true（`false` 或 `NULL`）的产品**禁止**进入新品段（fail-closed，宁可漏也不推非 AI）。谓词**必须**用 `eq(is_ai_related, true)`（NULL 与 false 均排除），**禁止** `IS NOT FALSE` / `<> false`（会漏放 NULL）。此闸门为确定性 SQL 谓词，**不改**塌缩、硬规则合并、`merge_conflict` 排除、跨天从未 success 窗口、`order`、`limit` 与中文展示口径（一字不变），也不把是否推送交给 LLM——LLM 仅产出 `is_ai_related` 语义判定。

#### 场景:非 AI 产品不进新品段
- **当** 某产品经判定 `is_ai_related=false`（如扫雷游戏、通用日志库），且满足其余全部候选条件
- **那么** `selectProductCandidates`（`applyAiGate=true`）的 `is_ai_related = true` 谓词将其排除、不进入日报新品段

#### 场景:未判分产品（含迁移前已中文化者）因 NULL 被推送候选排除但仍被判定步骤选中判分
- **当** 某产品 `is_ai_related` 为 NULL（尚未判分），无论其 `name_zh` 已否（迁移前已中文化 name_zh 非空、或全新未中文化）
- **那么** 它被最终推送候选（`applyAiGate=true`）fail-closed 排除；但因判定工作集取自 `applyAiGate=false` 的无闸门候选集、且以 `is_ai_related IS NULL`（非与 `name_zh IS NULL` 取 AND）纳入，它仍会被判定步骤选中、判分并落 `is_ai_related`，不会永久死锁在 NULL

#### 场景:AI 相关判定复用中文化 LLM 调用不新增调用且落库不丢弃
- **当** 某 `is_ai_related IS NULL` 的候选产品进入判定步骤
- **那么** 系统在既有 `summarizeProduct` 同一次 LLM 调用中同时产出 `name_zh`/`tagline_zh` 与 `is_ai_related`，经产品持久化写入 `ai_products.is_ai_related`（不发起第二次调用、不丢弃该字段）；若为已中文化产品补判，COALESCE 保留既有译名不覆盖

#### 场景:产品无正文时按名判定且不据训练知识断言存在
- **当** 某链接型产品（如 Show HN，`content` 为 null）进入判定
- **那么** 判定与中文化只据产品名概括，注入当前日期，不编造产品名未含的参数/发布状态、不据训练知识断言该产品是否存在或是否已发布

#### 场景:AI 判定失败不拖垮新闻且回退 NULL
- **当** 某产品的 AI 相关性判定（中文化调用）失败
- **那么** 该步骤捕获异常、记错误/告警、`is_ai_related` 保持 NULL（该产品本轮被 fail-closed 排除）、不向上抛、不进熔断分母，新闻段与其余产品不受影响

#### 场景:缺列启动探针 fail-fast(迁移先于代码)
- **当** 代码先于 `0011` 迁移部署，`ai_products.is_ai_related` 列尚不存在
- **那么** `assertProductZhColumns` 探针在启动即 fail-fast 报缺列，而非让产品闸门在被静默吞掉的 `selectProductsForChannelSafe` 内抛错致新品段静默变空
