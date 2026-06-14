# product-discovery 规范

## 目的
待定 - 由归档变更 expand-sources-dual-channel-products 创建。归档后请更新目的。
## 需求
### 需求:Product Hunt 确定性产品采集

系统必须提供一个确定性的 Product Hunt 采集器，以程序（而非 Agent 自由决定）拉取每日上榜产品。采集结果必须**先以统一结构写入 `raw_items`**（`source='product_hunt'`、`raw_type='product'`，PH 原始 payload 入 `metadata`），与其它采集源一致进入统一原始证据层（对齐 QA.md「输出统一写入 `raw_items`」与 `raw_type` 含 `product`），**禁止绕过 `raw_items` 直写 `ai_products`**；产品塌缩进 `ai_products` 是下游确定性步骤（见「ai_products 硬规则产品合并」）。采集必须使用只读 Developer Token 认证（无需交互式 OAuth flow），禁止把 token 写死在代码中、必须来自环境配置，缺失时按既有 env 校验快速失败。采集器必须遵守 Product Hunt 限流（GraphQL 约 6250 复杂度点/15min、REST 约 450 请求/15min）：必须读取响应的 `X-Rate-Limit-Remaining` / `X-Rate-Limit-Reset` 头并在余量耗尽时退避，禁止无视限流头持续打满。所有外部调用必须带重试与错误日志，失败禁止静默吞掉；但**采集中途的鉴权类错误（HTTP 401/403，如 token 被撤销/过期）不进入退避重试**（重试不可恢复的鉴权错误只浪费预算），直接按单源失败记 error、由 allSettled 隔离。

PH 产品名必须写入 `raw_items.title`（满足 QA.md §8.1 `title TEXT NOT NULL`），并作为下游 `ai_products.name` 的来源；PH 产品名罕见缺失时以确定性兜底值（`product_hunt_slug` 或 `canonical_domain`）填充 title，绝不留空致 `raw_items` 入库失败。

#### 场景:每日拉取上榜产品先入 raw_items
- **当** 产品发现任务触发采集
- **那么** Product Hunt 采集器用 Developer Token 拉取当日上榜产品，以统一结构（`source='product_hunt'`、`raw_type='product'`，产品名写入 `title`，含 slug、原文 URL、描述、上榜时间）写入 `raw_items`，不绕过原始证据层

#### 场景:PH 产品名缺失时 title 兜底非空
- **当** 某 PH 产品缺产品名
- **那么** `raw_items.title` 以 `product_hunt_slug`（或 `canonical_domain`）兜底填充，不留空、`raw_items` 入库不因 `title NOT NULL` 失败

#### 场景:限流余量耗尽时退避而非打满
- **当** 某次响应的 `X-Rate-Limit-Remaining` 降至 0 / 接近 0
- **那么** 采集器依 `X-Rate-Limit-Reset` 退避到下个重置窗口再继续，禁止无视限流头持续请求

#### 场景:token 缺失时启动即报错
- **当** 缺少 Product Hunt token 并尝试运行产品发现
- **那么** 系统以明确错误信息快速失败，禁止匿名静默继续

### 需求:ai_products 硬规则产品合并

系统必须把 `raw_items(raw_type='product')` 的产品条目塌缩进 `ai_products` 表，**仅以程序与数据库唯一约束做硬规则合并，绝不交给 LLM 判断**。合并键必须为 `canonical_domain`、`github_repo`、`product_hunt_slug` 三者的唯一约束。塌缩必须在**事务内**按以下确定性步骤（**不得按优先级短路只查第一个命中键** —— 短路会漏掉其余键命中的孤儿行）：

1. 对该条产品的**全部非空归一化键**各做一次 `SELECT ... FOR UPDATE`，收集命中的既有 `product_id` 集合。为防两并发塌缩按不同键顺序对不同行加锁互相死锁，`FOR UPDATE` 必须按**确定性全序**（如命中 `product_id` 升序）加锁；P2 产品塌缩亦明确由**单实例**承载（与 arXiv 单实例采集假设一致），并发概率低、DB 唯一约束兜底。
2. 据命中集合 size 分流：**size=0 → INSERT 新行**；**size=1 → UPDATE 该行**（只更新 last_seen 类可累加字段、记 `representative_raw_item_id` 回指，禁止覆盖产品身份主键 `product_id`）；**size>1 → 多键命中多行冲突分支**（见下）。
3. **INSERT 必须填充 `ai_products.name`（NOT NULL）**，取自该 `raw_item` 的 `title`（即 PH 产品名）；缺失时以确定性兜底值（`product_hunt_slug` 或 `canonical_domain`）填充，**绝不留空致 INSERT 因 NOT NULL 约束失败**。
4. 产品塌缩**只读未塌缩过的 product 行**（`raw_type='product' AND collapsed=false`），塌缩成功（INSERT/UPDATE/标 merge_conflict 任一终态）后将该 raw_item 置 `collapsed=true`，使其不被每轮无界重读重塌（复用 `collapsed` 列，对 product 行语义为「已塌缩进 ai_products」，见 dedup-and-normalization）。塌缩对 raw_item 幂等：重读已塌缩行无副作用，但通过 `collapsed=false` 过滤避免线性增长的重扫。

`canonical_domain` 必须由 URL 规范化纯函数从产品官网 URL 提取（去追踪参数、host 小写、去 www 前缀口径一致），`github_repo` 必须归一为 `owner/name` 形式，`product_hunt_slug` 取 PH 原生 slug。三键任一缺失时不得用该键参与合并（禁止用 NULL 键产生 `UNIQUE(col, NULL)` 放行多行的静默失效）。

塌缩 INSERT/UPDATE 除 `name`、三合并键、`representative_raw_item_id` 外，QA.md §8.3 的其余富化列（`vendor`/`official_url`/`category`/`description`/`open_source`/`mcp_supported`/`score` 等）**P2 可留空**，富化留 P5 顾问期——本期产品发现只做「发现 + 硬合并 + 推送」，不做产品富集。

**多键命中多行冲突必须显式处置、禁止静默择一**：当一条新产品同时带多个稳定键、而这些键在 DB 中分别命中**不同的既有行**（如 `canonical_domain` 命中行 X、`github_repo` 命中行 Y）时，系统必须在事务内对各归一化键 `SELECT ... FOR UPDATE` 收集命中的 `product_id` 集合；集合含 >1 个不同 `product_id` 即为合并冲突，必须**记录冲突 + 告警 + 不自动择一 upsert**（保留各行待后续期处理），**禁止只按优先级更新一行而留下其余应属同一产品的孤儿行**。冲突状态必须有持久落点（在涉及的各 `ai_products` 行的 `metadata` 标记 `merge_conflict` + 冲突对方 product_id 集合），使「同一冲突不重复告警」可判（已标记 `merge_conflict` 的同组冲突再次命中时只更新不重复告警，避免每轮采集重复刷告警）。跨行传递合并（合并 X/Y 为一行并迁移引用）涉及关系表迁移，留 P3 与 `item_product_relations` 一并做。`raw_item↔product` 关系本期不建 `item_product_relations`（P3），仅以 `ai_products.representative_raw_item_id` 回指过渡。

#### 场景:首次塌缩 INSERT 填充非空 name
- **当** 某产品在 `ai_products` 中无任一稳定键命中、需 INSERT 新行
- **那么** INSERT 填充 `name`（取自 raw_item 的 title / PH 产品名，缺失则兜底 slug 或 domain），不留空、不因 `name NOT NULL` 约束失败

#### 场景:同一产品经稳定键命中时塌缩为单行
- **当** 同一产品在两次采集中返回相同 `product_hunt_slug`（或相同 `canonical_domain` / `github_repo`）
- **那么** 第二次塌缩在事务内查到命中行并 `UPDATE`，`ai_products` 中该产品仅一行，`product_id` 不被覆盖

#### 场景:多键命中多行时记冲突告警不静默择一且不重复刷
- **当** 一条新产品的 `canonical_domain` 命中既有行 X、`github_repo` 命中另一既有行 Y（两行历史上独立创建）
- **那么** 系统检测到命中 product_id 集合 size>1，在各行 `metadata` 标记 `merge_conflict` 并告警、不自动择一 upsert、不留孤儿行；该冲突组下轮再命中时只更新不重复告警（不调用 LLM 判断）

#### 场景:合并键全部由程序与 DB 决定
- **当** 判定两条产品记录是否为同一产品
- **那么** 判定完全依据 `canonical_domain` / `github_repo` / `product_hunt_slug` 唯一约束与 URL 规范化纯函数，禁止调用 LLM 做合并判断

#### 场景:缺失合并键不以 NULL 参与唯一约束
- **当** 某产品缺少 `github_repo`
- **那么** 该键不参与合并（不产生 `UNIQUE(github_repo, NULL)` 放行多行），仅用其余可用稳定键，源内幂等不失效

### 需求:每日产品发现推送

系统必须把当日新发现产品按程序选择后推送，并以 `push_records` 的 `UNIQUE(target_type, target_id, channel, push_date)` 保障幂等。产品推送记录的四元组必须为 `target_type='product'`、`target_id=product_id`、`channel`、`push_date`（**取 Asia/Shanghai，与事件日报 `push_date` 时区口径同源**——二者用同一时区计算「今天」，时区不同源会跨零点把一天算两天致跨天候选窗口失效），与事件日报（`target_type='event'`）各自独立命名空间、互不挤占。

**产品推送并入新闻日报消息（合并变更）**：产品发现**不再是独立 BullMQ 调度任务/独立消息**（原「每日产品发现独立调度链/队列/cron/独立单例锁」一并废止）。产品作为「新品段」并入新闻日报的**同一条**「AI Radar 每日情报」消息（与「要闻段」events 并列）。其内部仍是确定性顺序子流程「产品采集（由日报 `collectAllSources` 覆盖）→ **产品塌缩一次（channel-blind）** → **per-channel 选产品候选** → 并入日报消息」：产品塌缩调 `collapseUncollapsedProductRawItems`（import 自 `src/collectors/product-collapse.ts`，在 channel 展开之前**只跑一次**——产品塌缩单实例承载，绝不随 per-channel 并发重复），随后对每个 channel 调 `selectProductCandidates(channel, dbh, limit)`；塌缩与候选各自包 try/catch 永不向上抛（失败降级空段）。产品段在日报 `runDailyWorkflow()` 的单例锁（`acquireDigestLock(push_date)`）内执行，由该锁保 push_date 全局单例（不再需要独立 `product-digest:{channel}:{push_date}` 锁）。

**产品候选查询复用既有导出纯函数**：`selectProductCandidates(channel, dbh, limit=TOP_N)` 是导出纯函数（无 `now` 参数——跨天去重与时刻无关），日报直接 `import` 复用。**链接来源**：候选查询的 SELECT 含 `canonical_domain`，映射 `canonicalUrl = canonical_domain ? 'https://' + canonical_domain : null`（`ai_products` 无 `url` 列，仅 canonical_domain/github_repo/product_hunt_slug；domain 含 scheme/path/空白等畸形则降级 null）。产品行渲染：产品名 + 官网链接（`canonicalUrl`，为 null 时降级纯产品名，绝不渲染坏链接），**产品段零 LLM**（无 headline/summary 不渲染要点行、不调 LLM 生成定位）。

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
- **那么** 用候选查询映射的 `canonicalUrl`（`https://canonical_domain`）；`canonical_domain` 为空或畸形则 `canonicalUrl=null`、降级为纯产品名，绝不渲染坏链接；产品段不调任何 LLM

#### 场景:独立 product-digest 调度链已移除
- **当** worker 启动注册调度链
- **那么** 不再注册独立 `product-digest` 队列/cron/单例锁；产品推送只经日报链承载

#### 场景:产品段失败不拖垮新闻段
- **当** 产品塌缩或产品候选查询失败
- **那么** 塌缩/候选各自捕获异常、记错误/告警、该日报新品段降级为空，新闻「要闻段」仍正常推送（产品段不进新闻摘要熔断分母、不拖垮整条日报）

#### 场景:产品塌缩只跑一次不随 channel 重复
- **当** 日报对多个 channel 各取产品候选
- **那么** 产品塌缩 `collapseUncollapsedProductRawItems` 在 channel 展开之前只调一次（channel-blind），各 channel 仅各调 `selectProductCandidates(channel)`；绝不每 channel 重复塌缩（避免违反产品塌缩单实例假设）


### 需求:产品塌缩为多源输入并支持跨源产品合并

产品塌缩（`ai_products`）MUST 为**多源**输入：消费**任何** `source` 的 `raw_items(raw_type='product')` 行（source-agnostic，按 `raw_type='product' AND collapsed=false` 选取，**不按 source 过滤**），不限于 Product Hunt。本期新增 Show HN（`source='show_hn'`，见 source-collectors）作为第二个产品源。塌缩入口 MUST 保持 source-agnostic——MUST NOT 为任何理由把入口收窄到按单一 source 过滤（否则会静默断掉除 PH 外的产品源）。塌缩的合并判定、三唯一键、`FOR UPDATE` 多键命中收集、`size` 分流、`merge_conflict` 不静默择一等 MUST **沿用既有「ai_products 硬规则产品合并」需求**，本需求不重定义这些判定。

产品发现链路的采集 MUST 经产品源子集 `PRODUCT_SOURCES`（见 source-collectors）取所有产品源（PH + Show HN），与产品塌缩在同一链路衔接，使新增产品源被采集后即被同链塌缩——MUST NOT 让某产品源仅被采集入库却无塌缩触发（避免依赖跨 workflow 隐式时序的脆弱闭合）。

**跨源合并** MUST 经非空归一键实现：不同源的产品共享同一非空归一键时合并为 `ai_products` 单行。归一键提取对所有产品源一致（`canonical_domain` 由产品 URL 经 URL 规范化提取、`github_repo` 由 github URL 归一为 `owner/name`、`product_hunt_slug` 取 PH 原生 slug；Show HN 无 slug，其 slug 键空、不参与合并，合规）。

**github 托管产品的合并键修复（必须）**：`extractProductMergeKeys` MUST **无条件**令 `canonical_domain='github.com'` 置 null（**不** gate 在 `github_repo` 非空上）。`github.com` 非有意义的产品域：指向具体 repo 者用 `github_repo` 作精确合并键；指向 `github.com/owner` org/profile 页者无具体 repo（`github_repo` 亦 null）→ 三键全空、由采集器跳过（见 source-collectors），不应靠 `github.com` 域合并。**为何不能仅在 `github_repo` 非空时抑制**：org 页（单段路径）`github_repo=null`，条件抑制会留它们仍共享 `canonical_domain='github.com'` 彼此静默合并（残留撞域）。否则所有 github 托管产品共享 `canonical_domain='github.com'`，在 `lockMatchingProductIds` 的 OR 命中里彼此 size=1 命中 → 被静默 `UPDATE` 合并为同一行（非 `merge_conflict`，更隐蔽）——Show HN 大量直链 `github.com/owner/repo` 会触发灾难性误并。修复后指向具体 repo 的 github 产品按各自 `github_repo` 独立、不因共享 `github.com` 域误并；此修复对 Product Hunt 同样正确（PH 的 github 托管产品同被抑制、改按 `github_repo` 合并）。

跨源合并后 `ai_products.name` 取**先 INSERT 的源**的标题（`resolveName` 仅 INSERT 时设、UPDATE 不更新）；下游 `product-digest` 展示用 `ai_products.name`（不依赖 `representative_raw_item_id`，故后者跨源 last-writer 语义不影响展示）。Show HN 标题须在采集器侧剥除 `Show HN:` 前缀（见 source-collectors），避免先到为 Show HN 时 name 带帖式前缀。`name` 统一口径富化留 P5。

#### 场景:Show HN 产品经 source-agnostic 入口塌缩入 ai_products
- **当** 一条 `source='show_hn'`、`raw_type='product'`、`url` 非空（归一后至少一键非空）的 Show HN raw_item 经真实入口 `collapseUncollapsedProductRawItems` 塌缩
- **那么** source-agnostic 入口按 `raw_type='product'` 选中它，经 `canonical_domain`/`github_repo` 键 INSERT/UPDATE 进 `ai_products`，无需 PH 专属字段；该行为构成回归守护——任何把入口收窄到单 source 的改动会使本断言失败

#### 场景:同一产品 PH 与 Show HN 经 github_repo 跨源合并为单行
- **当** 某 github 托管产品先经 Product Hunt 入 `ai_products`（`github_repo='owner/repo'`），其后又经 Show HN 采到同一 github 仓库（同 `github_repo`）
- **那么** 事务内多键 `FOR UPDATE` 命中既有行、塌缩为 `UPDATE`（同一 `product_id`、不新建第二行），实现跨源合并

#### 场景:两个不同 github 仓库的产品不因共享 github.com 域误并
- **当** 两个不同 github 托管产品（`url` 分别为 `github.com/a/a`、`github.com/b/b`，经 url 推导 `github_repo` + 撞出 `github.com` 域）先后塌缩（至少一个 `source='product_hunt'` 以背书修复对 PH 同样正确）
- **那么** 经无条件抑制后二者 `canonical_domain` 均为 null、仅按各自 `github_repo` 键匹配 → 互不命中 → 各成 `ai_products` 单独行（不被静默合并、不误记 merge_conflict）

#### 场景:Show HN 缺 product_hunt_slug 不影响其余键合并
- **当** Show HN 产品无 `product_hunt_slug`（仅 `canonical_domain` 或 `github_repo`）
- **那么** 空 slug 键不参与合并（不产生 `UNIQUE(product_hunt_slug, NULL)` 放行多行），塌缩仅用非空键，源内幂等与跨源合并不失效
