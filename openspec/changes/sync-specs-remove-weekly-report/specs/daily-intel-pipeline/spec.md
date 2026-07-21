## MODIFIED Requirements

### 需求:每日定时单队列顺序编排

系统必须用 BullMQ 提供一个每日定时触发的 `daily-digest` 任务，调用一个纯顺序的工作流函数 `runDailyWorkflow()`，按固定顺序执行：采集（registry 驱动的多源 `Promise.allSettled` 并发抓取，含 RSS 大厂官方 feed / Hacker News / GitHub / arXiv / Product Hunt）→ 规范化/硬去重塌缩 → Value Judge 逐条判断 → **发布时间回填（published-at-inference：对 `should_push=true` 且 `published_at IS NULL` 的事件做 AI 推断回填，受独立单次上限约束）** → Top N 选择 → 中文摘要 → **向所有已配置通道分发推送（Telegram 与飞书）**。BullMQ 仅充当定时触发器与整 job 重试外壳，本期禁止把各阶段拆成多个相互投递的队列。

**发布时间回填必须在 Value Judge 之后、Top N 选择之前执行**：Top N 候选窗口以 `published_at` 时效过滤、对 NULL 自然排除（见「Top N 组合分选择」），故缺失发布时间的事件必须先经回填阶段补值，能补的补、补不出（AI 无法判定）的保持 NULL 由 Top N 时效闸排除。回填阶段失败/超时按「无法判定（NULL）」降级，不得阻塞或中止 `runDailyWorkflow()` 其余阶段。回填阶段是 `runDailyWorkflow()` 顺序链内的一个**阶段**（非独立调度入口），与告警链的回填以 DB 层 CAS（`UPDATE ... WHERE published_at IS NULL`）并发安全。

**回填阶段绝不计入降级率熔断（`DEGRADE_ABORT_RATIO`，绝不可省）**：回填的「判不出（NULL）」是**预期的高比例安全失败方向**（老文 + 线索少的事件本就大量判不出，判不出即排除、不误推），其比例不代表流水线健康度。回填阶段**禁止**产生新的熔断阶段、其「判不出/失败」**禁止**计入任何降级率熔断分母——熔断分母只含 Value Judge 与中文摘要两阶段（既有口径）。否则冷启动老 NULL 事件的高「判不出」率会触发 `DEGRADE_ABORT_RATIO` 误中止**正常**日报。

多通道分发必须**并发**（`Promise.allSettled`）各走一遍 telegram-push 定义的「待发集合→pending→原子送达→success/failed」状态机，单通道发送失败必须隔离（记录该 channel failed、不拖垮另一通道），各通道幂等按 channel 独立。整 job 由单例锁（`daily-digest:{push_date}`）防双实例，TTL 须覆盖含多通道并发分发的最坏时长（见 telegram-push「日报任务全局单例」）。**Telegram 为必配通道**：「已配置通道」集**至少含 `telegram`**、不可为空（飞书可选，见 feishu-push）；若 Telegram 必需配置缺失则按 P1 既有 env 校验启动快速失败，禁止「已配置通道集为空 → 日报静默无出口」。

实时告警（realtime-alerts）必须由**独立的定时/触发任务**承载，**不得**塞进 `runDailyWorkflow()` 的单一顺序链，也不得与日报各阶段相互投递构成复杂队列图——它是与日报并列的独立调度入口，遵守其能力规范的幂等口径。**产品发现（product-discovery）已并入日报链作为「新品段」**（见下），不再是独立调度任务。每日定时 cron 默认触发时刻不得卡在整点/半点（降低飞书 11232 限流）。

**日报内承载产品「新品段」**：日报顺序子流程在新闻链之后、早退判断之前增产品子段，分两步（塌缩单实例、候选 per-channel）：① 产品 raw_items 已由采集阶段 `collectAndStore`（→`collectAllSources` 全集，含 PH/Show HN）覆盖，无需额外产品采集入口；② **产品塌缩一次（channel-blind）**：在 channel 展开之前调一次 `collapseUncollapsedProductRawItems`（import 自 `src/collectors/product-collapse.ts`；产品塌缩由单实例承载，绝不可随 per-channel 并发跑 N 次；须在产品候选查询之前，使 `merge_conflict` 标记对候选可见），包 try/catch 永不抛错；③ **per-channel 产品候选**：对每个已配置 channel 调既有导出 `selectProductCandidates(channel, dbh, limit)`，结果存 `productsByChannel: Map<Channel, SelectedEvent[]>`（算一次、贯穿早退判断与 dispatch，dispatch 不重算），候选查询包 try/catch 失败降级空段。产品子段不进新闻评分/摘要熔断分母（产品段拿不到 judge/digest 累加变量、作用域天然隔离）、不复用新闻 Top N 名额。塌缩与候选各自永不向上抛，「产品失败不拖垮新闻」由此结构契约保证。

**早退条件（两段皆空才不推，products 经 map 贯穿）**：候选层早退须为「新闻 Top N 为空 且 `productsByChannel` 所有 channel 候选均为空」才 `skipped-no-candidates`；`productsByChannel` 必须在该早退判断之前算出并在推送阶段复用（不重算）。dispatch 层：单 channel 内 event/product 两 pending 皆空才 skip 该 channel。新闻空+产品非空、新闻非空+产品空 都须正常推（只推非空段）。

**单条日报消息双 target_type 分发**：日报推送须支持一条消息同时含「要闻段」（events，`target_type='event'`）与「新品段」（products，`target_type='product'`），各自按自己的 target_type 计算待发集合、写 `push_records`、置终态：复用同一 dispatcher 状态机机制（`computePendingSet` 按 target_type 各算「跨天 per-channel 从未 success」待发 → 各 INSERT `pending` → 一次 sender 发送一条双段消息 → 按发送结果把两套记录各按自己 target_type 置终态）。绝不另写漂移状态机、绝不把产品记入 `event` 命名空间。该分发须满足：
- **分段 includedIds（防被截断误标）**：渲染分别回 `eventIncludedIds`/`productIncludedIds`。合并消息可能超 `MAX_MESSAGE_LENGTH` 被截断、截断点横跨两个 target_type 命名空间——dispatch 只对各段 includedIds 的记录按各自 target_type 置 `success`，被截断未发的保持 `pending` 下次重拼，绝不误标 success。
- **非空抛错不变量（跨段保持）**：两段 pending 并集非空、但两段 includedIds 并集为空 → 抛错（防静默漏推），不静默跳过。
- **终态方案 A（两段各自独立事务，event 先固化，product 失败不回滚 event）**：发送成功后**先**在一个事务把 `eventIncludedIds` 置 `success`（要闻段优先固化），**再**在另一事务把 `productIncludedIds` 置 `success`；product 终态写若抛异常只记错误/告警、不回滚 event 段，残留 product pending 由下次日报运行补发（outcome 仍 `sent`、不触发整 job 重试）。event 终态事务自身抛错则不 swallow、向上传播 → run-daily 置 failedChannels 触发整 job 重试（与 product 非对称是有意的）。发送失败（sender 抛）→ 两段各自独立事务置 `failed`。承认 event-success/product-pending 中间态为可接受窗口（既有 dispatcher 本就无跨 target_type 原子性）。
- **段级失败隔离**：product 侧任一 DB 操作异常绝不令「消息已发送成功」的 event 段被误判/回滚 `failed`；product 侧失败降级空新品段或仅记该段错误（必发错误日志/告警）。
- **返回契约**：`dispatchDailyDigest` 返回独立接口 `DailyDispatchResult { pushDate, outcome, eventIncludedIds, productIncludedIds }`（不复用 `DispatchResult`）；`outcome`=两段皆 skip→`skipped`、sender 抛→`failed`、否则→`sent`（含 product 终态写失败仍 `sent`）。run-daily per-channel 汇总仅读 `outcome`。
- **表头计数取实发数**：表头「AI Radar 每日情报（要闻 X·新品 Y）」中 X=`eventIncludedIds.length`、Y=`productIncludedIds.length`。

**移除独立产品调度**：worker 不再注册独立 `product-digest` 调度链/队列/cron/单例锁；产品推送只经日报链承载（产品段在日报单例锁内，天然防同 push_date 并发双发）。新闻熔断 abort（judge/digest 降级率超阈）时整条日报含产品段当日不推、次日 cron 补——产品搭日报 job 便车、不免疫 job abort（「不进熔断分母」指产品不影响熔断触发）。新闻事件的评分/摘要/熔断/时效闸/幂等口径不变。

**产品中文化前置 + 新品段中文渲染（capability product-chinese-digest）**：日报产品段编排须在**产品塌缩之后、per-channel 候选之前**插入一次 channel-blind 产品中文化步骤（中文化候选 = 各 channel 推送候选精确并集，见 product-discovery / product-chinese-digest）；该步骤**永不向上抛**、产品中文化失败**不进熔断分母、不中止流水线**（延续「失败不拖垮新闻」），但整步失败规模异常须单独告警（系统故障可观测、「不进熔断」≠「无监管」）。**失败语义与 events 编排不同规格**：Agent 内核（summarizeProduct）与 events 同规格，编排零件对称 collapseProductsOnce（永不抛）、非 events digest 的「非业务异常 rethrow + 熔断」。新品段渲染由「仅英文产品名 + 链接」改为「中文译名（回退英文名）+ 中文简介要点行（套**产品专属上限 `PRODUCT_TAGLINE_MAX`** 截断、**非 events HEADLINE_MAX**、与 schema cap 同一常量；无则省略要点行、退纯标题）」，Telegram 与飞书两渲染口径一致。

#### 场景:定时触发跑通整条流水线并多通道分发
- **当** 每日定时触发 `daily-digest` 任务
- **那么** `runDailyWorkflow()` 按采集（含 arXiv）→去重→判断→发布时间回填→选择→摘要→分发顺序执行，并向 Telegram 与飞书两通道各自分发日报

#### 场景:发布时间回填在 Value Judge 之后 Top N 之前
- **当** `runDailyWorkflow()` 执行到选 Top N 之前，存在 `should_push=true` 且 `published_at IS NULL` 的事件
- **那么** 系统先对其调 published-at-inference 回填（受独立单次上限约束），再进入 Top N 选择；补不出的保持 NULL 被 Top N 时效闸排除；回填失败不阻塞后续阶段

#### 场景:单通道发送失败不拖垮另一通道
- **当** 多通道分发时某一通道（如飞书）发送失败
- **那么** 该通道记录 failed 并隔离，另一通道照常完成推送，整 job 不因单通道失败而漏发另一通道

#### 场景:告警独立调度、产品并入日报新品段
- **当** 检视产品发现、实时告警的触发方式
- **那么** 实时告警由独立定时/触发任务承载，不嵌入 `runDailyWorkflow()` 单一顺序链、不与日报阶段构成相互投递队列；产品发现已并入日报链作为新品段（不再独立调度）

#### 场景:日报顺序子流程含产品塌缩与候选
- **当** 日报触发
- **那么** 在新闻链（塌缩→评分→回填→Top N→摘要）之后、早退判断之前，先调一次 `collapseUncollapsedProductRawItems`（channel-blind），再对每个已配置 channel 调 `selectProductCandidates` 存入 `productsByChannel`，产品候选并入日报消息新品段

#### 场景:产品塌缩一次且在产品候选之前
- **当** 日报子流程执行产品段
- **那么** 产品塌缩在 channel 展开之前只调一次（绝不随 per-channel 并发重复执行，避免违反产品塌缩单实例假设产生同批竞态）、且必在所有 channel 候选查询之前，确保 `merge_conflict` 标记对候选可见

#### 场景:一条日报消息双 target_type 各自幂等
- **当** 当日同时存在新闻事件待发与产品待发
- **那么** 渲染一条「要闻+新品」双段消息、一次发送；事件行按 `target_type='event'` 写 `push_records`、产品行按 `target_type='product'` 写，各自独立幂等（失败各自重试、成功各自不重推），不混入对方命名空间

#### 场景:合并消息超长截断时分段 includedIds 不误标
- **当** 要闻段+新品段合并后超 `MAX_MESSAGE_LENGTH`、新品段尾部被截断未发出
- **那么** dispatch 只对 `eventIncludedIds`/`productIncludedIds`（各自实际发出的）按对应 target_type 置 `success`，被截断未发的产品保持 `pending`、下次重拼，绝不误标 success

#### 场景:产品侧终态写 DB 异常不拖垮已发成功的要闻段
- **当** 消息已发送成功，event 段终态已在其独立事务置 `success`，随后产品段终态写（发送之后）抛 DB 异常
- **那么** 要闻段保持 `success`（已在前一事务固化、不被产品段事务回滚）；产品侧异常必发错误日志/告警（不依赖 failedChannels 兜底），`outcome` 仍为 `sent`，残留 product pending 下次补发

#### 场景:发送前产品侧 DB 异常只降级新品段
- **当** 产品段 computePendingSet 或 INSERT pending 在发送之前抛 DB 异常
- **那么** `productsPending` 降级为空、必发错误日志/告警；若 event 段非空则只渲染推 event 段，若 event 段也空则两段皆空 → `skipped`（不发空消息），均不拖垮要闻段

#### 场景:产品段为空仍推新闻段（反之亦然）
- **当** 当日无产品候选但有新闻 Top N（或反之）
- **那么** 日报只渲染非空段并正常推送；仅当新闻 Top N 与 `productsByChannel` 全空时早退 `skipped-no-candidates`

#### 场景:崩溃重试只重发未 success 段
- **当** 一条日报已发出但在写两套终态前进程崩溃，下次同 push_date 重试
- **那么** 重试先对两段各跑 `computePendingSet`，已 `success` 的段被排除、只重发仍未 success 段（崩在写任何 success 前则两段都未 success → 重发整条，唯一键 + 候选窗口兜底不重复记录）

#### 场景:产品段失败不进新闻熔断、不拖垮日报
- **当** 产品塌缩或产品候选查询失败
- **那么** 塌缩/候选各自捕获异常、记错误/告警、返回空新品段，新闻段照常评分/摘要/推送；产品失败不计入新闻 judge/digest 降级率熔断分母

#### 场景:新闻链熔断 abort 时整条日报含产品段当日不推
- **当** 新闻链 judge 或 digest 降级率超阈触发 `WorkflowAbortError`（LLM 大面积故障）
- **那么** 整条日报 job 终止（产品段位于熔断 throw 之后、不执行），当日要闻段与新品段都不推、次日 cron 补（产品幂等不退化）；「产品不进熔断分母」指产品不影响熔断触发，非产品免疫 job abort

#### 场景:产品中文化阶段编排在塌缩后候选前
- **当** 日报流水线执行到产品段（judge/digest 熔断之后、早退之前）
- **那么** 先 collapseProductsOnce（channel-blind 一次），再 channel-blind 产品中文化一次，再 per-channel 产品候选；中文化失败不中止流水线、不进熔断分母

#### 场景:新品段渲染中文译名与简介
- **当** 渲染日报新品段、产品已中文化
- **那么** 渲染中文译名 + 中文简介要点行（套 `PRODUCT_TAGLINE_MAX` 截断 / 转义、Telegram 与飞书一致）；未中文化的产品回退英文名、省略要点行

#### 场景:产品中文化失败不拖垮日报但可观测
- **当** 某产品中文化业务失败（ProductDigestFailureError）或整步遇系统异常（DB 断连）
- **那么** 该产品回退英文名照常推送，流水线不中止、不进 events 熔断分母、要闻段不受影响；但整步失败数异常须单独告警（不进熔断 ≠ 无监管、防系统故障静默）
