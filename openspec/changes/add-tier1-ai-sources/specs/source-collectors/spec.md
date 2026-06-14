## 新增需求

### 需求:Hugging Face Papers 采集（官方 JSON API）

系统 MUST 提供一个 HF Papers 采集器，经 **Hugging Face 官方 JSON API**（`GET https://huggingface.co/api/daily_papers`，**无鉴权**）拉取每日精选论文作**数据沉淀源**。采集器 MUST 把每条映射为统一 `CollectedItem`：`source='hugging_face_papers'`、`source_item_id = String(paper.id)`（HF 稳定论文 id，非空）、`url = https://huggingface.co/papers/{paper.id}`、`title = paper.title`、`content = paper.summary`、`published_at`=（`paper.publishedAt` 为有效日期则 `Date`，否则 `null`；解析 MUST 用与 arXiv `toDate` 一致的 NaN 守卫）、**`raw_type='paper'`**、**`collapsed=true`**、`metadata` 透传 `hf_paper_id` 及可得的 `submittedBy`/`organization`/`num_comments`。单轮条数 MUST 有上限（`HF_PAPERS_MAX_PER_RUN`）。

**缺字段处置（硬规定，比照 arXiv「无 identifier 跳过」先例）**：`paper.id` 缺失/null/空串时采集器 MUST **跳过该条并记日志**，MUST NOT `String(null|undefined)`（否则产 `'null'`/`'undefined'` 假 `source_item_id` 绕过 store 空 id 校验、互相 `ON CONFLICT` 吞掉致静默丢数据）。`paper.title` 缺失/空串时 MUST **跳过该条并记日志**（`raw_items.title` NOT NULL，无合理回退源时不降级、不写空 title）。HF 为 JSON API 源（非 RSS），不受 RSS vendor-provenance 不变量约束，来源身份由 `metadata` 的 `organization`/`submittedBy`/`hf_paper_id` 承载。

论文 MUST **仅作数据沉淀**（`collapsed=true`，与 arXiv 同口径）：不进事件塌缩、不进日报、不推送（事件塌缩按 dedup-and-normalization 类型路由排除 `paper`；论文板块留 P3）。`CollectorSource` 枚举与 registry MUST 扩入 `hugging_face_papers`，纳入 `collectAllSources`（日报全集沉淀）；MUST NOT 纳入 `REALTIME_NEWS_SOURCES`（非实时）或 `PRODUCT_SOURCES`（非产品）。所有调用 MUST 带 `withRetry` + 错误日志；单源失败 MUST 由 `Promise.allSettled` 隔离、不拖垮整批、不触发系统级全失败告警。

**跨源论文重复（显式接受）**：`paper.id` 多为 arXiv id，同一篇可能同时存在于 `source='hugging_face_papers'` 与既有 `source='arxiv'`。二者不同 `source` → `UNIQUE(source, source_item_id)` 不跨源去重 → 两行；P2 两者均 `collapsed=true` sink-only、无下游消费，**无害**；跨源去重留 P3 论文消费期。

#### 场景:HF Papers 经 JSON API 采集为 paper 沉淀
- **当** 采集器 `GET huggingface.co/api/daily_papers` 返回当日论文列表
- **那么** 每条映射为 `source='hugging_face_papers'`、`raw_type='paper'`、`collapsed=true`、`source_item_id=String(paper.id)`、`title=paper.title`、`content=paper.summary`、`published_at` 为有效日期或 null，写入 `raw_items` 作沉淀

#### 场景:HF Papers 仅沉淀不进下游
- **当** HF Papers 条目以 `raw_type='paper'` 入库
- **那么** 事件塌缩按类型路由排除 `paper`、不进日报/推送；`hugging_face_papers` 不在 `REALTIME_NEWS_SOURCES`/`PRODUCT_SOURCES`，不进告警/产品链

#### 场景:HF Papers 缺 id 或缺 title 即跳过
- **当** daily_papers 返回的某条目 `paper.id` 缺失/null/空串，或 `paper.title` 缺失/空串
- **那么** 采集器跳过该条并记日志，绝不写入 `source_item_id='null'`/`'undefined'` 等假 id、绝不写入空 `title`；其余合法条目正常发射

#### 场景:HF Papers 单源失败被隔离
- **当** daily_papers API 调用失败（超时/非 2xx/解析错）且重试耗尽
- **那么** 记错误日志后由 `allSettled` 隔离，其余源照常完成、整批不中止、不触发全失败告警

### 需求:sitemap 增量采集（无 RSS 的 lab 一手新闻）

系统 MUST 提供一个**配置驱动的 sitemap 增量采集器**，用于接入「无原生 RSS、但有 `sitemap.xml` 且文章页服务端渲染含 `og:` 标签」的一手 lab 新闻源（首期：Anthropic News）。配置 MUST 为列表，每项含 `sitemap URL`、`路径前缀`（如 `/news/`）、`vendor`（如 `anthropic`）。

采集流程 MUST 为：① fetch `sitemap.xml`，解析每个 `<url>` 的 `<loc>` 与 `<lastmod>`；② 对每个 `loc` 先 `c = normalizeUrl(loc)`（`normalizeUrl` 内部 try/catch、对畸形/非 http/相对无 base 的 loc 返 null 而不裸抛——MUST NOT 用裸 `new URL(loc)` 直接取 pathname，否则相对 loc 会抛 `TypeError` 中断该源）；`c === null` 跳过该 loc；否则按 `new URL(c).pathname` **以配置路径前缀开头**（`startsWith`，在已规范化的绝对 URL 上取 pathname，**非**裸字符串 `contains` 以免误匹配 query-string/fragment）、`lastmod` 在近 `FIRST_SEEN_WINDOW_DAYS` 天窗内、**且 `c`（即 `canonical_url`）不在「DB 已见集」**（见下「增量语义」）三条同时满足才纳入；③ 对**每个窗内未见 URL** fetch 文章 HTML、提取 `og:title`（→ `title`）与 `og:description`（→ `content`）；④ 映射为 `CollectedItem`：`source='sitemap'`、`metadata.vendor=<配置 vendor>`、`metadata.feed_url=<sitemap URL>`、`metadata.lastmod=<lastmod>`、`url=文章 URL`、**`published_at=null`**（见下「时效正确性」）、**`raw_type='news'`**、`source_item_id = canonical_url(文章 URL)`（即步骤②的 `c`，恒非 null——null loc 已在②跳过、不发射），**仅 `c` 长度 > 255 时 MUST 折叠为既有 `contentHash(title, content)` 函数**（`raw_items.source_item_id` 为 `varchar(255)`，超界会在 store 阶段 INSERT 抛错且不被采集器隔离，故采集器侧前置折叠）。**无 `normalizeUrl=null → contentHash` 兜底**（与 F-5「null loc 过滤阶段跳过」一致，避免矛盾及 `canonical_url=NULL` 入库致去重失效）。`og:title` 缺失时 MUST 回退（如 URL slug 派生）以保证 `title` 非空；`og:title` 与 `og:description` **同时缺失**时 MUST **跳过该篇、不发射**（防 slug-title + null-content 退化垃圾进日报候选）。

**时效正确性（MUST，对齐既有 published_at recency 红线）**：采集器 MUST NOT 把 `lastmod` 写入 `published_at`。`lastmod` 是「最后修改」时间，改版老文会被 Top-N 时效闸误当「今天发布」纳入候选；且 published-at-inference 回填只对 `published_at IS NULL` 触发，非 NULL 的 lastmod 永不被纠正。故 `published_at` MUST 置 `null`、交由既有 published-at-inference 从 `og:` 内容推断真实发布日；`lastmod` 仅入 `metadata.lastmod`（可作推断 hint）+ 窗口 diff 粗筛。

**增量语义（MUST，无游标 → DB 已见集 + best-effort 窗口）**：sitemap 采集器无 arXiv 式游标。per-article fetch 前 MUST 查「DB 已见集」（`SELECT canonical_url FROM raw_items WHERE source='sitemap'`），跳过已入库 URL，使同一文章只 fetch HTML 一次（消除每轮重复抓取）。窗口（`FIRST_SEEN_WINDOW_DAYS`）仅作候选粗筛。该机制 MUST 显式声明为 **best-effort 窗口快照 + DB 去重、非 at-least-once 增量**；窗口默认应显著大于最坏调度间隔以降跳窗漏采概率。`lastmod` 缺失/解析为 NaN 的 URL MUST **保守跳过**（无法判定是否窗内、避免一次性灌入全站老文）；`loc` 经 `normalizeUrl` 为 null（畸形/非 http）的条目 MUST 在过滤阶段跳过（避免以 `canonical_url=NULL` 入库污染已见集去重）。**已见集查询失败语义（MUST）**：已见集查询失败（DB 不可达/超时）时采集器 MUST 让整源失败（抛出由 `allSettled` 隔离），MUST NOT 降级为空已见集（否则窗内 URL 全被当未见 → per-article 全量重抓风暴）。**first-fetch-wins（本期接受属性）**：按 `canonical_url` 跳过 + store `ON CONFLICT DO NOTHING` ⇒ 文章首次入库后其 og 内容/lastmod 后续更新永不重抓；对近 immutable 的 news 本期接受，P3 若需追更以 `metadata.lastmod` 变化触发。

**可观测契约（MUST，防站点改版静默归零）**：采集器 MUST 对每源记录 `loc_count`/`path_match_count`/`window_candidate_count`/`emitted_count`。sitemap 返回 2xx 但 **`loc_count=0`**（非 XML/结构变更/正则全失配）MUST `logError` 并使**整个 `sitemap` source 判失败**（throw → `runRegistry` 经 `allSettled` 计 perSource.ok=false、计入告警），MUST NOT 记为「成功 0 条」；`loc_count>0 && window_candidate_count=0` 才是正常「无窗内新文」。**粒度约束（P2）**：`perSource.ok` 按 `CollectorSource` 键控、`sitemap` 是单 registry 项聚合全部 `SITEMAP_SOURCES`，故 `loc_count=0` 的 throw 会失败**整个 sitemap source**（非「单个配置源」）；**P2 `SITEMAP_SOURCES` 仅含 Anthropic 一条**，整源=该配置源，语义无歧义。多配置源的 per-config 部分失败隔离（一个 lab 坏、其余照常 emit）须采集器内部聚合，留待第二个 sitemap lab 接入（见 design 待解决）。

sitemap 与文章 HTML 的解析 MUST 用确定性方式（如正则提取 `<loc>`/`<lastmod>`/`og:` 标签，与 arXiv OAI-PMH 正则解析同范式），**MUST NOT 引入 HTML 解析库（cheerio 等）或无头浏览器**。每篇 fetch 与整源调用 MUST 带 `withRetry`，单篇失败跳过该篇、不拖垮该源，整源失败由 `allSettled` 隔离。`source='sitemap'`（通用机制）+ `metadata.vendor` 标识具体 lab；下游路由一律按 `raw_type` 不按 `source`，`raw_type='news'` 经事件塌缩正常纳入日报。多 sitemap 源共用 `source='sitemap'` 不需 RSS 式 feed 命名空间化，因去重键 `canonical_url(文章 URL)` 跨 vendor 本就全局唯一（含域名）；`UNIQUE(source, source_item_id)` 约束键正常即 `canonical_url`、仅 `len>255` 折叠为 `contentHash` 时由内容抗碰撞承载唯一，去重仍走 `canonical_url`。`CollectorSource` 与 registry MUST 扩入 `sitemap`，纳入 `collectAllSources`；MUST NOT 纳入 `REALTIME_NEWS_SOURCES`（per-article fetch 较重）或 `PRODUCT_SOURCES`。

#### 场景:sitemap-diff 取窗内未见文章、跳过已采
- **当** 采集器 fetch 配置的 sitemap，某 `/news/` URL 的 `lastmod` 在近 N 天窗内
- **那么** 若其 `canonical_url` 不在 DB 已见集（`source='sitemap'`）则纳入采集；已在已见集的 URL 被跳过、不重复 fetch HTML；窗外（lastmod 过老）及 `lastmod` 缺失/NaN 的 URL 被跳过

#### 场景:per-article 提取 og 标签映射为 news（published_at 留 NULL 走 inference）
- **当** 对窗内未见文章 URL fetch HTML
- **那么** 正则提取 `og:title` 作 `title`、`og:description` 作 `content`，映射为 `source='sitemap'`、`metadata.vendor` 为配置 vendor、`metadata.lastmod` 为 lastmod、`published_at=null`、`raw_type='news'`、`source_item_id=canonical_url`（`len>255` 折叠既有 `contentHash` 函数；无 null 兜底分支，畸形 loc 已在过滤阶段跳过），进事件塌缩→日报；真实发布日由既有 published-at-inference 回填

#### 场景:og:title 缺失回退、og 双缺则跳过
- **当** 某文章页缺 `og:title` 但有 `og:description`
- **那么** 采集器以 URL slug 派生等回退值填 `title`，绝不写入空 `title`（`raw_items.title` NOT NULL）
- **当** 某文章页 `og:title` 与 `og:description` 同时缺失（非标准文章页/已改版）
- **那么** 采集器跳过该篇、不发射退化条目

#### 场景:sitemap 2xx 但解析 0 loc 判源失败（防静默归零）
- **当** sitemap.xml 返回 2xx 但正则解析出 0 个 `<loc>`（站点结构变更/正则失配）
- **那么** 采集器 `logError` 并将该源判为失败（perSource.ok=false、计入告警），绝不记为「成功 0 条」；仅 `loc_count>0` 且窗内候选为 0 时才视作正常「无新文」

#### 场景:已见集查询失败时整源失败、不全量重抓
- **当** 「DB 已见集」查询（`SELECT canonical_url WHERE source='sitemap'`）因 DB 不可达/超时失败
- **那么** 采集器让整源失败（抛出由 `allSettled` 隔离），绝不降级为空已见集导致窗内 URL 被全量重抓

#### 场景:单篇文章 fetch 失败不拖垮该源
- **当** 某窗内文章 HTML fetch 失败且重试耗尽
- **那么** 跳过该篇、记错误日志，该源其余文章照常采集；整源调用失败则由 `allSettled` 隔离、不拖垮其余源

#### 场景:sitemap 源不进实时告警/产品子集
- **当** 实时告警或产品发现链路选源采集
- **那么** `sitemap` 不在 `REALTIME_NEWS_SOURCES`/`PRODUCT_SOURCES` 内，仅在 `collectAllSources`（日报全集）被调用
