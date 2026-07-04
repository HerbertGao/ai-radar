## 1. 数据模型与 schema

- [x] 1.1 `src/db/schema.ts` 加 `mrPriceReview` 表（`id`/`plan_id`/`old_value`/`candidate_value`/`currency`/`source_url`/`source_confidence`/`token`(UNIQUE)/`status`/`extracted_at`/`decided_at`/`decided_by`/`created_at`）+ `(plan_id) WHERE status='pending'` 偏唯一索引；`status ∈ {pending,approved,superseded,apply_failed}`（不含 rejected）
- [x] 1.2 生成前向 Drizzle 迁移（forward-only），本地 `drizzle-kit` 校验建表 + 偏索引成立
- [x] 1.3 `src/db/mr-schema.zod.ts` 加 `mr_price_review` 有限值列校验（`status`/`currency`/`source_confidence`）；`openReview`/`supersede` 写行前过 Zod（CAS 只改常量 status 可免）

## 2. 检测层 blocked-page 修复（model-radar-ingestion 修改需求）

- [x] 2.1 `src/mr/scrape/` 抽取/指纹链加 `blockedMarkers`（登录/验证码/滑块/人机/403/forbidden/robot）识别；命中 → **不更新 `content_fingerprint`** + **必须给 `target_type='source'` 打标**
- [x] 2.2 单测：200 登录墙页 → 指纹不变 + 打标、不误报「变了」；下轮真内容 → 正常比对

## 3. 候选抽取器 + gate（src/mr/curation/extract.ts）

- [x] 3.1 `extract.ts`：**复用 scrape 的价区归一函数**（不复制），per-source 锚定窗 + 币种/单位/边界/块数/promo 判别，产出 `{value,currency}` 判别联合（歧义/大跳/promo/登录墙/多金额 → 无候选）；多 plan 源一律 escalate（一键仅单价源）
- [x] 3.2 `gate()` 纯函数：预填须同时满足 官方源 `source_confidence∈{official_pricing,official_doc}`（由 source 注册表派生、非页面）+ 现价非 NULL + 同币种 + `0<|Δ|/current≤20%`；否则 escalate（NULL→FIRST_READ / 非官方 / pct>20% / 币种变 / 折扣形态）
- [x] 3.3 `gate()` assert 自检覆盖分支（官方小改带值 / pct>20% 无值 / ¥40→¥4 无值 / NULL 现价 FIRST_READ / 非官方源无值 / 币种变无值 / current=0 不除零抛错）

## 4. 待批记录 store（src/mr/curation/price-review-store.ts）

- [x] 4.1 `openReviewOrSupersede()`：单事务锁既有 pending → **未过期且同候选** no-op / **不同候选或已过期（`extracted_at≤now()-TTL`）** 置旧 `superseded` + 插新 pending（**不用裸 ON CONFLICT DO NOTHING 当唯一机制**，偏索引仅并发兜底）；token 由 `node:crypto` `randomBytes(16)`（真 128-bit）；`extracted_at` 由 DB `now()`
- [x] 4.2 `claimReview()` CAS：`WHERE token=? AND status='pending' AND extracted_at>now()-make_interval(hours=>$ttl) RETURNING id`（校验过的正整数 ttl，非字面拼接）冻结值；`markSuperseded(id)` / `markApplyFailed(id)`（独立事务、`WHERE id=? AND status='pending'`）
- [x] 4.3 单测：未过期同候选→no-op、不同候选→supersede 旧+插新（旧 token 此后 CAS no-op）；**过期同候选→supersede+重发（防卡死）**；过期令牌 claim CAS 0 行

## 5. 批准核心（src/mr/curation/approve.ts）

- [x] 5.1 `applyReview(token, decidedBy)` 主事务：CAS 认领(RETURNING `id`) → 锁 plan 校验 `current_price/currency == 冻结 old_value/currency`（不等→抛出）→ `_recordPriceChangeTx`（传冻结候选/provenance）→ **按真实 outcome 判定**：成功唯一可达 = `appended`；`history-conflict`/任何非 `appended` →抛出。成功路径**不触碰 `mr_review_flag`、不刷 child `last_checked`**（价格 freshness 由 recordPriceChange 已刷的 `mr_plans.last_checked` 覆盖；**不得用 markChecked**——它会塌缩整页 flag + 假刷未复核 child 陈旧）
- [x] 5.2 成功提交后：`applyReview` **best-effort 触发 `publishSnapshotInvalidation`**（抛错记日志、不使批准转失败，仿 public wrapper 非致命）。失败处理：主事务抛出→回滚→**独立事务** `WHERE id=? AND status='pending'` 置 `apply_failed`（基线漂移对称置 `superseded`）；0 行不动+记日志；flag 不 resolve。过期/已决/superseded 点按 → `answerCallbackQuery` 反馈
- [x] 5.3 集成测：双击/重投→只落库一次、`mr_price_history` 只追加一条；基线漂移(现价≠冻结old)→不写+superseded；`recordPriceChange` 返回 history-conflict→apply_failed+flag 未 resolve；`recordPriceChange` 抛错→apply_failed；成功→快照失效被触发；并发 supersede 与 apply_failed 按 id 不误标
- [x] 5.4 `eslint.config.js`：`curation/**` 仅 `approve.ts` 可 import 事实 writer（`recordPriceChange` 等），`propose.ts`/`extract.ts` 触 lint；加一条 lint 断言测试或 CI 校验

## 6. Proposer lane（src/mr/curation/）

- [x] 6.1 `propose.ts` `runPriceCuration()`：读 pending flag 的 http 源 → `safeFetch`（**复用 scrape SSRF chokepoint + 重试 + 错误日志**）→ `extract` → 有候选且与现价异则 `openReviewOrSupersede` → 发卡；`plan_id` 经 `mr_plan_sources` 解析，多 plan 源无法唯一定位则 escalate
- [x] 6.2 `curation-queue.ts`：BullMQ 四件套（镜像 `scrape-queue.ts`），主镜像 lane
- [x] 6.3 `card.ts`：Telegram inline-keyboard 卡片（`callback_data=mrpr:<token>:approve`，显 old→new diff + 源摘要）+ 飞书**通知**卡片（无写按钮、**不含 token**，引导去 Telegram），复用 `push/message.ts` 转义

## 7. 入站接收 + 接线 + 门控

- [x] 7.1 `src/push/telegram.ts`：`BotApiLike.sendMessage` 加可选 `reply_markup`
- [x] 7.2 `telegram-callback.ts`：grammY `bot.start()` 长轮询（**仅 web 镜像**）+ `bot.on('callback_query:data')` → token 定长/字符集校验 + 拒未知 op + `from.id`（数值化）∈ `TELEGRAM_APPROVER_IDS`（鉴权在任何 DB 往返前）→ `applyReview` → `answerCallbackQuery` + editMessageText 去按钮；缺 `from` 拒；**轮询/发送有重试退避 + 错误日志**；**`callback_data`/token 从日志脱敏**（只记 id/plan_id）
- [x] 7.3 `src/config/env.ts`：加 `MR_PRICE_CURATION_ENABLED`(默认 false)/`MR_PRICE_CURATION_CRON`/`TELEGRAM_APPROVER_IDS`(逗号→number[])/`MR_PRICE_REVIEW_TTL_HOURS`(正整数校验) + `isMrPriceCurationEnabled()`；**跨镜像 fail-closed**：proposer 须 `MR_PRICE_CURATION_ENABLED` **且 `TELEGRAM_APPROVER_IDS` 就绪**才注册 lane、接收缺 `TELEGRAM_APPROVER_IDS` 不 start bot（各记日志）
- [x] 7.4 `src/pipeline/worker-main.ts`：注册 curation lane（门控，含 APPROVER_IDS 检查）；`src/index.ts`：仅 web 启停 grammY 长轮询 bot（随快照 bg 一并优雅关闭；**web 单副本 + worker 只 send** 注释说明长轮询约束）
- [x] 7.5 money 值只从服务端行读的断言测试：构造篡改 `callback_data` 金额 → 落库仍用行上冻结值

## 8. 收尾验证

- [x] 8.1 `npm run lint` + `npm run typecheck` + 相关测试全绿（typecheck/lint clean；curation 59 测试全绿；全树 878 测试通过、0 断言失败——35 个文件仅因本机缺 `.env` 在 env 引导处未加载，与本变更无关）
- [x] 8.2 `openspec-cn validate add-model-radar-price-curation-approval --strict` 通过
- [x] 8.3 冒烟流程已由集成测试覆盖（approve.test 双击/漂移/history-conflict/快照、propose.test Δ=0/多plan/supersede、telegram-callback.test 鉴权序/篡改）；真实环境端到端冒烟（起 DB+Redis+bot）留待带门 `MR_PRICE_CURATION_ENABLED` 的部署期执行（红线：测试不触真生产 DB/发送）
