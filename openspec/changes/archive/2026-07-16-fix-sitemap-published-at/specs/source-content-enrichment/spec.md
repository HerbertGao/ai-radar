## MODIFIED Requirements

### 需求:判分与摘要前的确定性正文补全

系统必须在 Value Judge 判分**之前**、对**待判新闻事件**的**代表 raw_item** 执行一次确定性正文补全：当代表 raw_item 的 `content` 为**空或纯空白**（见下「空定义须单一谓词」）**且**其有可抓取 URL（`canonical_url` 或 `url`）时，抓取该 URL 的文章 HTML，用 `og:description`（缺失时可退回有限正文文本）提取正文并写回 `raw_items.content`。补全**必须**复用 `extractOgTag` 与 `defaultFetchArticle` 既有的 2xx / `content-type` 含 `html` / `MAX_BODY_BYTES` / `COLLECTOR_FETCH_TIMEOUT_MS` **校验逻辑**，**禁止**引入新的可读性/DOM 解析依赖（不做全文抽取）；但因 `defaultFetchArticle` 默认 `redirect:'follow'` 且无出网守卫，补全**不得裸调 `defaultFetchArticle` 随访**，须以下述「SSRF/出网信任边界」的受控抓取（`redirect:'manual'`/逐跳 host 重校验）执行。

**作用域仅新闻、不含产品**：本阶段只对**新闻类**待判事件代表 raw_item 生效；产品条目（`raw_type='product'`）经独立 `product-collapse` 塌缩、且产品塌缩运行在本补全之后，产品行此时不存在，故产品**无补全 grounding**（产品按名判定，见 product-discovery）。

**待判工作集必须精确等于 Value Judge 将判的事件集**：补全的工作集**必须**与 `scoreUnscoredEvents` 的候选 SELECT 同口径——即 `importance_score IS NULL`（未评分）**且** `merged_into IS NULL`（非 tombstone）的事件，其中代表 raw_item `content` 为空且有可抓 URL 者。**理由**：value-judge-agent 要求「判分输入须含正文，除非补全失败」是**对所有被判事件**的普遍约束；若补全工作集窄于 `scoreUnscoredEvents` 将判的集合（如只覆盖本轮塌缩产物、漏掉上一轮已塌缩未评分的历史事件），这些漏掉的事件仍会被判分、却退化仅标题，违反该普遍约束。排除 tombstone 亦避免对已被合并、不会被判的事件浪费抓取。

**全站样板 `og:description` 必须视同缺失（本需求修改点）**：补全的正文来源就是 `og:description`，而部分源的文章页对**每一篇**都返回同一段**全站样板文案**（实测 Anthropic News 14 篇最新文章中 **6 篇**的 `og:description` 逐字相同：`Anthropic is an AI safety and research company that's working to build reliable, interpretable, and steerable AI systems.`）。采集器把该样板视同缺失（`content = null`，见 source-collectors）后，这些行**恰恰因此**落进本阶段的工作集；本阶段重抓的是**同一张页面**，拿回的是**同一段样板**——而它**非空**，`extractOgTag` 返回非空串即**成功路径**。若原样写回：

- `content` 由 `null` 变回**非空样板** → chinese-digest-agent 的 `hasContent`（判 `content` 非空）为 `true` → **「无正文不编造」护栏不触发** → LLM 拿一段全站公司简介当正文 grounding 去写这条事件的摘要。**这比无正文更糟**：无正文会触发护栏、只出 headline；样板则让模型理直气壮地拿无关内容当依据。
- 且 `content` 一旦非空，该行**永久离开本阶段的工作集**（工作集判 `content` 为空）——这段样板遂成为该 raw_item 的**终身正文**，此后无任何补全路径会再修正它。

故本阶段**必须**在写回**之前**判样板：抽到的 `og:description` 命中已知全站样板时，**必须按抓取失败计**（`fail += 1`、记错误日志、`content` 保持为空、继续下一条），**禁止**写回 `raw_items.content`。该样板判定**必须与采集器共享同一个 `isSiteBoilerplate` 判定**（**单一定义、两处引用**）；**禁止**在采集器与补全阶段各写一份——两份判定必然漂移（样板串变更时只改了一处，另一处照旧放行），本条要堵的洞会从漂移的那一侧重新打开。

补全**必须**满足以下不变量：

- **空定义须单一谓词、选取与写回一字不差**：「空或纯空白」**必须**用**同一个 SQL 谓词**在工作集选取与原子写回两处一致判定——例如 `content IS NULL OR content !~ '\S'`（无非空白字符即空白；等价 `btrim(content, E' \t\n\r\f\v')=''`）。**禁止**一处用应用层 JS `String.trim()`、另一处用 Postgres `trim()`：前者剥离 tab/换行/Unicode 空白，后者仅剥离 ASCII 空格，二者对 `'\t\n'` 类内容分歧——会致该行被工作集选中抓取、却在写回谓词命中 0 行、永久不填且向下游传空白（重开本条要消除的缺口）。
- **绝不覆盖已有非空 `content`（写回须原子判空）**：只对空/纯空白的行补写。写回**必须**将上述空判定与写入原子化——`UPDATE raw_items SET content=? WHERE id=? AND (content IS NULL OR content !~ '\S')`（0 行命中即已被并发填充，跳过、良性），**禁止**「先 SELECT 判空、后无条件 UPDATE」的非原子写（RSS/Ask HN 等并发再抓可能在两步间填入真实正文，被覆盖）。已有正文（如 RSS/Ask HN 自带 text、sitemap 抓到的**非样板** `og:description`）保持不变。
- **SSRF/出网信任边界（提交者可控 URL，绝不可复用假设为一方 URL 的裸抓取）**:补全抓取的 `canonical_url`/`url` 源自 HN / Show HN / Product Hunt / RSS 等**外部提交者可控**内容，与 sitemap 抓取的一方（Anthropic）URL **不同信任级**。`defaultFetchArticle` 自身**仅有** 2xx/content-type/大小/超时闸、**无 host/IP 出网守卫**（sitemap 的 host 同注册域守卫 FIX-7 在 `collectOneSitemap` 内、不在 `defaultFetchArticle`，本路径不经过它）。故补全抓取**必须**在发起请求前施加出网守卫：**拒绝私网 / 环回 / 链路本地 / 云元数据地址**（含 `127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`（含 `169.254.169.254`）、`::1`、`fc00::/7`、`fe80::/10` 等）与无法解析为公网的主机，并处理**跳转**（`redirect:'manual'` 或逐跳 host 重校验，防经 302 跳到内网绕过首跳校验）。补全**不得**将提交者可控 URL 当作一方 URL 裸抓取；design「不抓内网」的成立以本守卫为前提。
- **逐条隔离、best-effort、永不拖垮流水线**：单条抓取失败（网络错误 / 非 2xx / 非 HTML / 超限 / 超时 / og 缺失 / **抽到全站样板** / 被 SSRF 守卫拒绝）必须 try/catch 隔离、记错误日志、该条 `content` 保持为空并继续；补全阶段整体**禁止**向上抛错中止 `runDailyWorkflow()`，**禁止**计入任何降级率熔断分母（判分/摘要熔断口径不变）。
- **不改采集源、不新增源、不启用 browser egress**：补全只对已入库的代表 raw_item 按其既有 URL 抓取，属日报链内的确定性富化阶段。
- **可观测**：补全的命中数（成功写回）与失败数（含被 SSRF 守卫拒绝数、**命中全站样板数**）必须随日报日志暴露。

补全后写回的 `content` 供 value-judge-agent（判分 grounding）与 chinese-digest-agent（摘要 grounding）消费；补全失败（`content` 仍空，**含抽到全站样板而按失败计**）时，下游判分/摘要**必须**退化为「仅标题」路径并受各自的「无正文不编造」护栏约束（见 chinese-digest-agent）。

#### 场景:空 content 链接帖补抓 og:description 写回
- **当** 某待判事件代表 raw_item `content` 为空且有可抓 `canonical_url`（如 Hacker News 直链帖）、其 host 为公网地址，补全阶段抓取其文章 HTML 并 `og:description` 非空**且非全站样板**
- **那么** 提取的正文经原子判空 `UPDATE ... WHERE content IS NULL OR content !~ '\S'`（与工作集同一空谓词）写回该 `raw_items.content`，供后续判分与摘要 grounding

#### 场景:补抓到全站样板 og:description 按失败计、content 保持 null
- **当** 某待判事件代表 raw_item 的 `content` 为空（采集器已把该页的全站样板 `og:description` 视同缺失），补全阶段重抓同一张页面、`extractOgTag` 又抽回**同一段全站样板**（非空串，属 `extractOgTag` 的成功返回）
- **那么** 补全在写回**之前**以**与采集器共享的同一个 `isSiteBoilerplate` 判定**识别出样板，**按抓取失败计**（失败计数 +1、记错误日志、不发起写回、继续下一条），`content` **保持 `null`**；下游判分/摘要退化为仅标题路径，chinese-digest-agent 的「无正文不编造」护栏**正常触发**（只出 headline、绝不拿全站公司简介当正文编内容）

#### 场景:已有非空 content 不被覆盖(原子判空)
- **当** 某代表 raw_item 已有非空 `content`（如 RSS 自带正文，或 sitemap 抓到的非样板 `og:description`，或并发再抓在补全 SELECT 与 UPDATE 之间填入）
- **那么** 原子写回条件不命中（0 行）、跳过、不覆盖既有正文

#### 场景:提交者可控 URL 指向内网/元数据被 SSRF 守卫拒绝
- **当** 某代表 raw_item 的 `url` 指向私网 / 环回 / 链路本地 / 云元数据地址（如 `http://169.254.169.254/…` 或内网服务），或经 302 跳转指向此类地址
- **那么** 补全在发起（或逐跳）时被出网守卫拒绝、记失败日志与计数、`content` 保持为空、不抓取内网、不把响应体写回，下游对该事件退化仅标题

#### 场景:单条抓取失败隔离不拖垮流水线
- **当** 某条补抓因网络错误 / 非 2xx / 非 HTML / 超 `MAX_BODY_BYTES` / 超时 / `og:description` 缺失 / 抽到全站样板 / SSRF 拒绝而失败
- **那么** 该条捕获异常（或按失败计）、记错误日志、`content` 保持为空、继续下一条；补全阶段不向上抛错、不中止日报、不进熔断分母；下游对该事件退化为仅标题路径

#### 场景:无可抓 URL 或已是 tombstone 的事件跳过补全
- **当** 某代表 raw_item `content` 为空但既无 `canonical_url` 也无 `url`，或该事件 `merged_into` 非空（已被语义合并为 tombstone）
- **那么** 补全阶段跳过该事件（无可抓来源 / 不会被判分），不产生外部请求
