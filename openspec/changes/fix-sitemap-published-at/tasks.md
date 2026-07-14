## 1. 页面发布日的确定性提取

- [ ] 1.1 `src/collectors/sitemap.ts` 的 per-article HTML 解析阶段（**已在抓这张 HTML** 取 `og:title`/`og:description`）新增日期提取，规则 **MUST 为「唯一 h1 锚定 + 整串全匹配」**：
      - **锚定**：要求**文档中有且仅有一个 `<h1>`**（实测 30/30 成立）。数量 ≠ 1 → `null`（干净失败——站点日后加 nav/卡片 h1 时正是这条守住）。
        **绝不可用「`og:title` 文本相等」作锚点** —— 实测**仅 18/30** 成立（反例 `core-views-on-ai-safety`：og=`Anthropic's core views on AI safety`、h1=`Core views on AI safety: When, why, what, and how`），**会丢弃 40% 有日期的页面**、正好制造本变更要修的那个 bug
      - **整串全匹配**：对该 h1 **之后紧邻元素**的文本做 `^\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*$`。**绝不可做子串搜索**
      - 匹配失败 → `null`，**绝不退而求其次**
- [ ] 1.2 **解析口径**：MUST `Date.UTC(y, m, d)` 显式构造 UTC 零点，**绝不可** `new Date(str)`（V8 对非 ISO 串按**运行时本地时区**解析 → 容器 TZ 变化会让下游时效窗口边界漂 ≤1 天）。合理下限取常量 **`2015-01-01`**。经 `2015-01-01 <= d <= now` 校验；越界 → `null`
- [ ] 1.2b **本源关掉 AI 推断兜底**（design D7；提取失败 ⇒ `published_at` 保持 NULL ⇒ 不推送，**绝不回落推断**）：
      `src/agents/published-at-inference/backfill.ts` 的候选查询（`:163-185`）**已经** `innerJoin(rawItems, …)` 并 `select({ source: rawItems.source })` ⇒ 在 `where(and(…))` 里加一个谓词即可：`ne(rawItems.source, 'sitemap')`。
      **只关这一个源，绝不可改推断能力的通用机制**（其余源的 URL / 标题 / 正文确有日期线索，推断在那里是有依据的语义补全）。
      **理由**：该源无任何页面外日期线索，推断只能从模型训练记忆里猜；它与本变更枪毙的「子串搜索」是**同一个失效模式**（错误日期天然落在合理范围内 → 范围校验 / 时效窗口 / 基线水位一道都挡不住）。**正则被要求「只准干净失败」，LLM 不能只被要求「读一段 prompt」。**
- [ ] 1.2c 单测（推断侧）：候选查询对 `source='sitemap'` 的 NULL-`published_at` 事件**不返回**；对其余源（`rss` / `hackernews` 等）照常返回。**存量那 10 条已推断出的日期不清除、不回填**（见 design 回滚段）
- [ ] 1.3 **ReDoS（本文件正是为此被重写过）**：定位 `<h1>` MUST 沿用既有范式 —— `indexOf('<h1')` / `indexOf('</h1>')`（`-1` **立即 bail**）+ **有界 slice**（如 300 字符）再在小串上跑锚定正则。**绝不可**写 `/<h1[^>]*>[\s\S]*?<\/h1>\s*<[^>]*>([^<]*)</`（无匹配页面上是二次方回溯；`parseSitemap` 当初正是因此从 lazy-capture 重写成 `indexOf`——实测 1MB 未闭合 `<url>` → **29s**，而 body 上限 **5MB**）
- [ ] 1.4 提取出的日期串 MUST 经既有 `stripUnsafeChars` 净化（与其余入库文本同口径）
- [ ] 1.5 可观测：每源记录 `date_extracted_count` / `date_missing_count`（落 `sitemap.ts:552-556` 的既有计数器 sink）。**诚实登记**：没有新文的日子里，「提取率跌零」与「今天没新文」**不可区分**
- [ ] 1.5b **支路 1：日期提取归零 MUST 响，且判据 MUST 是【DB 复算】——绝不可读本轮采集结果**（design D10）。
      在 `src/pipeline/run-daily-workflow.ts` 加一次**独立的 `await alert(...)` 调用**（`dedupKey = 'sitemap-date-extraction-zero'`），谓词取自对 `raw_items` 的复算：
      ```sql
      SELECT count(*) AS emitted,
             count(*) FILTER (WHERE published_at IS NOT NULL) AS date_extracted
      FROM raw_items
      WHERE source = 'sitemap' AND fetched_at >= <今日 00:00，按 PUSH_TIMEZONE>
      ```
      `emitted > 0 且 date_extracted = 0` → 告警。**MUST NOT 塞进 `classifySystemFailure`**——它的入参就是「本轮采集统计」，用它等于把判据重新绑回「谁采的」。
      ⚠️ **为何不能用本轮采集结果**：`sitemap` 若被纳入高频实时链的采集子集，高频链每轮先采走新文并入库 ⇒ 已见集（`sitemap.ts:485-495`，读 `raw_items WHERE source='sitemap'`，**不分链**）已含该文 ⇒ 日报链跑 sitemap 时 `emitted = 0` **每天恒成立** ⇒ 「`emitted > 0 且 …`」形态的谓词**永不触发**——而它守的正是本变更自陈「**永久且不可恢复**」的那个失效。`raw_items` 是两条链**共同的事实源**，故 DB 复算与「谁采的」无关。
      ⚠️ **该告警只有在任务 8（运维告警 sink）落地后才是告警**：今天 `AlertSink` 的生产实现就是 `console.error`（`run-daily-workflow.ts:136` `defaultAlert`，注入点不传）。**任务 8 是本条的前置，不是可选增强。**
      **理由（组合后果，design Risks 第一条）**：提取失败的文章 `published_at=NULL` → 进已见集 ⇒ **永不重采**；D7 又把本源移出回填域 ⇒ 没有任何写路径会再碰它的 `published_at` ⇒ **这批文章永远不可见，包括正则修好之后**。**一个落 stdout 的计数器不是告警。**
      **只接日报链**——高频链有意不做系统级告警（`src/pipeline/alert-scan.ts:334`，防刷屏）。
      单测（读真库）：今日有 sitemap 新行且 `published_at` 全 NULL → 告警一次；今日有新行且至少一条有日期 → 不告警；今日零新行（无新文的日子）→ **不告警**（否则每天误报）
- [ ] 1.5c **支路 2：窗内有候选却零发射 MUST 响，判据 MUST 落在【采集器内部】**（design D10）：`loc_count > 0`（sitemap 健康、不 throw）+ 文章 URL 改版致 per-article fetch 全 404（`sitemap.ts:546` 逐篇 `continue`，不拖垮该源）⇒ `emitted_count = 0` ⇒ 支路 1 按定义不触发 ⇒ **整源静默死亡**；且这些文章从不入库 ⇒ **不进已见集** ⇒ 每轮重抓一遍。
      落地：在 `src/collectors/sitemap.ts` 的计数器**原地**判 `window_candidate_count > 0 && emitted_count === 0` → `ctx.logError(...)` + **`throw` 使整源失败**（与既有 `loc_count === 0` 的 throw **同款**）⇒ `perSource.ok = false` ⇒ 由 1.5e 的源级健康告警响（`dedupKey = 'source-health:sitemap'`）。
      ⚠️ **该 throw 不丢弃任何条目**——`emitted_count = 0` 意味着本轮本就一条都没发射，throw 丢的是空集合。**throw 没有代价**（写清，否则读者会以为有）。
      ⚠️ **为何不回传给编排层判**：`sitemap.ts:551-556` 的计数器只是 `ctx.logError` 的一个**字符串**；`collectSitemaps(): Promise<CollectedItem[]>`；`CollectAllResult.perSource = {ok, count, error}` ——**没有任何 per-source 计数器出口**。要在编排层判就得新建回传管道；而计数器就在采集器里，直接 throw 即可。
      单测：`window_candidate_count>0 && emitted===0` → 整源 throw；`window_candidate_count===0`（无新文的日子）→ **正常返回空数组、不 throw**
- [ ] 1.5d **`CollectStats` / `SystemFailureVerdict` 完全不动**（MUST）：1.5b 走 DB 复算、1.5c 走采集器 throw ⇒ **不需要**给本轮采集统计加任何 required 字段、**不需要**扩 `kind` 的取值域、**不需要** `sitemapWindowCandidates` / `sitemapEmitted` / `sitemapDateExtracted` 之类的回传字段。若实现中出现「给 `CollectStats` 加 sitemap 字段」，**立即拒绝**——那会把判据重新绑回「本轮这条链采到了什么」（1.5b 的失效模式），且这些 MUST 只活在 tasks/design 里、**进不了主规范**（归档后凭空消失）。
- [ ] 1.5e **源级健康告警（MUST，支路 2 的落点，否则 1.5c 的 throw 无处可响）**：`src/pipeline/run-daily-workflow.ts` MUST 对本轮 `collected.perSource` 中 `ok === false` 的**每一个源**各 `await alert(...)` 一条（`dedupKey = 'source-health:<source>'`，**per-source**——否则多源同时坏会塌成一条）。
      ⚠️ **已核实：`perSource` 今天没有任何消费者**（registry 产出后只有 `logError` + `console.error`，`run-daily-workflow` 从不读它）⇒ 主规范里「`loc_count=0` → throw → **计入告警**」这句话**今天就是空的**，1.5c 的 throw 若没有本条也照样落空。本条同时把那句空话变成真的。
      单测：两个源失败 → 两条告警、`dedupKey` 各不相同；全部源成功 → 零告警

## 2. 样板 `og:description` 视同缺失（**采集器 + 正文补全两处，共享同一判定**）

- [ ] 2.0 **`isSiteBoilerplate` 提为共享判定**：从 `src/collectors/sitemap.ts` 导出（`src/pipeline/content-enrichment.ts` **本就从该模块 import `extractOgTag` / `MAX_BODY_BYTES`**，无需新建模块）。
      首版**硬编码该常量串**（YAGNI；样板真变了会在补全/摘要里显形）：`Anthropic is an AI safety and research company that's working to build reliable, interpretable, and steerable AI systems.`（实测 14 篇最新 `/news/` 中 **6 篇**逐字相同）
      **绝不可在采集器与补全各写一份**——两份判定必然漂移（样板串变更时只改一处），洞会从漂移的那一侧重新打开
- [ ] 2.1 `src/collectors/sitemap.ts`（per-article）：`const content = isSiteBoilerplate(og) ? null : og;`
- [ ] 2.2 **顺序 MUST：`isSiteBoilerplate` 必须在 M-1 双缺检查【之后】作用于 `ogDescription`。**
      M-1 的跳过条件是 `if (ogTitle === null && ogDescription === null)`（`sitemap.ts:509`，一个 **AND**），样板视同缺失后条目**照常发射**（只是 `content=null`），**绝不可**因此把整篇跳过。
      **反序会翻转行为**：若先把样板 `ogDescription` 置 null、再判双缺，则「缺 `og:title` + 样板 `og:description`」的页面会从「发射 slug-title 条目」（`sitemap.ts:517-519` 既有的 slug 派生回退）**翻成「整篇跳过」**——一个没人授权过的可观测行为变化
- [ ] 2.3 **`src/pipeline/content-enrichment.ts`：写回前判样板**（**只做 2.1 是不够的——补全会把它写回来**）。当前 `:289` `const description = extractOgTag(html, 'og:description')` → `:299` `.set({ content: description })` **原样写回**，`grep -c "isSiteBoilerplate|boilerplate"` → **0**（零样板感知）：
      ```ts
      if (!description || isSiteBoilerplate(description)) { fail += 1; logError(…); continue; }
      ```
      即把既有的 `if (!description)` 失败分支扩为「缺失**或**样板」。**按失败计**（`fail += 1`、记错误日志、`content` 保持 `null`、继续下一条），**绝不写回**
- [ ] 2.4 单测（采集器侧）：样板串 → `content === null`；非样板的真实 `og:description` → 原样保留；空串 → `null`（既有行为）
- [ ] 2.5 单测（补全侧，**缺了它 2.1 会被 2.3 之外的路径悄悄绕过**）：`enrichCandidateContent` 抓到样板 `og:description` → **不写回**（`raw_items.content` 仍为 `null`）且计入 `fail`；抓到非样板 og → 正常写回、计入 `hit`
      ⚠️ **这条单测是 2.3 的【权威验收】**，不是 5.4 的那条生产 SQL——存量 28 行永不重采、且落回同一批**已评分**事件（`importance_score` 非 NULL ⇒ 永不进补全工作集）⇒ **不带「新采」谓词的那条 SQL 恒为 0，无论 2.3 有没有实现**。**一个恒绿的核验不是核验。**

> **为什么必须两处都做**：采集器置 null → 该行**恰因此**进入补全工作集（`EMPTY_CONTENT`）→ 补全重抓**同一张页面** → `extractOgTag` 拿回**同一段样板**。**它非空，是 `extractOgTag` 的成功路径**（不是失败路径）→ 原样写回 → `content` 变回样板。三道护栏被绕过的现状原样恢复：
> ① **摘要防幻觉护栏**（`agents/digest/index.ts:94` `hasContent = Boolean(input.content?.trim())` → `true`）→ 「无正文不编造」**不触发** → LLM 拿「正文：Anthropic is an AI safety and research company…」给 `Claude's extended thinking` 写摘要（**比无正文更糟**）；
> ② **正文补全**：`content` 变回**非空** ⇒ 该行**永久离开补全工作集**（工作集判 `content` 为空；且事件一经判分 `importance_score` 非 NULL ⇒ 也永久离开判分工作集）——**这段样板成为该 raw_item 的终身正文**；
> ③ **语义合并**：两篇不同文章的 embedding 文本共享同一段 `content` 摘录、灰区 LLM 的两侧 `Content:` 亦为同一串 → 系统性推高误并（`semantic-dedup` 自称过合并为「危险方向」，其空文本兜底只测 `trim()===''`、**常量非空样板整个漏过**）。

## 3. 测试：必须能证伪「正则根本不匹配真实页面」

- [ ] 3.1 **从线上字节级捕获三份真实 fixture 提交进仓**（现有 5 份 `anthropic-article*.html` **全是手写的**、`</h1>` 之后**什么都没有**、无一含日期 → 用它们写的测试**按构造无法证伪任何东西**）：
      - `anthropic-real-2026.html` ← `/news/ust-claude`（真实发布日 **2026-07-09**；og:title **==** h1）
      - `anthropic-real-2023.html` ← `/news/the-long-term-benefit-trust`（真实发布日 **2023-09-19**；其 `lastmod` 是 **2026-07-09** —— **这一份同时证伪 lastmod 方案**）
      - **`anthropic-real-ogtitle-differs.html`** ← `/news/core-views-on-ai-safety`（真实发布日 **2023-03-08**；**og:title ≠ h1** —— **这一份是 40% 失败面的证据，缺了它测试会全绿而召回照丢**）
      断言：提取值 `== 2026-07-09` / `== 2023-09-19` / `== 2023-03-08`（用 `toISOString()` 比较，**非**日期字符串比较——这样时区写错会当场红）
- [ ] 3.2 **负例 fixture（防脏提取，缺一不可）**：
      `</h1><div>By Jane Doe · Mar 2, 2025 · 5 min read</div>` → **null**（整串不匹配）
      `</h1><div>Updated Jan 5, 2024</div>` → **null**（修订日，整串不匹配）
      多 h1（`<h1>Nav</h1>…<h1>Title</h1><div>Jan 1, 2020</div>`）→ **null**（h1 数量 ≠ 1）
      无日期元素 → **null**；未来日期 / 早于 `2015-01-01` → **null**
- [ ] 3.3 **ReDoS 测试**（与既有 `MAX_BODY_BYTES` 测试同规格）：5MB body、无 `</h1>` 后元素 → **< 50ms 返回 null**
- [ ] 3.4 **修既有的假绿测试**：`src/collectors/__tests__/sitemap.test.ts` 的 `it('published_at===null 且 metadata.lastmod 落值（lastmod 不进 published_at）')` —— 其 fixture 无日期 → **改后仍绿**，会继续钉死一条本变更刚废除的契约。**拆成两条**：`(真实 2026 fixture) → 提取出 2026-07-09`（新契约）与 `(无日期 fixture) → null 且 metadata.lastmod 落值`（回落契约），**并改掉用例名**
- [ ] 3.5 全量测试与类型检查通过

## 4. 存量：**不动**（不重采、不删 raw_items、不回填）

- [ ] 4.1 **确认没有任何一次性数据任务**（唯一的 schema 迁移是 `drizzle/0013`：**加列 + 回填 `published_at_authority`**，见任务 7.2——它 **MUST NOT 触碰任何一行 `published_at`**）。早前版本要「按 `source='sitemap'` 清 28 行 raw_items 使其重采」——**已枪毙**（design D6）。若实现中重新出现「按源删 `raw_items` 行」/ 清 seen-set / 回填或清洗存量 `published_at` 的脚本，**立即拒绝**：
      - `schema.ts:134` `ai_news_events.representative_raw_item_id` 是**裸 bigint、零外键** ⇒ DELETE 静默成功、不级联；而塌缩的 `onConflictDoUpdate.set` **不含**它（`schema.ts:122` 明文「禁止覆盖代表」）⇒ **25 条事件的代表指针永久悬空**
      - 而核验 SQL 只读 `raw_items` ⇒ **恒绿，看不见事件层的损坏**
      - **注**：任务 7 把 `published_at` 从「单向 NULL-fill」改为「权威高者胜出」后，重采**不再**会丢弃新提取的页面日期——那从来不是唯一理由，**可挽回价值仍然是 0**（下条），结论不变
- [ ] 4.2 **诚实边界（本变更的收益边界）**：存量 25 条被**两把锁**永久锁死 —— ① 那 21 条 `should_push=true` 的事件 `is_ai_related` **全为 NULL**（该列 2026-07-10 才上线），日报要闻闸 `top-n.ts:269` 是 `eq(is_ai_related, true)` **fail-closed**，而判分工作集按 `importance_score IS NULL` 取（`score-events.ts:196`）⇒ **永不重判 ⇒ 永远 NULL**；② 真实发布日为 2023-09 / 2024-05 / 2026-07 等，**即便拿到正确日期也一律出 3 天时效窗**（**这是正确的**，守 `policy-push-timeliness`）。
      ⇒ **存量的可挽回价值 = 0。本变更 MUST NOT 用「存量会被救活」为自己背书——真实收益只对未来新文（约 1–2 篇/天）成立。** 提取器的正确性由 **3.1 的线上字节 fixture 单测**证明，不靠重采。

## 5. 部署与核验

- [ ] 5.1 部署：**含一个 forward-only 迁移 `drizzle/0013_*.sql`**（加 `published_at_authority` 列 + `CHECK` + 回填 authority，见 7.2；**不触碰 `published_at`**）；**无新 env、无一次性数据脚本、不碰 `ALERT_SCAN_ENABLED`**
- [ ] 5.2 **核验的证伪力边界（先读这条，再读 5.3/5.4）**：下面两条生产 SQL **只对【部署后新采的文章】有证伪力**，故**必须**钉 `first_seen_at >= '<部署时刻>'`。**不带该谓词时它们恒为 0**——存量 28 行永不重采（已见集前置过滤 + `ON CONFLICT DO NOTHING`）、且落回同一批**已评分**事件（`importance_score` 非 NULL ⇒ 永不进补全工作集）⇒ 补全根本不碰它们。**一个恒绿的核验不是核验。**
      **本变更的权威证伪器是 CI 单测**（3.1 的线上字节 fixture + **2.5 的补全侧样板单测** + 1.2c 的推断豁免单测），**不是**这两条 SQL。
      ⚠️ **同一条「永不重采」还有一个必须读到的后果**：提取失败的文章（`published_at=NULL`）同样进已见集 ⇒ **永不重采**，而 D7 已把本源移出回填域 ⇒ **没有任何写路径会再碰它的 `published_at`** ⇒ **这批文章【永远】不可见，包括正则修好之后**。**MUST NOT** 把「提取失败」理解成「修好就恢复」的可恢复降级。失败必须当场响（任务 1.5b），否则一次静默改版就是这条源**永久且无声**的消失。
- [ ] 5.3 **日期提取核验**（人工只读，不入 CI）：
      ```sql
      SELECT left(r.title,40), r.metadata->>'lastmod' AS lastmod, r.published_at::date AS extracted
      FROM raw_items r
      WHERE r.source='sitemap' AND r.first_seen_at >= '<部署时刻>'
      ORDER BY r.first_seen_at DESC;
      ```
      **验收**：新采文章的 `extracted` 必须等于其页面上的真实发布日，**绝不可**聚在 `lastmod` 的那几天。
      **若出现「published_at ≈ lastmod」→ 提取没生效、退回了 lastmod 语义 → 立即回滚**
- [ ] 5.4 **样板核验（新采文章必须为 0）**：
      ```sql
      SELECT count(*) FROM raw_items
      WHERE source='sitemap' AND first_seen_at >= '<部署时刻>'
        AND content LIKE 'Anthropic is an AI safety and research company%';
      ```
      采集器已把该串置 null（任务 2.1），故**任何 > 0 都只能来自补全的写回**（任务 2.3 没做/没生效）→ 立即修。
      ⚠️ 该 SQL **只能证伪、不能证明**——观察期内若一篇新文都没采到，它的 0 **不携带任何信息**。**证明由 2.5 的单测承担。**
- [ ] 5.5 观察 7 天：新文的 `published_at` 是否正确；**日报要闻段是否首次出现 Anthropic 官方新闻**；这些条目的摘要是否走了「无正文」护栏（只出 headline、不编内容）
- [ ] 5.6 **7 天观察窗的起算硬门 = 「CI 单测（2.5 + 3.1 + 1.2c）全绿」且「生产 SQL（5.3/5.4）在观察期内无新增违反」**。
      **MUST NOT** 以「5.4 的 SQL == 0」单独起算——**那个 0 可以来自一个真空**（无新文的日子里它恒为 0），**7 天的钟会从一个空的绿开始**。
      下游变更（P0 车道系列）以本观察窗为准入判据；**在 content 仍被补全写回样板的基线上观察 7 天 = 假绿信号**（日报摘要仍在拿样板当 grounding、语义相似度仍被样板抬高）。**任何早于该硬门时点的观察数据一律作废、不得用于下游变更的准入。**

## 6. 归档顺序（守卫，MUST）

- [ ] 6.1 **本变更 MUST 先于 `unify-judge-stage` 归档。**
      **原因**：`openspec-cn` 的归档守卫要求 MODIFIED 块的场景名集合是**主规范该需求场景名的超集**（少一个即 throw），而 MODIFIED 是**整条需求替换**。若 `unify-judge-stage` 先归档，它给 `source-content-enrichment` 写进主规范的**新场景名**在本变更的 MODIFIED 块里不存在 ⇒ 本变更归档时守卫 throw ⇒ **最省事的「修法」是给本变更补上那些场景名却保留旧正文 = 静默回滚 `unify-judge-stage` 的结构性改动**。
      两者都改 `source-content-enrichment`，顺序错了没有安全的补救路径。

## 7. `published_at` 归集：从「先到者永久胜出」改为「权威等级高者胜出」

> **没有这一节，本变更的页面日期提取【死于到达】**：生产实测三条 Anthropic 官宣（`fable-mythos-access` / `introducing-claude-tag` / `claude-sonnet-5`）的事件 `published_at` **全部来自 HN 的投稿时刻**——HN 先到、值已非 NULL，`COALESCE` 让**后到的一切**（含 RSS 的日期）被丢弃。上 HN 的恰恰是重大模型发布 = P0 车道存在的全部理由。落地后，sitemap 精确提取的发布日会在**每一篇上了 HN 的文章**上被同一个 `COALESCE` 丢弃。

- [ ] 7.1 **⚠️ 一条【不要做】的事（先读）：MUST NOT 引入「rss / sitemap 比 hacker_news 权威」的源级排序。** 实测 HN 与 RSS 不一致的事件里 `off_days` **大多是负的**（HN 的日期比 RSS **更早**：`hn=2026-06-29 / rss=2026-07-11`、`hn=2026-07-07 / rss=2026-07-11`）。**哪个是文章真正的发布日，数据里根本没有。** 按「rss > hn」去「修」会把这些事件的 `published_at` 往**后**推 1~12 天 ⇒ **让老文看起来更新** ⇒ 正是本变更要防的方向。
      **只有一条权威关系**：「**页面提取的发布日**」是权威的、MUST 覆盖已有值；**其余源之间不判高下**（同为近似值），维持既有的 NULL-fill + 先到者胜出。
- [ ] 7.1b **权威等级 MUST 为【四级】，LLM 推断绝不可与程序取得的事实同级**（⚠️ 第一架构原则）：
      ```
      0 = NULL（无日期）
      1 = LLM 推断        ← published-at-inference 的 AI 回填（它是【猜】的）
      2 = 程序取得的近似值 ← hacker_news 投稿时刻 / rss pubDate / github push 时刻（是【真实时间戳】，只是不是发布日）
      3 = 页面确定性提取   ← sitemap（全系统唯一的真发布日）
      ```
      **三级方案（AI 回填与 rss/hn 同为 1）是错的**：口径定死「同等级不覆盖」⇒ 第 1 天 AI 猜一个日期（1）、第 2 天该文上 HN 带来**真实投稿时间戳**（亦为 1）⇒ `1 > 1` 不成立 ⇒ 不覆盖 ⇒ **LLM 的猜测永久挡住了一个真实时间戳** ⇒ 直接违反「精确事实由程序与 DB 保障，绝不交 LLM」。
      **为何这个排序是对的**：真实时间戳（2）覆盖 LLM 猜测（1）——**程序 > LLM**；页面提取（3）覆盖一切；**近似值之间（2 vs 2）仍不覆盖** ⇒ rss/hn/github 之间**行为零变化**。
- [ ] 7.2 **schema + 迁移**（`drizzle/0013_*.sql`，下一个序号）。**⚠️ 语句顺序 MUST 逐字照抄——顺序错则生产迁移当场中止，而空库 CI 恒绿**：
      ```sql
      ALTER TABLE ai_news_events ADD COLUMN published_at_authority smallint NOT NULL DEFAULT 0;
      -- 0 = 无日期 / 1 = LLM 推断 / 2 = 程序取得的近似值 / 3 = 页面确定性提取

      UPDATE ai_news_events SET published_at_authority = 2 WHERE published_at IS NOT NULL;

      ALTER TABLE ai_news_events ADD CONSTRAINT ai_news_events_published_at_authority_check
        CHECK ((published_at IS NULL) = (published_at_authority = 0));   -- 【最后】才加约束
      ```
      **`CHECK` MUST 是最后一条**：drizzle-kit 从 schema 生成时会把 `ADD COLUMN` 与 `ADD CONSTRAINT` **一起**吐出，而手工插 `UPDATE` 的自然位置是**文件末尾** ⇒ 得到「先加 CHECK、再回填」⇒ 加约束的瞬间存量**每一行**（`published_at IS NOT NULL AND authority = 0`，列的 DEFAULT）**全部违反** ⇒ **迁移 abort、容器起不来**。
      **存量回填值取 2（不是 1）+ 登记不精确性**：存量的非空 `published_at` 里**确实混有** AI 推断写入的值（`backfill.ts` 已在生产跑），而该列不区分来源 ⇒ **无法把它们与程序值分开** ⇒ 保守统一置 **2**。代价：这些行被误标为「程序近似」，故不会被真实的 rss/hn 日期覆盖——**与今天的 `COALESCE` 行为完全一致，零回归**。
      **⛔ 存量 `published_at` 一行不动**（迁移里 MUST NOT 出现任何写 `published_at` 的语句）。**理由 MUST 逐字保留**：HN 与 RSS 不一致的事件**真值未知**（见 7.1），「清洗」等于瞎猜；而猜错的方向会让老文看起来更新。
- [ ] 7.3 **权威值的推导 MUST 由 `raw_items.source` 得出**（**不给 `raw_items` 加列**——本变更已 MUST「sitemap 的 `published_at` 只可能是页面提取值、`lastmod` MUST NOT 写入」，故可由 source 推导）：
      ```
      authority = CASE WHEN raw_items.published_at IS NULL THEN 0
                       WHEN raw_items.source = 'sitemap'   THEN 3
                       ELSE                                     2 END
      -- 等级 1 不由塌缩产出：只有 published-at-inference 的 CAS 回填写它（见 7.6）
      ```
- [ ] 7.3b **⚠️ `RawItemForCollapse` 没有 `source` —— 写成可选就让整个变更变成 no-op（编译通过、测试全绿）**：
      - `src/dedup/collapse.ts:32-44` 的 `RawItemForCollapse` **无 `source` 字段**；`:314-320` 的候选 SELECT **不投影 `rawItems.source`**。而 7.3 推导的**全部依据**就是 `raw_items.source`。
      - **MUST 写成 `source: string`（required，非可选）**。写成 `source?: string | null`（既有的 `publishedAt?: Date | null` 就是这个风格）⇒ 全部既有调用点/测试 seed **不改就编译通过** ⇒ `source` 为 `undefined` ⇒ 推导退化为「有日期即 2」⇒ **sitemap 恒为 2** ⇒ **页面提取的日期永不覆盖 HN 的投稿时刻** ⇒ **整个变更对「上了 HN 的重大发布」是 no-op**——而 `CHECK` 满足、迁移正常、单测（手工构造 item 时会记得传 source）**全绿**。
      - 塌缩候选 SELECT MUST 投影 `source: rawItems.source`（`collapse.ts:314-320`）。
      - **外部构造 `RawItemForCollapse` 的 4 处会编译报错**——**这是好事**（required 的全部目的），但 MUST 纳入工作量：`collapse.integration.test.ts:142/149`、`score-events.integration.test.ts:107`、`claim.integration.test.ts:58`、`alert-scan.integration.test.ts:329`。
      - **验收 MUST 走 `collapseUncollapsedRawItems`（读真库的集成测试）**，**MUST NOT** 只用手搭 item 的单测——手搭时会记得传 `source`，陷阱不暴露。
- [ ] 7.4 **硬去重塌缩**（`src/dedup/collapse.ts:162` 的 `onConflictDoUpdate.set`）：`publishedAt: sql\`COALESCE(…)\`` 改为
      ```sql
      published_at = CASE WHEN EXCLUDED.published_at_authority > ai_news_events.published_at_authority
                            THEN EXCLUDED.published_at ELSE ai_news_events.published_at END,
      published_at_authority = GREATEST(ai_news_events.published_at_authority, EXCLUDED.published_at_authority)
      ```
      **这两行就够，MUST 在代码注释与规范里写清「没漏 NULL-fill」**（否则下一个人会以为漏了）：不变量 `published_at IS NULL ⟺ authority = 0` 使 **NULL-fill 成为「权威高者胜出」的一个特例**——已有 NULL ⇒ authority=0 ⇒ 任何非空来者（≥1）> 0 ⇒ 自动填入；**同权威（2 vs 2）不覆盖** ⇒ 程序近似值之间维持既有的「先到者胜出」，**行为零变化**；程序近似（2）> LLM 推断（1）；页面提取（3）> 一切。
      **INSERT 分支**同步写入推导出的 `published_at_authority`。
- [ ] 7.4b **tombstone 改投分支**（`rerouteToSurvivor`，`collapse.ts:198,247-253`）：**该函数今天完全不写 `published_at`**（只累加 `source_count` + 更新 `last_seen_at`），而 tombstone 改投分支是那条 raw_item 的**唯一**写入路径 ⇒ 不改就**丢掉 authority=3 的精确日期**、且无任何后续路径会补。
      签名 MUST 加 `publishedAt` + `authority` 两参（`rerouteToSurvivor(tx, dedupKey, now, publishedAt, authority)`），对终态存活者按与 7.4 **同一口径**归集（「权威高者胜出 + `GREATEST`」），**MUST NOT 退回单向 NULL-fill、MUST NOT 干脆不写**。
- [ ] 7.5 **语义合并同规则**（`semantic-dedup` 主规范「确定性事件合并」的**第二个副本**：`published_at = COALESCE(存活, 被吞)`）：改为「被吞者 authority **严格更高**才取代存活者的值」+ `published_at_authority = GREATEST(...)`。**这一处 MUST 一并改，否则修一半**——存活者按 `first_seen_at` 定，与「谁的日期更精确」毫无关系（HN 先塌缩出的事件吞掉带页面提取日期的事件时，旧口径会把精确值丢弃）。
- [ ] 7.6 **AI 推断回填**（`published-at-inference` 的 CAS 回填 `WHERE published_at IS NULL`）MUST 同时把 `published_at_authority` 置 **1 = LLM 推断**（四级里**最低的非零级**）——既不能留在 0（破坏 `published_at IS NULL ⟺ authority = 0` 不变量、被 `CHECK` 拒绝），也**MUST NOT** 置 2 与程序取得的时间戳同级（同级不覆盖 ⇒ 猜测会永久挡住后到的真实 rss/hn 时间戳，见 7.1b）。
- [ ] 7.7 单测：
      - 同 `dedup_key`，先 `hacker_news`（有日期，authority=2）后 `sitemap`（页面提取日期）→ 事件 `published_at` **= sitemap 的值**、`authority = 3`
      - 先 `sitemap` 后 `hacker_news` → `published_at` **不变**（仍是页面提取值）、`authority` 仍为 3
      - 先 `hacker_news` 后 `rss`（均 authority=2）→ `published_at` **不变**（先到者胜出，**行为与本变更前一致**）
      - 事件已有 AI 推断值（authority=1），后到 `hacker_news`（authority=2）→ `published_at` **被真实时间戳取代**、`authority=2`（**程序 > LLM**）
      - 首建 `published_at IS NULL`（authority=0），后到任一带日期的源 → 补入（NULL-fill 特例）
      - 语义合并：存活者 authority=2、被吞者 authority=3 → 存活者的 `published_at` 被取代、`authority=3`
      - **塌缩集成测试（读真库，7.3b 的权威验收）**：经 `collapseUncollapsedRawItems` 从真实 `raw_items` 塌缩（**不手搭 item**），`source='sitemap'` 的行推导出 `authority=3`——**手搭 item 的单测不算数**（手搭时会传 `source`，可选字段的陷阱不暴露）
      - **tombstone 改投**（7.4b）：命中 tombstone 的 sitemap raw_item（authority=3）→ 终态存活者的 `published_at` 被取代、`authority=3`

## 8. 运维告警 sink：把 `AlertSink` 接上真通道，幂等交给 DB

> **没有这一节，本变更所有「MUST 告警」都是空的**：`run-daily-workflow.ts:136` 的 `defaultAlert = (msg, detail) => console.error('[pipeline][ALERT] …')`，而 `worker.ts` **不传 alert** ⇒ **生产用的就是它**。规范反复建立的「`logError` 不是告警 / `classifySystemFailure` 才是」——**在代码里是同一个 `console.error`，只差一个前缀**。

- [ ] 8.0 **⚠️ 先做这条，否则 sink 会把【4 条既有告警】变成静默**：`run-daily-workflow.ts` 有 **5 个** `alert()` 调用点，其中 **4 个不带 `dedupKey`**。sink 契约是「`dedupKey = detail.dedupKey`」，而 `push_records.target_id` 是 **`varchar(128) NOT NULL`**（`schema.ts:191`）⇒ `target_id = undefined` ⇒ **NOT NULL 违反** ⇒ 被 sink 自己的 best-effort catch 吞掉 ⇒ **这 4 条告警连 stderr 都不再有**（今天至少还进 stderr）；而 sink 的单测（都传 `dedupKey`）**全绿**。⇒ **为了让新告警落地而引入的 sink，会把 4 条已经存在的告警变成静默**（`add-per-source-staleness-alert` 那条能力当场作废）。
      **① `AlertSink` 的 detail MUST 收窄为必填 `dedupKey`**（**枚举必漏，编译器不漏**——收窄会逼出全部 5 个调用点）：
      ```ts
      interface AlertDetail { dedupKey: string; [k: string]: unknown }
      type AlertSink = (message: string, detail: AlertDetail) => void | Promise<void>;
      ```
      **② 逐个分配 `dedupKey`**：
      | 调用点 | dedupKey |
      |---|---|
      | `:499` 系统级故障 | `kind`（已有）|
      | `:531` 源陈旧度 | **`source-staleness:<source>`（per-source！否则多源塌成一条）** |
      | `:641` judge 熔断 | `degrade-abort:value-judge` |
      | `:783` digest 熔断 | `degrade-abort:digest` |
      | `:980` 租约已失 | `digest-lease-lost` |
      **③ `AlertSink` MUST 可返回 `Promise<void>`，且 5 个调用点 MUST `await`**：sink 要做 DB INSERT + 网络发送 + 状态 UPDATE，全是异步；而 `:641 / :783 / :980` **紧接着就 throw**（`WorkflowAbortError` / lease-lost）⇒ 不 await 则告警是个游离 Promise、工作流已在栈上抛错、job 已失败 ⇒ **投递零完成保证**。
- [ ] 8.1 新增 `createOpsAlertSink({ sender, dbh, channels, now }): AlertSink`：
      ```
      alert(message, detail) →
        ① dedupKey = detail.dedupKey                      // 类型上必填（8.0）
        ② push_date = dateInTimeZone(now())               // Asia/Shanghai，绝不可用 UTC 日（8.1b）
        ③ INSERT push_records (target_type='ops-alert', target_id=dedupKey,
                               channel, push_date, status='pending')
           ON CONFLICT DO NOTHING
           → 命中 0 行 ⇒ 今天已就该 dedupKey 告过警 ⇒ 【直接 return，不发】
        ④ 经 sender 发送（复用仓内既有 createFeishuSender）
        ⑤ 成功 → status='success'；失败 → 【不得占用当日限频名额】（8.1c）
      ```
      **限频状态住在 DB 的 `UNIQUE(target_type, target_id, channel, push_date)` 里**（`schema.ts:201`，本仓推送幂等地基）。**三个白拿好处 MUST 写进规范/注释**：
      - **零新状态**：不需要 Redis 键、不需要进程内 Map（后者每次 redeploy 复位 ⇒「今天已告过 / 连续 N 轮」永不达标 ⇒ **静默不告警**）
      - **跨进程 / 跨重启 / 跨两条链自动去重**：日报链与高频告警链用同一个 `dedupKey` ⇒ 一条先告了，另一条自动命中唯一键冲突而跳过（**该收益以 8.1b 的时区口径为前提**）
      - **与第一架构原则一致**：幂等由 DB 唯一约束保障，绝不交给应用层自由发挥
- [ ] 8.1b **⚠️ `push_date` 的时区口径 MUST 钉死，否则「跨两条链自动去重」是假的、天天双响**：MUST 用 `src/push/push-date.ts` 的 `dateInTimeZone(date, env.PUSH_TIMEZONE)`（`Asia/Shanghai`，仓内**唯一**正确口径），**MUST NOT** 用 UTC 日（`toISOString().slice(0,10)` 是最常见的错误写法）。
      **理由 MUST 逐字写进规范**：**UTC 日界 = 08:00 CST，而日报链恰在 08:03 CST 跑**——只差 3 分钟 ⇒ 07:49 那一轮高频链的告警落 `push_date = D-1`、日报链落 `push_date = D` ⇒ **唯一键不冲突** ⇒ **持续故障期天天双响**。
      `createOpsAlertSink` MUST 支持注入 `now`（可测），两条链 MUST 传同一口径的运行时刻。
- [ ] 8.1c **⚠️ 发送失败（`status='failed'`）MUST NOT 占用当日限频名额**：否则同一 `dedupKey` 的下次告警会命中 `ON CONFLICT DO NOTHING`（0 行）而跳过 ⇒ **一次发送失败 = 该告警当天彻底哑火**。**MUST 择一落地并写清**：失败时**删除**该 pending 占位行（下轮可重新占位重试），**或**把限频判据改为「存在 `status='success'` 的行才算今天已告过」。**不得留给实现者临时发明。**
- [ ] 8.1d **通道选择 MUST 定死**：`createFeishuSender()` 依赖 `isFeishuEnabled()`，故 sink 的 channel 取「**已配置通道全集**」逐个发（与业务推送同口径）；**未配置任何通道时 MUST 回落 `console.error`，且 MUST NOT 写任何 `push_records` 行**——否则限频键把「没通道可发」也算成「今天已告过」，通道配好之后当天仍然静默。
- [ ] 8.2 `target_type = 'ops-alert'` MUST 扩入 `src/push/targets.ts` 的 `targetTypeEnum`（枚举集中收口、禁止散落字面量）。**与推送用的 `alert` 分属两个命名空间、绝不复用**（后者是 P0 实时告警的**内容**推送）。
- [ ] 8.2b **⚠️ 新 `target_type` 会污染既有的 MCP 工具（必然代价，MUST 显式登记并修）**：`src/mcp/tools/get-today.ts:71-88` 的 `push_records` 查询**不过滤 `target_type`**（只按 `push_date` + `status='success'`）⇒ 一条 `ops-alert` 的 success 行会让 `records.length > 0` ⇒ 不再返回「今日尚未推送」，而返回**空要闻段 + 空产品段**，且 `channels` 被 sink 的通道污染。
      **修法**：该 SQL 侧加 `targetType IN ('event','product')`。
- [ ] 8.3 **注入点是 `run(ctx)`，不是 `runDailyWorkflow`**（⚠️ 措辞错会把人指到错文件）：`src/pipeline/worker.ts:52` 实际调的是 `run(ctx)`（`run-daily-workflow.ts:1118`，自称「生产默认补齐 DI」）⇒ **真正的注入点是 `run()`**。在那里补齐 sink 的生产默认；不注入 ⇒ 落回 `defaultAlert` ⇒ 只进 stderr ⇒ 本节等于没做。
- [ ] 8.4 本变更的告警调用方（各自的 `dedupKey`）：
      - 日期提取归零（DB 复算）→ `'sitemap-date-extraction-zero'`（任务 1.5b）
      - 源级健康告警（含 1.5c 的「窗内有候选零发射」throw 与既有的 `loc_count=0` throw）→ `'source-health:<source>'`（任务 1.5e）
      - **既有 5 个调用点全部接上同一个 sink**（8.0 的表）——它们今天也一样**只进 stderr**
- [ ] 8.5 单测：同一 `dedupKey` 当天第二次调用 → **不发送**（`INSERT ... ON CONFLICT DO NOTHING` 命中 0 行）；不同 `dedupKey` → 各发一次；**sender 抛错后同 `dedupKey` 再次告警 → 仍会发送**（8.1c：失败不占名额）；**未配置任何通道 → 不写 `push_records` 行、回落 `console.error`**（8.1d）；**跨 UTC 日界但同一 `Asia/Shanghai` 日的两次调用（07:49 与 08:03 CST）→ 只发一次**（8.1b）；sender 抛错 → 记日志、**不向上抛**（best-effort，告警链路绝不把它监视的工作流搞崩）

## 9. `CHECK` 约束会当场打挂既有测试 seed（工作量 MUST 纳入）

> `published_at_authority NOT NULL DEFAULT 0` + `CHECK ((published_at IS NULL) = (published_at_authority = 0))` ⇒ **任何写 `published_at` 非空、却不写 authority 的 INSERT 当场违约**。生产写路径已被任务 7 覆盖 ✅；**测试 seed 一处没提** ❌。失败方向是对的（fail-loud，不会静默漏），但它**不是零成本**。

- [ ] 9.1 **seed helper 统一改为写 `(published_at, published_at_authority)` 二元组**（非空 → 2、NULL → 0）。已核实受影响的 seed 点（14 处）：
      `alert-scan.integration.test.ts:150,608,761` · `run-daily-workflow.integration.test.ts:452,869` · `weekly-report.integration.test.ts:92` · `top-n.integration.test.ts:58` · `kb-ingestion.integration.test.ts:79` · `retrieval.integration.test.ts:121` · `backfill.integration.test.ts:89` · `digest-persistence.integration.test.ts:67` · `merge-events.integration.test.ts:66` · `mcp/query-tools.integration.test.ts:77` · `push-event-now.integration.test.ts:68` · `mark-tools.integration.test.ts:27`
- [ ] 9.2 **一条 `CHECK` 回归测试**：直接 INSERT `published_at` 非空 + `published_at_authority = 0` → DB 拒绝；INSERT `published_at` NULL + `authority > 0` → DB 拒绝。（防日后有人把 `CHECK` 从迁移里悄悄拿掉——不变量是「权威高者胜出即隐含 NULL-fill」的**全部依据**。）
