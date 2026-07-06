# daily-intel-pipeline 规范

## 目的
待定 - 由变更 minimal-intel-pipeline 同步创建。归档后请更新目的。
## 需求
### 需求:每日定时单队列顺序编排

系统必须用 BullMQ 提供一个每日定时触发的 `daily-digest` 任务，调用一个纯顺序的工作流函数 `runDailyWorkflow()`，按固定顺序执行：采集（registry 驱动的多源 `Promise.allSettled` 并发抓取，含 RSS 大厂官方 feed / Hacker News / GitHub / arXiv / Product Hunt）→ 规范化/硬去重塌缩 → Value Judge 逐条判断 → **发布时间回填（published-at-inference：对 `should_push=true` 且 `published_at IS NULL` 的事件做 AI 推断回填，受独立单次上限约束）** → Top N 选择 → 中文摘要 → **向所有已配置通道分发推送（Telegram 与飞书）**。BullMQ 仅充当定时触发器与整 job 重试外壳，本期禁止把各阶段拆成多个相互投递的队列。

**发布时间回填必须在 Value Judge 之后、Top N 选择之前执行**：Top N 候选窗口以 `published_at` 时效过滤、对 NULL 自然排除（见「Top N 组合分选择」），故缺失发布时间的事件必须先经回填阶段补值，能补的补、补不出（AI 无法判定）的保持 NULL 由 Top N 时效闸排除。回填阶段失败/超时按「无法判定（NULL）」降级，不得阻塞或中止 `runDailyWorkflow()` 其余阶段。回填阶段是 `runDailyWorkflow()` 顺序链内的一个**阶段**（非独立调度入口），与告警链的回填以 DB 层 CAS（`UPDATE ... WHERE published_at IS NULL`）并发安全。

**回填阶段绝不计入降级率熔断（`DEGRADE_ABORT_RATIO`，绝不可省）**：回填的「判不出（NULL）」是**预期的高比例安全失败方向**（老文 + 线索少的事件本就大量判不出，判不出即排除、不误推），其比例不代表流水线健康度。回填阶段**禁止**产生新的熔断阶段、其「判不出/失败」**禁止**计入任何降级率熔断分母——熔断分母只含 Value Judge 与中文摘要两阶段（既有口径）。否则冷启动老 NULL 事件的高「判不出」率会触发 `DEGRADE_ABORT_RATIO` 误中止**正常**日报。

多通道分发必须**并发**（`Promise.allSettled`）各走一遍 telegram-push 定义的「待发集合→pending→原子送达→success/failed」状态机，单通道发送失败必须隔离（记录该 channel failed、不拖垮另一通道），各通道幂等按 channel 独立。整 job 由单例锁（`daily-digest:{push_date}`）防双实例，TTL 须覆盖含多通道并发分发的最坏时长（见 telegram-push「日报任务全局单例」）。**Telegram 为必配通道**：「已配置通道」集**至少含 `telegram`**、不可为空（飞书可选，见 feishu-push）；若 Telegram 必需配置缺失则按 P1 既有 env 校验启动快速失败，禁止「已配置通道集为空 → 日报静默无出口」。

实时告警（realtime-alerts）、周报（weekly-report）必须由**独立的定时/触发任务**承载，**不得**塞进 `runDailyWorkflow()` 的单一顺序链，也不得与日报各阶段相互投递构成复杂队列图——它们是与日报并列的独立调度入口，各自遵守其能力规范的幂等口径。**产品发现（product-discovery）已并入日报链作为「新品段」**（见下），不再是独立调度任务。每日定时 cron 默认触发时刻不得卡在整点/半点（降低飞书 11232 限流）。

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

#### 场景:告警/周报独立调度、产品并入日报新品段
- **当** 检视产品发现、实时告警、周报的触发方式
- **那么** 实时告警、周报由独立定时/触发任务承载，不嵌入 `runDailyWorkflow()` 单一顺序链、不与日报阶段构成相互投递队列；产品发现已并入日报链作为新品段（不再独立调度）

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

### 需求:Top N 组合分选择

系统必须由程序（而非 LLM）从候选事件中选出每日 Top N。候选窗口必须为 `should_push=true AND published_at 在近 N 天（闭区间 lowerBound <= published_at <= now）AND 该 event 尚未投递给**所有已配置通道**`（success 覆盖的 distinct 已配置通道数 < 配置通道数）。

**时效闸必须基于发布时间 `published_at`，禁止基于抓取时间 `first_seen_at`**：`first_seen_at` 在塌缩建事件时被赋值为 raw_item 的入库时刻（抓取时间），与文章真实发布时间无关；以它做时效过滤会在冷启动/新增源时把大量历史老文（其 `first_seen_at` 恰为「今天」）误当「近 N 天新消息」推送，违反时效性。故候选窗口的「近 N 天」必须以 `published_at` 衡量。复用现有窗口天数配置（`FIRST_SEEN_WINDOW_DAYS`，默认 3），不新增窗口配置项；`first_seen_at` 语义不变（仍记录首次抓取时间，供调试/僵尸 claim 回收等用途），仅不再用于时效过滤。

**时区比较口径必须显式且唯一**：`published_at` 是带时区的发布**绝对时刻**（schema `withTimezone: true`），下界 `lowerBound` 由 `startOfDayInTimeZone` 把「今天（Asia/Shanghai）往前第 (N−1) 个自然日 00:00」换算为 UTC 绝对时刻。时效闸即 `lowerBound <= published_at <= now` 的**绝对时刻比较**（非「裸日期 vs 带时区」混比，也不按发布地本地日历重算）。落在「上海日界」UTC 前后一瞬的事件行为由此唯一确定：发布绝对时刻 ≥ 下界即入窗、否则出窗。

**必须设未来日期上界 `published_at <= now`（绝不可省）**：除下界外必须再加上界排除未来日期。`published_at` 的错误未来值不止来自 AI 推断（AI 有 refine 拦截，见 `published-at-inference`），**确定性来源**（RSS `pubDate`、GitHub `pushed_at` 等）同样可能给出未来日期（源端 bug / 时区错配 / 恶意 feed），经采集直接入库、不过 AI 拦截。若只设下界，未来日期 `>= lowerBound` 恒真会绕过时效闸被当「近期」推送。上界 `published_at <= now` 在过滤层拦住**任何来源**的未来值，与 AI refine 构成双层防御。

**已知源特例（GitHub）**：采集器对 `github` 源写入的 `published_at = pushed_at ?? created_at`（仓库最后 push 时间，非「首次发布时间」）。故活跃的老仓被任何新 commit 推动后其 `published_at` 会变新、可能落进近 N 天窗口。本期不改采集器口径（属 source-collectors 职责），将其记为已知局限（见本变更 design 风险节）；`published_at` 作为「时效近似」在 GitHub 源上语义为「最近活跃」而非「首次发布」。

**`published_at` 为 NULL 的事件必须先经 `published-at-inference` 能力的 AI 推断回填**：采集阶段已解析得到 `published_at` 的事件直接参与过滤；缺失者先由 AI 推断，推断成功则回填后参与过滤，AI 仍无法判定（保持 NULL）则**排除出候选**（不推送）。最终候选过滤必须为 DB 层确定性 query（基于 `published_at`），禁止把「是否够新 / 是否推送」交给 LLM——LLM 仅做 `published_at` 语义抽取。

「尚未投递给所有通道」而非「今天未 success」——否则常青高分事件会跨天天天上榜重复推送（退出标准②仅约束「同一天不重复」，但产品语义要求一条事件一生只成功推一次）。

**统一日报模型（Model B）——选题与通道解耦 + 各通道可靠补发，绝不可违背**：每日只选**一份** channel-blind 的 Top N（按 `rank_score` 统一排序，不按 channel 分别选题），由编排层把**同一份**名单发放给**所有已配置通道**（通道只负责投递上游统一选好的信息，不参与选题）。**各通道可靠投递（不丢消息）**：dispatcher `computePendingSet` 按 **per-channel 跨天**口径过滤——该 channel **从未** success 过的才进该通道待发；故某通道（如飞书）失败时该事件在该 channel 无 success → 跨天/跨次仍在该通道待发 → **可靠补发**，已 success 的通道（如 telegram）则被排除、绝不跨天重发。候选窗口排除「已投递给**所有**已配置通道」者——只要还差任一通道未 success 就留在统一名单（保住 Top N 名额给仍需投递的事件）；一旦所有已配置通道都 success → 移出名单、不再跨天重选。**禁止按通道分别选题**（早期「telegram 的名单泄漏给飞书」与「任一通道成功即踢出致失败通道丢消息」都是被本模型纠正的反模式）。候选窗口判定「近 N 天」所用的「今天」必须与 telegram-push 的 `push_date` 同源（Asia/Shanghai），禁止两处时区口径漂移。

系统必须按组合分 `rank_score = 0.45*importance + 0.25*developer_relevance + 0.20*novelty − 0.10*hype_risk` 排序（权重必须可经 config 配置），取 Top N（N 可配，约 5–10）。排序必须带确定性 tiebreaker（`published_at DESC NULLS LAST, event_id ASC`）以保证 Top N 边界可复现。系统必须设 importance 下限闸（如 `>= 60`）：低于阈值的事件不入选，宁可当日少于 N 条也不凑数。LLM 的 `should_push` 仅作为候选信号，禁止由 LLM 决定最终推送名单与排序。

> 说明：时效闸 `published_at >= lowerBound`（`gte` 对 NULL 返假）已在 SQL 层排除所有 NULL `published_at` 行，故进入排序的候选 `published_at` 恒非 NULL，tiebreaker 中的 `NULLS LAST` 分支在日报候选里成为不可达的防御性冗余（保留无害、代码无需改）。

#### 场景:时效窗口基于发布时间而非抓取时间
- **当** 某高分事件 `published_at` 早于近 N 天窗口（如多年前发布的老文），但因新增源/冷启动今日才首次抓到（`first_seen_at` 为今天）
- **那么** 该事件不进入今日 Top N（按 `published_at` 判定不在近 N 天），不被误当新消息推送

#### 场景:发布时间为未来的事件被排除
- **当** 某事件 `published_at` 晚于当前时刻（未来日期，无论来自确定性来源如 RSS/GitHub 还是其它）
- **那么** 该事件被时效闸上界 `published_at <= now` 排除、不入候选，不被当「近期」误推

#### 场景:发布时间缺失经 AI 推断后参与过滤
- **当** 某事件采集阶段 `published_at` 为 NULL，经 `published-at-inference` 推断出明确发布日期并回填
- **那么** 系统以回填后的 `published_at` 判定其是否在近 N 天窗口，决定是否入候选

#### 场景:AI 仍无法判定发布时间的事件被排除
- **当** 某事件 `published_at` 为 NULL，且经 AI 推断后仍无法判定（保持 NULL）
- **那么** 该事件被排除出今日 Top N 候选，不被推送

#### 场景:按组合分确定性取 Top N
- **当** 候选事件多于 N 条
- **那么** 系统按 `rank_score` 降序并应用确定性 tiebreaker（`published_at DESC NULLS LAST, event_id ASC`）取前 N 条，对同一批已落库事件多次运行结果一致

#### 场景:已投递给所有已配置通道的事件移出统一名单
- **当** 某 event 已在所有已配置通道（如 telegram + feishu）均 success 推送过，今日仍 `should_push=true` 且 `published_at` 在近 N 天窗口内
- **那么** 该 event 不进入今日 Top N（已全部投递完毕），不会被跨天重复推送

#### 场景:缺任一通道的事件仍在名单、由该通道跨天补发
- **当** 某 event 已在 telegram success、飞书 success 失败（飞书无 success），已配置通道为 telegram + feishu
- **那么** 该 event 仍进入统一 Top N（飞书尚缺）；分发时 telegram 的 `computePendingSet` 排除它（telegram 已 success、不重发）、飞书的 `computePendingSet` 纳入它（飞书从未 success、可靠补发），不丢消息

#### 场景:统一一份 Top N 发放给所有已配置通道
- **当** 当日选出一份 Top N，已配置通道为 telegram + feishu
- **那么** 同一份 channel-blind Top N 名单发放给两个通道（选题与通道解耦）；各通道按其 per-channel 跨天 `computePendingSet` + 四元组独立投递，不因另一通道而改变选题

#### 场景:下限闸过滤低分事件
- **当** 某候选事件 `importance` 低于下限阈值
- **那么** 该事件不入当日 Top N，即使当日入选总数因此少于 N 条

### 需求:降级逐条容错与降级率熔断

系统在 Value Judge 与中文摘要逐条处理时，单条失败必须跳过该条并记录错误日志、累加降级计数，整批继续（局部容错），失败条目对应的 `raw_item` 已入库可在后续运行重判。Value Judge 阶段必须**只处理尚未评分的事件**（`*_score IS NULL`），已评分事件跳过不重判。

**并发评分必须原子 claim（P2 新增，绝不可省）**：自 P2 起，日报工作流与实时告警高频工作流（见 realtime-alerts）可能**并发**对同一未评分事件跑 Value Judge。仅靠「只处理 `*_score IS NULL`」无法防并发双评分——两条链路可同时 `SELECT` 到同一未评分事件、各自送 LLM 评分并互相覆写。故送 LLM 前必须做**确定性原子 claim**：用 `UPDATE ai_news_events SET judge_claimed_at=now() WHERE event_id=? AND *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now() - interval 'T') RETURNING`（或 `SELECT ... FOR UPDATE SKIP LOCKED`），**只有 claim 成功者送 LLM 评分**，未 claim 到的链路跳过该事件。

**超时回收语义必须显式（否则僵尸 claim 永久漏评分）**：claim 条件**必须含 `OR judge_claimed_at < now() - interval 'T'`**——否则 claim 后崩溃留下的事件（`judge_claimed_at` 非空但 `*_score` 仍 NULL）将不满足 `judge_claimed_at IS NULL`、**永远无法被任一链路重新 claim**，结构性漏评分→漏日报漏告警（反而比双评分更糟）。

**回收阈值 `T` 必须覆盖端到端「claim→写分提交」最坏时长（绝不可省）**：一个被 claim 的事件停留在「`*_score IS NULL` 且 `judge_claimed_at` 已写」的总时长 = `L`（单条 LLM 硬超时，如 `LLM_TIMEOUT_MS`，超时即失败计入降级、释放该事件）+ `W`（LLM 返回后写 `*_score`/事务提交的延迟上界，含 DB 写排队与进程暂停容限）。**仅 `T > L` 不够**——若 LLM 在逼近 `L` 返回后遭遇 GC 暂停/写排队 > `(T−L)`，另一链路会满足 `judge_claimed_at < now()-T` 重新 claim → 双评分覆写。故回收阈值必须满足 **`T > L + W`**（或等价地：把 `L` 定义为「claim→写分提交」的端到端预算、写分与 claim 释放在同一事务原子完成，使「正在进行」的总时长恒 `< L < T`）。如此 `judge_claimed_at < now() - interval 'T'` 只可能命中**已崩溃/已超时释放**的僵尸 claim，绝不会误回收仍在合法评分/写分中的事件。由此保证「一事件只被评一次分、永不覆写、且崩溃不致永久漏评」跨日报/告警两链路成立。

降级率必须**按阶段分别计算、各自独立熔断**：Value Judge 阶段分母 = 本轮实际送判（未评分）的事件数，中文摘要阶段分母 = 进入摘要的事件数（Top N）；二者各自独立判定，禁止合并计算。某阶段分母 > 0 且其降级率严格超过阈值（`> ratio`，如 `> 0.5`）时，系统必须中止并告警，禁止推送残缺日报。**多通道分发阶段的发送失败不计入 Value Judge / 摘要熔断分母**——分发失败由「单通道隔离 + 该 channel failed 记录 + 下次重试」承载（见每日编排与 telegram-push），不与判断/摘要熔断混算。

某阶段分母为 0 时（本轮无未评分事件、或 Top N 为空）必须禁止按 `0/0` 计算降级率；但**分母为 0 本身不是错误、不得据此中止**——Value Judge 分母 = 0 时直接进入 Top N 选择（已评分常青事件仍可入选），中文摘要分母 = 0（Top N 为空）时无可推、正常不推。禁止把「Value Judge 分母 = 0」误判为「今日无候选」而中止。

「系统级故障」告警必须以**采集/规范化层**为准而非以 judge 分母为准，**且仅适用于日报工作流（`runDailyWorkflow`）**——实时告警高频工作流（每 15–30min 跑、全源返回 0 是常态）**不套用**本告警，否则会每天数十次误告警刷屏（见 realtime-alerts）。以下两种情形日报工作流必须以可观测方式告警，而非静默空跑：
1. 本轮采集返回条数为 0（**registry 全部源**失败——P2 由 P1 的「三源」扩为 registry 注册的全部源 RSS/HN/GitHub/arXiv/Product Hunt，单个源失败如 arXiv 持续 429 被 allSettled 隔离、不触发本告警，唯有全部源返回 0 才告警）；
2. 本轮采集返回条数 > 0 但**新闻类可处理条目数为 0**（全部 `unprocessable`，即无任何**新闻类**条目能构造 `dedup_key`）——提示采集器采空或归一函数故障。

注意告警分母只统计**新闻类**条目：`raw_type IN ('product','paper')` 的产品/论文条目**不计入**「新闻类可处理条目数」（它们不进事件塌缩，见 dedup-and-normalization 类型路由）——否则某轮仅 arXiv 返回 paper、新闻源全空时，paper 会掩盖新闻真空使告警失灵；反之新闻真空必须照常告警。「可处理条目数」必须包含「塌缩进已存在新闻事件」的条目；「当日全部新闻条目命中既有事件、无新事件」属正常无新闻情形、不告警；唯有「全部新闻条目 unprocessable 或无新闻条目」才告警。

#### 场景:个别条目失败整批继续
- **当** 少数事件的 Value Judge 或摘要失败而降级
- **那么** 这些事件被跳过并记录，其余事件照常进入后续阶段，流水线不中止

#### 场景:并发评分只评一次不覆写
- **当** 日报链与实时告警高频链同时取到同一未评分事件送评分
- **那么** 仅原子 claim（`UPDATE ... judge_claimed_at WHERE *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now()-T) RETURNING`）成功的一条链路送 LLM，另一条跳过，该事件只被评一次、`*_score` 不被覆写

#### 场景:claim 后崩溃的事件经 T 后被重新评分
- **当** 某事件被 claim（`judge_claimed_at` 已写）后进程崩溃、`*_score` 仍为 NULL
- **那么** 经回收阈值 `T`（满足 `T > L + W`，见上）后，后续运行因 `judge_claimed_at < now()-T` 重新 claim 到该事件并评分，不形成永久漏评分

#### 场景:正在评分的长事件不被误回收
- **当** 某事件正被一条链路合法评分中（LLM 调用受硬超时 `L`，写分提交延迟上界 `W`，回收阈值 `T > L + W`）
- **那么** 该事件停在「score NULL + 已 claim」的总时长恒 `< L + W < T`，不可能存活到 `now()-T`，故另一链路不会因超时回收误重新 claim 它、不双评分覆写

#### 场景:任一阶段降级率过高时中止告警
- **当** Value Judge 或中文摘要任一阶段分母 > 0 且其降级率严格超过阈值
- **那么** 系统中止本次流水线并告警，不推送残缺日报；摘要阶段的少量失败不因 judge 阶段大分母被稀释而漏判

#### 场景:Value Judge 分母为 0 时仍推送已评分常青事件
- **当** 本轮塌缩后无任何未评分事件（Value Judge 分母 = 0），但存在已评分、`should_push=true`、从未 success 的常青事件
- **那么** 流水线不中止、不误判「今日无候选」，这些常青事件正常进入 Top N 选择并被推送

#### 场景:registry 全部源失败时按采集层告警
- **当** 本轮 registry 注册的全部源采集返回条数均为 0
- **那么** 系统以可观测方式告警，不按 `0/0` 求值为「降级率正常」而静默空跑；单个源（如 arXiv 持续 429）失败被隔离、不触发本告警

#### 场景:采集非空但全部新闻类 unprocessable 时告警
- **当** 本轮采集返回条数 > 0 但新闻类可处理条目数为 0（全部新闻条目 unprocessable，product/paper 不计入）
- **那么** 系统以可观测方式告警（提示采集器/归一函数故障）；而当新闻条目全部命中既有事件（可处理数 > 0、无新事件）时属正常无新闻，不告警

#### 场景:分发失败不计入判断/摘要熔断
- **当** 多通道分发时某通道发送失败
- **那么** 该失败仅按单通道隔离 + failed 重试处理，不计入 Value Judge / 摘要的降级率熔断分母

### 需求:要闻段与新品段跨段去重抑制（同一项目双段重复兜底）

系统 MUST 在 `runDailyWorkflow()` 选出要闻段（channel-blind Top N，待推 `pushable`）与新品段（`productsByChannel`）之后、推送早退判断与 dispatch 之前，执行一道**确定性跨段去重抑制**：若同一项目既出现在要闻段又出现在新品段，MUST **从要闻段剔除该事件、保留新品段产品**（Show HN/Launch HN 等本质是产品，新品段是其正确归属、且带官网链接与中文简介）。

对齐键 MUST 为**产品归一三键组**（`canonical_domain` / `github_repo` / `product_hunt_slug`），复用既有导出纯函数 `extractProductMergeKeys`（与产品塌缩、Show HN 采集同一口径，避免漂移）：
- **要闻侧**：对每个待推事件取其代表 raw_item 的 `canonical_url`（经既有 eventId→canonical_url 映射 `loadCanonicalUrls`），调 `extractProductMergeKeys({ url: canonicalUrl })` 提出该事件的三键组。
- **新品侧**：取产品的**存储归一键**（`ai_products.canonical_domain` / `github_repo` / `product_hunt_slug` 字段本身，由 `selectProductCandidates` 随候选一并带出、见 product-discovery「链接来源」段的候选载体约定），**MUST NOT** 取经 `resolveProductUrl` 渲染出的 `canonicalUrl`（后者含 github/PH 回退、提域会得到 `github.com`/`producthunt.com`，致 mass 误抑制——见下）。
- **平台 host 域 MUST 排除（一类缺陷、非两个特例）**：构建产品「域集」时 MUST 剔除**平台 host**——即「代码托管 / 包注册 / 产品目录 / PaaS 等本身非某产品自有域、其上路径才是产品身份」的 host。根因：产品 `canonical_domain` 被重载——真实产品取自 `website` 字段（有意义身份键），但**无 website 的 Show HN/PH 产品**其 raw_item `url` 是提交的平台 URL，经 `extractProductMergeKeys`（`website = meta.website ?? input.url`）落成平台 host 域。`extractProductMergeKeys` **当前只对 `github.com` 置 null**（其余平台 host 不管）。若不排除，任一 `canonical_url` host 为该平台的要闻事件会被 mass 误抑制（与 round 1 的 `github.com`、round 2 的 `producthunt.com` **同一类缺陷**）。
  - **denylist MUST 为命名常量 `PLATFORM_HOSTS`**（所有排除引用点 MUST 指向它、禁止在调用点内联子集），至少含：`github.com`（已 null）、`producthunt.com`、`gitlab.com`、`gitee.com`、`bitbucket.org`、`codeberg.org`、`sourceforge.net`、`npmjs.com`、`pypi.org`、`crates.io`、`huggingface.co`。**收录判据**：只收「**URL 路径**而非**子域**标识产品」的平台 host（`github.com/owner/repo`、`npmjs.com/package/x`…）；**子域标识产品**的 PaaS（`myapp.vercel.app`/`x.github.io`/`x.netlify.app`）**不入**——`extractCanonicalDomain` 取完整 host，子域本就是产品唯一身份、不撞域。MUST 注释「**任何产品源（见 `PRODUCT_SOURCES`）的无 website 兜底 URL host 若是路径式平台 host，MUST 加入本常量**」，并在 `PRODUCT_SOURCES` 定义处加回引注释指向 `PLATFORM_HOSTS`，把「新增产品源 ↔ 新增平台 host 排除」的耦合在**两处编辑点**都显式化（防再以一次生产误抑制事故才发现）。
  - **残留（accepted）**：denylist 是确定性枚举、不可证完备；未列入的平台 host 仍可能 mass 误抑制一类该 host 的要闻——后果仅「少推若干要闻、新品段仍在、非数据损坏」，属可接受 bounded 残留（彻底根治需让产品塌缩按 `canonical_domain` 来源 website-vs-fallback 区分、对所有平台 host 一致置 null，那触及产品塌缩写入路径、超本次范围）。PH 产品的有效身份是 `product_hunt_slug`、github 产品是 `github_repo`——平台 host 域排除后它们走各自精确键对齐。
- **判定**：事件的任一**非空**键命中任一产品对应键集合（`canonical_domain ∈ 产品域集`〔已排除平台 host〕 或 `github_repo ∈ 产品 repo 集` 或 `product_hunt_slug ∈ 产品 slug 集`）即判为同一项目、抑制该事件。

判定 MUST 纯由程序确定性键完成，MUST NOT 调用 LLM / embedding 做「是否同一项目」判断（守第一架构原则：跨表去重由程序与确定性键保障，绝不交给语义层）。

**为何用三键组而非渲染域**：`extractProductMergeKeys` 无条件令 `github.com` 域置 null（两侧一致）——github 来源的要闻事件（`raw_type='repo'`，`canonical_url` host=`github.com`，经新闻塌缩进 `ai_news_events`）与 github-only 产品都不以 `github.com` 域参与比对，改由 `github_repo`（`owner/repo`）精确对齐：既**杜绝**「所有 github 要闻被 github.com 域 mass 误抑制」（修改3 的回退 URL 提域会撞 `github.com` 的 blocker），又**顺带闭合** github 直链的 news↔product 双段重复（`themartiano/luz` 类）。`producthunt.com` 不被 `extractProductMergeKeys` 置 null，故 MUST 在构建产品域集时显式排除（见上「平台 host 域 MUST 排除」）。

**键提取的两侧不对称（设计如此，记录以防误用）**：要闻侧只传 `{ url: canonicalUrl }`（无 `metadata`），故 `product_hunt_slug` 与 `meta.canonical_domain`/`meta.github_repo` 分支对事件**永不触发**——事件只可能经 URL 推导的 `canonical_domain` 或 `github_repo` 命中。**注意**：事件侧的 `canonical_domain` **不经平台 host 排除**（事件键是 `extractProductMergeKeys({url})` 原样输出，仅 `github.com` 被该函数置 null，`producthunt.com` 等在事件侧仍保留）；抑制的安全性来自**产品域集排除平台 host**（命中需事件域 ∈ 产品域集，而产品域集已剔平台 host），不是事件键被擦洗。新品侧传存储字段（含 `product_hunt_slug`）。

**两侧是同一键空间的两次独立派生，同步义务 MUST 显式**：产品侧三键是 `extractProductMergeKeys` 在**塌缩时**写入 `ai_products` 的存储值（冻结），事件侧是**查询时**对 `canonical_url` 现调 `extractProductMergeKeys`；二者经同一函数派生、口径一致，但**平台 host denylist 是抑制层在两者之上额外施加的变换、不在 `extractProductMergeKeys` 内**。故「单一口径避免漂移」仅指 `extractProductMergeKeys` 本身；若该函数的 host 置 null 规则未来变化（如开始 null `producthunt.com`），MUST 同步检视抑制层 denylist（去重避免双重维护）。因此 PH-only 产品（域被排除、repo null、仅 slug）与任何要闻事件都**不命中**（事件侧产不出 slug 键）：这是**安全方向的欠抑制**（PH-host 要闻↔产品的双段重复本期不闭合，属可接受残留，PH 本是产品源、极少作要闻 canonical）。

> 动因：`ai_news_events`（要闻）与 `ai_products`（新品）分表去重、无跨表去重，同一项目经不同源进两表即双段重复（生产实锤：HN `48544823` / `grassdx.com` 同时进要闻与新品）。采集期前缀过滤（见 source-collectors）只堵 HN 一条路径；RSS/sitemap 转载产品发布等其它源仍可能与 PH/Show HN 同产品撞域，故 MUST 有装配期确定性兜底，闭合「当天不重复推送」「分层去重 + 唯一约束兜底」不变量。

抑制 MUST 保持要闻段 channel-blind 单份语义（Model B）：MUST 用**所有已配置通道新品候选的并集**（`productsByChannel` 各通道候选并集）构成产品三键集合，剔一份 channel-blind 要闻段，MUST NOT 按单通道产品候选分别剔不同的要闻名单（否则破坏「同一份 Top N 发放给所有通道」）。**并集 + channel-blind 的已知权衡（accepted）**：某产品 P 仅为 telegram 候选（feishu 已 success 过 P 故不在 feishu 候选）、而同项目要闻事件 E 尚缺 feishu 投递时，E 会被从 channel-blind 要闻段剔除，致 feishu 当天既无该产品也无该要闻。这是 Model B「单份名单」与「产品 per-channel 一生一次」的固有张力下的取舍：选并集（防双段重复）优于交集（交集会在 telegram 留下 E+P 双段重复，即本提案要消灭的 bug）。E **不写 push_record**（见下）故跨天候选资格保留；产品 P 是 per-channel 一生一次、一旦在某通道 success 即离开该通道候选 → 并集域不再含 P → E 恢复。**恢复有界性（精确表述）**：E 的恢复以「P 清出候选」**且**「E 的 `published_at` 仍在 `FIRST_SEEN_WINDOW_DAYS` 时效窗内」为条件——通常 P 次日推完即恢复（≤1 天）；但若某通道**持续 failed/pending**（P 从未 success → 长期留候选），E 会随之被持续抑制直至该通道恢复或 E 时效窗过期。此为**通道不可用期的固有现象**（该通道本就投不出 E、不是本抑制新增的丢失），非永久漏推的反例；不引入 LLM、不加无界状态机来规避。

被抑制的要闻事件 MUST NOT 写入 `event` 命名空间的 `push_records`（不置 `pending`/`success`/`failed`）——它只是不进入本条日报消息；其跨天候选资格（「尚未投递给所有已配置通道」）MUST 保持不变，使其在某天不再被任一新品候选覆盖时能正常回到要闻段推送（不造成永久漏推）。**早退一致性**：抑制 MUST 产出 `pushableDeduped`，并由其**同时**喂给早退判断（`pushableDeduped.length === 0 且所有 channel 产品候选皆空` 才 `skipped-no-candidates`）与 dispatch（被剔事件不进 dispatch 的 `computePendingSet` 入参、故不写 push_record）；表头「要闻 X」取 dispatch 后 `eventIncludedIds.length`、自然为抑制后实发数。抑制位置在 `productsByChannel` 算出之后（依赖它）、早退判断之前；运行于中文摘要循环之后（`canonicalUrls`/`productsByChannel` 此时才齐备）——被剔事件已耗的摘要 LLM 调用为可接受的少量浪费（不另调度重排以省此开销）。

**纯函数 + 接线职责划分**：键比对 MUST 由 `src/selection/cross-segment-dedup.ts` 的**纯函数**承载，该模块**入参为已提取的键**（事件 `{eventId, keys}` 列表 + 产品三键集合）、**自身 MUST NOT import `src/collectors/*`**（保持 selection 层不新增 collectors 依赖边）。键来源分两侧：
- **产品侧（无需现提取，键随候选带出）**：`selectProductCandidates` MUST 让每个产品候选**携带其存储三键**（`canonical_domain`/`github_repo`/`product_hunt_slug`，见 product-discovery「候选载体」），编排层从内存中的 `productsByChannel` 候选对象直接读取构建产品键集合——**满足「复用 `productsByChannel`、MUST NOT 引入额外 DB 查询」**（键已随候选在内存，无需回查 `ai_products`）。
- **事件侧（现提取）**：编排层 `run-daily-workflow.ts` 对每个 `pushable` 事件用 `canonicalUrls.get(eventId)` 调 `extractProductMergeKeys({ url })` 提键。`run-daily-workflow.ts` 已 import `collectAndStore`（`../collectors/index.js`）→ **pipeline→collectors 依赖边已存在**；`extractProductMergeKeys` 在 `../collectors/product-keys.js`（零 `../db`/零 `env` 的纯 leaf 模块），import 它为同向良性边、不引入 DB 池、不成环。

**误抑制边界（accepted，确定性无更优解）**：① 同一 `canonical_domain` 下厂商既有真实要闻文章又有自家产品（如 `acme.ai` 博客新闻 + `acme.ai` 产品）→ 域键命中会剔掉该要闻；这是域级对齐的固有假阳性，后果仅「少推一条要闻、新品段仍在、非数据损坏」，确定性手段无法区分「同项目冗余」与「同域异内容」（语义区分被第一架构原则禁止）。② 两个不同产品共享**同一完整 host**（`extractCanonicalDomain` 取完整 host 去 www、**非** eTLD+1，故 `a.github.io` ≠ `b.github.io`，PaaS 子域天然不撞；仅同一裸 host 才撞，极罕见）。两类均 bounded、非破坏，记为 accepted。

#### 场景:同一项目同域同时进要闻与新品 → 要闻段剔除
- **当** 某事件 `canonical_url` 经 `extractProductMergeKeys` 得 `canonical_domain` = 某新品候选的 `canonical_domain`（如 `grassdx.com` 同时在要闻段与新品段）
- **那么** 该事件从要闻段剔除、不进日报要闻段、不写 `event` push_record；对应产品保留在新品段照常推送

#### 场景:github 直链同项目经 github_repo 对齐剔除
- **当** 某要闻事件 `canonical_url` 为 `https://github.com/owner/repo`（经 `extractProductMergeKeys` 得 `canonical_domain=null`、`github_repo='owner/repo'`），且某 github-only 新品候选 `github_repo='owner/repo'`
- **那么** 两侧 `github_repo` 命中 → 该要闻事件被抑制（闭合 github 直链 news↔product 双段重复，不依赖已被置 null 的域键）

#### 场景:github 来源要闻不被 github.com 域 mass 误抑制
- **当** 某 github 来源要闻事件（`raw_type='repo'`，`canonical_url=https://github.com/aaa/bbb`）与某无关 github-only 产品（`github_repo='ccc/ddd'`）同日出现
- **那么** 两侧 `canonical_domain` 均经 `extractProductMergeKeys` 置 null（不以 `github.com` 撞域），`github_repo` 不同（`aaa/bbb` ≠ `ccc/ddd`）→ **不**抑制，该 github 要闻正常推送

#### 场景:producthunt.com 域不致误抑制（平台 host 排除）
- **当** 某无 website 的 PH 新品候选其存储 `canonical_domain='producthunt.com'`（由 `extractProductMergeKeys` 从 PH 帖 URL 推出），与某 `canonical_url` host 为 `producthunt.com` 的要闻事件同日出现
- **那么** 构建产品域集时 `producthunt.com` 被显式排除（平台 host），二者不以 `producthunt.com` 撞域 → 该要闻不被误抑制（PH 产品改靠 `product_hunt_slug` 对齐）

#### 场景:要闻事件三键均不命中任何新品键 → 保留
- **当** 某要闻事件的 `canonical_domain`/`github_repo`/`product_hunt_slug` 三键与所有通道新品候选并集的对应键集合均无交集
- **那么** 该事件保留在要闻段，正常推送，不受抑制影响

#### 场景:全要闻段被抑制 + 新品非空 → 仍推新品段（早退用 pushableDeduped）
- **当** 抑制后 `pushableDeduped` 为空但存在新品候选
- **那么** 早退判断按 `pushableDeduped`（非原始 `pushable`）判定不早退、只渲染推送新品段；表头 `要闻 0·新品 Y`

#### 场景:抑制不破坏被剔事件跨天候选资格
- **当** 某事件今日因被新品段覆盖而从要闻段抑制、未写 `event` push_record
- **那么** 次日若它不再被任一新品候选覆盖，仍满足「尚未投递给所有已配置通道」候选窗口、可正常进入要闻段推送（无永久漏推）

#### 场景:跨段抑制用全通道并集三键集合保持 channel-blind
- **当** 某产品在 telegram 新品候选、不在 feishu 新品候选（或反之）
- **那么** 抑制用两通道新品候选的**并集三键集合**（域集〔排平台 host〕/ repo 集 / slug 集）剔一份 channel-blind 要闻段（只要任一通道会推该产品 → 要闻段就剔对应事件），不按通道分别剔不同要闻名单

#### 场景:表头计数取抑制后实发数
- **当** 跨段抑制从要闻段剔除 K 条后再 dispatch
- **那么** 表头「AI Radar 每日情报（要闻 X·新品 Y）」的 X 取抑制后实发事件数（`eventIncludedIds.length`），不含被剔事件

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

