## 为什么

QA §7.3 把 **Hacker News「Show HN」** 列为关键产品发现源，但 P2 只接了 Product Hunt。Show HN 是开发者「秀作品」的高信号产品流——独立开发者、开源工具、AI 应用的首发常在此，与 ai-radar「AI 工具选型顾问」定位高度契合。

经实测（2026-06-14，先验证后设计），**HN Algolia Search API** 完全可行：`https://hn.algolia.com/api/v1/search_by_date?tags=show_hn`，无鉴权、HTTP 200、免鉴权限流约 1 万 req/h（每轮 1 次请求）。`numericFilters=created_at_i>{窗口},points>={阈值}`（逗号=AND）实测可用：近 3 天 333 条 Show HN，叠加 `points>=10` → 14 条有热度的真产品（Putt.day 267 赞、FablePool 513 赞、Paca/Jira 替代 101 赞等）。字段贴合 `CollectedItem`：`objectID`→sourceItemId、`title`→title、`url`→url（产品官网/github repo）、`created_at_i`（**秒**）→ publishedAt（须 `new Date(created_at_i*1000)`）、`points`/`num_comments`/`author`→metadata。

**review 推翻/修正的两处关键假设（先验证后设计）**：
1. **不能复用 `source='hacker_news'`**（D2）：现有 Firebase HN collector 以 `source='hacker_news'`+`String(item.id)`+`rawType='post'` 入库；Show HN 若复用同 `(source, source_item_id)` 但 `rawType='product'`，`store.ts` 的 `ON CONFLICT (source, source_item_id) DO NOTHING` 会让先插入者胜——前台高赞 Show HN 被 Firebase 抢先当 `post` 入新闻流、永不进产品塌缩。故用**独立 `source='show_hn'`**。
2. **「零塌缩改动」前提对 github 托管产品破裂（blocker，已据 review 修正为含一处小塌缩修复）**：`extractProductMergeKeys` 对 github URL 经 `extractCanonicalDomain` 得 `canonical_domain='github.com'`。Show HN 大量直链 `github.com/owner/repo`，**所有 github 托管产品 canonical_domain 都是 `github.com`** → 在产品塌缩 `lockMatchingProductIds` 的 OR 命中里彼此 size=1 命中 → **静默 UPDATE 合并、把所有 github 产品塌进同一行**（非 merge_conflict，更隐蔽）。故本提案**新增一处小而正确的塌缩修复**：**无条件**抑制 `canonical_domain='github.com'`（github.com 非有意义产品域，github 托管产品的精确键是 `github_repo`；指向 `github.com/owner` org/profile 页者无具体 repo、三键全空由采集器跳过）——此修复对 Product Hunt 同样正确（消除既有同类隐患）。

## 变更内容

- **新增 Show HN 采集器（`source='show_hn'`，新代码）**：调 HN Algolia `search_by_date`，`tags=show_hn` + `numericFilters=created_at_i>{近 N 天下界},points>={SHOW_HN_MIN_POINTS}`，映射为 `CollectedItem`：`sourceItemId=String(objectID)`、`url`、`title`（**剥除 `Show HN:` / `Show HN –` 前缀**再作产品名，避免 `ai_products.name` 带帖式前缀）、`publishedAt`（`created_at_i` 正数才 `new Date(created_at_i*1000)`、否则 null，秒→毫秒；比 `hacker-news.ts` toDate 多一道 `>0` 守卫防 1970）、**`rawType='product'`**、`metadata={points,num_comments,author,hn_object_id}`。带 `withRetry` + 错误日志，单源失败由编排层 `allSettled` 隔离。
- **`CollectorSource` 枚举新增 `'show_hn'`**；collector registry（`buildRegistry`）新增一项。
- **新增产品源子集 `PRODUCT_SOURCES = {product_hunt, show_hn}`**（与既有 `REALTIME_NEWS_SOURCES` 对称）；**`product-digest` 的采集阶段由硬编码 `collectProductHunt` 改为 `collectSources(PRODUCT_SOURCES, ...)`**，使 Show HN 与 PH 在**同一条产品链**被采集 → 紧接同链塌缩，链路显式闭合、不依赖跨 workflow 隐式时序。`show_hn` **不纳入** `REALTIME_NEWS_SOURCES`（实时新闻/事件源子集）。
- **一处小塌缩修复（F1 blocker）**：`extractProductMergeKeys` **无条件**令 `canonical_domain='github.com'` 置 null，使不同 github 产品按精确的 `github_repo` 键合并、不因共享 `github.com` 域被误并为一行（含 `github.com/owner` org/profile 页残留——无条件抑制 + 采集器三键全空跳过彻底闭合）。
- **`url` 归一后三键全空的 Show HN 跳过**：采集器**复用既有 `extractProductMergeKeys`**（单一口径）判定——若三归一键（`canonical_domain`/`github_repo`/`product_hunt_slug`）全为 null（覆盖 `url=null`/空串/缺字段、非 http(s) 如 `mailto:`/相对路径、以及 `github.com/owner` 无具体 repo 的 org 页）则不发射（记日志）。产品发现要可识别产品，无键者无法塌缩、不构成产品实体。
- **配置**：`.env.example` + 本地 `.env` 新增 `SHOW_HN_MIN_POINTS`（默认 10）、`SHOW_HN_MAX_PER_RUN`（单轮上限，默认 30）；复用候选窗口天数 `FIRST_SEEN_WINDOW_DAYS` 作 `created_at_i` 下界（**仅采集期控量**，见下「影响」对口径的更正）。

## 功能 (Capabilities)

### 新增功能
（无——Show HN 采集归入 `source-collectors`，产品消费归入既有 `product-discovery`。）

### 修改功能
- `source-collectors`: 新增 Show HN 采集器需求（Algolia API、`tags=show_hn` + 时间窗 + points 确定性闸、`source='show_hn'`、`rawType='product'`、`publishedAt` 单位、三键全空跳过、剥前缀、单源隔离）；`CollectorSource`/registry 扩 `show_hn`；新增 `PRODUCT_SOURCES` 子集；声明 `show_hn` 不在 `REALTIME_NEWS_SOURCES`。
- `product-discovery`: 声明产品塌缩为**多源**输入（source-agnostic，PH + Show HN）；`product-digest` 采集 `PRODUCT_SOURCES`；新增**无条件抑制 `canonical_domain='github.com'`** 的合并键修复（github 产品按 `github_repo` 合并、org 页无键跳过）；跨源合并经 `github_repo`/`canonical_domain`、缺 `product_hunt_slug` 不破坏；`name` 跨源为先到源标题（last-writer，下游 product-digest 用 `ai_products.name` 展示、不依赖 `representative_raw_item_id`）。

## 影响

- **代码**：**新增叶子纯模块 `src/collectors/product-keys.ts`**（迁入 `extractProductMergeKeys`+`normalizeGithubRepo`+`asString`+`extractCanonicalDomain`+`ProductMergeKeys`，最小入参 `ProductKeyInput`，传递闭包零 `../db` 零 `../config/env`，F1 无条件抑制落此）；`product-collapse.ts` 与 `product-hunt.ts` 改从 product-keys import 相应符号（迁移 `product-hunt.test.ts` 引用）；新增 `src/collectors/show-hn.ts`（import product-keys 的 `extractProductMergeKeys` 判跳过、不 import product-collapse）；`src/collectors/types.ts` `CollectorSource` 加 `'show_hn'`；`src/collectors/index.ts` `buildRegistry` 加项 + 导出 + 新增 `PRODUCT_SOURCES` + `PerSourceOptions/collectors`（具名键）加 `showHn`；**`src/pipeline/product-digest.ts` 采集阶段改用 `collectSources(PRODUCT_SOURCES, options.collectOptions)`，并把注入位 `RunProductDigestOptions.collect: ProductHuntCollectorOptions` 改为 `collectOptions?: CollectAllOptions`（迁移既有 PH 测试注入位 `collect:{...}` → `collectOptions:{productHunt:{...}}`）**；`src/config/env.ts` 加两项。新增采集器单测 + 塌缩集成测试 + product-digest 端到端测试 + 真实 Algolia 响应 fixture。
- **数据**：`raw_items` 多 `source='show_hn'`/`raw_type='product'` 行；`ai_products` 多 Show HN 来源产品、与 PH 跨源合并。无 schema 迁移。
- **下游口径更正**：产品 `product-digest` 选品按 **`ai_products.last_seen_at` DESC**（`product-digest.ts`），**不经 `published_at` 时效窗**。故采集期 `created_at_i>{FIRST_SEEN_WINDOW_DAYS 天}` 下界**仅为采集量控制**（少采老帖），**并非**与日报/告警的 `published_at` 近 N 天闸「口径同源」——`published_at` 仍正确填以备 P5 富化，但产品链当前不消费它。事件流/告警**不受影响**（`raw_type='product'` 经 dedup-and-normalization `IS DISTINCT FROM 'product'` 排除出事件塌缩）。
- **spec**：`source-collectors` 与 `product-discovery` 增量需求，归档时同步主规范。

## 非目标

- **不移除/改动现有 Firebase topstories HN collector**（`source='hacker_news'` 综合新闻流，与 Show HN 产品流互补并存）。
- **不改 `ai_products` schema、不加富化列**（富化留 P5）；product-collapse 仅做 F1 的 `github.com` 抑制这一处必要修复，不重构其合并算法。
- **不做 Show HN 的 LLM 语义预筛**：采集期只用 `points` 众投确定性闸 + 时间窗（与 github collector「按 star 排序」同属确定性群体信号、非内容语义；区别：points 是绝对阈值，可能某日返回空，属预期、不触发任何告警）。
- **不接 Reddit r/SideProject、r/SaaS 等其余 §7.3 产品源**（条款风险/单列后续）。
- **不把确定性状态交给 LLM**：源筛选、去重、产品合并、幂等仍由程序 + DB 唯一约束保障。
