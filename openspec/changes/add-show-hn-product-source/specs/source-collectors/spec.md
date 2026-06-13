## 新增需求

### 需求:Show HN 产品采集（HN Algolia API）

系统 MUST 提供一个 Show HN 采集器，经 **Hacker News Algolia Search API**（`https://hn.algolia.com/api/v1/search_by_date`，无鉴权）拉取「Show HN」帖作为**产品发现源**。查询 MUST 用 `tags=show_hn` + `numericFilters` 叠加两道**确定性闸**：① 时间窗 `created_at_i > {下界}`（借 `FIRST_SEEN_WINDOW_DAYS` 天数作下界，**仅采集期控量**——非与下游选品口径同源，见 product-discovery：产品选品按 `last_seen_at`、不经 `published_at` 时效窗）；② 众投质量闸 `points >= SHOW_HN_MIN_POINTS`（默认 10）。`numericFilters` 多条件以逗号 AND。`points` 是 HN 群体投票信号、**非内容语义判断**（与 GitHub collector「按 star 倒序」同属确定性群体信号；区别：points 是**绝对阈值**，某轮可能 0 条达标 → 返回空，属预期、不触发告警）。MUST NOT 在采集期做关键词/LLM 语义预筛。单轮采集条数 MUST 有上限（`SHOW_HN_MAX_PER_RUN`，默认 30）。

查询 MUST 经 HTTP 正确编码（运算符 `>`/`>=` 等必须编码，否则裸 `>` 致 400）；`numericFilters` 多条件以逗号 AND——逗号**字面或 `%2C` 均可**（Algolia 服务端解码 `%2C` 回逗号、AND 仍生效，实测证实），故可用 `URLSearchParams`。MUST NOT 把 `points` 过滤放客户端（须在 `numericFilters` 串内由 API 侧过滤，否则单轮 `hitsPerPage` 上限会先按时间截断再滤、漏掉窗内高赞帖）。

采集器 MUST 把每条 Show HN 映射为统一 `CollectedItem`：`source='show_hn'`、`source_item_id = String(objectID)`（HN item id，稳定非空）、`url`=帖提交 URL、`title`=帖标题**剥除 `Show HN` 前缀后**的产品名（前缀形如 `Show HN` 后接 `:`/`-`/`–`/`—` 及空白，**大小写不敏感**；剥后为空串则回退原始 title，`title` NOT NULL 绝不留空）、`published_at`=（`created_at_i` 为**正数**时 `new Date(created_at_i*1000)`，否则 `null`——`created_at_i` 为秒、缺失/非数/`0`/负数均取 null，因 `new Date(0)`=1970 是合法 `Date` 不被 NaN 守卫挡）、**`raw_type='product'`**、`metadata` 透传 `points`/`num_comments`/`author`/`hn_object_id`。`published_at` MUST NOT 写成裸秒或裸毫秒数字（`CollectedItem.publishedAt` 为 `Date|null`，裸 number 类型不符且落库即错）。

`source='show_hn'` MUST 是独立于现有 `source='hacker_news'`（Firebase topstories 综合新闻流）的来源标识，**禁止复用 `hacker_news`**：二者 `raw_type` 不同（`hacker_news`=`post`、`show_hn`=`product`），共用同一 `(source, source_item_id)` 命名空间会因 `ON CONFLICT (source, source_item_id) DO NOTHING` 被判同条、先插入者胜，致前台高赞 Show HN 被 Firebase 抢先以 `post` 入新闻流、永不进产品塌缩（路由随采集顺序非确定）。独立 source 还使 `source` 作 registry 编排键可把 Show HN 精确归入产品源子集（见下）、`item.source='show_hn'` 在 `ai_products`/可观测上诚实标明产品流来源。

**跳过判据 = 复用既有 `extractProductMergeKeys` 得三归一键全空即跳**（单一口径，避免采集器判定与塌缩提键口径漂移）：采集器 MUST 对候选 item 调 product-collapse 导出的 `extractProductMergeKeys`，若 `canonical_domain`/`github_repo`/`product_hunt_slug` 全为 null 则记日志、**跳过、不发射**（不降级进新闻流）。此判据天然覆盖：`url` null/空串/缺字段、非 http(s)（`mailto:`/相对/`ftp:`）、**以及 `github.com/owner` 这类无具体 repo 的 org/profile 页**（`normalizeGithubRepo` 要求 ≥2 段路径 → `github_repo=null`；经 product-discovery 的无条件 `github.com` 域抑制后 `canonical_domain` 亦 null → 三键全空）。产品发现要可识别产品，无键者会建无归一键的孤儿行。

`CollectorSource` 枚举与 collector registry MUST 扩入 `show_hn`。MUST 新增产品源子集 **`PRODUCT_SOURCES = {product_hunt, show_hn}`**（与既有 `REALTIME_NEWS_SOURCES` 对称）；产品发现链路（`product-digest`）的采集 MUST 经 `collectSources(PRODUCT_SOURCES, ...)` 取所有产品源（取代硬编码单采 Product Hunt），使 Show HN 与 PH 在同一产品链被采集、紧接同链产品塌缩（链路显式闭合）。`show_hn` MUST NOT 纳入 `REALTIME_NEWS_SOURCES`（实时新闻/事件源子集）。所有外部调用 MUST 带重试与错误日志；单源失败 MUST 由编排层 `Promise.allSettled` 隔离，不拖垮整批、不触发系统级全失败告警。

#### 场景:Show HN 经 Algolia 时间窗 + points 闸采集为产品
- **当** 采集器以 `tags=show_hn` + `numericFilters=created_at_i>{FIRST_SEEN_WINDOW_DAYS 天下界},points>={SHOW_HN_MIN_POINTS}` 调 Algolia `search_by_date`
- **那么** 仅返回近窗内、points 达阈值的 Show HN，每条映射为 `source='show_hn'`、`raw_type='product'`、`source_item_id=String(objectID)`、`published_at=new Date(created_at_i*1000)`、`title` 已剥 `Show HN:` 前缀、`metadata` 含 points/author 等

#### 场景:归一键全空的 Show HN 被跳过不发射
- **当** 某 Show HN 帖经 `extractProductMergeKeys` 得三归一键全空（`url` null/空串/缺字段、或非 http(s) URL、或 `github.com/owner` 无具体 repo 的 org/profile 页）
- **那么** 采集器记日志并跳过该条、不发射 `CollectedItem`，product-collapse 不会遇到无归一键的孤儿产品

#### 场景:Show HN 用独立 source 不与 Firebase HN 命名空间碰撞
- **当** 同一前台高赞 Show HN 帖同时被 Firebase topstories collector（`source='hacker_news'`/`raw_type='post'`）与 Show HN collector（`source='show_hn'`/`raw_type='product'`）采到
- **那么** 二者 `(source, source_item_id)` 不同、各入库一行，分别进事件塌缩与产品塌缩，互不 `ON CONFLICT` 覆盖、不双计、路由确定

#### 场景:show_hn 经产品源子集采集、不进实时告警子集
- **当** 产品发现链路采集时
- **那么** `show_hn` ∈ `PRODUCT_SOURCES` 被 `product-digest` 经 `collectSources(PRODUCT_SOURCES)` 采到；且 `show_hn` ∉ `REALTIME_NEWS_SOURCES`，不进告警高频链——即便误入该子集，`raw_type='product'` 亦经事件塌缩排除而不评分告警（告警隔离由 raw_type 路由保障，非由子集成员资格保障）

#### 场景:Show HN 单源失败被隔离
- **当** Algolia API 调用失败（超时 / 非 2xx / 解析错）且重试耗尽
- **那么** 记错误日志后由编排层 `allSettled` 隔离，其余源照常完成、整批不中止、不触发全失败系统告警；points 阈值致某轮返回空亦属正常、不告警
