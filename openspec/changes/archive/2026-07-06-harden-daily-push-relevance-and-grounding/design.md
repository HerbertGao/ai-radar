## 上下文

生产日报两类可复现缺陷（非 AI 内容混入要闻/新品；简介基于陈旧训练知识编造）经生产库核实同一根因：**链接帖只有标题 + URL，全流程从不抓取正文**（`raw_items.content` 长度为 0），仅 Anthropic sitemap 一个采集器抓 og:description。于是 Value Judge 与摘要器都只吃标题——判分信号弱、`is_ai_related`（模型已产出）被 `mapping.ts` 丢弃、摘要器用过期知识脑补。产品段更绕过判分、无任何 AI 闸门。

涉及模块：采集（复用 sitemap 抓取）、Value Judge、Top N 选择、中文摘要、产品中文化/候选、日报编排、一次 DB 迁移。属跨领域 + 数据模型变更，故立 design。

约束：守第一架构原则（是否推送由程序 + DB，`is_ai_related` 只作过滤谓词，LLM 只做语义判定）；不引新依赖；不改语义去重阈值 / 幂等四元组 / 推送状态机；不启用 browser egress。

## 目标 / 非目标

**目标：**
- 非 AI 事件不进要闻段、非 AI 产品不进新品段（fail-closed）。
- 判分与摘要以补抓正文 grounding；补抓失败时摘要不编造、不据训练知识否认真实发布。
- 复用既有机制（`defaultFetchArticle`/`extractOgTag`、产品既有中文化 LLM 调用、既有 Zod/降级/熔断口径），最小新增面。

**非目标：**
- 不做全文可读性抽取（只取 og:description / 有限正文）。
- 不做 `is_ai_related` 批量回填脚本、不追溯重推**新闻**历史：新闻侧已评分事件不自动重判（无重判路径）。**产品侧非回填而是正常前向自愈**：产品判定工作集每轮以 `is_ai_related IS NULL` 自然纳入候选窗口内（merge_conflict 排除 + 跨天从未 success + 近期）的未判产品前向补判——这些本就是从未成功推送的候选、非已投递历史，属正常前向工作集自愈，不是回填脚本，与本非目标不冲突。
- 不改 Model Radar、去重阈值、排序权重、幂等与跨天不重推口径。
- 不新增采集源、不启用自动浏览器抓取。
- 不做产品侧正文补抓：产品按名判定（+ 采集器已存正文），补全只作用于新闻事件。
- 不改实时告警链（`alert-scan`）：共用评分但本期不前置补全、告警推送候选不加 `is_ai_related` 闸门；只硬化日报要闻/新品段。

## 决策

**D1 — 正文补全插在「语义合并之后、Value Judge 之前」（按阶段名锚定，非行号）。** 判分与摘要都需正文；补全先行才能一次 grounding 两者。**关键位序**：塌缩→判分之间的窗口内还有**语义合并阶段（阶段 2.5）**，其灰区 LLM 合并判也读 `raw_items.content`；补全放在**语义合并之后**是有意选择——① 语义去重是明确非目标，合并判维持仅标题现状、本变更不改（记录取舍，不视作缺陷）；② 只富化存活代表、不对随即 tombstone 的事件浪费抓取。**补全工作集须与判分集同口径**（`importance_score IS NULL AND merged_into IS NULL`，空 content + 可抓 URL）：否则漏掉的待判事件仍会判分却退化仅标题，违反 value-judge「须含正文除非补全失败」的普遍约束。补全阶段 best-effort、逐条 try/catch、永不抛错、**不进熔断分母**（沿用「回填/产品失败不进熔断」的既有先例）。替代方案「在各 collector 内抓正文」被否：抓取分散到 5 个采集器、且非候选条目也被抓浪费预算；集中在待判事件代表 raw_item 上抓，量级仅数十条/次。

**D2 — `is_ai_related` 落库既有输出、fail-closed 闸门。** Value Judge 已产出 `is_ai_related`，只需 `mapping.ts` 不丢 + UPDATE set 补列 + `selectTopN` 加谓词 `is_ai_related = true`。`false` 与 `NULL` 一律排除（fail-closed）：用户抱怨是「非 AI 泄漏」，宁可漏一条边界 AI 也不推 PlayStation。替代方案「加 confidence 阈值/三态」被否：YAGNI，布尔够用，先止血再按数据演进。

**D3 — 复用 sitemap 的解析/校验逻辑与 og:description，不引 readability；但抓取须自带 SSRF 守卫、不裸调 `defaultFetchArticle`。** 复用 `extractOgTag` 与 `defaultFetchArticle` 既有的 2xx / content-type html / 5MB / timeout **校验逻辑**（不引 jsdom/readability，守 ponytail：native/既有优先）。**关键**：`defaultFetchArticle` 默认 `redirect:'follow'` 且无 host/IP 出网守卫（FIX-7 在 `collectOneSitemap` 内），故对提交者可控 URL **不得裸调它随访**——否则攻击者提交公网 `http://evil/x` 过预检后 302 跳 `169.254.169.254` 仍被跟随（SSRF）。补全须以**受控抓取**执行：发起前 IP denylist 预检 + `redirect:'manual'` / 逐跳 host 重校验（见「信任边界 = SSRF」风险与 task 2.3）。绝不覆盖已有非空 `content`（RSS/Ask HN 自带 text、sitemap 已抓的保持不动）。

**D4 — 摘要加「无正文不编造 + 当前日期注入」护栏。** 即使补全失败仍需兜底 symptom B。prompt 硬约束：无正文时只据标题概括、禁止编造版本/参数/发布状态、禁止据训练知识断言产品是否存在；注入当前日期使模型不以训练截止为「现在」。这是 grounding 之外对陈旧知识幻觉的第二道防线。

**D5 — 产品 AI 判定复用既有中文化调用（名判、不补抓），判定工作集与闸门解耦（防死锁）。** 产品已有 `summarizeProduct` 中文化 LLM 调用，扩产 `is_ai_related` 同调用产出，**不新增 LLM 调用**；产品**按名判定 + 采集器已存正文（若有），不经 source-content-enrichment 补抓**（补全只作用于新闻事件、且运行在产品塌缩之前，产品行与 `representative_raw_item_id` 此时不存在——原「有正文时经补全 grounding 产品」是不可达的伪路径，已删）。名判时受与新闻对称的「不编造 + 注入当前日期 + 不据训练知识断言存在」护栏。

判定/落库须避开的陷阱（**两处，缺一即死锁或产出即丢弃**）：
- **陷阱一：工作集派生自被闸门的同一函数。** `digestPendingProducts` 现实现**复用 `selectProductCandidates` 构建工作集**；若把 `is_ai_related = true` 直接加进该函数，工作集随之被闸门 → NULL 产品永进不了工作集 → 死锁。故须**参数化** `selectProductCandidates` 的 AI 闸门（`applyAiGate` 选项，加在现签名 `(channel, dbh, limit)` 之后 / 折进 options bag，不挤占 `dbh` 注入位）：判定工作集调 `applyAiGate=false`（无闸门候选集），仅最终 per-channel 推送候选调默认 `applyAiGate=true`。
- **陷阱二：既有 `name_zh IS NULL` 待判谓词。** 现工作集以 `name_zh IS NULL` 判「未中文化」；补判须改为 `is_ai_related IS NULL`（**替换或 `OR`，绝不 AND**）——否则迁移前已中文化（name_zh 非空、is_ai_related NULL）产品被 AND 排除、永久 NULL。以 is_ai_related IS NULL 纳入意味对历史产品重跑一次同调用，须 COALESCE 保留既有译名。例外：占位名产品（`UNNAMED_PRODUCT_NAME`）本被排除、永久 NULL（记录、接受）。
- **落库不丢弃。** `updateProductZh` 现 `set` 仅 `{nameZh,taglineZh}`；须补 `isAiRelated` 入参与 `set`、call-site 透传 `summarizeProduct` 产出。只加列 + 加闸门谓词而不接持久化写入 = 判定产出被静默丢弃（正是本变更为新闻消除的「产出即丢弃」缺陷）。
- **缺列 fail-fast。** `assertProductZhColumns` 探针须扩断言 `ai_products.is_ai_related`（及 `ai_news_events.is_ai_related`）——否则代码先于迁移部署时产品闸门读缺列在被静默吞的 `selectProductsForChannelSafe` 内抛错 → 新品段静默变空（假绿）。

**D6 — 一次 forward-only 迁移，两列可空布尔，不回填。** `0011`：`ai_news_events.is_ai_related` + `ai_products.is_ai_related`（均 nullable boolean）。不回填历史，NULL fail-closed 排除即预期行为。**波及面须如实陈述（勿低估）**：新闻侧 `scoreUnscoredEvents` 只判 `importance_score IS NULL`，故已评分但 is_ai_related NULL 的事件不只是「已推/老事件」，也含**候选窗口内、should_push、尚未投递全通道**的合法待推事件——它们迁移后被 fail-closed 排除、随窗口老化永久不再推送。**新闻/产品非对称**：产品侧工作集以 is_ai_related IS NULL 纳入、候选窗口内下一轮即重判自愈（工作集沿用 `limit`/`跨天从未 success`）；超 limit 或窗外的 NULL 产品在**再采集刷新 `last_seen_at`** 后随窗口滑动自愈——注意判定工作集是**未闸门** top-N（按 recency），推送集是**已闸门**，故当 ≥N 个更近的非 AI 产品挤占未闸门窗口时，一个真 AI 产品可能排在未闸门 rank N+1、当轮不被判、被 fail-closed 排除：这是**可接受的 fail-closed 漏（绝非误推、绝非死锁）**，不宣称此类产品"本不可推"；新闻侧无对称重判（新增会违反「不回填」非目标，故不做）。如需极少数补救，手动重置 `importance_score=NULL` 触发重判，不做自动回填。迁移幂等经 drizzle-kit journal 保障（非裸 SQL 重跑；`ADD COLUMN` 与 0008/0010 同惯例、无 `IF NOT EXISTS`），集成测断言两列存在 + boolean + nullable。

## 风险 / 权衡

- **[闸门质量受判分输入限制]** 补全失败退化仅标题时，边界项（如蹭「AI Engine」的 Qualcomm Linux）可能被判 `is_ai_related=true` 漏过 → 补全 grounding 提升判准；fail-closed 方向偏向少推；被过滤计数入日志供调参。
- **[误杀真 AI 新闻]** 模型误判 `false` → 该条被 drop → 以补全 grounding 降低误判 + 暴露「被 is_ai_related=false 过滤」计数，异常升高可见。
- **[日报延迟增加]** 每次补全数十条外部抓取 → 仅对空 content 候选抓、带 timeout、逐条隔离、best-effort，量级可控；失败不阻塞。**并发须显式**：在 30 分钟 digest 锁内运行，串行最坏 = N × `COLLECTOR_FETCH_TIMEOUT_MS`；应设有界并发池（如小池）或显式接受串行 best-effort（每条以 timeout 为上限），watchdog 续租使其非致命但延迟须有界。
- **[迁移后既有 should_push 事件停推]** `is_ai_related` NULL 被 fail-closed 排除。**波及面非仅「已推/老事件」**：`scoreUnscoredEvents` 只判 importance NULL，故窗口内 should_push、未投递全通道的合法待推事件也被排除、永久不再推送（见 D6）。符合「不追溯重推」非目标、被接受；新闻侧无自动重判（会违反非目标），如需极少数补救可手动重置 importance_score=NULL 触发重判，不做自动回填。
- **[抓取外部 URL 的信任边界 = SSRF，须自加出网守卫]** 补全 URL 源自 HN/RSS/PH 等**外部提交者可控**内容，与 sitemap 的一方（Anthropic）URL **不同信任级**。`defaultFetchArticle` **仅有** 2xx/content-type/大小/timeout 闸、**无 host/IP 守卫**——sitemap 的 host 同注册域守卫（FIX-7）在 `collectOneSitemap` 内、不在 `defaultFetchArticle`，本路径不经过它。故原「同信任级 / 复用同一组防护 / 不抓内网」**不成立**；补全**必须**自加 SSRF 出网守卫：拒绝私网/环回/链路本地/云元数据地址（含 169.254.169.254）与非公网主机，并处理跳转（`redirect:'manual'` 或逐跳 host 重校验，防 302 绕过）。「不抓内网」以本守卫为前提。
- **[og:description 是营销文案非正文]** grounding 于 og:description 可能偏向发布方框架、放大 hype、或使 is_ai_related 对被营销标注「AI」者过度置真。作为 best-effort 接受，保持 fail-closed 方向 + 过滤计数可观测，以便检测过/欠触发。
- **[实时告警链的 grounding 缺口]** 告警链共用 `scoreUnscoredEvents`（一生一次评分）但本期不前置补全、告警候选不加 is_ai_related 闸门 → 告警先判的事件得仅标题 is_ai_related、非 AI 事件仍可经告警泄漏。本期显式非目标（见 proposal 非目标 / daily-intel-pipeline「作用域仅日报链」），不把「补全提升闸门质量」呈为对所有入口普适；如需另起提案。

## 迁移计划

1. 出 `drizzle/0011_*`（两列 nullable boolean），`src/db/schema.ts` 补列；迁移幂等可重跑（集成测断言）。
2. 部署后新日报运行即：补全 → 判分落 `is_ai_related` → 摘要护栏 → 要闻/新品闸门生效。
3. 回滚：还原代码即可，两列空置无害（谓词与映射恢复原状后不读该列）。
