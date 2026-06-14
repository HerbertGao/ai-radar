## MODIFIED Requirements

### 需求:每日产品发现推送

系统必须把当日新发现产品按程序选择后推送，并以 `push_records` 的 `UNIQUE(target_type, target_id, channel, push_date)` 保障幂等。产品推送记录的四元组必须为 `target_type='product'`、`target_id=product_id`、`channel`、`push_date`（**取 Asia/Shanghai，与事件日报 `push_date` 时区口径同源**），与事件日报（`target_type='event'`）各自独立命名空间、互不挤占。

**产品推送并入新闻日报消息（本次变更）**：产品发现**不再是独立 BullMQ 调度任务/独立消息**（原「每日产品发现独立调度链/队列/cron/独立单例锁」一并废止）。产品作为「新品段」并入新闻日报的**同一条**「AI Radar 每日情报」消息（与「要闻段」events 并列）。其内部仍是确定性顺序子流程「产品采集（由日报 `collectAllSources` 覆盖）→ **产品塌缩一次（channel-blind）** → **per-channel 选产品候选** → 并入日报消息」：产品塌缩调 `collapseUncollapsedProductRawItems`（import 自 `src/collectors/product-collapse.ts`，在 channel 展开之前**只跑一次**——产品塌缩单实例承载，绝不随 per-channel 并发重复），随后对每个 channel 调 `selectProductCandidates(channel, dbh, limit)`；塌缩与候选各自包 try/catch 永不向上抛（失败降级空段）。产品段在日报 `runDailyWorkflow()` 的单例锁（`acquireDigestLock(push_date)`）内执行，由该锁保 push_date 全局单例（不再需要独立 `product-digest:{channel}:{push_date}` 锁）。

**产品候选查询复用既有导出纯函数**：`selectProductCandidates(channel, dbh, limit=TOP_N)` 已是导出纯函数（无 `now` 参数——跨天去重与时刻无关），日报直接 `import` 复用、**无需「抽出」**；移除独立调度后原地保留导出。**链接来源**：本期扩展该查询的 SELECT 增 `canonical_domain`，映射 `canonicalUrl = canonical_domain ? 'https://' + canonical_domain : null`（`ai_products` 无 `url` 列，仅 canonical_domain/github_repo/product_hunt_slug）；WHERE 条件（跨天去重 + merge_conflict 排除）逐字不变。产品行渲染：产品名 + 官网链接（`canonicalUrl`，为 null 时降级纯产品名，绝不渲染坏链接），**产品段零 LLM**（无 headline/summary 不渲染要点行、不调 LLM 生成定位）。

**跨天不重推候选窗口（与 event 同口径，绝不可省、绝不退化）**：选择进入推送的产品候选必须满足「该 `product_id` **从未被任何 `push_date` 以该 channel `success` 推送过**」（**按 channel 分判**：同一产品可分别进 telegram/feishu 候选）；「同日不重复」由唯一约束兜底，「跨天一产品一生只推一次」由本候选窗口 + dispatcher 的 `computePendingSet`（任一 push_date 该 channel success 排除）双层兜底，**并入日报后此口径不变**（绝不因并入变成天天重推）。

**处于未解决合并冲突态的产品必须排除出推送候选**：被标记 `merge_conflict` 的 `product_id` 必须排除出推送候选，直到 P3 跨行合并解决。**产品候选查询必须在产品塌缩阶段完成之后执行**（日报顺序子流程内：产品塌缩一次 → per-channel 产品候选 → 并入消息），确保 `merge_conflict` 标记对候选可见。

推送流程必须**复用 telegram-push/feishu-push 定义的同一套「待发→`pending`→原子送达→`success`/`failed`」状态机机制**（仅 `target_type` 与候选/幂等口径不同），禁止另写漂移状态机；唯一键冲突即跳过。**单条日报消息同时承载 event 与 product 两类待发集合时，必须各按自己的 `target_type` 计算待发、写 `push_records`、置终态**（event 行写 `target_type='event'`、product 行写 `target_type='product'`），绝不把产品记入 event 命名空间；且须遵守 `daily-intel-pipeline` 定义的分段 includedIds（截断不误标）、**方案 A 两段独立事务终态（event 先固化、product 失败不回滚 event）**、段级失败隔离契约。选择哪些产品进入推送由程序规则决定，禁止由 LLM 决定最终推送名单。

#### 场景:同一天同一产品不重复推送
- **当** 某产品当日已以某 channel `success` 推送（在日报消息的新品段内）
- **那么** 同 `push_date` 同 channel 再选候选时被唯一约束/待发集合排除，不重复出现在该日报消息

#### 场景:跨天一产品一生只推一次（并入日报后不退化）
- **当** 某产品因持续上榜、`last_seen` 天天刷新而连日进入候选池
- **那么** 候选查询按「该 `product_id` 从未以该 channel `success`」排除已推过的产品，仅首次出现在某日日报新品段，绝不天天重推

#### 场景:merge_conflict 产品排除出日报新品段
- **当** 某产品被标记 `merge_conflict`
- **那么** 产品候选查询（在产品塌缩之后执行）排除它，不进入日报新品段，直到跨行合并解决

#### 场景:产品作为日报新品段而非独立消息推送
- **当** 日报触发并存在当日新产品候选
- **那么** 产品以「新品段」并入同一条「AI Radar 每日情报」消息（与要闻段并列），不再产生独立的产品推送消息；产品行各按 `target_type='product'` 写 `push_records`

#### 场景:产品行链接来源与降级
- **当** 渲染产品行
- **那么** 用候选查询映射的 `canonicalUrl`（`https://canonical_domain`）；`canonical_domain` 为空则 `canonicalUrl=null`、降级为纯产品名，绝不渲染坏链接；产品段不调任何 LLM

#### 场景:独立 product-digest 调度链已移除
- **当** worker 启动注册调度链
- **那么** 不再注册独立 `product-digest` 队列/cron/单例锁；产品推送只经日报链承载

#### 场景:产品段失败不拖垮新闻段
- **当** 产品塌缩或产品候选查询失败
- **那么** 塌缩/候选各自捕获异常、记错误/告警、该日报新品段降级为空，新闻「要闻段」仍正常推送（产品段不进新闻摘要熔断分母、不拖垮整条日报）

#### 场景:产品塌缩只跑一次不随 channel 重复
- **当** 日报对多个 channel 各取产品候选
- **那么** 产品塌缩 `collapseUncollapsedProductRawItems` 在 channel 展开之前只调一次（channel-blind），各 channel 仅各调 `selectProductCandidates(channel)`；绝不每 channel 重复塌缩（避免违反产品塌缩单实例假设）
