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
- **本源的 `published_at` MUST 只可能是「页面确定性提取值」这一种语义**（`lastmod` 已被①明令禁止写入、AI 推断已被本源豁免）。这条不是文字游戏，它是下游能**由 `source` 推导发布日权威等级**的全部依据：事件层的 `published_at_authority`（`sitemap` → **2**「页面确定性提取」、**其余一切非页面提取的日期值**（rss 的 `pubDate` / hacker_news 与 show_hn 的投稿时刻 / github 的 push 时刻 / AI 推断）→ **1**、无日期 → 0，见 dedup-and-normalization「基于 dedup_key 的硬去重塌缩」）**不需要给 `raw_items` 加列**，正是因为本源恒不产出第二种语义的值。**任何日后想让本采集器在提取失败时写入某个「近似日期」（`lastmod`、fetch 时刻、任何猜测值）的改动，MUST 先推翻该推导**——否则一个近似值会被下游当成 authority=2 的「文章自己印的发布日」，去**覆盖**其它源的日期。
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

**高频实时链 MUST 同样消费 `perSource`（本需求修改点，在上一条之上【追加】而非替换）**：`sitemap` 纳入实时子集后（见下「实时子集归属」），高频链每天跑 72–96 轮；若只有日报链发源级告警，站点改版把某源打成结构性失败时，本车道会**静默丢掉该源最长 24 小时**——而 ≤20min 的采集延迟正是本车道唯一收益。两条链 MUST **共用同一个判定与同一个 `dedupKey`**：

- 告警 MUST 经 platform-foundation 的**运维告警 sink**（`createOpsAlertSink`，见「运维告警落真实通道并由 DB 唯一约束限频」）落**真实通道**，**MUST NOT 只落 stderr 后继续吞**；
- **限频状态 MUST 住在推送幂等的 DB 唯一约束里**（`UNIQUE(target_type, target_id, channel, push_date)`）：`ON CONFLICT DO NOTHING` 命中 0 行 ⇒ 今天已就该源告过 ⇒ 直接 return。⇒ **零新状态、跨进程、跨重启、跨两条链自动去重**（高频链每天 72–96 轮、故障源每轮都 throw ⇒ 第一轮告警，其余 71–95 轮命中唯一键冲突而跳过；两条链共用 `dedupKey` ⇒ **不会双响**）。**MUST NOT 用 Redis 键或进程内 Map** 承载限频 / 「连续 N 轮」计数——进程内 Map 每次 redeploy 复位 ⇒ 计数永不达标 ⇒ **静默不告警，比刷屏更糟**；
- **日报链那一份 MUST NOT 因「高频链已发」而被省掉**：整条 P0 车道的回滚路径是 `ALERT_SCAN_ENABLED=false`（worker 完全跳过告警链）⇒ 只把源级告警放在高频链，**一回滚唯一的告警出口就随之消失**；
- **MUST NOT 套用日报的「全源返回 0」系统级告警**——高频链空轮是常态，那道闸会每天数十次误告警。这两条是**不同判据**（前者判「整轮全挂」，后者判「某一个源结构性失败」），「不做全源 0 告警」MUST NOT 被扩大为「不做源级健康告警」。

sitemap 返回 2xx 但 **`loc_count=0`**（非 XML/结构变更/正则全失配）MUST `logError` 并使**整个 `sitemap` source 判失败**（throw → `runRegistry` 经 `allSettled` 计 perSource.ok=false → 源级健康告警），MUST NOT 记为「成功 0 条」；`loc_count>0 && window_candidate_count=0` 才是正常「无窗内新文」。**粒度约束（P2）**：`perSource.ok` 按 `CollectorSource` 键控、`sitemap` 是单 registry 项聚合全部 `SITEMAP_SOURCES`，故 `loc_count=0`（及支路 2）的 throw 会失败**整个 sitemap source**（非「单个配置源」）；**P2 `SITEMAP_SOURCES` 仅含 Anthropic 一条**，整源=该配置源，语义无歧义。多配置源的 per-config 部分失败隔离（一个 lab 坏、其余照常 emit）须采集器内部聚合，留待第二个 sitemap lab 接入（见 design 待解决）。

sitemap 与文章 HTML 的解析 MUST 用确定性方式（如正则提取 `<loc>`/`<lastmod>`/`og:` 标签，与 arXiv OAI-PMH 正则解析同范式），**MUST NOT 引入 HTML 解析库（cheerio 等）或无头浏览器**；fetch MUST 限 body 大小上界 + 校验 content-type（防超大/畸形 body 拖垮解析）。每篇 fetch 与整源调用 MUST 带 `withRetry`，单篇失败跳过该篇、不拖垮该源，整源失败由 `allSettled` 隔离。`source='sitemap'`（通用机制）+ `metadata.vendor` 标识具体 lab；下游路由一律按 `raw_type` 不按 `source`，`raw_type='news'` 经事件塌缩正常纳入日报。多 sitemap 源共用 `source='sitemap'` 不需 RSS 式 feed 命名空间化，因去重键 `canonical_url(文章 URL)` 跨 vendor 本就全局唯一（含域名）；`UNIQUE(source, source_item_id)` 约束键正常即 `canonical_url`、仅 `len>255` 折叠为 `contentHash` 时由内容抗碰撞承载唯一，去重仍走 `canonical_url`。`CollectorSource` 与 registry MUST 扩入 `sitemap`，纳入 `collectAllSources`。**源子集归属见下「实时子集归属」段（本需求修改点）。**

**实时子集归属（MUST，本需求修改点）**：`sitemap` **MUST 纳入 `REALTIME_NEWS_SOURCES`**（高频告警链每轮采它），**MUST NOT 纳入 `PRODUCT_SOURCES`**（其产出 `raw_type='news'`、不进产品塌缩）。

**该归属买到的是【采集延迟】，不是【告警资格】（MUST 写明，防因果被写反）**：实时告警的候选谓词**没有 source 条件**（见 realtime-alerts），`REALTIME_NEWS_SOURCES` 的**唯一**运行时消费点是高频链的**采集阶段**。而 `sitemap` 本就在 `collectAllSources`、日报链每天全量采 ⇒ **其事件早已在 `ai_news_events` 中、今天就具备告警资格**。纳入实时子集的收益是把一方厂商官方公告的**采集延迟从 ≤24 小时压到 ≤20 分钟**（一轮 `ALERT_SCAN_CRON`）。**系统 MUST NOT 声称「`sitemap` 不在实时子集时其事件不会触发告警」**——那是假的。

原排除理由「per-article fetch 较重」**已被本采集器自身的增量语义摊薄**：per-article HTML fetch 发生在**「DB 已见集」去重之后**（见上「增量语义」），且 **first-fetch-wins** ⇒ 同一文章一生只 fetch 一次 HTML。**稳态每轮成本 = 1 次 `sitemap.xml` GET + 1 次已见集查询**；per-article fetch **仅在新文章出现时**发生（约 1–2 篇/天）、**不随轮次增长**。

**新增稳态成本（如实登记）**：高频链每 15–20min 一轮 ⇒ 每天 **72–96 次** `sitemap.xml` GET + 同样次数的已见集查询。须留意对方站点的 WAF / 限流（UA 为 `ai-radar`）。

**该归属正是上面「为何两条判据都不能建立在『本轮这条链采到了什么』之上」所设想的那个前提的兑现（MUST 一并读到）**：`sitemap` 进高频链后，高频链每 15–20 分钟先采走新文并入库 ⇒ 已见集（`raw_items WHERE source='sitemap'`，**不分链**）已含该文 ⇒ 08:0x 日报链再跑 sitemap 时 `emitted_count = 0` **每天恒成立**。故支路 1 的判据 MUST 是 DB 复算、支路 2 的判据 MUST 落在采集器内部——**任何把它们改回「读本轮这条链的采集结果」的改动，会使两条告警在本归属下永不触发**。

**重渲染风暴的落点与量级（如实登记，非本需求引入的成本）**：站点批量刷新 `lastmod` 会把大量老文推回窗口（最坏全量 per-article fetch + 同量判分）。该风暴**今日已存在**——`sitemap` 本就在 `collectAllSources`、日报链每天全量采，重渲染那天日报链自己就会承受它。纳入实时子集**只改变落点**：从「日报链在 07:3x 被卡」变为「重渲染后一轮内高频告警链被卡（告警延迟）」；已见集在 fetch 之前过滤 ⇒ 风暴只发生**一轮**。**但该轮的时长 MUST NOT 被低估为「30–60 分钟」**：告警链**无熔断阶段**，LLM 同时全挂时，单轮最坏耗时 = 篇数 × (LLM 重试上限 × 单次 LLM 超时 + 单次补全 fetch 超时) = `213 × (3×60s + 15s) = 41,535s` ≈ **11.5 小时**（见 realtime-alerts 的「告警链无熔断阶段」登记）。**并发堆积不成立**（告警 worker `concurrency: 1`，后续 cron 只排队）；**真实风险是单轮长时阻塞 = P0 车道整段不可用**。故 realtime-alerts 要求**告警侧判分 MUST 有界**（每轮工作预算，触顶发结构化事件、下一轮续判）——`ALERT_SCAN_ENABLED=false` 是事后止血，**MUST NOT** 作为唯一的运行时保护。

`arxiv` 与 `product_hunt` 的排除理由**不受此摊薄影响**，两者仍 MUST NOT 进 `REALTIME_NEWS_SOURCES`（arXiv 非实时且 ≥3s 串行节流；PH 为产品源且 GraphQL 复杂度配额受限）。

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
- **且** **高频实时链同样消费 `perSource`**、用**同一个判定与同一个 `dedupKey`** 发告警：经 `createOpsAlertSink` 落真实通道，限频由推送幂等唯一约束 `UNIQUE(target_type, target_id, channel, push_date)` 承载（今日已告过即命中冲突跳过 ⇒ 跨进程 / 跨重启 / 跨两条链自动去重，**不双响**；高频链每天 72–96 轮只发第一轮）。**两条链都发**是因为整条 P0 车道的回滚路径是 `ALERT_SCAN_ENABLED=false`——只放高频链，一回滚出口即消失；只放日报链，本车道会静默丢源最长 24 小时。**绝不可**改用 Redis 键或进程内 Map 限频（redeploy 复位 ⇒ 永不达标 ⇒ 静默不告警），**亦绝不可**套用日报的「全源返回 0」系统级告警（高频链空轮是常态）

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
- **那么** `sitemap` **在** `REALTIME_NEWS_SOURCES` 内（高频告警链每轮采它，稳态成本 = 1 次 `sitemap.xml` GET + 1 次已见集查询），**不在** `PRODUCT_SOURCES` 内（不进产品发现链）；日报全集 `collectAllSources` 照常采
- **且** 该归属**只影响采集延迟**（≤24h → ≤20min），**不影响告警资格**——实时告警的候选谓词无 source 条件，`sitemap` 事件在纳入本子集之前（经日报链的全量采集）就已具备告警资格
- **场景名为历史命名**（本需求修改前 `sitemap` 两个子集都不进），**以正文为准**：现为「进实时告警子集、不进产品子集」。场景名保留原样是因为 openspec-cn 归档守卫要求 MODIFIED 块逐字保留主规范该需求的全部场景名——**改场景名会让归档直接失败**


### 需求:次级源经实时告警链由阈值过滤而非源级排除

本需求只管**采集侧的一件事**：次级 RSS 源 MUST NOT 被源级排除出实时告警链。告警链的源子集 `REALTIME_NEWS_SOURCES` 含 `rss` 且为 **source 级粒度**（无 feed 级开关），故次级 / 社区 RSS 源（GitHub Blog / GitHub Changelog / Lobsters 等）的条目 MUST 与 T1 RSS 源一样进入告警链的采集与评分。

**是否真告警由 realtime-alerts 判定，本需求 MUST NOT 重复定义它**——告警闸的两条支路、`published_at` 时效窗口（含 NULL 排除与未来上界）、tombstone 排除、首次启用基线水位、Model B「一生一次」去重、`ALERT_MAX_PER_SCAN` 单轮上限、`is_ai_related` 的 fail-closed 极性，一律以 realtime-alerts 为唯一权威表述。**在本需求里抄一份副本，就是给两份表述埋下漂移**。

**本需求的修改点，是撤回它此前对下游判定下的一句断言**：原文写「达阈值是**必要**条件」。realtime-alerts 已把告警闸改为两条**并列**支路（重要性 **或** 精确事实变更词表；`is_ai_related = true` 是两支路**共用**的 fail-closed 前提），故 `ALERT_IMPORTANCE_THRESHOLD` 对词表支路**既非充分亦非必要**：低 `importance` 的次级源条目，只要 `representative_title` 命中精确事实变更词表且 `is_ai_related = true`，**会**取得告警资格（生产实测：30 天语料内唯一一条经该支路命中的事件，正是中文媒体转述的「Claude 终于舍得重置 Fable 5 额度了」，`importance=30`）。这恰恰是本需求「不按源级排除」立场的兑现——**该类变更来自 T1 官网还是次级媒体转述，不改变它对开发者当日决策的价值**。

系统 MUST NOT 为压制次级源而把 `rss` 从告警子集摘除（会误伤 T1 大厂官方 RSS 的重大发布实时告警），本期亦 MUST NOT 引入 feed 级告警黑名单。**理由是同一条**：两者都是在采集侧对内容做价值判断，而噪音治理的位置在下游闸（见「RSS 源分层与次级源噪音治理」）；采集侧一旦开始筛，被筛掉的东西就再也不会出现在任何可观测口径里。

**词表支路本期不附加 source 谓词（本期决定，非永久禁令）**：`ai_news_events` 的 source 全集当前**恰等于** `REALTIME_NEWS_SOURCES`，故源级谓词今天筛掉 0 行、加了是空操作——本期不加。**但这个等式是两处独立手工维护的字面量之间的巧合，不是被守护的不变量。**

**前向守卫的触发谓词 MUST 按事件塌缩的【实际闸】写，MUST NOT 写成「产出 `raw_type='news'` 的源」**：事件塌缩的候选闸是**黑名单**而非白名单——`src/dedup/collapse.ts:327-329` 为 `raw_type IS DISTINCT FROM 'product' / 'paper' / 'experience'`，且 `raw_items.raw_type` **可空**（`src/db/schema.ts:83` 无 `.notNull()`），`IS DISTINCT FROM` 正是为**有意放行 NULL** 而选（`NULL NOT IN (...)` 求值为 NULL 会放行，注释明写）。故触发谓词 MUST 为：

> 任何人新增一个源，其产出的 `raw_type` **不在事件塌缩排除集 `{product, paper, experience}` 内**（**含 `raw_type` 为 NULL / 未设置**），却没同步把该源加进 `REALTIME_NEWS_SOURCES`，等式即被打破，该源条目会进 `ai_news_events`、**直接取得词表支路的 P0 资格**——一条从未为 P0 审过的源，一命中就是一次手机震动。

**「`raw_type='news'`」这个措辞会把守卫写成恒不触发的空守卫，仓内现成的反例有两个**：`hacker_news` 产出 `raw_type='post'`、`github` 产出 `raw_type='repo'`——**两者今天就在 `REALTIME_NEWS_SOURCES` 里**，而「产出 `news` 吗？」这个自查会对它们判「不适用」。未来的源写 `raw_type='changelog'` / `'video'` / 忘了写（NULL）时同理：作者照旧措辞自查 → 判不适用 → 跳过登记 → 条目照样落进事件层并取得 P0 资格。**守卫的措辞不得排除它存在的理由。**

**若等式将来被打破，为词表支路附加 source 谓词是正当补救；本需求 MUST NOT 被引用来禁止它。**

#### 场景:次级源与 T1 源同等套用 realtime-alerts 全部候选条件
- **当** 某次级源（如 GitHub Changelog）条目经评分，且满足 realtime-alerts 的全部候选条件（含告警闸的任一支路、`published_at` 在时效窗口内、按 Model B 尚未 alert-success 投递给所有已配置通道）
- **那么** 该事件按既有告警链触发实时告警（与 T1 源同等对待）

#### 场景:次级源的低分事实变更经词表支路告警
- **当** 某次级源（如中文聚合媒体）条目 `importance_score` 低于 `ALERT_IMPORTANCE_THRESHOLD`（如 30 < 85）、`is_ai_related = true`，但其 `representative_title` 命中精确事实变更词表（如「Claude 终于舍得重置 Fable 5 额度了」），且满足 realtime-alerts 的其余候选条件
- **那么** 该事件**触发**实时告警——达阈值**非必要**条件；次级源的身份不构成排除理由（源级排除仍被禁止）

#### 场景:次级源未达阈值不告警且不被源级摘除
- **当** 某次级源条目 `importance_score` 低于 `ALERT_IMPORTANCE_THRESHOLD`，且 `representative_title` **未**命中精确事实变更词表、**或**命中词表但 `is_ai_related` 为 `false`/`NULL`（或不满足 realtime-alerts 的其余候选条件）
- **那么** 该事件不触发告警，但 `rss` 仍保留在 `REALTIME_NEWS_SOURCES` 中（T1 RSS 源的告警能力不受影响）

### 需求:RSS 源分层与次级源噪音治理

系统的 RSS 源清单 MUST 允许在 T1 大厂官方源（高信号，如 OpenAI / DeepMind / Hugging Face / Mistral / Microsoft）之外，纳入**次级 / 社区源**（较低信号、非 AI-only，如 GitHub Blog `github.blog/feed/`、GitHub Changelog `github.blog/changelog/feed/`、Lobsters `lobste.rs/rss`）。两类源 MUST 共用 `source='rss'`、**沿用**既有「三源确定性采集」（名为三源、实为多源，见该需求）「源内幂等采集」「RSS 来源厂商标记」需求的采集保障（`source_item_id` fallback 链 / 源内幂等 / 单源失败隔离 / vendor provenance 落 `metadata`）——本需求**不重定义**这些既有判定，仅声明次级源同样适用、不因信号高低而分裂出新 `source` 取值或新 collector。

次级源的**噪音治理 MUST 完全交由下游既有闸**承担。系统 MUST NOT 在采集期对次级源做源级排除、关键词硬预过滤或专门的更高门槛——即「够好才挤进日报 / 告警」由下游的语义判断 + 确定性闸共同把关，价值判断不下放给采集期规则（守「Agent 控语义、不把语义判断交给硬规则」分层原则；且采集期筛掉的内容不会出现在任何下游可观测口径里，误筛永不可见）。

下游的闸 MUST 分清三类（**本需求修改点：原文只列两类，且断言「系统当前无 AI 相关性硬闸、`is_ai_related` 无对应列」——该列的写路径已于 2026-07-10 上线，该断言已不成立**）：

1. **LLM 语义判断**——Value Judge 输出的 `importance`（0-100，落库列 `importance_score`）与**语义布尔 `should_push`**。`should_push` 是 LLM 直出字段，**非**程序对 importance 的数值比较：prompt 不含任何如 75 的数值锚，代码亦无推导 `should_push` 的 `importance>=N` 程序闸。（这只是说 `should_push` 的**产生**不含阈值，不否认日报 `IMPORTANCE_FLOOR` 与告警 `ALERT_IMPORTANCE_THRESHOLD` 这两道**独立的** importance 阈值闸。）
2. **程序确定性闸**——日报 `IMPORTANCE_FLOOR`（与噪音治理相关的必要闸为 `should_push=true AND importance_score >= IMPORTANCE_FLOOR`；这非 Top N 候选的完整条件，后者另含 `published_at` 时效窗口与 Model B 通道去重，见 `src/selection/top-n.ts`）与实时告警 `ALERT_IMPORTANCE_THRESHOLD`。
3. **AI 相关性 fail-closed 闸 `is_ai_related = true`**——`false` 与 `NULL` **一律排除**（宁可漏也不推非 AI）。日报要闻候选恒带此闸（`eq(is_ai_related, true)`）；实时告警的**精确事实变更支路**亦带（该支路无 importance 地板，若不带此闸，一条与 AI 无关的 SaaS「Introducing our new pricing」帖只要标题命中词表就会被推送）。判定细节见 realtime-alerts，本需求不重复定义。

**注意 `ALERT_IMPORTANCE_THRESHOLD` 对精确事实变更支路既非充分亦非必要**（见「次级源经实时告警链由阈值过滤而非源级排除」）：低分次级源条目命中词表且 `is_ai_related = true` 时**会**告警。这不是本需求「噪音交下游闸」立场的例外——该词表闸位于**评分之后**、方向**只加不减**（只提升告警资格、从不压制任何条目），与本需求禁止的「采集期按主题预筛并排除内容」性质相反。**词表支路的噪音主力控制是 `published_at` 时效窗口**（realtime-alerts 定义），而非任何采集期规则。

#### 场景:次级源条目以 source='rss' 正常入库
- **当** 采集 GitHub Blog / GitHub Changelog / Lobsters 等次级 / 社区 RSS feed
- **那么** 每条目以 `source='rss'` 写入 `raw_items`，复用与 T1 源相同的 fallback 链与源内幂等，不被采集期源级排除

#### 场景:次级源噪音由下游评分闸吸收而非采集期硬筛
- **当** 某次级源条目经 Value Judge 评分后未获 `should_push=true`，或 `importance_score` 低于 `IMPORTANCE_FLOOR`，或 `is_ai_related` 为 `false`/`NULL`
- **那么** 该条目自然不进日报候选 / 不占 Top N 名额，而采集层未对其做任何源级排除或关键词预过滤
