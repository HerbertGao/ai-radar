## MODIFIED Requirements

### 需求:sitemap 增量采集（无 RSS 的 lab 一手新闻）

系统 MUST 提供一个**配置驱动的 sitemap 增量采集器**，用于接入「无原生 RSS、但有 `sitemap.xml` 且文章页服务端渲染含 `og:` 标签」的一手 lab 新闻源（首期：Anthropic News）。配置 MUST 为列表，每项含 `sitemap URL`、`路径前缀`（如 `/news/`）、`vendor`（如 `anthropic`）。

采集流程 MUST 为：① fetch `sitemap.xml`，**正则线性切块**解析每个 `<url>` 的 `<loc>` 与 `<lastmod>`（MUST 用 `indexOf` 切块/取标签而非整-xml lazy 捕获正则，防未闭合标签的二次方回溯 ReDoS；标准无前缀 `<loc>` 才取，排除 `image:loc` 等扩展命名空间标签）；② 对每个 `loc` 先 `c = normalizeUrl(loc)`（`normalizeUrl` 内部 try/catch、对畸形/非 http/相对无 base 的 loc 返 null 而不裸抛——MUST NOT 用裸 `new URL(loc)` 直接取 pathname，否则相对 loc 会抛 `TypeError` 中断该源）；`c === null` 跳过该 loc；否则按 `new URL(c).pathname` **以配置路径前缀开头**（`startsWith`，在已规范化的绝对 URL 上取 pathname，**非**裸字符串 `contains` 以免误匹配 query-string/fragment）、文章 host 与 sitemap host **同注册域**（剥 `www.` 后相等或为其子域，防 SSRF 抓内网/元数据 host）、`lastmod` 在近 `FIRST_SEEN_WINDOW_DAYS` 天窗内、**且 `c`（即 `canonical_url`）不在「DB 已见集」**（见下「增量语义」）同时满足才纳入；③ 对**每个窗内未见 URL** fetch 文章 HTML、提取 `og:title`（→ `title`）与 `og:description`（→ `content`）；④ 映射为 `CollectedItem`：`source='sitemap'`、`metadata.vendor=<配置 vendor>`、`metadata.feed_url=<sitemap URL>`、`metadata.lastmod=<lastmod>`、`url=文章 URL`、**`published_at = <页面确定性提取的发布日 | null>`**（见下「时效正确性」）、**`raw_type='news'`**、`source_item_id = canonical_url(文章 URL)`（即步骤②的 `c`，恒非 null——null loc 已在②跳过、不发射），**仅 `c` 长度 > 255 时 MUST 折叠为既有 `contentHash(title, content)` 函数**（`raw_items.source_item_id` 为 `varchar(255)`，超界会在 store 阶段 INSERT 抛错且不被采集器隔离，故采集器侧前置折叠）。**无 `normalizeUrl=null → contentHash` 兜底**（与「null loc 过滤阶段跳过」一致，避免矛盾及 `canonical_url=NULL` 入库致去重失效）。`og:title` 缺失时 MUST 回退（如 URL slug 派生，回退值经危险字符净化）以保证 `title` 非空；`og:title` 与 `og:description` **同时缺失**时 MUST **跳过该篇、不发射**（防 slug-title + null-content 退化垃圾进日报候选）。

**文本安全（MUST）**：所有进 `raw_items` 文本列（`title`/`content`/`metadata` 字符串值）的值——无论来自 og 标签、实体解码、URL slug 派生——MUST 剔除 NUL/C0 控制字符（保留 `\t\n\r`）与 lone surrogate（保留合法 emoji 代理对），防 Postgres `text` INSERT 遇 NUL 抛错中止整批、lone surrogate 破坏下游 `JSON.stringify`。XML/HTML 实体解码 MUST 同时支持命名实体与数字字符引用（`&#NNN;`/`&#xHH;`），且数字实体解出的危险码点同样剔除。

**时效正确性（MUST，本需求修改点）**：

**① `lastmod` MUST NOT 写入 `published_at`，亦 MUST NOT 作为发布日期的推断线索**（既有红线不变）。`lastmod` 是「最后修改」时间：实测该源 241 条 `/news/` 的 lastmod **分散**于 2024-08 … 2026-07（最大簇 19 条 @2025-07-23），且**老文会被批量重渲染刷新**——一篇 **2023-09-19** 发布的文章其 `lastmod` 为 **2026-07-09**（偏差近 3 年）。把它当发布日（或递给推断 Agent 当**唯一**线索——该源标题/URL/正文确实都无日期）会把老文洗成「今天」，而范围校验、时效窗口、基线水位**一道都挡不住**（它们只拒未来值）。`lastmod` 仅入 `metadata.lastmod` + 窗口 diff 粗筛。

**② `published_at` MUST 由 per-article 页面**确定性提取**（本需求修改点）**。采集器**已经**在 per-article 阶段下载整张文章 HTML（取 `og:` 标签），MUST 在同一阶段提取真实发布日：

- **锚定 MUST 为「文档中有且仅有一个 `<h1>`」**（实测 30/30 成立），取其后**紧邻元素**。**MUST NOT 用「`og:title` 文本相等」作锚点**——实测**仅 18/30** 成立（反例 `core-views-on-ai-safety`：`og:title` = `Anthropic's core views on AI safety`、`<h1>` = `Core views on AI safety: When, why, what, and how`），会**丢弃 40% 有日期的页面**。`<h1>` 数量 ≠ 1 → `published_at = null`（**干净失败**；站点日后加 nav / 卡片 h1 时正是这条守住）。
- **MUST 为整串全匹配**（如 `^\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*$`），**MUST NOT 做子串搜索**。子串搜索的失败模式**不是「找不到」，是「找到错的」**：`By Jane Doe · Mar 2, 2025 · 5 min read` 照样被抠出日期、`Updated Jan 5, 2024` 会抠出**修订日**。而**页面上的错误日期天然落在合理范围内** → 范围校验 / 时效窗口 / 基线水位**一道都挡不住** → **老文被当今日突发**。**整串全匹配把「提取到错的」变成「什么都没提取到」——脏失败转干净失败，使「失败 → NULL → 回落」这条安全论证真正成立。**
- **解析口径 MUST 定死**：日期串无时区 → MUST 以 **`Date.UTC(y, m, d)`** 显式构造 UTC 零点，**MUST NOT** `new Date(str)`（V8 对非 ISO 串按**运行时本地时区**解析 → 容器 TZ 变化致下游时效窗边界漂 ≤1 天）。**合理下限 MUST 为常量 `2015-01-01`**。经 `2015-01-01 <= d <= now` 校验；越界 → `null`。
- **ReDoS（MUST，本文件正为此被重写过）**：定位 `<h1>` MUST 沿用本采集器既有范式——`indexOf` 线性切块（未找到立即 bail）+ **有界 slice** 再在小串上跑锚定正则。MUST NOT 用 `[\s\S]*?` 跨整张 5MB HTML 的懒惰捕获（`parseSitemap` 当初正是因此从 lazy-capture 重写为 `indexOf`——实测 1MB 未闭合 `<url>` 需 29s）。
- **提取失败 / 越界 → `published_at` 置 `null`，且 MUST NOT 回落 AI 推断**：本源的事件 MUST NOT 进入 `published-at-inference` 的回填域（见该能力的「确定性提取源豁免 AI 发布日推断」需求）。**降级方向 = 无日期 = 不推送**——宁可漏，绝不把一个猜出来的日期当精确事实。
- **本源的 `published_at` MUST 只可能是「页面确定性提取值」这一种语义**（`lastmod` 已被①明令禁止写入、AI 推断已被本源豁免）。这条不是文字游戏，它是下游能**由 `source` 推导发布日权威等级**的全部依据：事件层的 `published_at_authority`（`sitemap` → **3**「页面提取」、其余程序源 → **2**「程序近似值」、AI 推断 → **1**，见 dedup-and-normalization「基于 dedup_key 的硬去重塌缩」）**不需要给 `raw_items` 加列**，正是因为本源恒不产出第二种语义的值。**任何日后想让本采集器在提取失败时写入某个「近似日期」（`lastmod`、fetch 时刻、任何猜测值）的改动，MUST 先推翻该推导**——否则一个近似值会被下游当成 authority=3 的精确事实，去**覆盖**其它源的日期。
- **该失败 MUST 被登记为【永久且不可恢复】**：提取失败的文章照常入库 ⇒ 进「DB 已见集」⇒ **永不重采**（已见集前置过滤 + store 的 `ON CONFLICT DO NOTHING`），而回填域已排除本源 ⇒ **没有任何写路径会再写它的 `published_at`**。⇒ 这些文章**永远不可见，包括提取器日后被修好之后**。**MUST NOT** 把它描述成「修好即恢复」的可恢复降级。故提取失败 MUST 当场告警（见下「可观测契约」）；若日后要补救，MUST 是一个**确定性**重提取域（如 `source='sitemap' AND published_at IS NULL AND first_seen_at > now() - interval '3 days'` 重抓页面、重跑提取器），**MUST NOT 回落 LLM 猜测**。

> **为何必须程序提取而非 LLM 推断，且本源 MUST NOT 回落 LLM 推断**：发布日是**精确事实**，而第一架构原则为「精确事实由程序与 DB 保障，**绝不交 LLM**」。AI 推断是确定性来源缺失时的最后手段——**但它成立的前提是「有线索可依」**。本源**没有**：URL 无日期、标题无日期、`og:description` 是全站样板（见③），推断 Agent 唯一的输入是**模型的训练记忆**。
>
> **同一份规范不能有两套标准**：上一条 bullet 枪毙子串搜索，理由是「页面上的错误日期天然落在合理范围内 ⇒ 范围校验 / 时效窗口 / 基线水位一道都挡不住 ⇒ 老文被当今日突发」。**这段话逐字适用于本源上的 LLM 推断**（生产实测：它确实会从训练记忆里报出老文日期，如 `Golden Gate Claude → 2024-05-21`；它的全部防线也只有一道「拒未来值」的范围校验 + 一段 prompt）。**正则被要求「只准干净失败」，LLM 不能只被要求「读一段 prompt」。** 故本源关掉推断兜底（**只关本源**；其余源的 URL / 标题 / 正文里确有日期线索，推断在那里是**有依据的语义补全**，不是猜）。

**③ 全站样板 `og:description` MUST 视同缺失（本需求修改点）**：实测该源 14 篇最新文章中 **6 篇**的 `og:description` **逐字相同**（`Anthropic is an AI safety and research company that's working to build reliable, interpretable, and steerable AI systems.`）。该常量串落进 `raw_items.content` 后，**因其非空**而使三道下游护栏**构造性失效**：① 摘要防幻觉护栏（`hasContent` 判非空）**不触发**，LLM 拿样板当 grounding 写摘要（**比无正文更糟**）；② 正文补全工作集（判 `content` 为空）**永久排除**这些行；③ 语义合并的灰区判中，**两篇不同文章的 `Content:` 为同一串**，系统性推高误并。

故采集器 MUST 把已知全站样板 `og:description` **视同缺失**（`content = null`）。样板视同缺失后条目**照常发射**（仅 `content=null`），MUST NOT 因此跳过整篇。

**顺序 MUST**：样板判定 MUST 在 M-1 的「`og:title` 与 `og:description` **双缺**（**AND**）→ 跳过该篇」检查**之后**作用于 `og:description`。**MUST NOT 反序**——先把样板置 `null`、再判双缺，会使「缺 `og:title` + 样板 `og:description`」的页面从「以 URL slug 派生 `title` **照常发射**」**翻转为「整篇跳过」**，即样板判定意外收紧了 M-1 的跳过面（一个未经授权的可观测行为变化）。

**增量语义（MUST，无游标 → DB 已见集 + best-effort 窗口）**：sitemap 采集器无 arXiv 式游标。per-article fetch 前 MUST 查「DB 已见集」（`SELECT canonical_url FROM raw_items WHERE source='sitemap'`），跳过已入库 URL，使同一文章只 fetch HTML 一次（消除每轮重复抓取）。窗口（`FIRST_SEEN_WINDOW_DAYS`）仅作候选粗筛。该机制 MUST 显式声明为 **best-effort 窗口快照 + DB 去重、非 at-least-once 增量**；窗口默认应显著大于最坏调度间隔以降跳窗漏采概率。`lastmod` 缺失/解析为 NaN 的 URL MUST **保守跳过**（无法判定是否窗内、避免一次性灌入全站老文）；`loc` 经 `normalizeUrl` 为 null（畸形/非 http）的条目 MUST 在过滤阶段跳过（避免以 `canonical_url=NULL` 入库污染已见集去重）。**已见集查询失败语义（MUST）**：已见集查询失败（DB 不可达/超时）时采集器 MUST 让整源失败（抛出由 `allSettled` 隔离），MUST NOT 降级为空已见集（否则窗内 URL 全被当未见 → per-article 全量重抓风暴）。**first-fetch-wins（本期接受属性）**：按 `canonical_url` 跳过 + store `ON CONFLICT DO NOTHING` ⇒ 文章首次入库后其 og 内容/lastmod 后续更新永不重抓；对近 immutable 的 news 本期接受，P3 若需追更以 `metadata.lastmod` 变化触发。

**可观测契约（MUST，防站点改版静默归零）**：采集器 MUST 对每源记录 `loc_count`/`path_match_count`/`window_candidate_count`/`emitted_count`，并 MUST 记录**日期提取**的 `date_extracted_count`/`date_missing_count`。

**改版静默死亡有【两种】形态，二者 MUST 各有一条告警支路（本需求修改点）。** 两条告警 MUST 经运维告警 sink 落**真实通道**并由 DB 唯一约束限频（见 platform-foundation「运维告警落真实通道并由 DB 唯一约束限频」），MUST NOT 只落日志——**一个落 stdout 的计数器不是告警**。

两条支路的**判据落点不同，且都 MUST NOT 建立在「本轮这条链采到了什么」之上**（见下「为何不能用本轮采集结果作判据」）：

1. **文章页还在、但日期没了**（h1 数变了 / 日期格式变了）⇒ 判据 MUST 为**日报链对 DB 的复算**，**MUST NOT** 读本轮的采集结果：

   ```sql
   SELECT count(*) AS emitted,
          count(*) FILTER (WHERE published_at IS NOT NULL) AS date_extracted
   FROM raw_items
   WHERE source = 'sitemap' AND fetched_at >= <今日 00:00，按 PUSH_TIMEZONE>
   ```

   `emitted > 0 且 date_extracted = 0` → 告警（幂等键 `dedupKey = 'sitemap-date-extraction-zero'`）。该告警 MUST 是一次**独立的 `alert` 调用**，**MUST NOT** 塞进系统级故障判定（`classifySystemFailure`）——后者的入参是「本轮采集统计」，用它就把判据重新绑回了「谁采的」。因提取失败**永久不可恢复**（见上「时效正确性 ②」），仅记计数器不够。

2. **文章页整体没了**（文章 URL 改版 → per-article fetch 全 404）⇒ 判据 MUST 落在**采集器内部**（计数器本来就在那里）：`window_candidate_count > 0 且 emitted_count = 0`（窗内有候选、一篇都没发射）时，采集器 MUST `logError` 并 **`throw` 使整源失败**（与既有的 `loc_count = 0` 的 throw **同款**）⇒ `perSource.ok = false` ⇒ 由下面的「源级健康告警」响（`dedupKey = 'source-health:sitemap'`）。

   **该 throw 不丢弃任何东西**（MUST 写清，否则读者会以为 throw 有代价）：`emitted_count = 0` 意味着本轮该源**本来就一条都没发射**，throw 丢弃的是一个空集合。

**为何两条判据都不能建立在「本轮这条链采到了什么」之上（MUST 逐字保留）**：`sitemap` 若被纳入高频实时链的采集子集，则高频链会**先**采走新文并入库 ⇒ 已见集（`raw_items WHERE source='sitemap'`，**不分链**）已含该文 ⇒ 日报链再跑 sitemap 时 `emitted_count = 0` **每天恒成立** ⇒ 任何「`emitted > 0` 且 …」形态的、读本轮采集结果的谓词**永不触发**。故：

- 支路 1 的判据 MUST 是 **DB 复算**——`raw_items` 是两条链**共同的事实源**，判据因而**与「谁采的」无关**。
- 支路 2 的判据 MUST 落在**采集器内部**——`window_candidate_count` / `emitted_count` 是**该次采集自身**的计数器，无论哪条链调用它都自洽；且**不需要任何新的回传管道**（计数器与 throw 都在采集器里，`CollectAllResult.perSource` 只有 `{ok, count, error}`、没有 per-source 计数器出口）。

⇒ 二者都**不需要**扩展「本轮采集统计」结构（`CollectStats`）、不需要新增 required 字段、不需要扩展系统级故障的 `kind` 取值域。

**`emitted_count = 0` 时 MUST NOT 触发支路 1**——彼时「提取率跌零」与「今天没新文」不可区分，告警会天天误报。而「今天没新文」在计数器上恰是 `window_candidate_count = 0`，与支路 2 的 `window_candidate_count > 0` **完全可分**——故支路 2 **不会**在无新文的日子误报。

**支路 1 只接日报链**：高频告警链有意不做系统级故障告警（空轮是常态，防刷屏），本条不改该口径。支路 2 在采集器内部，两条链调用都会 throw，其告警由源级健康告警统一限频（同 `dedupKey`、当天只响一次）。

**源级健康告警（MUST，本需求修改点）**：日报链 MUST 对本轮 `perSource.ok = false` 的**每一个源**各发一条告警（`dedupKey = 'source-health:<source>'`，per-source ——否则多源同时坏会塌成一条）。**本条不是锦上添花**：`perSource` 今天**由 registry 产出、却无任何消费者**，源失败只落 `logError` + `console.error` ⇒ 本需求里「`loc_count = 0` → throw → **计入告警**」这句话、以及上面支路 2 的整条链路，**在没有本条时全部落空**。

sitemap 返回 2xx 但 **`loc_count=0`**（非 XML/结构变更/正则全失配）MUST `logError` 并使**整个 `sitemap` source 判失败**（throw → `runRegistry` 经 `allSettled` 计 perSource.ok=false → 源级健康告警），MUST NOT 记为「成功 0 条」；`loc_count>0 && window_candidate_count=0` 才是正常「无窗内新文」。**粒度约束（P2）**：`perSource.ok` 按 `CollectorSource` 键控、`sitemap` 是单 registry 项聚合全部 `SITEMAP_SOURCES`，故 `loc_count=0`（及支路 2）的 throw 会失败**整个 sitemap source**（非「单个配置源」）；**P2 `SITEMAP_SOURCES` 仅含 Anthropic 一条**，整源=该配置源，语义无歧义。多配置源的 per-config 部分失败隔离（一个 lab 坏、其余照常 emit）须采集器内部聚合，留待第二个 sitemap lab 接入（见 design 待解决）。

sitemap 与文章 HTML 的解析 MUST 用确定性方式（如正则提取 `<loc>`/`<lastmod>`/`og:` 标签，与 arXiv OAI-PMH 正则解析同范式），**MUST NOT 引入 HTML 解析库（cheerio 等）或无头浏览器**；fetch MUST 限 body 大小上界 + 校验 content-type（防超大/畸形 body 拖垮解析）。每篇 fetch 与整源调用 MUST 带 `withRetry`，单篇失败跳过该篇、不拖垮该源，整源失败由 `allSettled` 隔离。`source='sitemap'`（通用机制）+ `metadata.vendor` 标识具体 lab；下游路由一律按 `raw_type` 不按 `source`，`raw_type='news'` 经事件塌缩正常纳入日报。多 sitemap 源共用 `source='sitemap'` 不需 RSS 式 feed 命名空间化，因去重键 `canonical_url(文章 URL)` 跨 vendor 本就全局唯一（含域名）；`UNIQUE(source, source_item_id)` 约束键正常即 `canonical_url`、仅 `len>255` 折叠为 `contentHash` 时由内容抗碰撞承载唯一，去重仍走 `canonical_url`。`CollectorSource` 与 registry MUST 扩入 `sitemap`，纳入 `collectAllSources`；MUST NOT 纳入 `REALTIME_NEWS_SOURCES`（per-article fetch 较重）或 `PRODUCT_SOURCES`。

#### 场景:sitemap-diff 取窗内未见文章、跳过已采
- **当** 采集器 fetch 配置的 sitemap，某 `/news/` URL 的 `lastmod` 在近 N 天窗内
- **那么** 若其 `canonical_url` 不在 DB 已见集（`source='sitemap'`）则纳入采集；已在已见集的 URL 被跳过、不重复 fetch HTML；窗外（lastmod 过老）及 `lastmod` 缺失/NaN 的 URL 被跳过

#### 场景:per-article 提取 og 标签映射为 news（published_at 留 NULL 走 inference）
- **当** 对窗内未见文章 URL fetch HTML，页面**有且仅有一个 `<h1>`**，其后紧邻元素的文本**整串匹配** `Mon D, YYYY`
- **那么** 提取 `og:title` 作 `title`、`og:description` 作 `content`（样板则置 null）、**该日期经 `Date.UTC` 构造与范围校验后作 `published_at`**，映射为 `source='sitemap'`、`metadata.vendor`、`metadata.lastmod`、`raw_type='news'`、`source_item_id=canonical_url`（`len>255` 折叠 `contentHash`），进事件塌缩 → 日报候选
- **场景名中的「published_at 留 NULL 走 inference」为历史命名**（本需求修改前的行为），**以正文为准**：`published_at` 现由本阶段的确定性页面日期提取产出；提取失败时 `published_at` **保持 NULL 且不进 AI 推断**（本源已豁免，见上「② …MUST NOT 回落 AI 推断」）——**场景名里的「走 inference」已不再成立**。场景名保留原样是因为 openspec-cn 归档守卫要求 MODIFIED 块逐字保留主规范该需求的全部场景名——**改场景名会让归档直接失败**（与本 delta 保留「三源确定性采集」这类历史需求名同理）。

#### 场景:og:title 与 h1 文本不等时仍能提取日期
- **当** 某文章的 `og:title`（`Anthropic's core views on AI safety`）与其 `<h1>`（`Core views on AI safety: When, why, what, and how`）**不相等**，但文档只有一个 `<h1>`、其后紧邻元素为 `Mar 8, 2023`
- **那么** 提取**成功**（锚定条件是「唯一 h1」，**不是**「og:title 相等」）。**若以 `og:title` 相等作锚点，实测会丢弃 40% 有日期的页面**——正是本变更要修的那个 bug

#### 场景:日期元素含额外文本时整串全匹配失败置 NULL（不脏提取）
- **当** `<h1>` 后紧邻元素的文本为 `By Jane Doe · Mar 2, 2025 · 5 min read`，或为 `Updated Jan 5, 2024`（老文的修订日）
- **那么** 整串全匹配**失败** → `published_at = null`（**干净失败**；该事件不进 AI 推断回填域 → 无发布日 → 不推送）。**绝不可**用子串搜索从中抠出日期——那会把老文洗成一个「看起来很近」的日期，而范围校验 / 时效窗口 / 基线水位**一道都挡不住**

#### 场景:多个 h1 时干净失败
- **当** 页面含多个 `<h1>`（站点改版加了 nav / 相关文章卡片）
- **那么** `published_at = null`（**干净失败**：不锚到文档序第一个 `<h1>` 去猜，**也不回落 AI 推断**——本源的推断只能从训练记忆里猜，是同一个失效模式）；该条目无发布日 → 不推送（宁可漏）

#### 场景:全站样板 og:description 视同缺失
- **当** 某文章的 `og:description` 为该站的全站样板文案（如 `Anthropic is an AI safety and research company…`，实测 6/14 逐字相同）
- **那么** `content` 置 `null`（**视同缺失**）——使摘要防幻觉护栏正常触发（只出 headline、不拿样板当正文编内容）、使该行重新进入正文补全工作集、使语义合并不再以同一串样板比对两篇不同文章。该条目**仍照常发射**（M-1 的双缺跳过锚在 `og:title` 上）

#### 场景:og:title 缺失回退、og 双缺则跳过
- **当** 某文章页缺 `og:title` 但有 `og:description`
- **那么** 采集器以 URL slug 派生等回退值填 `title`，绝不写入空 `title`（`raw_items.title` NOT NULL）
- **当** 某文章页 `og:title` 与 `og:description` 同时缺失（非标准文章页/已改版）
- **那么** 采集器跳过该篇、不发射退化条目

#### 场景:图片扩展 image:loc 不被误当页面 loc
- **当** 某 `<url>` 块在标准 `<loc>` 前列出 Google 图片扩展 `<image:loc>`
- **那么** 采集器只取无命名空间前缀的标准 `<loc>` 作页面 URL，绝不把 `image:loc` 的图片地址误当文章去 fetch

#### 场景:文章 host 非 sitemap 注册域则跳过（SSRF 防护）
- **当** sitemap 列出的某 `/news/` loc 的 host 为内网/元数据/外域（如 `169.254.169.254`、`x.com.evil.com`）
- **那么** 采集器跳过该 loc、不对其 fetch；仅与 sitemap host 同注册域（剥 `www.` 后相等或其子域，apex 与 www 互通）的文章被采

#### 场景:sitemap 2xx 但解析 0 loc 判源失败（防静默归零）
- **当** sitemap.xml 返回 2xx 但正则解析出 0 个 `<loc>`（站点结构变更/正则失配）
- **那么** 采集器 `logError` 并将该源判为失败（perSource.ok=false、计入告警），绝不记为「成功 0 条」；仅 `loc_count>0` 且窗内候选为 0 时才视作正常「无新文」

#### 场景:日期提取归零由 DB 复算触发告警（与哪条链采的无关）
- **当** 站点改版致页面日期提取全失败（h1 数变了 / 日期格式变了），当天新入库的 sitemap raw_item 有若干条、但 `published_at` 全为 NULL
- **那么** 日报链以**对 `raw_items` 的 DB 复算**（`source='sitemap'` 且 `fetched_at >= 今日 00:00`，按 `PUSH_TIMEZONE`）判定 `emitted > 0 且 date_extracted = 0` → 经运维告警 sink 告警（`dedupKey='sitemap-date-extraction-zero'`）。判据**绝不可**取自「本轮这条链采集返回了什么」——高频链若也采 sitemap，会先把新文采走并入库、使日报链本轮 `emitted = 0` **每天恒成立**，那样的谓词**永不触发**；`raw_items` 是两条链共同的事实源，故 DB 复算与「谁采的」无关

#### 场景:窗内有候选却零发射时整源失败并告警
- **当** sitemap 本身健康（`loc_count > 0`、窗内有未见候选），但文章 URL 改版致每篇 per-article fetch 全 404（逐篇 `continue`、不拖垮该源）⇒ `window_candidate_count > 0` 且 `emitted_count = 0`
- **那么** 采集器 `logError` 并 **`throw` 使整源失败**（与 `loc_count = 0` 的 throw 同款）⇒ `perSource.ok = false` ⇒ 源级健康告警响（`dedupKey='source-health:sitemap'`）。该 throw **不丢弃任何条目**——`emitted_count = 0` 意味着本轮本就一条都没发射。判据留在采集器内部（计数器就在那里），**不需要**任何 per-source 计数器回传管道，也**不需要**扩展本轮采集统计结构

#### 场景:源级健康告警对每个失败源各响一条
- **当** 本轮采集中有一个或多个源失败（`perSource.ok = false`，含 `loc_count=0` 与「窗内有候选零发射」两种 throw）
- **那么** 日报链对**每一个**失败源各发一条告警（`dedupKey = 'source-health:<source>'`，per-source——绝不可把多个失败源塌成一条）。**没有本条，`perSource` 就是一个没有消费者的结构**（今天正是如此：源失败只落 `logError`），上面所有「throw → 计入告警」的链路全部落空

#### 场景:已见集查询失败时整源失败、不全量重抓
- **当** 「DB 已见集」查询（`SELECT canonical_url WHERE source='sitemap'`）因 DB 不可达/超时失败
- **那么** 采集器让整源失败（抛出由 `allSettled` 隔离），绝不降级为空已见集导致窗内 URL 被全量重抓

#### 场景:文本含 NUL/控制字符/lone surrogate 被净化
- **当** 文章 og 内容（或实体解码、slug 派生）含原始 NUL/C0 控制字符或数字实体 `&#0;`/lone surrogate
- **那么** 采集器净化后再入库（剔危险码点、保留 `\t\n\r` 与合法 emoji），绝不让 NUL 进 Postgres `text` 致 INSERT 抛错中止整批

#### 场景:单篇文章 fetch 失败不拖垮该源
- **当** 某窗内文章 HTML fetch 失败且重试耗尽
- **那么** 跳过该篇、记错误日志，该源其余文章照常采集；整源调用失败则由 `allSettled` 隔离、不拖垮其余源

#### 场景:sitemap 源不进实时告警/产品子集
- **当** 实时告警或产品发现链路选源采集
- **那么** `sitemap` 不在 `REALTIME_NEWS_SOURCES`/`PRODUCT_SOURCES` 内，仅在 `collectAllSources`（日报全集）被调用
