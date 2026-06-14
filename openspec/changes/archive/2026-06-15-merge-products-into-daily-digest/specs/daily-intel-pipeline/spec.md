## MODIFIED Requirements

### 需求:每日定时单队列顺序编排

系统必须以每日定时单队列顺序编排日报全流程（采集 → 事件塌缩 → Value Judge 评分 → 发布时间回填 → Top N 选择 → 中文摘要 → 多通道推送），阶段间普通 await 顺序衔接，整个日报任务用 `acquireDigestLock(push_date)` 包住（finally 释放）保证某 `push_date` 全局单例。

**日报内承载产品「新品段」（本次变更）**：日报顺序子流程在新闻链之后、**早退判断之前**增产品子段，分**两步**（塌缩单实例、候选 per-channel）：① 产品 raw_items 已由采集阶段 `collectAndStore`（→`collectAllSources` 全集，含 PH/Show HN）覆盖，无需额外产品采集入口；② **产品塌缩一次（channel-blind）**：在 channel 展开**之前**调一次 `collapseUncollapsedProductRawItems`（import 自 `src/collectors/product-collapse.ts`；产品塌缩由单实例承载，**绝不可随 per-channel 并发跑 N 次**；须在产品候选查询**之前**，使 `merge_conflict` 标记对候选可见），包 try/catch 永不抛错；③ **per-channel 产品候选**：对每个已配置 channel 调既有导出 `selectProductCandidates(channel, dbh, limit)`（非 LLM；跨天「该 product_id 从未以该 channel `success`」+ 排除 `merge_conflict`），结果存 `productsByChannel: Map<Channel, SelectedEvent[]>`（**算一次、贯穿早退判断与 dispatch，dispatch 不重算**），候选查询包 try/catch 失败降级空段。产品子段**不进新闻评分/摘要熔断分母**（产品段拿不到 judge/digest 累加变量，由作用域天然隔离）、不复用新闻 Top N 名额。塌缩与候选**各自永不向上抛**，「产品失败不拖垮新闻」由此结构契约保证。

**早退条件（两段皆空才不推，products 经 map 贯穿）**：候选层早退须改为「**新闻 Top N 为空 且 `productsByChannel` 所有 channel 候选均为空**」才 `skipped-no-candidates`；`productsByChannel` 必须在该早退判断**之前**算出，并在推送阶段被复用（不重算）。dispatch 层：单 channel 内 event/product 两 pending 皆空才 skip 该 channel。新闻空+产品非空、新闻非空+产品空 都须正常推（只推非空段）。

**单条日报消息双 target_type 分发**：日报推送须支持一条消息同时含「要闻段」（events，`target_type='event'`）与「新品段」（products，`target_type='product'`），**各自按自己的 target_type 计算待发集合、写 `push_records`、置终态**：复用同一 dispatcher 状态机机制（`computePendingSet` 按 target_type 各算「跨天 per-channel 从未 success」待发 → 各 INSERT `pending` → **一次** sender 发送一条双段消息 → 按发送结果把两套记录各按自己 target_type 置终态）。这是 dispatcher 的能力扩展（首次单次发送跨两个 target_type 命名空间），绝不另写漂移状态机、绝不把产品记入 `event` 命名空间。该分发须满足以下契约：

- **分段 includedIds（防被截断误标）**：渲染须分别回 `eventIncludedIds`（要闻段实际拼进消息的）与 `productIncludedIds`（新品段实际拼进的）。合并消息可能超 `MAX_MESSAGE_LENGTH` 被截断、截断点横跨两个 target_type 命名空间——dispatch 必须只对各段 includedIds 的记录按各自 target_type 置 `success`，被截断未发的（不在 includedIds）**保持 `pending`** 下次重拼，绝不误标 success（防永久漏推）。
- **非空抛错不变量（跨段保持）**：若「两段 pending 并集非空、但两段 includedIds 并集为空」→ **抛错**（沿用既有「非空 pending 渲染 0 条即抛错」防静默漏推），不静默跳过。
- **终态方案 A（两段各自独立事务，event 先固化，product 失败不回滚 event）**：发送成功后**先**在一个事务把 `eventIncludedIds` 置 `success`（消息已送达、优先固化要闻段），**再**在另一事务把 `productIncludedIds` 置 `success`；**product 终态写若抛异常，只记错误/告警、不回滚 event 段**（PG 单事务无法「event 提交 product 回滚」，故拆两事务），残留 product pending 由下次 `computePendingSet` 补发。发送失败 → 两段各自独立事务置 `failed`（或保持 pending）下次重试。承认 event-success/product-pending 中间态为可接受窗口（既有 dispatcher 本就无跨 target_type 原子性）。
- **段级失败隔离**：product 侧任一 DB 操作（computePendingSet/INSERT/终态写）异常绝不令「消息已发送成功」的 event 段被误判/回滚 `failed`；product 侧失败降级空新品段或仅记该段错误（**发送前**异常如 product 的 computePendingSet/INSERT 失败 → `productsPending` 降级为空、只渲染推 event 段）。
- **返回契约**：`dispatchDailyDigest` 返回 `{ pushDate, outcome, eventIncludedIds, productIncludedIds }`；`outcome` 合并规则=两段皆 skip→`skipped`、sender 抛异常→`failed`、否则→`sent`（**含「sender 成功但 product 终态写失败」也判 `sent`**，product 残 pending 次日补、不令该 channel 进 `failedChannels` 触发整 job 重试）。run-daily 的 per-channel 汇总按此 outcome 判 `failedChannels`/`anySent`。
- **表头计数取实发数**：表头「AI Radar 每日情报（要闻 X·新品 Y）」中 X=`eventIncludedIds.length`、Y=`productIncludedIds.length`（实发数，非 pending 应发数）。

**移除独立产品调度**：worker 不再注册独立 `product-digest` 调度链/队列/cron/单例锁；产品推送只经日报链承载（产品段在日报单例锁内，天然防同 push_date 并发双发）。新闻事件的评分/摘要/熔断/时效闸/幂等口径**不变**。

#### 场景:日报顺序子流程含产品塌缩与候选
- **当** 日报触发
- **那么** 在新闻链（塌缩→评分→回填→Top N→摘要）之后、早退判断之前，先调一次 `collapseUncollapsedProductRawItems`（channel-blind），再对每个已配置 channel 调 `selectProductCandidates` 存入 `productsByChannel`，产品候选并入日报消息新品段

#### 场景:产品塌缩一次且在产品候选之前
- **当** 日报子流程执行产品段
- **那么** 产品塌缩在 channel 展开之前**只调一次**（绝不随 per-channel 并发重复执行，避免违反产品塌缩单实例假设产生同批竞态）、且必在所有 channel 候选查询之前，确保 `merge_conflict` 标记对候选可见

#### 场景:一条日报消息双 target_type 各自幂等
- **当** 当日同时存在新闻事件待发与产品待发
- **那么** 渲染一条「要闻+新品」双段消息、一次发送；事件行按 `target_type='event'` 写 `push_records`、产品行按 `target_type='product'` 写，各自独立幂等（失败各自重试、成功各自不重推），不混入对方命名空间

#### 场景:合并消息超长截断时分段 includedIds 不误标
- **当** 要闻段+新品段合并后超 `MAX_MESSAGE_LENGTH`、新品段尾部被截断未发出
- **那么** dispatch 只对 `eventIncludedIds`/`productIncludedIds`（各自实际发出的）按对应 target_type 置 `success`，被截断未发的产品保持 `pending`、下次重拼，绝不误标 success

#### 场景:产品侧终态写 DB 异常不拖垮已发成功的要闻段
- **当** 消息已发送成功，event 段终态已在其独立事务置 `success`，随后产品段**终态写（发送之后）**抛 DB 异常
- **那么** 要闻段保持 `success`（已在前一事务固化、不被产品段事务回滚）；产品侧异常**必发错误日志/告警**（不依赖 failedChannels 兜底），`outcome` 仍为 `sent`，残留 product pending 下次补发

#### 场景:产品段为空仍推新闻段（反之亦然）
- **当** 当日无产品候选但有新闻 Top N（或反之）
- **那么** 日报只渲染非空段并正常推送；仅当新闻 Top N 与 `productsByChannel` 全空时早退 `skipped-no-candidates`

#### 场景:崩溃重试只重发未 success 段
- **当** 一条日报已发出但在写两套终态前进程崩溃，下次同 push_date 重试
- **那么** 重试先对两段各跑 `computePendingSet`，已 `success` 的段被排除、只重发仍未 success 段（崩在写任何 success 前则两段都未 success → 重发整条，唯一键 + 候选窗口兜底不重复记录；at-least-once 与既有 dispatcher 同口径）

#### 场景:产品段失败不进新闻熔断、不拖垮日报
- **当** 产品塌缩或产品候选查询失败
- **那么** 塌缩/候选各自捕获异常、记错误/告警、返回空新品段，新闻段照常评分/摘要/推送；产品失败不计入新闻 judge/digest 降级率熔断分母

#### 场景:发送前产品侧 DB 异常只降级新品段
- **当** 产品段 computePendingSet 或 INSERT pending 在**发送之前**抛 DB 异常
- **那么** `productsPending` 降级为空、**必发错误日志/告警**；若 event 段非空则只渲染推 event 段，若 event 段也空则两段皆空 → `skipped`（不发空消息），均不拖垮要闻段

#### 场景:新闻链熔断 abort 时整条日报含产品段当日不推
- **当** 新闻链 judge 或 digest 降级率超阈触发 `WorkflowAbortError`（LLM 大面积故障）
- **那么** 整条日报 job 终止（产品段位于熔断 throw 之后、不执行），**当日要闻段与新品段都不推、次日 cron 补**（产品幂等不退化：次日候选窗口仍判未 success 重发）；「产品不进熔断分母」指产品不影响熔断触发，非产品免疫 job abort
