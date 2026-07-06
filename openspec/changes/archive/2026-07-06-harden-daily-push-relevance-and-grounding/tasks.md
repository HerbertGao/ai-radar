## 1. 数据模型迁移

- [x] 1.1 新增 forward-only 迁移 `drizzle/0011_*`：`ai_news_events` 加 `is_ai_related boolean`（可空）、`ai_products` 加 `is_ai_related boolean`（可空）；`ADD COLUMN` 与 0008/0010 同惯例（无 `IF NOT EXISTS`），re-run 幂等由 drizzle-kit journal 保障（非裸 SQL 重跑）
- [x] 1.2 `src/db/schema.ts`：`aiNewsEvents` 与 `aiProducts` 各补 `isAiRelated: boolean('is_ai_related')` 列
- [x] 1.3 集成测：断言迁移后两列**存在 + 类型 boolean + nullable**（`information_schema` 查询，仿 `ai-products-migration` 范式）；`npm run migrate` 连续两次经 journal 跳过、无新 SQL（沿用既有 `*-migration.integration.test.ts` 范式）

## 2. 正文补全（source-content-enrichment，仅新闻）

- [x] 2.1 在 `src/collectors/sitemap.ts` 导出 `extractOgTag`（`defaultFetchArticle` 已导出）供跨模块复用
- [x] 2.2 新增补全模块（如 `src/pipeline/content-enrichment.ts`）：**工作集须与 `scoreUnscoredEvents` 判分集同口径**——`importance_score IS NULL AND merged_into IS NULL` 的事件、其代表 raw_item `content` 为空/纯空白且有 `canonical_url`/`url` 者；**空定义用单一 SQL 谓词** `content IS NULL OR content !~ '\S'`（等价 `btrim(content, E' \t\n\r\f\v')=''`），**工作集选取与原子写回必须用同一谓词**（禁止一处 JS `String.trim()`、一处 Postgres `trim()`——前者含 tab/换行/Unicode 空白、后者仅 ASCII 空格，对 `'\t\n'` 分歧致选中却写回 0 行）；抓取 → `extractOgTag(html,'og:description')` → **原子写回** `UPDATE raw_items SET content=? WHERE id=? AND (content IS NULL OR content !~ '\S')`（0 行=已被并发填充，跳过；绝不「先 SELECT 判空后无条件 UPDATE」）；逐条 try/catch 隔离、记错误日志、返回命中/失败计数
- [x] 2.3 复用 `defaultFetchArticle` 的 2xx + content-type html 闸 + `MAX_BODY_BYTES` + `COLLECTOR_FETCH_TIMEOUT_MS`，**并自加 SSRF 出网守卫**（`defaultFetchArticle` 无 host/IP 守卫，FIX-7 在 `collectOneSitemap` 内、本路径不经过）：发起前拒绝私网/环回/链路本地/云元数据地址（`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`(含 169.254.169.254)、`::1`、`fc00::/7`、`fe80::/10`）与非公网主机，跳转用 `redirect:'manual'` 或逐跳 host 重校验（防 302 绕过）；不引 readability/jsdom 新依赖
- [x] 2.4 `src/pipeline/run-daily-workflow.ts`：**按阶段名锚定**——在**语义合并阶段之后**、`scoreUnscoredEvents`（约 line 447）之前插入补全阶段（链序：塌缩 → 语义合并 → 补全 → 判分）；整阶段 try/catch 永不抛错、不进熔断分母。补全默认**串行 best-effort**（每条以 `COLLECTOR_FETCH_TIMEOUT_MS` 为上限、逐条隔离；量级数十条可接受，如实测偏慢再引小并发池），整体在 digest 锁内、watchdog 续租使延迟有界非致命。语义合并判维持仅标题（有意取舍，见 design D1）
- [x] 2.5 单测（注入 fetch 桩不触网）：空 content+可抓公网 URL 写回；**纯空白 content 视同空——测试输入须含 `'\t\n'`（tab/换行，非仅空格 `'   '`，以真正暴露 JS/Postgres trim 方言分歧），抓取后经同一 `content !~ '\S'` 谓词写回成功（断言非 0 行、内容被填）**；已有非空 content 不覆盖（**断言 DB 未变**，非仅未抛）；单条抓取失败隔离——**断言失败条 content 仍空 AND 兄弟条仍被处理**（非仅「阶段未抛」）；无可抓 URL / tombstone 事件跳过；**SSRF 桩：URL 指向 169.254.169.254 / 内网 / 经 302 跳内网 → 被守卫拒绝、不写回、记失败计数**（守卫须 `redirect:'manual'`/逐跳校验，不裸调 `defaultFetchArticle` 随访）

## 3. Value Judge 落 is_ai_related + grounding

- [x] 3.1 `src/agents/value-judge/mapping.ts`：`AiNewsEventScoreColumns` 加 `isAiRelated: boolean`，`mapOutputToEventScores` 补 `isAiRelated: output.is_ai_related`（不再丢弃）
- [x] 3.2 `src/agents/value-judge/score-events.ts`：UPDATE `set` 补 `isAiRelated: scoreColumns.isAiRelated`（保持既有 `WHERE ... merged_into IS NULL` CAS、set 仅含 `*_score`/`should_push`/`is_ai_related` 不变）
- [x] 3.3 **实工作在调用侧，非仅改签名**：`judgeRawItem` 已接受可选 `content`/`source`；须改 `scoreUnscoredEvents` 的候选 SELECT——现只取 `representativeTitle`，**left join `raw_items`**（经 `representative_raw_item_id`）载入补全后的 `content` 与 `source`，再以 `{title, content, source}` 传入；补全失败 content 仍空时如实回退仅标题
- [x] 3.4 集成测：判分后可从 `ai_news_events` 读回 `is_ai_related`（true/false 均可）；grounding **须断言传入注入 `generateObjectFn` 的 prompt 文本含该 content**（非「读回 mock 硬编码输出」——后者即使 content 未接入也绿，属假绿）

## 4. 要闻候选 AI 闸门

- [x] 4.1 `src/selection/top-n.ts` `selectTopN`：WHERE `and(...)` 追加 `eq(aiNewsEvents.isAiRelated, true)`（false/NULL 自然排除，fail-closed）；**必须** `eq(col,true)`，禁止 `isNotFalse`/`ne(col,false)`（会漏放 NULL）
- [x] 4.2 集成测：`is_ai_related=false` 与 `NULL` 事件被排除、`true` 事件正常入选；**种子须令其余候选谓词（should_push / published_at 窗内 / importance≥floor / merged_into IS NULL / 未投递全通道）全 TRUE，使 is_ai_related 为唯一区分量**（否则被别的谓词排除也绿、测不到闸门缺失）；排序/幂等口径不变

## 5. 摘要防幻觉护栏

- [x] 5.1 `src/agents/digest/index.ts` `buildPrompt`：注入当前日期；无正文（`content` 空）时加约束——只据标题概括、禁止编造版本/参数/发布状态、禁止据训练知识断言产品是否存在/否认真实发布
- [x] 5.2 `run-daily-workflow.ts`：**实工作在加载侧**——现 `loadCanonicalUrls`（约 line 509）只取 `canonical_url`、`forDigest`（约 line 542）未带 content/source；须扩加载（或加姊妹加载）经 `representative_raw_item_id` 取补全后 `content`+`source` 并透传 `digestEvent`（`EventForDigest` 已接受二者，只改签名不接加载即静默空转）
- [x] 5.3 单测（注入 generateObject 桩）：有正文 prompt 含正文分支；**无正文分支须断言 prompt 含日期 + 不编造/不否认发布约束**（仅断言有正文分支则护栏本身未测）

## 6. 产品 AI 闸门（名判、不补抓、防死锁、落库不丢弃）

- [x] 6.1 `src/agents/product-digest/{index.ts,schema.ts}`：`summarizeProduct` 输出 schema 扩 `is_ai_related` 布尔，与 `name_zh`/`tagline_zh` 同调用产出、经 Zod 校验；产品 prompt 加**与新闻对称的护栏**（注入当前日期 + 禁止编造产品名未含事实 + 禁止据训练知识断言产品存在/发布）；产品**名判**（+ 采集器已存 content），无 enrichment 补抓
- [x] 6.2 `src/pipeline/product-digest.ts` **参数化闸门防死锁**：`selectProductCandidates` 加 `applyAiGate` 选项（默认 `true`）——**加在现签名 `(channel, dbh, limit)` 之后 / 折进 options bag，不得挤占 `dbh` 注入位**（集成测依赖 dbh 注入）；`digestPendingProducts` 构建判定工作集时以 `applyAiGate=false` 调用（无闸门候选集），且待判谓词由 `name_zh IS NULL` 改为 `is_ai_related IS NULL`（**替换/`OR`，绝不与 `name_zh IS NULL` 取 AND**——防迁移前已中文化产品死锁）；挑中者判定并落 `ai_products.is_ai_related`；步骤永不向上抛、不进熔断分母；`UNNAMED_PRODUCT_NAME` 产品永久 NULL 排除（记录的接受例外）
- [x] 6.3 `src/agents/product-digest/persistence.ts` **落库不丢弃**：`updateProductZh` 扩 `isAiRelated` 入参、`set` 补该列；写 `name_zh`/`tagline_zh` 用 COALESCE/仅当前为 NULL 时写（补判已中文化产品不覆盖既有译名）；`product-digest.ts` call-site（约 line 335）透传 `summarizeProduct().is_ai_related`
- [x] 6.4 `selectProductCandidates` 最终推送候选（`applyAiGate=true`）WHERE 追加 `eq(is_ai_related, true)`（false/NULL 排除，fail-closed，禁 `IS NOT FALSE`/`ne`）；不改 order/limit/merge_conflict/跨天口径
- [x] 6.5 `src/pipeline/product-digest.ts` `assertProductZhColumns`：扩断言 `ai_products.is_ai_related`（及 `ai_news_events.is_ai_related`）列存在，保迁移先于代码 fail-fast（防缺列时产品段静默变空）
- [x] 6.6 集成测：非 AI 产品（is_ai_related=false）不进新品段；**种子一个 `name_zh` 非空 + `is_ai_related` NULL 的产品，断言其仍被判定步骤选中判分（不死锁）**（`name_zh` NULL 种子在错误的 AND 实现下也绿、测不到陷阱二）；复用同一 LLM 调用不新增第二次调用；补判 COALESCE 不覆盖既有译名；判定失败回退 NULL 不拖垮新闻；`applyAiGate=false` 工作集含 NULL 产品、`applyAiGate=true` 推送候选排除 NULL 产品

## 7. 可观测

- [x] 7.1 日报日志暴露：补全命中数、失败数（含**被 SSRF 守卫拒绝数**）、被 `is_ai_related`（false 或 NULL）过滤掉的要闻与新品计数

## 8. 验收

- [x] 8.1 `docker compose up -d` + `npm run migrate` 连续两次验证迁移幂等（经 journal 跳过）
- [x] 8.2 `npx tsc --noEmit` 0 错、`npm run lint` 0 错
- [x] 8.3 全量 vitest 全绿、0 skip（真实 pg+redis）
- [x] 8.4 对 7-01/7-02 生产实例的复现条目（Claude Sonnet 5 / Qualcomm Linux / PlayStation / 扫雷等非 AI 产品）用其真实标题+URL 跑一次日报链，确认：非 AI 要闻/新品被闸门排除、补全后摘要不再据训练知识否认真实发布、SSRF 守卫对内网/元数据 URL 生效（交付用户在生产环境用真实凭据执行确认）
  - 已用**生产同款模型 `deepseek/deepseek-v4-pro`** 真实 LLM 对复现条目确认三点：Qualcomm Linux/PlayStation 真判 `is_ai_related=false`（→ 闸门排除）；Claude Sonnet 5 摘要不再否认发布、Leanstral 1.5 不脑补参数（当前日期已注入）；SSRF 守卫经单测 + IPv4-mapped IPv6 hex 回归测覆盖。整条生产日报链的端到端 run 可按需另行执行。
