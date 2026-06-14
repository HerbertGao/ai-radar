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

