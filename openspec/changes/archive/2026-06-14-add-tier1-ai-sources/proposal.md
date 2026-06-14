## 为什么

`docs/source-expansion-roadmap.md` 调研（2026-06-14 实证）确定的「扩源第一梯队」：一批一手 lab / 厂商 / 论文源，覆盖现有源的空白（更多大厂官方博客、每日精选论文、顶级 lab Anthropic 一手动态、AI 工具目录新闻）。核心认知：**「无原生 RSS」≠「无低成本入口」**——HF 有官方 JSON API、Anthropic 有 sitemap、AlternativeTo/Perplexity 有藏在子域名/子路径的官方 feed，全程避开 RSSHub 与无头浏览器、守住「确定性轻量采集」架构红线。

## 变更内容

分三部分，按接入方式：

**A. 9 个 RSS（零代码，复用现有 RSS collector，仅改 `RSS_FEEDS` 的 `url|vendor`）** —— 全部实测 200 + 原生 feed + 非空：
- Together AI `https://www.together.ai/blog/rss.xml`、NVIDIA 开发者博客 `https://developer.nvidia.com/blog/feed/`、AWS ML Blog `https://aws.amazon.com/blogs/machine-learning/feed/`、Google Research `https://research.google/blog/rss/`、Google AI `https://blog.google/technology/ai/rss/`、Microsoft Research `https://www.microsoft.com/en-us/research/feed/`、Stability AI `https://stability.ai/news-updates?format=rss`、AlternativeTo `https://feed.alternativeto.net/news/all`、Perplexity changelog `https://docs.perplexity.ai/docs/resources/changelog/rss.xml`（所有 feed URL 含 `https://` scheme，与既有 RSS_FEEDS 条目一致）。
- vendor 标记：`together`/`nvidia`/`aws`/`google`（research.google 与 blog.google 同 vendor，feed_url 区分）/`google`/`microsoft`（与既有 Microsoft AI 同 vendor，feed_url 区分）/`stability`/`alternativeto`/`perplexity`。Perplexity changelog 为月级粗粒度（追产品迭代），标注。

**B. HF Papers — 新「JSON API 采集器」**：新增 `src/collectors/hf-papers.ts`，`GET https://huggingface.co/api/daily_papers`（无鉴权 JSON），映射 `source='hugging_face_papers'`、`source_item_id=String(paper.id)`、`url=https://huggingface.co/papers/{id}`、`title=paper.title`、`content=paper.summary`、`published_at=paper.publishedAt`、**`raw_type='paper'`、`collapsed=true`**（仅沉淀，与 arXiv 同——P2 不进事件/日报/推送，论文板块留 P3）、`metadata` 透传。`CollectorSource` += `'hugging_face_papers'`；registry 加项；纳入 `collectAllSources`（日报全集沉淀），**不入** `REALTIME_NEWS_SOURCES`/`PRODUCT_SOURCES`。

**C. Anthropic News — 新「sitemap 采集器」**：新增 `src/collectors/sitemap.ts`，**配置驱动**（`sitemap URL | 路径前缀 | vendor`）。流程：fetch `sitemap.xml`（正则提取 `<loc>`+`<lastmod>`，同 arXiv 正则解析模式、不引入 cheerio）→ 过滤路径前缀（`/news/`）+ `lastmod` 窗内 + **DB 已见集去重**（`canonical_url` 不在 `source='sitemap'` 已入库集，消每轮重复 fetch，best-effort 非 at-least-once）→ 对**每个窗内未见 URL** fetch 文章 HTML、**正则取 `og:title`(title) / `og:description`(content)**（靠标准 og: 标签、非站点专属选择器降脆弱；og:title 单缺回退 URL slug、og 双缺则跳过；正文全文留后续）→ 映射 `source='sitemap'`、`metadata.vendor='anthropic'`、`metadata.feed_url=sitemap URL`、`metadata.lastmod=lastmod`、`url=文章URL`、**`published_at=null`（lastmod≠发布时间，交既有 published-at-inference 推断，避免改版老文当新推刷屏）**、**`raw_type='news'`**（进事件塌缩→日报）、`source_item_id=canonical_url`（仅 `len>255` 折叠既有 `contentHash` 函数；畸形 loc 在过滤阶段已跳过、无 null 兜底分支）。**可观测**：sitemap 2xx 但解析 0 loc 判源失败告警（防站点改版静默归零）。`CollectorSource` += `'sitemap'`（通用机制、可扩展到其他有 sitemap 的 lab）；registry 加项；纳入 `collectAllSources`，**不入** `REALTIME_NEWS_SOURCES`（per-article fetch 较重）/`PRODUCT_SOURCES`。

**配置**：`.env.example`+`.env` 的 `RSS_FEEDS` 追加 9 条；新增 `SITEMAP_SOURCES`（`url|路径前缀|vendor` 列表，默认含 Anthropic）、`HF_PAPERS_MAX_PER_RUN`、sitemap 的窗口复用 `FIRST_SEEN_WINDOW_DAYS`。

## 功能 (Capabilities)

### 新增功能
（无新 capability——三部分均属 `source-collectors`。）

### 修改功能
- `source-collectors`: ① RSS 源清单纳入更多一手厂商/工具源（沿用既有 RSS 机制，零代码，无新需求判定，仅 config）；② 新增「HF Papers JSON API 采集器」需求（JSON API 采集器类型、paper sink-only）；③ 新增「sitemap 增量采集器」需求（sitemap-diff 发现 URL + per-article og: 提取、`source='sitemap'` + vendor、rawType='news'）；④ `CollectorSource` 扩 `hugging_face_papers`/`sitemap`；两新采集器均守既有不变量（source_item_id 非空 / allSettled 单源隔离 / withRetry / registry 注册即接入），不入实时告警/产品子集。

## 影响

- **代码**：新增 `src/collectors/hf-papers.ts`、`src/collectors/sitemap.ts`；`src/collectors/types.ts` `CollectorSource` += 两值；`src/collectors/index.ts` `buildRegistry` 加两项 + 导出 + 注入位；`src/config/env.ts` 加 `SITEMAP_SOURCES`/`HF_PAPERS_MAX_PER_RUN`。RSS 部分**零 src 改动**（仅 config）。新增两采集器单测 + fixture。
- **数据**：`raw_items` 多 `source='hugging_face_papers'`(paper sink)、`source='sitemap'`(Anthropic news)、`source='rss'`(9 新 feed) 行；Anthropic news 进事件流→日报。无 schema 迁移。
- **下游**：日报候选输入增多（9 RSS + Anthropic news）；论文仅沉淀不影响日报/告警；产品链不受影响（无产品源新增）。**9 个新 RSS feed 因 `REALTIME_NEWS_SOURCES` 含整个 `rss` source（feed 级无开关）会同时进入实时告警链**，由既有 `ALERT_IMPORTANCE_THRESHOLD` 等闸过滤（与既有 RSS 行为一致，本期接受；feed 级告警策略另开变更）。sitemap news 的 `published_at=null` 由 published-at-inference 回填后方进 Top-N 时效窗。
- **spec**：`source-collectors` 增量需求，归档时同步主规范。

## 非目标

- **不接** xAI / There's An AI For That / Futurepedia / BetaList / Indie Hackers（CF 硬墙或无入口）、Reddit（`.rss` 实测 429 + 条款灰区）、Papers with Code（已死）、GitHub Trending（无 feed）——见 `docs/source-expansion-roadmap.md`。
- **不引入 RSSHub**（公共实例自身被 CF 拦、须自托管运维、恰缺最难源路由、违背确定性轻量采集）、**不引入无头浏览器**。
- **不做 Anthropic 文章全文正文提取**（og:description 作摘要够 P2，全文留后续）；**不做论文板块渲染/推送**（HF Papers 同 arXiv 仅沉淀，target_type 不含 paper）。
- 不把确定性状态（源筛选/去重/幂等）交给 LLM。
- 不改既有 RSS/arXiv/PH/Show HN/HN/GitHub 采集器；不动 product-collapse / 事件塌缩 / 告警 / 日报编排。
