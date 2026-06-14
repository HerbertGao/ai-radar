## 上下文

`docs/source-expansion-roadmap.md`（2026-06-14 实证）定的扩源第一梯队。现有采集器全部「内联提供 title+content」（RSS via rss-parser、HN/GitHub via JSON、arXiv via OAI-PMH 正则解析、PH via GraphQL、Show HN via Algolia JSON）。本期引入两种**新采集器机制**：JSON API（HF Papers）与 sitemap-diff（Anthropic），后者是唯一需要 per-article HTML 抓取的源。

实测要点（当日 curl/WebFetch 亲测）：
- 9 个 RSS：全部 200 + 原生 feed + 非空（清单见 proposal）。
- HF daily_papers：`GET huggingface.co/api/daily_papers` 200 JSON、~50 条/日、无鉴权、字段 `paper.id`/`title`/`summary`/`publishedAt`。
- Anthropic：`sitemap.xml` 200、229 条 `/news/` + 457 `<lastmod>`；文章页直 fetch 200、有 `og:title`+`og:description`+SSR 正文（非纯 JS、无 `__NEXT_DATA__`）。

既有不变量（不可违背）：collector 统一输出 `CollectedItem`（`source_item_id` 非空 fallback 链、title NOT NULL）、`Promise.allSettled` 单源失败隔离、`withRetry`+错误日志、registry 注册即接入、结构化输出。arXiv 已确立「paper 仅沉淀 `collapsed=true`、不进事件/日报」与「正则解析 XML、不引入解析库」两个先例。

## 目标 / 非目标

**目标**：以最小、确定性、可复用的方式接入第一梯队源；两个新采集器类型守既有不变量、不入实时/产品子集。
**非目标**：不引入 RSSHub / 无头浏览器 / HTML 解析库（cheerio）；不做论文推送、不做 Anthropic 全文提取；不改既有采集器与下游编排。

## 决策

### D1：RSS 部分零代码（复用现有 RSS collector）
9 个源都是标准 RSS/Atom，`rss-parser` 已覆盖。纯改 `RSS_FEEDS` 的 `url|vendor` + `.env.example` + 远端 `.env`，无 src 改动（与 Mistral/Microsoft/GitHub/Lobsters 同模式）。多 feed 同 vendor（google×2、microsoft×2）由 `metadata.feed_url` 区分（既有先例 GitHub Blog/Changelog）。Perplexity changelog 月级粗粒度，作产品迭代补充、标注，不期望细粒度新闻。

### D2：HF Papers — JSON API 采集器（新机制，但结构最干净）
- 新 `src/collectors/hf-papers.ts`：`GET huggingface.co/api/daily_papers`（注入 `fetchJson` 桩可测），映射每条为 `CollectedItem`：`source='hugging_face_papers'`、`sourceItemId=String(paper.id)`、`url=https://huggingface.co/papers/{paper.id}`、`title=paper.title`、`content=paper.summary`、`publishedAt=paper.publishedAt 为有效日期则 Date 否则 null`、`rawType='paper'`、`collapsed=true`、`metadata={hf_paper_id, submittedBy?, organization?, num_comments?}`。`HF_PAPERS_MAX_PER_RUN` 限单轮条数。
- **缺字段处置（M-B，契约硬规定，比照 arxiv.ts:195「无 identifier 跳过」先例）**：`paper.id` 缺失/null/空串 → **跳过该条 + 记日志**，绝不 `String(null|undefined)`（否则产 `'null'`/`'undefined'` 假 id 绕过 store 空 id 校验、互相 `ON CONFLICT` 吞掉致静默丢数据）；`paper.title` 缺失/空 → **跳过该条 + 记日志**（`title` NOT NULL，无合理回退源时不降级、不写空 title）。`publishedAt` 解析复用与 `arxiv.ts` `toDate` 一致的 **NaN 守卫纯函数**（抽到共享处或同口径实现，避免三采集器三套时间解析），非法日期 → null。
- **为何 `collapsed=true` sink-only**：与 arXiv 同——P2 论文仅作数据沉淀，事件塌缩按 dedup-and-normalization 类型路由排除 `paper`，不进日报/推送（论文板块留 P3）。入库即 `collapsed=true` 使事件塌缩入口不每轮重扫。
- **来源身份（无 `metadata.vendor`）**：vendor-provenance 不变量是 RSS 专属需求，HF（JSON API 源、非 RSS）不受其约束；来源身份由 `metadata` 的 `organization`/`submittedBy`/`hf_paper_id` 承载（sitemap 则仍带 `metadata.vendor`，与 RSS 同范式）。
- registry 加项；纳入 `collectAllSources`（日报全集，沉淀）；**不入** `REALTIME_NEWS_SOURCES`（非实时、paper）/`PRODUCT_SOURCES`（非产品）。
- **替代**：用 `/papers/feed`（401，需鉴权）— 否决（官方 JSON API 无鉴权且字段更全）。HF 401/403 不像 arXiv 429 高频，故用简单 `withRetry` 不精分错误码（accepted-degraded：HF daily_papers 无鉴权、401/403 极罕见，盲重试浪费有限）。

### D3：Anthropic — sitemap 增量采集器（新机制，唯一带 HTML 抓取）
- 新 `src/collectors/sitemap.ts`，**配置驱动**（`SITEMAP_SOURCES` 每项 `sitemapUrl | pathPrefix | vendor`，默认含 Anthropic `https://www.anthropic.com/sitemap.xml | /news/ | anthropic`）。可扩展到未来其他「有 sitemap、文章页 SSR + og: 标签」的 lab。
- 流程：① fetch sitemap.xml，**正则**提取每个 `<url>` 的 `<loc>`+`<lastmod>`（同 arXiv 正则解析 XML 模式，不引入 cheerio）；② **对每个 `loc` 先 `c = normalizeUrl(loc)`**（`normalizeUrl` 内部 try/catch，畸形/非 http/相对无 base 均返 null，不裸抛——统一 A-4 与 F-5 的两条抛错路径为一个 null 门）：`c === null` 跳过；否则用 `new URL(c).pathname.startsWith(pathPrefix)`（在已规范化的绝对 URL 上取 pathname，不会抛）过滤路径前缀；再用 `lastmod` 在近 `FIRST_SEEN_WINDOW_DAYS` 天窗内（缺失/NaN 跳过）**且** `c` 不在「DB 已见集」（见 M-D，去重键 = `canonical_url` = `c`）；③ 对**每个窗内未见 URL** fetch 文章 HTML，**正则**提取 `<meta property="og:title" content="...">`(title) 与 `og:description`(content)；④ 映射 `source='sitemap'`、`metadata.vendor='anthropic'`、`metadata.feed_url=sitemapUrl`、`metadata.lastmod=lastmod`（lastmod 留作 metadata 信号/inference hint，**不进 published_at**，见 M-C）、`url=文章URL`、`publishedAt=null`、`rawType='news'`、`sourceItemId`=（`c` 长度 > 255 → `contentHash(title, content)`；否则 `c`，见 M-B/F-6；注意 `c` 此处已非 null，null 在步骤②已跳过）。
- **title 来源差异（最大新代码点）**：现有 collector 内联提供 title+content；sitemap 源 sitemap 本身无 title，故采集器**内部 per-article fetch 取 og:title/og:description**（不新增 pipeline 阶段）。`og:title` 缺失时回退 URL slug 派生（title NOT NULL 绝不留空）；**`og:title` 与 `og:description` 同时缺失**（说明该页非标准文章页/已改版）时**跳过该篇、不发射**——避免 slug-title + null-content 的退化垃圾条目进日报候选（与 show-hn「归一键全空即跳过、不降级」同范式，见 M-1）。这是本提案唯一外部 HTML 依赖。
- **D3-f 可观测契约（M-A，防站点改版静默归零）**：URL 发现阶段记录每源 `loc_count`（sitemap 解析出的 `<url>` 总数）/ `path_match_count`（含 pathPrefix）/ `window_candidate_count`（窗内且未见）/ `emitted_count`（成功发射）。**sitemap 返回 2xx 但 `loc_count=0`**（非 XML / 结构变更 / 正则全失配）MUST `logError` 并把该配置源判为**失败**（perSource.ok=false，由 allSettled 计入告警），**不得**记为「成功 0 条」——`loc_count>0 && window_candidate_count=0` 才是正常「无窗内新文」。这把设计自承的「per-article og 退化（不崩）」与「URL 发现阶段整源归零（须告警）」两种退化区分开，后者不能静默。
  - **判失败的粒度（F-7）**：`runRegistry` 的 `perSource.ok` 仅由「promise rejected」决定（index.ts），而 `sitemap` 是**单 registry 项聚合全部 `SITEMAP_SOURCES`**。**P2（仅 Anthropic 单配置）**：`loc_count=0` → 采集器 `throw` → 整 `sitemap` source 经 allSettled 计 `ok=false`，机制成立。**多配置源（未来多 lab）的部分失败隔离**（一个 lab sitemap 坏、其余照常发射）须由采集器**内部**做 per-config 聚合（坏配置记失败信号但不 throw、好配置照常 emit，同 RSS 多 feed 隔离范式）——本期单源不需要，列入待解决，避免 spec「该配置源判失败」措辞承诺单 registry 项无法表达的粒度。
- **增量语义（M-D，无游标 → DB 已见集 + best-effort 窗口）**：sitemap **无 arXiv 式游标**。控量靠两层：① per-article fetch 前查「DB 已见集」= `SELECT canonical_url FROM raw_items WHERE source='sitemap'`，跳过已入库 URL → 同一文章**只 fetch HTML 一次**（消除每轮重复抓取）；② `lastmod` 窗口仅作「候选粗筛」减少要比对的 URL 量。**显式声明**：sitemap 是 **best-effort 窗口快照 + DB 去重、非 at-least-once 增量**；「是否已采」的事实交还 DB（符合「DB 控状态」第一架构原则），不纯依赖时间窗。窗口默认应显著大于最坏调度间隔（默认 `FIRST_SEEN_WINDOW_DAYS=3` ≫ 日报 cron 每日 1 次，裕量充足）以降跳窗漏采概率；残留漏采风险（调度连续漏跑超窗 + DB 无该 URL）由窗口裕量缓解、本期接受并标注。
- **去重键为何是 `canonical_url`（非 source_item_id）**：去重 MUST 在 per-article fetch **前**完成（以避免重复 fetch），故去重键只能是「**fetch 前就能从 URL 单独算出的稳定值**」。`canonical_url = normalizeUrl(loc)` 满足（纯 URL 函数）；`source_item_id` **不满足**——它在 `len>255` 时折叠为 `contentHash(title, content)`、依赖 fetch 后才有的 og 内容，fetch 前无法复算。故已见集查 `canonical_url`、候选比对 `normalizeUrl(loc)`；二者对长 URL 仍是完整 URL（`canonical_url` 是无长度限的 `text` 列），即使 `source_item_id` 已折叠，去重仍正确。
- **已见集的两个本期接受属性（F-2/F-3 显式声明）**：① **结果集随累计行数无界增长**——每轮 `SELECT canonical_url FROM raw_items WHERE source='sitemap'` 取回全部历史 sitemap canonical_url。`WHERE source='sitemap'` 用 `(source, source_item_id)` 唯一索引的 `source` 前缀做**范围扫**定位 sitemap 行，但 `canonical_url` 是无索引 `text` 列、投影须**回表**（非 index-only），返回行数随累计无界。Anthropic 量级（实测 229 条 `/news/`、逐年数百行）安全；本期**不**为 `canonical_url` 单列加索引（守「无 schema 迁移」）；通用机制扩到高频/巨量 lab 时须配窗口下界裁剪或改增量游标（见待解决）。② **first-fetch-wins**——按 `canonical_url` 跳过 + store `ON CONFLICT DO NOTHING` ⇒ 文章首次入库后其 `og:title`/`og:description`/`lastmod` 后续被官方更新将**永不重抓**；对近 immutable 的 news（Anthropic 发布即定稿）本期接受；P3 若需追更，以 `metadata.lastmod` 变化触发重抓。
- **已见集查询失败语义（F-4，MUST）**：DB 不可达/查询超时时，采集器 MUST 让**整源失败**（抛出由编排层 `allSettled` 隔离），**MUST NOT 降级为空已见集**（否则窗内 URL 全被当「未见」→ per-article HTML 全量重抓风暴，违背 M-D「只 fetch 一次」）。
- **lastmod 缺失/非法（M-4）**：某 `<url>` 无 `<lastmod>` 或解析为 NaN 时，**保守跳过该 URL**（无法判断是否窗内 → 不采，避免把全站老文一次性灌入）；该 URL 待其后续有合法 lastmod 或被其他机制发现时再采。
- **限量与隔离**：只 fetch「窗内且 DB 未见的 URL」（Anthropic 低频发文、N 小）；单源整体 + 每篇 fetch 都经 `withRetry`，单篇失败跳过不拖垮该源、整源失败由 `allSettled` 隔离。
- `source='sitemap'`（通用机制）+ `metadata.vendor` 标识具体 lab——与 RSS 的 `source='rss'`+vendor 同范式；下游事件塌缩按 `rawType='news'` 正常纳入（→ 日报）。**source 枚举命名约定**：`source` 取值混用「机制类」（rss/sitemap）与「平台类」（arxiv/product_hunt），统一约束是**下游路由一律按 `raw_type` 不按 `source`**（已核实 collapse/store 无 source 分支）；`source` + `metadata.vendor` 共同定位具体源。
- registry 加项；纳入 `collectAllSources`；**不入** `REALTIME_NEWS_SOURCES`（per-article fetch 较重、Anthropic 日报级足够）/`PRODUCT_SOURCES`。
- **替代**：抓 `/news` 列表页 HTML（站点专属选择器、改版即坏）— 否决（sitemap-diff 发现 URL 更稳）；引入 cheerio — 否决（正则取 og: 标签够用、与 arXiv 一致不增依赖）；纳入 REALTIME 子集 — 否决（per-article fetch 重）；`publishedAt=lastmod` — **否决**（lastmod=最后修改，改版老文会被当新发布、且 inference 只纠 NULL 不纠非 NULL，与 recency 红线相反，见 M-C）。

### D4：两新采集器的 source_item_id 与去重
- HF Papers：`String(paper.id)`（HF 稳定 id；多为 arXiv id，但缺失/空时跳过、绝不产假 id，见 M-B）。
- sitemap：`source_item_id` 正常 = `canonicalUrl(文章URL)`（=步骤②的 `c`，URL 规范化后稳定）；仅 `c.length > 255` 时折叠为 `contentHash(title, content)`（见 F-6）。**无 `normalizeUrl=null → contentHash` 兜底分支**（Codex/CR/RC 一致）：`normalizeUrl(loc)` 为 null 的畸形 loc 已在**步骤②过滤阶段跳过、不发射**（F-5/A-4），故映射阶段的 `c` 恒非 null——若反而保留「null 时 contentHash 兜底发射」会与 F-5 跳过矛盾，且 store 独立算 `canonical_url=normalizeUrl(url)=NULL`（store.ts）致该行无法被 canonical_url 比对、下轮重抓。`contentHash` **MUST 调用既有 `contentHash(title, content)` 函数**（不手写哈希、分隔符以函数实现为准），输出定长 64 hex。
- **source_item_id 长度上界（F-6，采集器侧守卫）**：`raw_items.source_item_id` 为 `varchar(255)`（schema.ts）。sitemap 是**首个**以完整 canonical URL 系统性作 source_item_id 的源（既有 URL-keyed 源极少回退到纯 URL）。**失败位置矫正**：`storeCollectedItems` 的 INSERT 在 `collectAllSources`/`allSettled` **之后**的 store 阶段，store 仅校验 source_item_id 非空（store.ts）、**不**校验长度——故超 255 的 source_item_id 会在 store 阶段 INSERT 抛错、**不被采集器 allSettled 隔离**，可能中断整个 store 阶段（非「整源隔离」）。**故采集器侧 MUST 守卫**（null 安全求值，`c` 在步骤②已非 null）：`sourceItemId = (c.length > 255) ? contentHash(title, content) : c`（`contentHash` 输出定长 64 hex、必 < 255），使超长 URL 在入库前已折叠、绝不把超界值送到 store。Anthropic URL 远短于 255、本期实际不触发，但守卫使通用机制对长 slug lab 安全（无需事后补救）。
- 均经 `UNIQUE(source, source_item_id)` 源内幂等。
- **sitemap 共用 `source='sitemap'` 的命名空间**：多 sitemap 源（未来多 lab）共用 `source='sitemap'`，源内幂等**不需** RSS 式 feed 命名空间化（RSS 因不同 feed 的 guid 可能撞号而须 `sha256(feed_url‖guid)`），因去重键 `canonical_url(文章URL)` 跨 vendor 本就全局唯一（article URL 含域名）、与 vendor 无关。`UNIQUE(source, source_item_id)` 约束键 `source_item_id` 正常即 `canonical_url`（同样含域名全局唯一）；仅 `len>255` 折叠时退为 `contentHash(title, content)`——此时全局唯一性由 title+content 抗碰撞承载（不同 lab 文章内容不同），去重仍走 `canonical_url`，故折叠不破跨 vendor 唯一。**P3 跨源去重提醒**：HF `source_item_id` 是裸 arXiv id（`2406.12345`），arXiv 源是带前缀的 OAI identifier（`oai:arXiv.org:2406.12345`），二者字面不同；P3 做 HF/arXiv 跨源去重须按归一 arXiv id（剥前缀）比对，**不可**直接比 source_item_id。

## 风险 / 权衡

- **[sitemap 采集器 per-article HTML 抓取脆弱性]** → 唯一外部 HTML 依赖。缓解：① 只取标准 `og:title`/`og:description`（跨站通用、比站点专属选择器稳）；② sitemap-diff 限到窗内新 URL（低频低量）；③ 每篇 withRetry、单篇/整源失败隔离不拖垮其余源；④ og:title 缺失回退 URL slug（不留空）。残留：Anthropic 改 og: 输出或站点结构则 title/content 退化（但不崩、有兜底）。属可接受的「为接顶级 lab 一手动态付的最小 HTML 代价」。
- **[HF Papers 与 arXiv 论文跨源重复]** → `paper.id` 多为 arXiv id，同一篇可能既在 `source='hugging_face_papers'` 又在 `source='arxiv'`。不同 source → `UNIQUE(source, source_item_id)` 不跨源去重 → 两行。P2 两者均 `collapsed=true` sink-only、无下游消费 → **无害**。P3 论文板块消费时再设计跨源去重（按归一 arXiv id）。本期显式接受、标注。
- **[lastmod ≠ 真实发布时间，已改为 NULL+inference（M-C）]** → sitemap `lastmod` 是「最后修改」；若直接当 `published_at`，改版老文 lastmod 跳到今天会被 Top-N 时效闸当「今天发布」首次纳入候选（与 commit `15573c8` fix-push-recency 方向相反、撞 `policy-push-timeliness` 刷屏红线），且 **published-at-inference 回填非 NULL 值不纠正** → 非 NULL 的 lastmod **永不被纠正**，proposal 原「下游精化」缓解对 sitemap 不生效。**故 sitemap 写 `published_at=null`、走既有 published-at-inference 从 og: 内容推断真实发布日；lastmod 仅入 `metadata.lastmod`（可作 inference hint）+ 窗口 diff 粗筛**。
  - **回填前置链（精确，F-2）**：已核实 `backfill.ts` 回填域为日报域 `published_at IS NULL AND should_push=true`、告警域 `published_at IS NULL AND importance>=阈值`（**非纯 IS NULL**）；日报链阶段 3 评分（`score-events.ts` 仅 `importance_score IS NULL`、不依赖 published_at）**先于**阶段 3.5 回填，故 sitemap news 须先被 Value Judge 判 `should_push=true` 才进日报回填域。`should_push=false` 者（含未评分事件——`should_push` 列 schema `default(false)`，未评分=false 非 NULL，同口径排除）published_at 永 NULL、被 Top-N 排除——**正确行为**（不该推的本就不展示），但 sitemap「进日报」的真实条件是 `should_push=true ∧ inference 定出日期`，非仅「published_at IS NULL」。inference 失败仍 NULL 者与任何 NULL published_at 源同口径被排除（保守正确：不展示无法定日的条目）。
  - **silent-zero 可观测（F-2，P3 不在本期范围）**：sitemap 有「采了但永不进日报」的静默失效面（inference 持续判不出日期 → 永 NULL → 永被排除，且与「当日无新文」无信号区分）。**本期不实现 sitemap 专属 silent-zero 信号**——既有 `BackfillPublishedAtResult` 的 `undetermined` 是**跨全源聚合标量、无 source 维度**（backfill.ts），「按 source 过滤」需改 backfill 统计结构，落在本提案非目标「不改下游编排」之外；且功能本身不依赖该信号（inference 能定日时正常工作）。故降为 P3 观测项（见待解决），上线后据 backfill 聚合 `undetermined` + 日报里 Anthropic 出现率人工评估；若需 sitemap 专属信号，另开变更扩 backfill 统计 per-source 维度。**本期不写为 spec/tasks 的 MUST，避免承诺不可实现项。**
  - **首抓 lastmod 作保守下界的待评估**：M-C 对**改版老文**正确（lastmod 不可当 published_at）；对**首次入库 + lastmod 在窗内**的条目，lastmod ≈ 真实发布日、常优于「判不出→永久排除」。本期严守「绝不回写 published_at=lastmod」；若上线 inference 命中率低，按待解决评估「仅 first-seen + lastmod 在窗内 → lastmod 作保守 published_at」的窄回退（不触改版老文回写红线）。
- **[sitemap 无增量游标的跳窗漏采 + 重复 fetch（M-D）]** → 见 D3「增量语义」：纯时间窗会在调度漏跑超窗/窗口调小时静默漏采、且每轮重复 fetch 窗内文章。缓解：per-article fetch 前查 DB 已见集（`source='sitemap'` 的 canonical_url）跳过已采 → 只 fetch 一次；窗口仅作粗筛、显式声明 best-effort 非 at-least-once。残留：DB 无该 URL 且调度连续漏跑超窗的极端漏采，由窗口裕量缓解、本期接受标注。
- **[sitemap URL 发现阶段静默归零（M-A）]** → sitemap 2xx 但解析 0 loc（结构/正则失配）若记「成功 0 条」会掩盖站点改版致核心源静默失效。缓解：可观测计数器 + `loc_count=0` 判源失败告警（见 D3「D3-f 可观测契约」）。设计自承的「退化不崩」锚只覆盖 per-article og 退化，URL 发现归零须告警、不在该锚内。
- **[9 RSS 自动进实时告警链]** → `REALTIME_NEWS_SOURCES` 含整个 `rss` source（feed 级无开关），故 9 个新 RSS feed 同时进**实时告警链**（非仅日报），由既有 `ALERT_IMPORTANCE_THRESHOLD` 等闸过滤。本期接受（与既有 RSS 行为一致），在 proposal 影响段披露；若需 feed 级告警策略另开变更。
- **[Perplexity changelog 月级粒度]** → 粗，只追产品迭代非细新闻。零成本、作补充，标注。
- **[9 RSS 噪音]** → NVIDIA/AWS/Google Research 偏泛技术，靠既有 `IMPORTANCE_FLOOR` + Value Judge `should_push` 滤（与 GitHub Blog/Lobsters 同治噪路径，采集期不源级排除）。
- **[新增 CollectorSource 值的下游影响]** → `hugging_face_papers`/`sitemap` 是新 source 值；事件塌缩按 `rawType` 路由（paper 排除、news 纳入），不按 source；产品塌缩按 rawType='product' 不受影响；REALTIME/PRODUCT 子集为手工字面量、不含新值（确认）。

## 迁移计划

含代码，无 schema 迁移。步骤：
1. `CollectorSource` += `'hugging_face_papers'`、`'sitemap'`。
2. 新增 `src/collectors/hf-papers.ts`（JSON API，注入桩可测；缺 id/title 跳过 M-B；publishedAt 复用 toDate NaN 守卫）。
3. 新增 `src/collectors/sitemap.ts`（配置驱动 sitemap-diff + per-article og: 正则提取，注入 fetch 桩可测）：published_at=null + lastmod→metadata（M-C）；per-article fetch 前查 DB 已见集去重（M-D，去重键 canonical_url，注入「已见 canonical_url 集」查询桩可测）；可观测计数器 + loc_count=0 判源失败（M-A）；og:title+description 同缺跳过（M-1）；lastmod 缺失/NaN 跳过（M-4）；source_item_id = canonical_url（`len>255` 折叠既有 contentHash 函数，无 null 兜底——畸形 loc 已在过滤阶段跳过，F-5/M-B）。
4. `src/config/env.ts` 加 `SITEMAP_SOURCES`（`url|pathPrefix|vendor` 列表，默认 Anthropic；比照 RSS_FEEDS 钉死错误分支：段数≠3/任一段空/pathPrefix 不以 `/` 开头 → 启动快失败）、`HF_PAPERS_MAX_PER_RUN`（默认合理值如 50）；sitemap 窗口复用 `FIRST_SEEN_WINDOW_DAYS`。
5. `buildRegistry` 加 hf-papers / sitemap 两项 + 导出 + `PerSourceOptions`/`collectors` 具名注入位；**确认两源不入 `REALTIME_NEWS_SOURCES`/`PRODUCT_SOURCES`**。
6. `.env.example`+本地 `.env`：`RSS_FEEDS` 追加 9 条；加 `SITEMAP_SOURCES`/`HF_PAPERS_MAX_PER_RUN`。
7. 测试：RSS 复用既有 collectors.test（既有「全集采集」测试需加 hf-papers/sitemap 注入桩防漏桩落真实网络，含负向断言两源不入 REALTIME/PRODUCT）；hf-papers 单测（注入 JSON 桩 + 固化真实响应 fixture：映射/publishedAt/sink collapsed=true/**缺 id 跳过/缺 title 跳过**/单源失败）；sitemap 单测（注入 sitemap XML 桩 + 文章 HTML 桩 + 已见集桩：lastmod 窗过滤/**已见 URL 跳过不重复 fetch**/og:title·og:description 正则提取/og:title 缺失回退/**og:title+description 同缺跳过**/**lastmod 缺失跳过**/**published_at=null + lastmod 入 metadata**/**loc_count=0 判源失败**/单篇失败跳过/整源 allSettled 隔离/source_item_id=canonical_url（len>255 折叠既有 contentHash 函数、无 null 兜底））。
8. 远端 ts.mac-mini：build→save→ssh load + 同步 `.env`（RSS_FEEDS + 新两项）+ up -d + 验证。
9. `/opsx:sync` + `/opsx:archive`。

**回滚**：registry 移除两项 + 还原 env + 删两文件 + revert CollectorSource；已入库 hugging_face_papers/sitemap 行独立 source、不影响既有源。

## 待解决问题

- **sitemap 采集器是否值得为单源（Anthropic）引入**：它是配置驱动、可复用于未来 lab（Meta 若 SSR、其他无 RSS 但有 sitemap 的）；本期仅 Anthropic。若上线后 og: 提取频繁退化，再评估是否改抓 RSS 替代源或降级。
- **HF_PAPERS_MAX_PER_RUN / sitemap 窗口默认值**：上线据量/质调；窗口须显著大于最坏调度间隔（M-D best-effort 漏采裕量）。
- **sitemap published_at 走 inference 的命中率 + silent-zero 监控（P3）**：M-C 改 published_at=null 后，sitemap news 能否进 Top-N 取决于 published-at-inference 从 og: 内容推断成功率；本期不加 sitemap 专属可观测信号（需改 backfill 统计 per-source 维度、属本期范围外，见 D3 M-C silent-zero 段），上线后据 backfill 聚合 `undetermined` + 日报里 Anthropic 出现率人工评估；命中率低则评估两条路：① 另开变更给 `BackfillPublishedAtResult` 加 per-source `undetermined` 维度使 silent-zero 可观测；② 「仅 first-seen + lastmod 在窗内 → lastmod 作保守 published_at」的窄回退（不触改版老文回写红线）。
- **9 RSS 进实时告警链的噪音/成本观测（带触发阈值的接受）**：新增 9 feed 中 NVIDIA/AWS/Google Research 偏泛技术、高频，因 `REALTIME_NEWS_SOURCES` 含整 `rss` 立即进实时告警评分链（依赖 `ALERT_IMPORTANCE_THRESHOLD` 兜底）。本期接受，但上线后观测这些 feed 进告警链的评分量/噪音占比；若阈值拦不住致告警噪音或 LLM 成本显著上升，**主动**触发「feed 级告警开关」变更（非被动等另开）。
- **巨型 sitemap / 已见集 / URL 长度（通用机制扩展隐患，统一口径）**：当前 Anthropic 量级（百级）下三者均安全；通用机制扩到高频/巨量 lab 时须一并评估——① sitemap 正则全文扫的内存/时延（分页/流式）；② 已见集查询 `WHERE source='sitemap'` 无界增长（配窗口下界 `fetched_at>=窗口` 或改增量游标）；③ source_item_id 超 `varchar(255)`（长 slug 折叠 contentHash）。
- **多 sitemap 源的部分失败隔离（F-7）**：本期单配置（Anthropic）下 `loc_count=0` throw 即可；多配置 lab 时须采集器内部 per-config 聚合（坏配置不 throw、好配置照常 emit），同 RSS 多 feed 隔离范式，留待第二个 sitemap lab 接入实现。
- **HF/arXiv 跨源论文去重**：P3 论文消费时做（本期 sink-only 无害；注意 source_item_id 字面不可比，须归一 arXiv id，见 D4）。
- **是否把 Anthropic news 纳入实时告警**：本期否（per-article fetch 重）；若 Anthropic 重大发布的实时性要求高，再评估轻量化（如只 sitemap-diff 出 URL 进告警、正文延后）。
