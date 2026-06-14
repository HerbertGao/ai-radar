## 1. 前提复验（实现前钉死，已由提案 review 强对账确认，实现者复核）

- [x] 1.1 复验 `src/pipeline/product-digest.ts`：`selectProductCandidates`（**已是 line 96 的导出纯函数**，签名 `(channel, dbh, limit=env.TOP_N)`、**无 now**、当前返回 `canonicalUrl/headlineZh/summaryZh` 全 null）、独立调度零件（队列 `PRODUCT_DIGEST_QUEUE`/job `PRODUCT_DIGEST_JOB`/cron job key/独立锁 `productLockKey`/`runProductDigest`）；**`collapseUncollapsedProductRawItems` 不在本文件**——它 export 自 `src/collectors/product-collapse.ts:277`（product-digest.ts:46 仅 import），且其文档明言「产品塌缩单实例承载、顺序处理避免同批竞态」
- [x] 1.2 复验 `src/push/dispatcher.ts`：`computePendingSet(topN, _pushDate, dbh, targetType, channel)`（**第二参 push_date 仅用于 INSERT pending 四元组、不参与 success 过滤**，dispatcher.ts:92；success 过滤是「任一 push_date 该 channel success 排除」）、`dispatchDigest` 的 pending→render→send→写终态、**`renderDigest` 回 `includedIds`（截断子集）、`includedIds.length===0` 抛错防漏推、发送在事务外/终态写在发送后另起事务（:199/:230）、终态 UPDATE 用 `inArray(targetId, includedIds)` 限单 (targetType,channel,pushDate)**、`DispatchResult.outcome`/`eventIds`
- [x] 1.3 复验 `src/push/message.ts`：`buildDigestMessage`（表头 `events.length`、**按块累加遇超限即停**产 includedIds）、**weekly 双段是 `buildWeeklyTelegramMessage`/`buildWeeklyFeishuCard` 内部闭包 `renderSection`/`pushSection`（不可直接 import）+ `WeeklySelectedEvent.weeklyItems` 单条降维 + 整份 `truncateByCodePoint` 截断（无逐条 includedIds）**、长度上限/转义常量
- [x] 1.4 复验 `src/pipeline/run-daily-workflow.ts`：早退 `if (pushable.length===0) return 'skipped-no-candidates'`(:463)、`Promise.allSettled` per-channel 分发(:509，**并发**)、`:517-523` 汇总 `failedChannels`/`anySent`/`dispatch.outcome`、`acquireDigestLock(push_date)` 范围(:246/484)；`src/pipeline/worker-main.ts:72-79` 链 2 product-digest 注册点；`src/db/schema.ts` ai_products 列（**有 canonical_domain，无 url 列**）；**全仓确认 `PRODUCT_DIGEST_CRON` 不存在**（product 复用 `DAILY_DIGEST_CRON`）

## 2. 产品候选复用 + 链接映射 + 塌缩一次

- [x] 2.1 `product-digest.ts` 扩 `selectProductCandidates` 的 SELECT 增 `canonicalDomain`，映射 `canonicalUrl = canonicalDomain ? 'https://' + canonicalDomain : null`（**WHERE 条件逐字不变**：merge_conflict 排除 + neverSuccessfullyPushed 跨天 per-channel）；保留其导出（供日报 `import`，可迁至 `src/selection/`）
- [x] 2.2 产品段实现为**两步、不打包成含 collapse 的 per-channel 函数**：① `collapseProductsOnce(dbh)`——包 try/catch 调 `collapseUncollapsedProductRawItems`（**import 自 `src/collectors/product-collapse.ts`**），永不抛错；在 channel 展开**之前只调一次**（channel-blind，防并发违反单实例假设）；② per-channel 调 `selectProductCandidates(channel, dbh)`（各包 try/catch 失败降级空段），结果存 `Map<Channel, SelectedEvent[]>`

## 3. 日报双段渲染（message.ts，新增双数组契约）

- [x] 3.1 `src/push/message.ts` 增 `renderDailyDigest(events, products, channel)`：表头「AI Radar 每日情报（要闻 X·新品 Y）」（X=`eventIncludedIds.length`、Y=`productIncludedIds.length`，**实发数**）；分「要闻」段（events：序号+标题+要点 headline_zh→summary_zh+原文）与「新品」段（products：序号+产品名+官网链接 `canonicalUrl`；`canonicalUrl` 为 null → 仅产品名；产品无 headline/summary → 不渲染要点行；**零 LLM**，不去找 ai_products 简述列）。借 weekly 视觉分段排版（必要时把 section 渲染抽成共享函数，**不复用 `WeeklySelectedEvent` 单条结构**）；**截断采 `buildDigestMessage` 的「按块累加遇超限即停」语义（非 weekly 整份 truncateByCodePoint）**，events 段沿用单块有界保证「首块恒可装→eventIncludedIds≥1」。telegram（MarkdownV2）+ 飞书（JSON 卡片，由 text 承载 card JSON）各分两段。**返回 `{ text, parseMode, eventIncludedIds, productIncludedIds }`**；截断顺序=要闻段优先、新品段顺延（顺延者不进 includedIds）；某段空只渲染非空段

## 4. 单消息双 target_type 分发（dispatcher.ts，能力扩展）

- [x] 4.1 `src/push/dispatcher.ts` 增 `dispatchDailyDigest(events, products, { now, sender, channel }, dbh)`（**单 channel 对称签名**；channel 维度在 run-daily per-channel 层引入，dispatch 内不循环 channel）：① `eventsPending=computePendingSet(events,pushDate,dbh,'event',channel)`、`productsPending=computePendingSet(products,pushDate,dbh,'product',channel)`；② 两 pending 皆空 → `skipped`，仅一段空只处理非空段；③ 两集合各 INSERT pending（各自 target_type，ON CONFLICT DO NOTHING）；④ `renderDailyDigest(...)` 取 `{text, parseMode, eventIncludedIds, productIncludedIds}`；⑤ **非空抛错不变量**：两段 pending 并集非空但两段 includedIds 并集空 → 抛错；⑥ 一次 sender 发送；⑦ **终态方案 A（两段各自独立事务）**：成功 → **先**一个事务把 eventIncludedIds 置 `success`（要闻段优先固化）→ **再**另一事务把 productIncludedIds 置 `success`；**product 事务失败只记错告警、不回滚 event 段**；失败（sender 抛）→ 各自独立事务置 `failed`；被截断未发的保持 pending；⑧ **段级失败隔离**：product 侧任一 DB 异常绝不令已发成功的 event 段被误判/回滚 failed；⑨ **返回独立新接口** `DailyDispatchResult { pushDate, outcome, eventIncludedIds, productIncludedIds }`（**不复用 `DispatchResult`**——其 `pending`/`eventIds` 不适用双段；run-daily 汇总仅读 `outcome`、不读 `pending`/`eventIds`），outcome=两段皆 skip→skipped / sender 失败→failed / 否则→sent

## 5. 日报插产品段 + 改早退 + 改推送（run-daily-workflow.ts）

- [x] 5.1 在新闻链之后、**早退判断之前**：调一次 `collapseProductsOnce(dbh)`（channel-blind）→ 对每个已配置 channel 调 `selectProductCandidates(channel, dbh)` 存 `productsByChannel: Map<Channel, SelectedEvent[]>`（算一次、贯穿早退与 dispatch）
- [x] 5.2 早退条件(:463) 改为 `if (pushable.length===0 && [...productsByChannel.values()].every(p => p.length===0)) return 'skipped-no-candidates'`
- [x] 5.3 推送阶段(:509) 把 `dispatchDigest(pushable, ...)` 改为 `dispatchDailyDigest(pushable, productsByChannel.get(channel) ?? [], { now, sender, channel }, dbh)`（每 channel 并发、复用 map 不重算）；:517-523 汇总按 `dispatchDailyDigest` 返回的 `outcome` 判 `failedChannels`/`anySent`

## 6. 移除独立 product-digest 调度（保留 selectProductCandidates 导出）

- [x] 6.1 `src/pipeline/worker-main.ts:72-79`：删链 2 product-digest lane 注册 + 对应 import（`createProductDigestQueue`/`scheduleProductDigest`/`createProductDigestWorker`）；文件头注释「四条调度链」→「三条」
- [x] 6.2 `src/pipeline/product-digest.ts`：删独立调度零件（`createProductDigestQueue`/`scheduleProductDigest`/`createProductDigestWorker`/`runProductDigest`/`PRODUCT_DIGEST_QUEUE`/`PRODUCT_DIGEST_JOB`/cron job key/独立锁 `productLockKey`/`acquireProductDigestLock`/`ProductLockRedis`）；**保留** `selectProductCandidates`（已迁/已留导出）。**`collapseUncollapsedProductRawItems` 在 `src/collectors/product-collapse.ts`、不受本文件删减影响**（日报直接从 product-collapse.ts import）。**`queue.ts` 不改；无 `PRODUCT_DIGEST_CRON` env 可删（`DAILY_DIGEST_CRON` 保留给日报，严禁删）**

## 7. 测试（不触网/不连真库，注入桩；钉 channels 防误发生产飞书）

- [x] 7.1 `message.ts` `renderDailyDigest` 单测：要闻+新品两段都在、产品行带链接、`canonicalUrl=null` 降级纯名、产品无要点行、某段空只渲染非空段、两段皆空、表头计数取实发数、**截断时分段 includedIds 正确（被截断产品不进 productIncludedIds）、按块累加语义（非整份截断）、首块恒可装 eventIncludedIds≥1**、长度上限/转义（telegram + feishu）、**产品段单块恒可装（`name`/`canonical_domain` 均 varchar(255) 有界 + 产品名套 TITLE_MAX 截断 + 链接超长丢链接兜底）→ 要闻段空时 productIncludedIds≥1（产品段首块亦恒可装、不触发非空抛错卡死）**
- [x] 7.2 `dispatcher.ts` `dispatchDailyDigest` 单测：event 行写 `target_type='event'`/product 行写 `target_type='product'`（不混命名空间）、各自 computePendingSet 跨天去重（按 channel）、**方案 A：event 段先在其事务 success；product 终态写失败时 event 段仍 success 不回滚（注入 product UPDATE 抛错桩）、product 残 pending、且返回 `outcome='sent'`（不进 failedChannels）；发送前 product computePendingSet/INSERT 抛错桩 → productsPending 降级空、只推 event 段；被截断未发保持 pending 不误标 success、非空抛错不变量、两段皆空不发、outcome 合并规则；product 终态写失败时**必发错误日志/告警**（与 outcome=sent 并存，可观测性断言）；**event 终态事务失败时抛错传播（不 swallow）→ 该 channel 进 failedChannels 触发整 job 重试（与 product 终态失败 swallow→sent 非对称）**；空 event + 发送前 product 失败 → 两段空 → skip 不发空消息**；产品跨天「一产品一生一次」+ merge_conflict 排除
- [x] 7.3 `run-daily-workflow` 集成/单测：日报含产品段（注入 `collapseProductsOnce` + per-channel `selectProductCandidates` 桩）、**塌缩只调一次（多 channel 下断言 collapse 调用次数=1）**、产品段抛异常→空新品段、新闻段照推、不进熔断分母、早退「两段皆空」（新闻空+产品非空 / 新闻非空+产品空 各正常推单段、两段皆空才 skip）、汇总按 outcome
- [x] 7.4 既有 product-digest 测试：删除独立调度/锁/队列相关测试；`selectProductCandidates` 改纯查询测试（含 canonicalUrl 映射、canonical_domain 为 null/畸形降级纯名）；**`show-hn-product-digest.integration.test.ts` 的「Show HN 采集→塌缩→入 ai_products」端到端断言须迁移保留**（链路仍存活、不随删 `runProductDigest` 丢失）——**迁移落点钉死**：① **改用 `collectAndStore` 的 per-source 选项对象 stub**（既有 `runProductDigest` 驱动随其删除而迁移，**per-source 选项口径不变**；`collectAndStore({ productHunt: { fetchGraphql }, showHn: { fetchJson, ... }, dbh })`——`collectAndStore` 入参是 `CollectAllOptions & { dbh }`、**无 `channels` 字段**，勿加 `channels`；per-source 选项在顶层因 `CollectAllOptions extends PerSourceOptions`，经 buildRegistry 透传、驱动**真实** `collectShowHn`/`collectProductHunt` + stub fetch，保留 `raw_items.source='show_hn'`/github_repo 抑制 canonical_domain 等真实 collector 行为覆盖）断言 Show HN 入 `raw_items`；② 调 `collapseUncollapsedProductRawItems(dbh)` 断言塌缩入 `ai_products`；不沿用已删的 `runProductDigest` 驱动（**勿**改成 `collectors:{}` 函数注入——那会绕过真实 collector、削弱端到端覆盖）；既有日报测试同步（推送改 dispatchDailyDigest、加产品桩、钉 channels + 注入 sender mock）

## 8. 自验

- [x] 8.1 `npm run lint`（pre-commit 钩子亦会跑）0 错；`npx tsc --noEmit` 0 错（确认删除的 product-digest 符号无残留引用）；`npx vitest run` 全绿（集成测试本地 PG 可连即跑、否则 skip，结果说明）— **结果：tsc exit 0 / eslint 0 错 / vitest 41 files·500 tests passed · 7 skipped · 0 failed（本地 PG+Redis 在线，集成测试实跑）**

## 9. 远端 ts.mac-mini 部署

- [x] 9.1 本地 `docker build` → `docker save | ssh ts.mac-mini docker load`（GHCR 受阻，部署 memory）→ 远端 `docker compose --profile app up -d --force-recreate`（**无 .env 清理步**——无独立产品调度 env；`DAILY_DIGEST_CRON` 保留）
- [x] 9.2 验证：`docker compose logs --since 90s worker` 确认**调度链数减一**（不再有 product-digest）；下次日报 cron 后确认推**一条**「AI Radar 每日情报（要闻 X·新品 Y）」含两段、不再有独立产品消息；push_records **有候选日**仍有 `target_type='product'` 行（**无候选日则断言「无新增 product 行 + 日报正常推要闻段」**，验收脚本容忍空）

## 10. 提交与规范归档

- [x] 10.1 提交代码（`.env` 不入库；本次无 `.env.example` 改动——无产品调度 env）；含 src 实现 → **走 PR**
- [x] 10.2 PR 合并后：`/opsx:sync` 将增量规范并入 `daily-intel-pipeline` + `product-discovery` 主规范（确认覆盖原 product-discovery「独立 BullMQ 调度任务」表述）
- [x] 10.3 PR 合并后：`/opsx:archive` 归档本变更（纯文档直推 main）
