## 上下文

Model Radar 现状：检测层（`src/mr/scrape/**` http 指纹 + `src/mr/freshness/**` staleness）已建但默认关；唯一改价入口 `recordPriceChange`（`src/mr/ingest/`）已建，`recordPriceChange → runSnapshotRebuild → publishSnapshotInvalidation` 已自动（web 进程订阅者重建快照 → 公开页更新）。推送栈（grammY Telegram + 飞书自定义机器人）**目前全是单向出站**（只 `api.sendMessage`，无 `callback_query`/无 `bot.start`）。eslint `no-restricted-imports` 禁 `scrape/**`+`freshness/**` import 事实 writer——检测结构上只能 propose。

四个决策 lens（Governance / Backend / Data Engineer / Feishu Integration）已论证：唯一缺的两件事是 **(a)** 一处跨「检测到 → 人批准」异步间隙钉住「候选值 + 能力令牌」的载体，**(b)** 一条入站路径（推送栈今天纯出站）。其余（检测→flag、改价、快照失效、BullMQ lane、CAS 幂等、freshness dispose）全部原样复用。用户在三档方案中拍板选「完整档：Telegram 一键批准」。

## 目标 / 非目标

**目标：**
- 开启检测（staleness + http 指纹）并补上「检测 → 抽取候选 → 人一键批准 → `recordPriceChange` 落库 → 快照刷新」的常规 curation 回路。
- 人保留 money-path 闸门：机器只发现与预填，落库只在人一键批准时发生。
- 把「一次性推送出站」升级为「安全的入站写触发」，且不破坏任一既有不变量。

**非目标：**
- 不把价格判定交给爬虫/LLM（抽取器只预填、绝不自动写）。
- 不建飞书 app-bot（仅 URL-button 兜底）。
- 不做 browser/manual 档自动抽值（靠 staleness 时间地板）。
- 不建自动过期清扫 cron；不给令牌加 HMAC/签名过期。

## 决策

**D1：新目录 `src/mr/curation/`，但写入口 eslint 收窄到只 `approve.ts`。** eslint ban 覆盖 `scrape/**`+`freshness/**`；curation 需 import `recordPriceChange` 故不能整体在 ban 内。但**若整个 `curation/` 都可 import writer，则"只人批准写事实"退化为散文保证**（未来一笔 `propose.ts` 直接调 writer 就绕过人）。故收窄：`curation/**` 中**仅** `curation/approve.ts`（批准落库核心）豁免，`propose.ts`/`extract.ts` 等仍禁 import 事实 writer（eslint `no-restricted-imports`）。这让"只人批准路径落库"重回结构保证。检测层一行不动、仍 propose-only。

**D2：新建 `mr_price_review` 表，而非复用 `mr_review_flag`。** `mr_review_flag` 是 `UNIQUE(target_type,target_id)` 单行 CAS 标志，只存 `{status,reason,opened_at}`，塌缩语义会让同 plan 两条候选相互覆盖、且不存值/币种/provenance。curation 需要一条**持久行**同时承载「要落的具体价」+「一次性批准令牌」。字段：`id`(PK)/`plan_id`/`old_value`/`candidate_value`/`currency`/`source_url`/`source_confidence`/`token`(128-bit,UNIQUE)/`status`/`extracted_at`/`decided_at`/`decided_by`。`(plan_id) WHERE status='pending'` 偏唯一索引 = 发一次卡的闸。替代方案：给 `mr_review_flag` 加 `candidate jsonb`（Data Engineer 建议）——否决，因完整档要跨小时间隙 + 令牌单用语义，独立表更干净、不污染 flag 塌缩契约。

**D3：令牌即能力，`callback_data` 只带引用、绝不带钱。** `callback_data = "mrpr:<token>:approve"`（忽略 reject；≈45B < Telegram 64B 限）。money 值/币种/provenance 一律服务端按 token 从 `mr_price_review` 行读。这从根上杜绝载荷篡改写攻击者选定价。令牌由 **CSPRNG（`node:crypto`）** 生成，行本身 + CAS 即单用令牌；**加有效期**（CAS 谓词含 `extracted_at > now()-<TTL>`）闭合"泄漏令牌长期可用"窗口，无需 HMAC/签名。

**D4：拓扑——proposer 在 worker 镜像，Telegram 接收 bot 在 web 镜像。** proposer = 主镜像新 BullMQ lane（日级 cron、http-only、无 Playwright，同 `mr-scrape-http`）。Telegram `callback_query` 接收（`bot.start()` 长轮询）在 **web 镜像**——web 是常驻进程、天然做 bot host。**注意：快照失效是 Redis pub/sub（`src/mr/snapshot/invalidation.ts`），与发布进程位置无关**，故 `applyReview` 即便跑在别处 web 订阅者也会重建——同进程**不是**载荷理由；把接收放 web 的真实理由只是"web 是常驻 bot host"。`applyReview(token, decidedBy)` 纯核心。**唯一 getUpdates 消费者**：仅 web 镜像 `bot.start()`，worker 只 `api.sendMessage`；多副本/多消费者会 409 flap（CAS 使其仅退化为可用性损失、不误写）。**跨镜像配置一致性**：proposer 除本侧 `MR_PRICE_CURATION_ENABLED` 外**还须校验 `TELEGRAM_APPROVER_IDS` 就绪**才注册（各查本侧 env 不足以防"发卡却无人能批"——proposer 必须显式确认批准侧白名单存在），接收侧缺白名单即不 start bot。

**D5：批准 = CAS 认领 + 基线校验 + outcome 判定，失败/成功各归位。** `applyReview` 主事务：CAS `UPDATE … SET status='approved' WHERE token=? AND status='pending' AND extracted_at>now()-make_interval(hours=><TTL>) RETURNING id`（TTL 取校验过的正整数、`make_interval` 非字面拼接；DB 单时钟）→ 0 行(已决/重放/过期)→幂等 no-op + `answerCallbackQuery` 反馈；非空(拿到 `id`) → 锁 plan 校验 **`current_price/currency == 冻结 old_value/currency`**（不等 → 基线漂移，抛出 → 回滚 → 独立事务按 `id` 置 `superseded`，不落库）→ 调 `_recordPriceChangeTx`（可接已开 tx）→ **按真实 outcome 判定**：writer 返回 `{appended|noop-refreshed|noop-same-tuple|history-conflict}`（**无 `applied`**——原 spec 名错，会令实现判失败每次真批准）。基线校验（current==冻结 old ∧ 候选≠current）已保证进写入时是真变更，故**成功唯一可达 outcome 是 `appended`**（`noop-*` 在此路径不可达，按非成功处理即安全）；`history-conflict`/任何非 `appended` = 失败并**主动抛出**。失败路径主事务回滚（CAS 认领一并回滚 → 行回 `pending`）→ 独立事务 **`WHERE id=<认领 id> AND status='pending'`** 置 `apply_failed`（键 `id` 非 plan/status，防并发 proposer 已 supersede 该行后误标新候选；0 行则不动+记日志）→ flag 不 resolve → staleness 重浮现。基线漂移路径对称地按 `WHERE id=? AND status='pending'` 置 `superseded`。**成功路径**：**不触碰 `mr_review_flag`、不刷 child `last_checked`**——价格事实 freshness 由 `_recordPriceChangeTx` 既有的 `mr_plans.last_checked` 刷新覆盖（无需 markChecked；注意 baseline `markChecked=resolveFlag+刷全 child last_checked`，用它会假刷未复核 child 的陈旧 + 塌缩整页 flag，两者皆错）；整页指纹 flag 交人 dispose，未策展同页事实由 staleness 兜底。**提交后另发 `publishSnapshotInvalidation`**（`_recordPriceChangeTx` 只在 tx 内写、无 public wrapper 的 after-commit `runSnapshotRebuild`，故 applyReview 须自补）——此调用 **best-effort、不得使已成功批准转失败**（仿 public wrapper 视 rebuild 失败非致命），抛错记日志、公开页短暂陈旧待下次失效自愈。这解决五个缺陷：① `apply_failed` 单事务不可达→独立事务；② `history-conflict` 假成功→按 outcome 判且 `appended` 唯一成功；③ 快照 after-commit 漏刷→自补 + best-effort 不回退批准；④ 并发 supersede 误标→键 `id`；⑤ markChecked 塌缩整页 flag/假刷 child→改为不碰 flag、只靠 recordPriceChange 已刷的价格 last_checked。

**D6：抽取器 fail-closed，只官方源高置信小改预填。** 抽取只丰富待批记录、绝不写事实；最坏「让人白看一次」。预填一键值须同时满足：官方源 `source_confidence∈{official_pricing,official_doc}`（**由 source 注册表按源信任派生、非取自页面**——防篡改页抬高置信度、且避免非官方源批准必 `apply_failed`）、现价非 NULL（NULL→`FIRST_READ` escalate，避 `|Δ|/NULL`）、同币种、`0<|Δ|/current≤20%`。**百分比门即挡住解析错**（¥40→¥4 = pct 90% → escalate；原 `ratio≥2/≤0.5` 是 pct>20% 的死分支，删）。**促销是尽力启发式、不声称 fail-closed**：呈折扣形态即 escalate，人手输兜底。多 plan 源（一页多价）本期 escalate、一键仅覆盖单价源。

**D7：飞书仅通知、不承载批准。** 飞书自定义机器人只出站、卡片按钮是浏览器 GET 文字链（`src/push/message.ts`「不依赖回调」）——若让它触发写，(a) GET 打不到 POST 端点=不生效，(b) 改 GET 则链接预览/扫描器/预取**零人工自动批准**，且群内广播无 approver 身份。故飞书卡片只通知 + 引导去 Telegram 批准。批准唯一入口 = Telegram。这也**取消了原本被飞书公开端点强制的 webhook**，使 Telegram 可用长轮询（无公开写端点 = 最小攻击面）。原生飞书一键需自建 Lark app（大新信任面），本期不做。

**D8：检测层 blocked-page 修复随本期一并做。** 开启检测后，200 验证码/登录页会立刻污染指纹 + 误报刷屏；blocked-page 命中 → 不更新 fingerprint（仿 truncated→skip）。属既有 ingestion 需求的补齐，非新能力。

## 风险 / 权衡

- **入站写路径是新信任边界** → Telegram 长轮询无公开写端点（bot-token 认证的 getUpdates 通道即传输鉴权，故不设 secret_token）+ `from.id` 数值化允许清单（挡群内他人，非 chat id）+ CAS（幂等/防重放）+ 令牌有效期 + money 值只服务端读（防载荷篡改）。
- **一键批准的橡皮图章习惯化**（人一眼扫过批准误值）→ 只官方源高置信小改预填、卡片必显 old→new diff；折扣/大跳/换档/歧义强制人手输；批准前校验 `current==冻结 old` 防基线漂移后误批。
- **web 单副本约束** → Telegram 长轮询是单 getUpdates 消费者，多副本 web 会 409/双处理。当前部署单 web 副本，成立；未来多副本须改 webhook 传输（+ secret_token 常量时间校验）。`// ponytail: 长轮询单副本，web 横扩再切 webhook`。
- **claim-then-write 非两阶段 saga**（认领与落库间崩溃）→ 主事务失败回滚留 `pending`，独立事务标 `apply_failed`，staleness 重浮现兜底；单用户低量足够，真并发再上 outbox。
- **proposer 重抓变更源**（不复用检测已抓的 body）→ 仅对指纹已变的少数源触发（一天几个），复用 scrape safeFetch（SSRF+重试+日志），不建 fetch 缓存。
- **飞书降级为只通知**（非一键）→ 批准要切到 Telegram 点一下，单操作者可接受；换来消灭整个飞书 GET 写洞 + 传输简化为长轮询。真要飞书原生一键再上 Lark app。

## Migration Plan

- 前向 Drizzle 迁移建 `mr_price_review`（forward-only，无破坏性变更；回滚 = 关 `MR_PRICE_CURATION_ENABLED` + 不 start bot，表空置无害）。
- 分阶段部署：先合并代码（全部门控关）→ 开 staleness/http 检测观察 flag → 再开 `MR_PRICE_CURATION_ENABLED` + 配 `TELEGRAM_APPROVER_IDS` 启用一键批准。proposer/接收各自缺 env 即 fail-closed 拒注册本侧（仿 `isFeishuEnabled`），不半启用。

## Open Questions

- （已定）传输：**Telegram 长轮询**（无公开写端点、最小攻击面），web 单副本约束已记入风险。多副本时切 webhook + secret_token。飞书已降级只通知，不再强制公开端点。
