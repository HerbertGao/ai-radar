## 1. 前提复验（实现前钉死）

- [x] 1.1 复验 `src/collectors/types.ts` 的 `CollectorSource` 现有值、`CollectedItem` 字段（含 `collapsed?`）；`src/collectors/index.ts` 的 `buildRegistry`/`PerSourceOptions`/`collectors` 注入位结构、`REALTIME_NEWS_SOURCES`/`PRODUCT_SOURCES` 子集
- [x] 1.2 复验 `src/collectors/arxiv.ts` 的「正则解析 XML + `collapsed=true` sink + 无 identifier 跳过（:195）+ `toDate` NaN 守卫」模式（HF/sitemap 复用此范式）；`src/dedup/collapse.ts` 事件塌缩 `IS DISTINCT FROM 'paper'`（确认 paper 被排除、news 纳入）；`src/dedup/normalize.ts` 的 `normalizeUrl`（非法返 null）；`src/collectors/types.ts` 的 `contentHash`（由 normalize.ts 的 `sha256Hex` 支撑；sitemap source_item_id 在 `len>255` 时折叠调用，**调用既有函数勿手写哈希**，按实际导出位置 import）
- [x] 1.3 复验 `.env`/`.env.example` 现有 `RSS_FEEDS`（追加 9 条前确认当前条数）、`FIRST_SEEN_WINDOW_DAYS`（sitemap 窗复用）
- [x] 1.4 复验 published-at-inference 回填闸：`src/agents/published-at-inference/backfill.ts` 回填域（确认日报域为 `published_at IS NULL AND should_push=true`、告警域为 `published_at IS NULL AND importance>=阈值`——非纯 IS NULL，M-C 须据此精确表述）；`src/pipeline/run-daily-workflow.ts` 阶段顺序（评分阶段 3 先于回填阶段 3.5，确认 should_push 在回填前已定）；`src/selection/top-n.ts` 时效闸键于 `published_at`（确认 NULL 自然排除、走 inference 后才进窗）；`src/agents/value-judge/score-events.ts` 评分仅 `importance_score IS NULL`（不依赖 published_at，确认 published_at=null 不阻评分）；`src/collectors/store.ts` 写 `canonical_url`、`ON CONFLICT DO NOTHING`、`source_item_id varchar(255)`（确认「DB 已见集」查询 `WHERE source='sitemap'` 可行 + first-fetch-wins + URL 长度上界，M-D/F-6）；`REALTIME_NEWS_SOURCES` 含整个 `rss`（确认 9 新 feed 自动进告警链，proposal 已披露）

## 2. 枚举与配置

- [x] 2.1 `src/collectors/types.ts`：`CollectorSource` 新增 `'hugging_face_papers'` 与 `'sitemap'`
- [x] 2.2 `src/config/env.ts`：新增 `HF_PAPERS_MAX_PER_RUN`（coerce 正整数，默认 50）；`SITEMAP_SOURCES`（解析 `url|pathPrefix|vendor` 逗号列表为 `{sitemapUrl,pathPrefix,vendor}[]`，默认含 `https://www.anthropic.com/sitemap.xml|/news/|anthropic`）。**比照 `RSS_FEEDS` 钉死错误分支启动快失败**（NIT-7）：每条段数≠3（`|` 不恰好 2 个）/ 任一段为空 / `pathPrefix` 不以 `/` 开头 → `ctx.addIssue`，绝不静默退化

## 3. HF Papers 采集器（JSON API）

- [x] 3.1 新增 `src/collectors/hf-papers.ts`：`collectHfPapers(options)` —— `GET https://huggingface.co/api/daily_papers`（注入 `fetchJson` 默认 global fetch + 超时）；映射每条：`source='hugging_face_papers'`、`sourceItemId=String(paper.id)`、`url=`https://huggingface.co/papers/${paper.id}`、`title=paper.title`、`content=paper.summary`、`publishedAt`=（paper.publishedAt 经**与 arxiv `toDate` 一致的 NaN 守卫纯函数**解析，有效则 Date 否则 null；toDate 复用/共享而非新写，NIT-4）、`rawType='paper'`、`collapsed=true`、`metadata={hf_paper_id:paper.id, submittedBy?, organization?, num_comments?}`；取前 `HF_PAPERS_MAX_PER_RUN` 条；`withRetry` + 错误日志，整源失败抛出由编排层隔离
- [x] 3.2 **缺字段跳过（M-B，比照 arxiv.ts:195）**：`paper.id` 缺失/null/空串 → 跳过该条 + 记日志，**绝不** `String(null|undefined)`（防假 id 绕过 store 空 id 校验致静默丢数据）；`paper.title` 缺失/空串 → 跳过该条 + 记日志（title NOT NULL，无回退源不降级）

## 4. sitemap 采集器（配置驱动 sitemap-diff + per-article og 提取）

- [x] 4.1 新增 `src/collectors/sitemap.ts`：`collectSitemaps(options)` —— 对每个配置源：① fetch sitemapUrl（注入 `fetchText` 桩），**正则**提取每个 `<url>` 的 `<loc>`+`<lastmod>`（同 arxiv.ts 正则范式，不引入 cheerio）；② 对每个 `loc` 先 `c = normalizeUrl(loc)`（**用 normalizeUrl 而非裸 `new URL(loc)`**——normalizeUrl 内部 try/catch、对相对/非 http/畸形 loc 返 null 不抛，统一 A-4 与 F-5 抛错路径）：`c===null` 跳过；否则 **`new URL(c).pathname.startsWith(pathPrefix)`**（在已规范化绝对 URL 上取 pathname、不会抛，`startsWith` 非裸 `includes` 防 query-string/fragment 误匹配，G-6/A-4）且 `lastmod` 在近 `FIRST_SEEN_WINDOW_DAYS` 天窗内（`lastmod` 缺失/NaN → **保守跳过该 URL**，M-4）且 `c` 不在 DB 已见集（M-D）；③ 对每个窗内未见 URL fetch 文章 HTML（注入 `fetchArticle` 桩），**正则**取 `<meta property="og:title" content="...">`→title、`og:description`→content；`og:title` 缺失回退 URL slug 派生（绝不空 title）；**`og:title`+`og:description` 同缺 → 跳过该篇不发射**（M-1）；④ 映射 `source='sitemap'`、`metadata={vendor, feed_url:sitemapUrl, lastmod}`、`url=文章URL`、**`publishedAt=null`**（lastmod 不进 published_at，走 inference，M-C）、`rawType='news'`、`sourceItemId`=（`c` 已非 null（②跳过过），`c.length > 255` → `contentHash(title, content)`；否则 `c`，M-B/F-6——超 255 在 store 阶段 INSERT 抛错且不被采集器隔离，故采集器侧前置折叠）
- [x] 4.2 **DB 已见集去重（M-D）**：per-article fetch **前**查「已见集」（注入「已见集」查询函数桩可测，默认查 raw_items）。**去重键 = `canonical_url`**（候选侧 = `normalizeUrl(loc)`，**必须用 fetch 前可从 URL 单独算出的纯 URL 值**；**不可**用 `source_item_id`——其在 `len>255` 时折叠为 `contentHash(title,content)`、依赖 fetch 后才有的 og 内容，fetch 前无法复算）。查询 `SELECT canonical_url FROM raw_items WHERE source='sitemap'`：`WHERE source=` 走 `(source, source_item_id)` 唯一索引 `source` 前缀范围扫定位行，`canonical_url`（无索引 text 列）投影回表（非 index-only，行量小可接受）；**本期不为 `canonical_url` 加索引（守无 schema 迁移）**。候选 `normalizeUrl(loc)` 已在集内则跳过、**不重复 fetch HTML**；窗口仅作粗筛，机制注释显式声明 best-effort 窗口快照 + DB 去重、非 at-least-once + first-fetch-wins（og 更新不重抓）。**查询失败（DB 不可达/超时）→ 整源 throw 由 allSettled 隔离，绝不降级空集致全量重抓（F-4）**。畸形 loc（`normalizeUrl(loc)` 返 null，含相对/非 http/抛错）在过滤阶段跳过、不入已见集（F-5/A-4，统一用 normalizeUrl 而非裸 `new URL(loc)` 避免相对 loc 抛错）
- [x] 4.3 **可观测计数器 + 静默归零告警（M-A）**：每源记 `loc_count`/`path_match_count`/`window_candidate_count`/`emitted_count`；sitemap 2xx 但 `loc_count=0`（结构变更/正则失配）→ `logError` 并把该源判为**失败**（编排层 perSource.ok=false 计入告警），**绝不**记「成功 0 条」；仅 `loc_count>0 && window_candidate_count=0` 视作正常无新文
- [x] 4.4 限量与隔离：仅 fetch 窗内未见 URL；每篇 fetch + 整源调用经 `withRetry`；单篇失败 try/catch 跳过该篇（记日志）、不拖垮该源；整源失败抛出由编排层 `allSettled` 隔离

## 5. 注册（registry + 子集）

- [x] 5.1 `src/collectors/index.ts`：`buildRegistry` 加 `{source:'hugging_face_papers', collect:()=>(c.hfPapers??collectHfPapers)(options.hfPapers)}` 与 `{source:'sitemap', collect:()=>(c.sitemap??collectSitemaps)(options.sitemap)}`；导出两采集器；`PerSourceOptions.hfPapers?`/`sitemap?` + `collectors` **具名键** `hfPapers?`/`sitemap?`（避免 `(opts?:never)` 基底）；**确认两源未加入 `REALTIME_NEWS_SOURCES`/`PRODUCT_SOURCES`**

## 6. RSS 配置（零代码）

- [x] 6.1 `.env.example` + 本地 `.env` 的 `RSS_FEEDS` 末尾追加 9 条 `url|vendor`（**URL 必须含 `https://` scheme**，否则 `rss-parser.parseURL` 收到非绝对 URL 报错，与既有条目格式一致）：`https://www.together.ai/blog/rss.xml|together`、`https://developer.nvidia.com/blog/feed/|nvidia`、`https://aws.amazon.com/blogs/machine-learning/feed/|aws`、`https://research.google/blog/rss/|google`、`https://blog.google/technology/ai/rss/|google`、`https://www.microsoft.com/en-us/research/feed/|microsoft`、`https://stability.ai/news-updates?format=rss|stability`、`https://feed.alternativeto.net/news/all|alternativeto`、`https://docs.perplexity.ai/docs/resources/changelog/rss.xml|perplexity`
- [x] 6.2 `.env.example` + 本地 `.env` 加 `HF_PAPERS_MAX_PER_RUN=50` 与 `SITEMAP_SOURCES=https://www.anthropic.com/sitemap.xml|/news/|anthropic`（带注释）

## 7. 测试（不触网，注入桩 + fixture）

- [x] 7.1 `src/collectors/__tests__/hf-papers.test.ts`：注入 fetchJson 桩 + 固化真实 daily_papers 响应 fixture（`__tests__/fixtures/hf-daily-papers.json`）；断言映射（source/sourceItemId=String(paper.id)/url/title/content/publishedAt 有效或 null）、`rawType='paper'` + `collapsed=true`、`HF_PAPERS_MAX_PER_RUN` 截断、**缺 id 跳过（绝不产 'null'/'undefined' id）**、**缺 title 跳过（绝不空 title）**、单源失败 withRetry 后抛出
- [x] 7.2 `src/collectors/__tests__/sitemap.test.ts`：注入 fetchText（sitemap XML 桩）+ fetchArticle（文章 HTML 桩）+ **已见集查询桩** + 固化真实 Anthropic sitemap 片段与一篇文章 HTML fixture；断言 lastmod 窗过滤（窗内取/窗外跳/**lastmod 缺失·NaN 跳**）、**已见 URL 跳过不重复 fetch（已见集桩返含某 URL → 该 URL 不调 fetchArticle）**、og:title→title / og:description→content 正则提取、og:title 缺失回退非空 title、**og:title+description 同缺跳过该篇**、**`published_at=null` + `metadata.lastmod` 落值（lastmod 不进 published_at）**、`source='sitemap'`/`metadata.vendor`/`rawType='news'`/`source_item_id=canonical_url`（正常）·`len>255 折叠既有 contentHash 函数`（**无 NULL 兜底——畸形 loc 已在过滤阶段跳过不发射**）、**loc_count=0（2xx 空解析）判源失败（不记成功 0 条）**、**已见集查询失败 → 整源抛出（不降级空集全量重抓，F-4）**、**畸形 loc（normalizeUrl 返 null）过滤阶段跳过（F-5）**、**pathPrefix 用 pathname.startsWith 匹配（query-string 含 `/news/` 不误匹配，G-6）**、**source_item_id 长度 > 255 折叠 contentHash（F-6）**、**跨 vendor 唯一：两条不同 vendor/域名的 loc → source_item_id 互不相等且均为完整 canonical URL 非裸 slug（锁 D4 全局唯一前提，G-12）**、单篇 fetch 失败跳过不拖垮该源、整源失败抛出
- [x] 7.3 既有「全集采集」测试同步（NIT-3，点名目标防漏改）：
  - `src/pipeline/__tests__/run-daily-workflow.integration.test.ts` 三个桩 helper（`collectorsReturning`、`collectorsAllFail`、`collectorsArxivPaperOnly`）各加 `hfPapers: async()=>[]` / `sitemap: async()=>[]`
  - `src/collectors/__tests__/collectors.test.ts` 两处 inline 桩点（「全部源挂」用例、并发用例）各加两源空桩；`buildRegistry` 全集断言数组扩到 8 项含 `'hugging_face_papers'`/`'sitemap'`
  - **负向断言（MINOR-2，锁子集意图）**：断言 `REALTIME_NEWS_SOURCES` 与 `PRODUCT_SOURCES` 均**不含** `'hugging_face_papers'`/`'sitemap'`
  - **（自验补漏）第三处 collectAllSources 注入点 `src/collectors/__tests__/product-hunt.test.ts`**（PH 单源失败用例走全集 registry）同样加 `hfPapers`/`sitemap` 空桩——8.1 全量自验时发现该处漏桩回退真实 collectHfPapers 打了真实 HF API、已补（`show-hn-product-digest.integration.test.ts` 用 `collectSources(PRODUCT_SOURCES)` 子集、新源被过滤、无需桩）

## 8. 自验

- [x] 8.1 `npx tsc --noEmit` 0 错；`npx vitest run` 单测全绿（集成测试本地 PG 可连即跑、否则 skip，在结果说明）<br>结果：`tsc --noEmit` exit 0；`vitest run` **38 passed | 3 skipped（41 文件），417 passed | 7 skipped（424 测试）**（3 个 skip 为 `skipIf(!databaseUrl)` 的集成测试在本机已连 DB 实跑、未 skip 的其余集成测试全绿；7 个 test-level skip 为既有）

## 9. 远端 ts.mac-mini 部署

- [ ] 9.1 `ssh ts.mac-mini` → `cd ~/ai-radar` → `cp -p .env .env.bak.$(date +%Y%m%d-%H%M%S)` 备份
- [ ] 9.2 python3 精确改远端 `.env`：`RSS_FEEDS` 追加 9 条（断言旧 9 条不存在、防重复）+ 加 `HF_PAPERS_MAX_PER_RUN`/`SITEMAP_SOURCES`（键不存在才加）；勿整文件覆盖
- [ ] 9.3 本地 `docker build` → `docker save | ssh ts.mac-mini docker load`（GHCR 受阻，部署 memory）→ 远端 `docker compose --profile app up -d` 重建 worker/web
- [ ] 9.4 `docker compose exec -T worker printenv RSS_FEEDS HF_PAPERS_MAX_PER_RUN SITEMAP_SOURCES` 确认；`docker compose logs --since 90s worker` 确认 env 校验通过 + 启动日志 `已启动 N 条调度链`

## 10. 提交与规范归档

- [ ] 10.1 提交代码 + `.env.example`（`.env` 不入库）；含 src 实现 → **走 PR**
- [ ] 10.2 PR 合并后：`/opsx:sync` 将增量规范并入 `source-collectors` 主规范
- [ ] 10.3 PR 合并后：`/opsx:archive` 归档本变更（纯文档直推 main）
