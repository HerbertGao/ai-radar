## 为什么

Model Radar 的 ~6 个编程订阅价格是**精确事实**，会不定期漂移，但目前无人被告知「哪一页动了」——检测层（staleness / http 指纹）已建但默认关，改价入口 `recordPriceChange` 已建却无便捷的人机交互面。结果是价格靠人肉盯页，容易陈旧。

本变更开启检测并补上「检测 → 抽取候选 → 人一键批准 → 唯一改价入口落库」的常规 curation 回路，作为「自动抓取（C）」的**轻量替代**：机器负责发现与预填，**人保留 money-path 闸门**（红线：价格绝不交爬虫/LLM 判定，只由人确认后经 `recordPriceChange` 落库）。

## 变更内容

- **新增 `mr_price_review` 表**：承载一条「已抽取的候选价 + 一次性能力令牌 + 冻结的 provenance」，跨越「检测到」与「人批准」之间的异步间隙；`(plan_id) WHERE status='pending'` 偏索引保证每 plan 至多一条待批、发一次卡。
- **新增 `src/mr/curation/` 目录**（**故意在 eslint ban `scrape/**`+`freshness/**` 之外**，可合法 import `ingest/recordPriceChange`；检测层不动、仍 propose-only）：
  - **候选抽取器**（fail-closed + enrich-only）：读检测层已归一的价区文本（复用 scrape 归一函数），只有「单一、带币种+周期、在界内、块数不漂移、非促销、非登录墙、官方源、现价非 NULL/非 0」的数才成候选；任何歧义→不给值。**百分比门**：仅高置信小幅同档变动（同币种、0<|Δ|/current≤20%）预填一键值；大跳/换档/疑似解析错（如 ¥40→¥4，pct=90%）/非官方源/多价源 → escalate 无值、强制人手输。
  - **curation BullMQ lane**（主镜像、日级 cron、无 Playwright，`MR_PRICE_CURATION_ENABLED` **且** `TELEGRAM_APPROVER_IDS` 就绪才注册——不发无人能批的卡）：读 pending flag 的 http 源（经 scrape SSRF chokepoint + 重试 + 错误日志）→ 抽取 → 有候选且异于现价则**单事务比对既有 pending：同候选 no-op / 不同或已过期则 supersede 旧+插新**（不用裸 `ON CONFLICT DO NOTHING`）→ 发卡。
  - **Telegram 一键批准**（web 镜像，`bot.start()` 长轮询、无公开写端点；**唯一** getUpdates 消费者）：grammY `callback_query` 收 `mrpr:<token>:approve`；`TELEGRAM_APPROVER_IDS` 数值化白名单（挡群内他人，认 `from.id` 非 chat id）+ CAS（认领返回 review `id`）`WHERE token=? AND status='pending' AND extracted_at>now()-<TTL>`（幂等/防重放/防过期）→ 锁 plan 校验现价==冻结 old（防基线漂移）→ 同事务 `_recordPriceChangeTx` → **检查返回 outcome**（仅 `appended`/已核幂等算成功；`history-conflict` 等未更新 current 一律失败）→ 刷新价格 freshness；提交后**触发快照重建**。失败：主事务回滚 → 独立事务按 `WHERE id=? AND status='pending'` 标 `apply_failed`、flag 不 resolve。传输鉴权来自 bot-token 认证的 getUpdates（故不设 webhook secret_token）；grammY 轮询/发送须有重试与错误日志；**约束 web 单副本**（多副本切 webhook）。
  - **飞书仅通知**：飞书自定义机器人只出站、卡片按钮是浏览器 GET，让其触发写会被链接预览/扫描器零人工自动批准且群内无 approver 身份——故飞书卡片只展示待复核 + 引导去 Telegram 批准，**不含任何写按钮、不携带令牌**。
- **修改检测层**：200 状态的登录墙/验证码页当前会污染 `content_fingerprint` 并误报「变了」——blocked-page 命中时**不更新指纹 + 必须给 source 打标**（仿既有 truncated→skip 幂等重试），避免开启检测后刷屏、并使误判/长期被墙的源浮现。

## 功能 (Capabilities)

### 新增功能
- `model-radar-price-curation`: 价格 curation 批准回路——候选抽取（fail-closed，官方源 + 百分比门）、`mr_price_review` 待批记录（CSPRNG 令牌即能力 + TTL）、Telegram 长轮询一键批准（`from.id` 白名单 + token CAS + TTL，**无 webhook secret_token**）、飞书**仅通知**（无写按钮），人批准后经唯一改价入口 `recordPriceChange` 落库并触发快照重建。

### 修改功能
- `model-radar-ingestion`: 检测器抓到 blocked-page（200 登录墙/验证码，非真内容）时不更新 `content_fingerprint` **且必须给 source 打标**，避免污染基线与误报、并使误判/长期被墙的源浮现（补齐既有「检测器原子防 stale-retry」只挡体超限截断的缺口）。

## 影响

- **新增代码**：`src/mr/curation/{extract,price-review-store,propose,approve,curation-queue,telegram-callback,card}.ts`（**无 feishu-web 写端点**——飞书只通知）；`mr_price_review` 表 + Drizzle 迁移 + `mr-schema.zod.ts` 枚举；curation 的集成测试（applyReview CAS 重放、基线漂移→不写、history-conflict→apply_failed、extract 登录墙/非官方→null、propose supersede 不吞新候选）。
- **改动代码**：`src/mr/scrape/*`（blocked-page→跳过指纹+打标）；`src/push/telegram.ts`（`BotApiLike.sendMessage` 加可选 `reply_markup`）+ 飞书通知卡片（无写按钮）；`src/pipeline/worker-main.ts`（+1 lane，门控）；`src/index.ts`（启停 grammY 长轮询接收 bot）；`src/config/env.ts`（+`MR_PRICE_CURATION_ENABLED`/`MR_PRICE_CURATION_CRON`/`TELEGRAM_APPROVER_IDS`/`MR_PRICE_REVIEW_TTL_HOURS`）；`eslint.config.js`（`curation/**` 仅 `approve.ts` 可 import 事实 writer）。
- **不动**：`recordPriceChange` 落库语义、判定/DTO/推荐器引擎、比价表口径、检测层「只 propose 不改事实」的 eslint 边界。

## 非目标

- **不把价格判定交给爬虫/LLM**：抽取器只预填候选、绝不自动写价；`recordPriceChange` 只在人一键批准后触发（money-path 红线，DB+人保障）。
- **飞书不承载批准**：飞书仅通知，批准唯一入口是 Telegram——避免飞书 GET 文字链被预览/扫描器零人工自动触发 money-path 写、及群内无 approver 身份的批准。飞书原生一键回调需自建 Lark app，本期不做。
- **不做 browser/manual 档自动抽值**：仅 http 档抽候选；browser（GLM/JS）与 manual（讯飞登录墙）继续靠 staleness 时间地板兜底。
- **不建独立过期清扫 cron / 不做重发退避**：令牌 TTL 折进 CAS 谓词；proposer 遇过期 pending 直接 supersede+重发（即便同候选），无需单独 sweep。**接受**：一个人始终不点的真实价改会按 TTL 节奏一直重发提醒（无 max-reissue 上限）——单操作者 / ~6 plan 量级噪音可忽略，堆积再加退避。
- **不给回调令牌加 HMAC/签名**：CSPRNG 128-bit 单用 + CAS + TTL 即单用能力；令牌只走 Telegram `callback_data`（非 URL、不进飞书/浏览器/日志），故无 HMAC。
