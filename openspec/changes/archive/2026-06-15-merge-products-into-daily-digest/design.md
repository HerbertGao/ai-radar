## 上下文

现状两条独立链：`daily-digest`（run-daily-workflow，新闻 event 链：采集→塌缩→评分→回填→Top N→摘要→推送，`target_type='event'`）与 `product-digest`（product-digest.ts，产品链：采集→产品塌缩→候选→推送，`target_type='product'`），各自 cron、各自单例锁、各自 `dispatchDigest` 一次发一条消息。两者均经 `dispatchDigest(topN, {now,sender,channel,targetType}, dbh)` → `computePendingSet`（按 target_type 算「任一 push_date 该 channel 从未 success」待发，dispatcher.ts:148）→ `renderDigest(pending, channel)`（表头硬编码「AI Radar 每日情报」）→ 发送 → 按 target_type 写 `push_records`。

**dispatcher 现状的关键事实（本设计须对齐，否则实现撞车）**：
1. **`renderDigest(pending)` 入单一扁平有序数组、回 `includedIds`（实际拼进消息、未被截断丢弃的子集，保持入参顺序）**；终态 UPDATE 用 `inArray(targetId, includedIds)` 且限定**单一** `(targetType, channel, pushDate)`（dispatcher.ts:172、216-247）。截断者保持 `pending`、下次因仍属待发集合而重拼（跨次发完）。`includedIds.length===0`（非空 pending 却渲染 0 条）**抛错**而非静默 skip（防永久漏推，dispatcher.ts:175-185）。
2. **发送在事务外、终态写在发送后另起事务**（dispatcher.ts:199 发送 / :207 失败置 failed / :230 成功置 success）。即既有 dispatcher 本就是 **at-least-once 外发**：崩在「发后写终态前」→ 残留 pending → 下次重发（唯一键兜底不重复记录）。**既有实现从无跨 target_type 原子性**。
3. **`computePendingSet(topN, _pushDate, dbh, targetType, channel)` 的第二参（push_date）仅用于后续 INSERT pending 四元组，不参与 success 过滤**（dispatcher.ts:92 注释；success 过滤是「任一 push_date 该 channel success 即排除」，与传入 push_date 无关）。
4. **既有「一条消息含 event+product」先例只有 weekly，但它用 `target_type='weekly'`、`target_id=iso_week`、整份一条 `push_record`，`renderDigest` 对 weekly 恒回 `includedIds=[iso_week]`、用 `WeeklySelectedEvent.weeklyItems` 单条降维 + 整份 `truncateByCodePoint` 截断（无「按块累加遇超限即停」的逐条 includedIds 语义）**。本变更要的是日报里**逐条** event/product 各自幂等，与 weekly 的「整份一条」是**不同的幂等模型**。故本变更复用 weekly 的只有**视觉分段排版**；幂等/截断必须采 `buildDigestMessage` 的「按块累加」语义（非 weekly 整份截断），否则丢失「首块恒可装→includedIds≥1」不变量。
5. **产品塌缩 `collapseUncollapsedProductRawItems` 导出于 `src/collectors/product-collapse.ts:277`（不在 product-digest.ts，后者只 import 它）**；其设计文档明言「**产品塌缩由单实例承载、顺序处理避免同批自冲突竞态**」（product-collapse.ts:9-13/270-273）——内部用 `SELECT ... FOR UPDATE` + product_id 升序防死锁，但**假设不被并发调用**。新闻塌缩是另一函数 `collapseUncollapsedRawItems`（查询层已排除 product/paper）。

既有不变量（不可违背）：推送先写 pending → 发 → success/failed，唯一键 `UNIQUE(target_type,target_id,channel,push_date)` 冲突即跳过；产品「跨天一产品一生一次 + 排除 merge_conflict」；事件 per-channel 跨天「从未 success」；去重/幂等/候选由程序+DB，绝不交 LLM；摘要降级熔断只含 event 的 judge/digest 两阶段。

## 目标 / 非目标

**目标**：把产品从独立推送链合并为日报消息内的「新品段」，一条「AI Radar 每日情报」=「要闻 + 新品」；保留产品采集/塌缩/`ai_products`/产品幂等口径；复用 weekly 的视觉分段排版，把 dispatcher 扩展出「单消息双 target_type 各自幂等」能力。
**非目标**：不删产品采集/实体库；不改 weekly/realtime-alerts/新闻评分摘要熔断时效闸；不退化产品幂等；产品段不引入 LLM 摘要；不做 N 段泛化（仅 event+product 两段，paper 等留待后续，见风险「前向脆弱」）。

## 决策

### D1：产品塌缩（一次，channel-blind）+ per-channel 候选并入日报顺序子流程
产品段在日报顺序子流程的新闻链之后、**早退判断之前**执行，拆为**两步**（不把塌缩塞进 per-channel 路径——塌缩单实例、候选才 per-channel）：

- **步骤 P1：产品塌缩一次（channel-blind）** `collapseProductsOnce(dbh)`：包一层 try/catch 调 `collapseUncollapsedProductRawItems`（**从 `src/collectors/product-collapse.ts` import**，它本就在那、无需迁移），任何异常 → 记错误/告警、视为「本次未塌缩」、**绝不向上抛**。**必须在 channel 展开之前只跑一次**——产品塌缩单实例承载（product-collapse.ts:272），若随 per-channel 并发跑 N 次会违反单实例假设产生同批竞态。产品 raw_items 已由日报采集阶段 `collectAndStore`（→`collectAllSources` 全集含 PH/Show HN，run-daily-workflow.ts:270 未限定 sources 子集）覆盖，无需额外产品采集入口。
- **步骤 P2：per-channel 产品候选** 对每个已配置 channel 调 `selectProductCandidates(channel, dbh, env.TOP_N)`，结果存入 `Map<Channel, SelectedEvent[]>`（记 `productsByChannel`），供早退判断与 dispatch 复用（算一次、不重算）。每 channel 候选查询包 try/catch，失败 → 该 channel 空新品段 + 告警，不向上抛。
- **`selectProductCandidates` 已是 product-digest.ts:96 的导出纯函数**，签名 `(channel: Channel, dbh, limit=env.TOP_N)`（**无 now 参数**——跨天去重是「任一 push_date success」与时刻无关）。日报直接 `import` 复用、**无需「抽出」**；移除独立调度后它原地保留导出（可迁至更中性的 `src/selection/`）。
- **链接数据来源（修复链接承诺与代码现实的矛盾）**：现状 `selectProductCandidates` 恒返回 `canonicalUrl: null`（product-digest.ts:139-147，只 SELECT productId/name/lastSeenAt），且 `ai_products` **无 `url` 列**（schema.ts:191-210 仅 canonical_domain/github_repo/product_hunt_slug）。本期**扩展 `selectProductCandidates` 的 SELECT 增 `canonicalDomain`，映射 `canonicalUrl = canonicalDomain ? 'https://' + canonicalDomain : null`**；`canonical_domain` 为 NULL 时 `canonicalUrl=null` → 渲染回退纯产品名（绝不渲染坏链接）。`canonical_domain` 由 product-collapse 写入端规范化为裸域、正常不含 scheme/path；映射时若检出 domain 已含 `://` 或空白等畸形，视为坏链降级纯名（不产生 `https://https://…`）。**WHERE 条件（merge_conflict 排除 + neverSuccessfullyPushed）逐字不变**，仅扩 SELECT 列 + 链接映射。
- **失败隔离=结构契约**：P1（塌缩）/P2（候选）均永不向上抛（异常转空段+告警），「产品失败不拖垮新闻」由这两步**永不抛错**保证，而非散落 try/catch 约定；产品段拿不到新闻熔断累加变量（judge/digest 分母），「不进熔断分母」由作用域天然隔离。

### D2：单消息双 target_type 分发（dispatcher 能力扩展，单 channel 对称签名，方案 A 终态）
- 新增 `dispatchDailyDigest(events, products, { now, sender, channel }, dbh)`——**与新闻侧 `dispatchDigest` 对称的单 channel 签名**（products 由 run-daily 在 per-channel 层从 `productsByChannel.get(channel)` 取并传入，dispatch 内**不循环 channel**，消除「productsForChannelA 误发进 channelB」错配）。对该 channel：
  1. `eventsPending = computePendingSet(events, pushDate, dbh, 'event', channel)`；
  2. `productsPending = computePendingSet(products, pushDate, dbh, 'product', channel)`（复用同一 `computePendingSet`，仅 target_type 不同——产品「跨天一产品一生一次」由 computePendingSet「任一 push_date success 排除」+ 候选查询 merge_conflict 排除共同保证）；
  3. **早退**：`eventsPending` 空 **且** `productsPending` 空 → `outcome:'skipped'`；仅一段空则只渲染/分发非空段；
  4. 两集合**各自** INSERT pending（`ON CONFLICT DO NOTHING`，各自 target_type）；
  5. `renderDailyDigest(eventsPending, productsPending, channel)` 渲染**一条**双段消息，回 `{ text, parseMode, eventIncludedIds, productIncludedIds }`（分段 includedIds，见 D3）；
  6. **非空抛错不变量（跨段保持）**：若「`eventsPending`∪`productsPending` 非空、但 `eventIncludedIds`∪`productIncludedIds` 为空」→ **抛错**（沿用 dispatcher.ts:175-185 防静默漏推）；
  7. **一次** sender 发送；
  8. **终态写（方案 A：两段各自独立事务，event 先固化，product 失败不回滚 event）**——发送成功后：
     - 先在**一个事务**内把 `eventIncludedIds` 行（`target_type='event'`）置 `success`（消息已送达是既成事实，**优先固化要闻段**）；
     - 再在**另一个事务**内把 `productIncludedIds` 行（`target_type='product'`）置 `success`；**product 终态写若抛 DB 异常 → 仅记错误/告警、不回滚 event 段**（event 已 success），残留的 product pending 由**下次日报运行**的 `computePendingSet` 补发（此时 outcome 仍为 `sent`、本 job 不因此重试，见 step10）。
     - **event 终态事务自身抛错**（消息已发、event 段写 success 失败）→ **不 swallow、抛错向上传播出 `dispatchDailyDigest`**（同既有 `dispatchDigest` 终态写不 catch 的口径）→ run-daily 的 `Promise.allSettled` 置该 channel 入 `failedChannels` → 整 job 重试；重试时 computePendingSet 排除已 success、event 残 pending 段按 at-least-once 重发（唯一键不重复记录）。**与 product 终态失败的非对称是有意的**：event 是优先段、写失败应触发重试；product 是 best-effort、写失败 swallow 返回 `sent`（不拖累已发的 event）。
     - 发送失败（sender 抛异常）→ 两段都未发成功，各自独立事务把对应 included 子集置 `failed`（或保持 pending），下次重试。
     - **为何不用「同一事务双终态」**：PG/drizzle 事务内任一 UPDATE 抛错即整事务 rollback——同一事务做不到「event 提交、product 回滚」，会与「product 失败不拖垮已发成功的 event 段」矛盾。故拆两事务，承认 event-success/product-pending 中间态（既有 dispatcher 本就无跨 target_type 原子性，见上下文 2）。被截断未发的（不在 included）始终保持 pending。
  9. **段级失败隔离（dispatch 内全程）**：product 侧任一 DB 操作（computePendingSet/INSERT pending/终态写）异常**绝不**令「消息已发送成功」的 event 段被误判/回滚——product 侧降级为空新品段或仅记该段错误。
  10. **返回独立新接口** `DailyDispatchResult { pushDate, outcome, eventIncludedIds, productIncludedIds }`（**不复用既有 `DispatchResult`**——其 `pending`/`eventIds` 字段不适用双段；run-daily 的 per-channel 汇总仅依赖 `outcome`、不读 `pending`/`eventIds`）。`outcome` 合并规则：两段皆 skip→`'skipped'`；**sender 抛异常→`'failed'`**；否则（sender 成功）→`'sent'`——**含「sender 成功但 product 终态写失败」也判 `'sent'`**（消息已送达是既成事实，不令该 channel 进 failedChannels 触发整 job 重试 + 告警噪音；product 残 pending 由下次日报运行补发）。run-daily 的 per-channel 汇总（run-daily-workflow.ts:517-523 `failedChannels`/`anySent`）按此 `outcome` 判定（`'failed'`→push 进 failedChannels；`'sent'`→anySent=true）。
- **product 段沿用 event 既有 per-channel 并发模型、无新增并发面**：两段的 pending INSERT 与终态写均限定四元组 `(target_type, target_id, channel, push_date)`，product 段与 event 段在同 channel 内串行、跨 channel 由 run-daily-workflow.ts:509 `Promise.allSettled` 并发（既有验证过的 telegram+feishu 并发路径）；product 段只是复用该并发面、隔离边界=channel 维度，**无需额外加锁**。
- **为何是「能力扩展」而非「复用核心不动 dispatcher」**：D2 新增 `dispatchDailyDigest`、首次让一次发送横跨 `event`+`product` 两命名空间——是对 dispatcher 的扩展。复用的是「待发→pending→原子送达→success/failed + includedIds 截断顺延」机制语义，禁止为产品另写漂移状态机。

### D3：日报消息双段渲染（借 weekly 视觉排版，截断采 buildDigestMessage 按块语义）
- `message.ts` 增 `renderDailyDigest(events, products, channel)`：**新增双数组渲染契约**（不复用 weekly 的 `WeeklySelectedEvent` 单条 `weeklyItems` 结构；weekly 的 `renderSection`/`pushSection` 是 `buildWeeklyTelegramMessage`/`buildWeeklyFeishuCard` 内部闭包、不可直接 import——按 weekly 实现模式新增 daily helper，必要时把 section 渲染抽成共享函数）。
- **截断语义采 `buildDigestMessage` 的「按块累加遇超限即停」（非 weekly 整份 `truncateByCodePoint`）**：要闻段在前、新品段顺延，共享 `MAX_MESSAGE_LENGTH` 预算；events 段沿用既有单块有界（`TITLE_MAX`/`HEADLINE_MAX`/`MAX_URL_LENGTH`，message.ts）保证「首块恒可装→`eventIncludedIds`≥1」不变量延续。
- 分「要闻」段（events：序号 + 标题 + 要点 headline_zh→summary_zh + 原文）与「新品」段（products：序号 + 产品名 + 官网链接 `canonicalUrl`；`canonicalUrl` 为 null → 仅产品名；产品无 headline/summary → 不渲染要点行；**零 LLM**）。Telegram（MarkdownV2）+ 飞书（JSON 卡片，由 `rendered.text` 承载 card JSON，沿用既有 FeishuSender）各自分两段。
- **分段 includedIds（核心，对齐 dispatcher 截断语义）**：渲染分别回 `eventIncludedIds`/`productIncludedIds`——合并消息超 `MAX_MESSAGE_LENGTH` 截断时截断点横跨两 target_type 命名空间，必须分段回 included 才能让 dispatch 只对「真发出的」按各自 target_type 置 success（否则被截断未发的产品误标 success → 永久漏推）。
- **已知偏置（记限制不静默）**：要闻段在前 → 新品段几乎总是被截断的那段。缓解：产品候选 `limit=TOP_N`（默认 8）× 仅「产品名+链接」短行，长度可控、正常远低于上限；持续触发再加「新品段配额」或分批多消息（本期 YAGNI 不做，只记限制）。
- **表头计数（取实发数、分列）**：「AI Radar 每日情报（要闻 X·新品 Y）」，X=`eventIncludedIds.length`、Y=`productIncludedIds.length`（**实发数**，非 pending 应发数）。
- **产品段零 LLM**：产品段=产品名 + 链接（无则纯名），**本期不引入任何产品 LLM 调用**（`ai_products` 无简述/定位列，不去找）。

### D4：移除独立 product-digest 调度（保留 selectProductCandidates 导出）
- **移除点精确定位**：① `worker-main.ts:72-79` 删「链 2 product-digest」lane 注册 + 对应 import（`createProductDigestQueue`/`scheduleProductDigest`/`createProductDigestWorker`），文件头注释「四条调度链」→「三条」；② `product-digest.ts` 删独立调度零件：`createProductDigestQueue`/`scheduleProductDigest`/`createProductDigestWorker`/`runProductDigest`/`PRODUCT_DIGEST_QUEUE`/`PRODUCT_DIGEST_JOB`/`PRODUCT_CRON_JOB_ID`/独立单例锁（`productLockKey`/`acquireProductDigestLock`/`ProductLockRedis`）。**保留导出 `selectProductCandidates`**（供日报 import）。
- **`collapseUncollapsedProductRawItems` 本就在 `src/collectors/product-collapse.ts`、不在 product-digest.ts**——日报直接从 product-collapse.ts import，无需迁移、不受 product-digest.ts 删减影响。
- **`queue.ts` 无任何 product 引用**（product 队列/cron 全在 product-digest.ts）——**不在 queue.ts 改动**。
- **`dispatchDigest`（新闻侧旧入口）保留**：run-daily 推送从 `dispatchDigest` 切到 `dispatchDailyDigest` 后，`dispatchDigest` 仍被 `alert-scan.ts:367`、`weekly-report.ts:578` 使用（product-digest.ts:390 的调用随其删除）——故 `dispatchDigest` **保留、非死代码**，不删。
- **无 `PRODUCT_DIGEST_CRON` env 可删**（全仓不存在；product-digest 独立链复用 `DAILY_DIGEST_CRON`/`DAILY_DIGEST_CRON_TZ`，product-digest.ts:449）。移除独立链后 `DAILY_DIGEST_CRON` **仅日报用、保留**。**严禁删 `DAILY_DIGEST_CRON`**（删它停掉整个日报调度）。env.ts/.env/.env.example **无产品调度 env 需清理**。

### D5：产品段在日报锁内的幂等与跨天口径（锁收紧的诚实权衡）
- 产品段（P1 塌缩 + P2 候选 + dispatch 产品侧）在日报 `acquireDigestLock(pushDate)` 单例内执行（lock.ts:84 锁键 `daily-digest:{push_date}`，**push_date 全局、不分 channel**），天然防同 push_date 并发双发。
- **锁模型变更=收紧而非等价（诚实陈述代价）**：原产品锁 `product-digest:{channel}:{push_date}`（**per-channel**，product-digest.ts:193），日报锁 **push_date 全局**。防双发更强（全 push_date 单例 ⊃ per-channel），代价：① 产品段绑进日报锁全生命周期（日报锁 TTL/看门狗按含 LLM 长任务的新闻链设计，产品段无 LLM、置于新闻链之后、增量小、不致失锁，run-daily-workflow.ts:484 dispatch 前 `isHeld()` 兜底）；② **产品推送失去独立重试性**——原产品链是独立 BullMQ job 可单独重跑，现产品失败搭**下次日报运行**补发，分两种：sender 失败 → 整 job 标 failed、BullMQ **本 job 重试**；product 终态写失败（sender 已成功，outcome=`sent`）→ 本 job **不重试**、product 残 pending 由**次日 cron（或同日另一次日报运行）**补发（与 D2-8/step10 自洽）。可接受但须显式记录、非称「天然等价」。
- **跨天「一产品一生一次」按 channel 分判**：由 `computePendingSet`（任一 push_date 该 channel success 排除）+ 候选查询 `neverSuccessfullyPushed`（NOT EXISTS success on channel）+ merge_conflict 排除三层保证，与原 product-digest 等价、不退化。**channel 维度关键**：同一产品可分别进 telegram/feishu 候选（各 channel 独立判「从未 success」），实现勿漏 channel 维度（P2 已是 per-channel 调用）。

### D6：早退条件 + products 变量流（候选层 + dispatch 层，修复「新闻空吞掉产品段」）
- **变量流**：日报顺序子流程在新闻链之后、早退判断之前依次：P1 产品塌缩一次（channel-blind）→ P2 对所有已配置 channel 各跑 `selectProductCandidates` 存 `productsByChannel: Map<Channel, SelectedEvent[]>`。该 map **算一次、贯穿早退判断与 dispatch**（dispatch 不重算）；**「算一次」限单次 job run 内**——BullMQ 重试是新 run、重新算 map（已 success 产品由候选窗口排除），不跨 job 缓存。
- **候选层早退（run-daily-workflow.ts:463）**：现状 `if (pushable.length===0) return 'skipped-no-candidates'`（pushable=新闻 Top N）。**改为** `if (pushable.length===0 && [...productsByChannel.values()].every(p => p.length===0)) return 'skipped-no-candidates'`。
- **dispatch 层（D2 step3）**：`dispatchDailyDigest` 内 `eventsPending` 空且 `productsPending` 空才 skip 该 channel；仅一段空则推非空段。
- **dispatch 复用 map**：run-daily-workflow.ts:509 per-channel 分发改 `dispatchDailyDigest(pushable, productsByChannel.get(channel) ?? [], { now, sender, channel }, dbh)`。
- 二者叠加保证 spec 场景「新闻空+产品非空仍推、产品空+新闻非空仍推、两段皆空才不推」。

## 风险 / 权衡

- **[截断跨双 target_type 撕裂原子性]（本变更最大新增风险）** → 合并消息超 `MAX_MESSAGE_LENGTH` 截断时截断点横跨两命名空间。缓解（D3）：渲染回**分段 includedIds**，dispatch 各按自己 included 子集置终态，被截断未发者保持 pending 跨次发完；截断采 buildDigestMessage 按块语义保「首块恒可装」。**已知偏置**：要闻段在前 → 新品段几乎总被顺延（产品候选短、长度可控，正常不触发；记限制）。
- **[终态非原子（方案 A）+ 崩溃重试口径]** → 终态写为**两段各自独立事务**（event 先固化 success、product 后写、product 失败不回滚 event），故存在 **event-success/product-pending 中间态**（可接受的已知窗口；既有单 target_type dispatcher 本就无跨 target_type 原子性）。**崩溃重试口径（at-least-once）**：崩在「发后写终态前」→ 残留 pending → 下次重试时**先对两段各跑 computePendingSet**，已 `success` 的段被排除、只重发**仍未 success 的段**（崩在写任何 success 前时两段都未 success → 重发整条，但唯一键 + 候选窗口兜底不重复记录）。这与既有 dispatcher at-least-once 同口径、非本变更新增数据风险。
- **[产品段拖累日报时延]** → P1 塌缩一次 + P2 per-channel 候选都是确定性 DB 操作（无 LLM），开销小；置于新闻链之后，不影响新闻评分/摘要。可接受。
- **[锁收紧 per-channel→global]** → 见 D5：产品段失去独立重试性、搭日报 job 重试。可接受，已记代价。
- **[新闻熔断 abort 连带产品段当日不推]** → 产品段（P1 塌缩 + P2 候选 + 推送）位于 judge 熔断（run-daily-workflow.ts:326）/ digest 熔断（:459）的 `throw WorkflowAbortError` **之后**。新闻链 judge/digest 降级率超阈触发熔断时整 job throw、产品段不执行 → **当日整条日报（含新品段）不推、次日 cron 补**（产品幂等不退化：次日 computePendingSet 仍判未 success 重发）。这是产品「搭日报 job 便车」的必然后果（熔断日 = LLM 大面积故障，整条日报静默是合理的，改产品段位置无法绕过 job abort，除非给产品独立推送路径——那违背合并目标）。**澄清「产品段独立旁挂/不进熔断分母」的语义**：指产品**不影响熔断触发**（产品不计入 judge/digest 降级率分母），**非**产品免疫 job abort 后果。诚实记录、非新增数据风险。
- **[前向脆弱：双段写死 2 段 2 类型]（已知设计债）** → `dispatchDailyDigest(events, products)` 把「2 段」焊进签名，破坏原 dispatcher「加 target_type 不改本文件」泛化意图。本期 YAGNI（非目标不引入 paper 推送）。**记为有意的、有边界的设计债**：未来若需 N 段（paper、产品定位），重构波及**四处**——`dispatchDailyDigest` 签名、返回的 `eventIncludedIds`/`productIncludedIds` 具名字段（应改 `Record<TargetType, string[]>`）、run-daily 汇总读取、表头计数公式（「要闻 X·新品 Y」固定两位）——届时重构为 `dispatchMultiSegmentDigest(segments: {targetType, items}[])`。

## 待解决问题

- 无阻塞性待解决项（链接来源、塌缩归属与次数、终态事务方案、早退变量流、返回契约、表头计数、product-digest.ts 去留、一句定位均已在 D1–D6 钉死）。
- 上线后据观感可微调：表头是否再加合计数（当前定「要闻 X·新品 Y」实发数）；新品段是否需要配额防系统性顺延（当前 YAGNI，实测触发再加）。

## 迁移计划

含代码、无 schema 迁移：
1. `product-digest.ts`：扩 `selectProductCandidates` SELECT 增 `canonicalDomain` + 映射 `canonicalUrl`（WHERE 不变）；保留该导出；删独立调度零件（队列/worker/cron/锁/runProductDigest）。
2. 新增产品段两步：`collapseProductsOnce(dbh)`（永不抛错包 `collapseUncollapsedProductRawItems`，import 自 `src/collectors/product-collapse.ts`，channel-blind 跑一次）+ per-channel `selectProductCandidates` 存 `productsByChannel`（候选包 try/catch）。
3. `message.ts` 增 `renderDailyDigest(events, products, channel)`（双数组契约，回分段 includedIds，借 weekly 视觉排版 + buildDigestMessage 按块截断语义）。
4. `dispatcher.ts` 增 `dispatchDailyDigest`（单 channel 对称签名 + 双 computePendingSet + 两段早退 + 单渲染 + 单发 + 方案 A 两段独立事务终态 + 段级失败隔离 + 返回 `{pushDate,outcome,eventIncludedIds,productIncludedIds}`）。
5. `run-daily-workflow.ts`：新闻链后 P1 塌缩一次 + P2 per-channel 候选存 map；早退条件改「pushable 空且 map 全空」；推送改 `dispatchDailyDigest(pushable, productsByChannel.get(channel), ...)`；:517-523 汇总按新 outcome 读。
6. `worker-main.ts`：删链 2 product-digest 注册 + import；注释「四条→三条」。
7. 测试：日报含产品段（双段渲染/分段 includedIds 截断/双 target_type 幂等/产品跨天一次/merge_conflict 排除/某段空/产品段抛异常不拖垮新闻+不进熔断分母/链接缺失降级纯名/event 段先 success 且 product 终态失败不回滚 event）；塌缩**只跑一次**断言；**Show HN 采集→塌缩→入 ai_products 端到端覆盖须迁移保留**（不随删 `runProductDigest` 丢失）；移除/改 product-digest 既有测试；既有日报测试加产品桩。**所有推送测试钉 channels + 注入 sender mock（防误发生产飞书）**。
8. 远端部署（同 tier1：本地 build→save→load + `compose up -d`；**无 .env 清理步**）；验证 worker 调度链数减一、日报含新品段。
9. /opsx:sync + /opsx:archive。

**回滚（诚实版）**：本变更删除整套 product-digest 独立调度代码（队列/worker/cron/锁/runProductDigest），故回滚是 **`git revert` 本 PR**（恢复整套独立调度代码 + 还原 run-daily/dispatcher/message），非「恢复注册一行」。产品 push_records 口径不变、无数据迁移、可逆。
