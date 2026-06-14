## 为什么

「每日产品发现推送」**不是 QA.md 的需求**。QA.md 对产品的定位是：采集产品 → 沉淀进 `ai_products` 实体库（§8.3「长期沉淀 AI 产品实体」）→ 喂未来「AI 工具选型顾问」（第三阶段，回答选型问题）；其「推送」需求（每日推送 Top N、飞书/Telegram、当天不重复）**只针对新闻情报日报**，从未要求「每天单独推一条产品 digest」。该独立产品推送是 2026-06-11 归档变更 `expand-sources-dual-channel-products` 提案夹带引入的（把「产品发现采集+实体库」与「每日产品推送」打包）。

现网实证（2026-06-14）：product-digest 复用 `dispatchDigest → renderDigest → buildDigestMessage`，表头硬编码「AI Radar 每日情报」、不分 target_type；产品无 `headline_zh`/`summary_zh`、渲染又没拿到链接 → **产品列表顶着「新闻日报」表头、光标题无要点无原文**被推（07:30 那条），与 07:55 真新闻日报观感重复、不规范。

用户决策：**把产品合并进新闻日报**——一条「AI Radar 每日情报」分「要闻（events）+ 新品（products）」两段，**停掉独立产品推送链**。产品采集 + `ai_products` 实体库**保留**（QA.md 范围，喂未来顾问）。

## 变更内容

修改 `daily-intel-pipeline` + `product-discovery`（+ 推送渲染 `telegram-push`/`feishu-push`）：

1. **停掉独立 product-digest 推送链**：移除其独立 BullMQ 调度任务/cron/推送注册（`PRODUCT_DIGEST_QUEUE`/`PRODUCT_DIGEST_JOB`/`product-digest-cron`、worker 启动不再注册「product-digest」调度链）。**保留**产品采集（PH/Show HN collector）、产品塌缩 `collapseUncollapsedProductRawItems`、`ai_products` 表与硬合并唯一约束、产品候选查询逻辑（迁移复用，不重写）。

2. **日报内承载产品**：`run-daily-workflow` 在新闻流水线之后、早退判断之前增「产品子段」（两步）：① 产品 raw_items 已由 `collectAllSources` 在日报采集阶段覆盖（PH+Show HN）；② **产品塌缩一次（channel-blind）**：在 channel 展开**之前**调一次 `collapseUncollapsedProductRawItems`（**import 自 `src/collectors/product-collapse.ts`**；产品塌缩单实例承载，不可随 per-channel 并发跑 N 次；须在候选查询之前以使 `merge_conflict` 可见），包 try/catch 永不抛错；③ **per-channel 候选**：对每个已配置 channel 调既有导出 `selectProductCandidates(channel, dbh, limit)`（确定性、非 LLM；跨天「该 product_id 从未以该 channel `success`」+ 排除 merge_conflict）存入 `Map<Channel, products>`（算一次、贯穿早退与 dispatch）；④ 与新闻 Top N 一起进**同一条日报消息**。

3. **消息渲染分两段**：日报消息由「单段事件列表」改为「**要闻（events）+ 新品（products）**」双段。**借周报的视觉分段排版**（`message.ts` 周报已有「本周要闻/本周新品」分段先例），但**新增** `renderDailyDigest(events, products, channel)` 双数组渲染契约——不复用周报的单条 `WeeklySelectedEvent.weeklyItems` 结构（周报是 `target_type='weekly'` 整份一条记录的「降维」模型，本变更要逐条双 target_type 各自幂等，是不同幂等模型）；周报的 `renderSection` 是内部闭包不可直接 import，按其模式新增 daily helper、必要时抽共享 section 函数。Telegram（MarkdownV2）+ 飞书（JSON 卡片）各自分段。产品行渲染：产品名 + 官网链接（由候选查询扩 SELECT `canonical_domain` 映射 `https://canonical_domain`；缺失则降级纯产品名，绝不渲染坏链接）；产品段**零 LLM**（无 headline/summary 则不渲染要点行，不调 LLM 生成定位）。表头「AI Radar 每日情报（要闻 X·新品 Y）」，X/Y 取**实发数**（分段 includedIds，见第 4 点）。
   > 注：`ai_products` 无 `url` 列（仅 canonical_domain/github_repo/product_hunt_slug）；现有 `selectProductCandidates` 恒返回 `canonicalUrl:null`。故本期**扩展该候选查询的 SELECT 增 canonical_domain + 链接映射**（WHERE 条件逐字不变），而非「逐字等价不重写」。

4. **单消息双 target_type 幂等（核心改造）**：一条日报消息同时含 `event` 与 `product` 两类待发集合，**各自按自己的 `target_type` 写 `push_records`**（event：`target_type='event'`、跨天 per-channel；product：`target_type='product'`、跨天「一产品一生一次」+ 排除 merge_conflict）。这是 dispatcher 的**能力扩展**（首次「单次发送跨两个 target_type 命名空间」），复用其「待发→pending→原子送达→success/failed + includedIds 截断顺延」机制语义，禁止另写漂移状态机、禁止把产品塞进 event 命名空间。**关键契约**：① `renderDailyDigest` 回**分段 includedIds**（`eventIncludedIds`/`productIncludedIds`）——合并消息可能超长被截断，须分段才能让 dispatch 只对「真发出的」按各自 target_type 置 success（防被截断产品误标 success 永久漏推）；② **终态方案 A（两段各自独立事务，event 先固化）**：发送成功后先在一个事务把 event 段置 success（消息已送达、优先固化要闻段），再在另一事务把 product 段置 success；**product 终态写失败只记错告警、不回滚 event 段**（PG 单事务无法「event 提交 product 回滚」，故拆两事务），残留 product pending 下次补发；③ **段级失败隔离**：product 侧 DB 异常绝不令「消息已发送成功」的 event 段被误判/回滚 failed；④ `dispatchDailyDigest` 返回 `{pushDate, outcome, eventIncludedIds, productIncludedIds}`，run-daily per-channel 汇总按 outcome 判 failedChannels/anySent（`outcome`：sender 抛异常→`failed`；否则→`sent`，**含「sender 成功但 product 终态写失败」也判 `sent`**、product 残 pending 次日补、不触发整 job 重试）。

5. **降级/容错**：产品段不走 LLM 摘要、不进新闻摘要熔断分母；产品塌缩/候选失败不拖垮新闻段（塌缩/候选各自 try/catch 永不抛、降级空段）。两段都可空：产品段空仍正常推新闻段，反之亦然；仅两段皆空才不推。**注：「不进熔断分母」指产品不影响熔断触发（不计入 judge/digest 降级率）；新闻链 judge/digest 熔断 abort（LLM 大面积故障）时整条日报含产品段当日不推、次日 cron 补（产品幂等不退化）——产品搭日报 job 便车、不免疫 job abort，此为有意行为。**

## 功能 (Capabilities)

### 新增功能
（无新 capability。）

### 修改功能
- `daily-intel-pipeline`: 日报顺序子流程新增「产品塌缩 → 产品候选 → 新品段渲染」；日报消息由单段改为「要闻+新品」双段；推送由单 target_type 扩为单消息双 target_type（event+product）各自独立幂等。
- `product-discovery`: 「每日产品发现推送」由**独立推送链**改为**日报消息内的新品段**；移除独立 product-digest 调度/cron/锁/推送；保留产品采集、塌缩、`ai_products`、候选查询逻辑与产品幂等口径（target_type='product'、跨天一产品一生一次）。
- `telegram-push` / `feishu-push`: 日报渲染器支持「要闻+新品」双段；dispatch 支持单消息双 target_type 原子拼装 + 各自幂等记录。

## 影响

- **代码**：`src/pipeline/run-daily-workflow.ts`（新闻链后**产品塌缩一次** `collapseUncollapsedProductRawItems`（channel-blind）+ **per-channel** `selectProductCandidates` 存 `Map<Channel,products>`/早退条件改「pushable 空且 map 全空」/推送改 `dispatchDailyDigest(pushable, productsByChannel.get(channel), ...)`/:517-523 汇总按新 outcome 读）、`src/pipeline/product-digest.ts`（**保留导出 `selectProductCandidates`**（扩 SELECT 增 canonical_domain + 链接映射）；删独立调度零件：队列/worker/cron/独立锁/runProductDigest）、`src/push/dispatcher.ts`（新增 `dispatchDailyDigest`：单 channel 对称签名 + 双 computePendingSet + 分段 includedIds + **方案 A 两段独立事务终态（event 先固化、product 失败不回滚 event）** + 段级失败隔离 + 返回 `{pushDate,outcome,eventIncludedIds,productIncludedIds}`）、`src/push/message.ts`（新增 `renderDailyDigest` 双数组渲染契约，借 weekly 视觉分段 + buildDigestMessage 按块截断语义）、`src/pipeline/worker-main.ts`（删链 2 product-digest 注册 + import，注释「四条→三条」）。**`collapseUncollapsedProductRawItems` 本就在 `src/collectors/product-collapse.ts`**（product-digest.ts 仅 import 它）、日报直接 import、不受 product-digest.ts 删减影响。**`queue.ts` 不改**（无任何 product 引用）。
- **数据**：无 schema 迁移；`push_records` 仍写 `target_type='product'`/`'event'`（口径不变，只是同一条消息触发两类记录）；产品仍跨天一产品一生一次。
- **下游**：用户每天收**一条**日报（含新品段），不再收独立产品消息；产品实体库不受影响。
- **配置**：**无独立产品调度 env 需清理**——`PRODUCT_DIGEST_CRON` 不存在（product-digest 独立链复用 `DAILY_DIGEST_CRON`/`DAILY_DIGEST_CRON_TZ`）；移除独立链后 `DAILY_DIGEST_CRON` 仅日报用、**保留**（严禁删，删则停整个日报调度）。
- **spec**：`daily-intel-pipeline`/`product-discovery` 增量需求，归档时同步主规范。

## 非目标

- **不删**产品采集（PH/Show HN）、`ai_products` 表/产品塌缩/硬合并唯一约束（QA.md 实体库范围、喂未来顾问）。
- **不改** `weekly-report`、`realtime-alerts`、新闻事件幂等口径、知识库沉淀。
- **不退化**产品幂等：仍「跨天一产品一生一次 + 排除 merge_conflict」，绝不因并入日报变成天天重推。
- 不引入 `target_type='paper'` 推送（论文仍仅沉淀）。
- 不把确定性状态（产品候选/去重/幂等）交给 LLM。
- 不改新闻段的评分/摘要/熔断/时效闸逻辑（产品段独立旁挂）。
