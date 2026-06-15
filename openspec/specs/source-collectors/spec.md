# source-collectors 规范

## 目的
待定 - 由变更 minimal-intel-pipeline 同步创建。归档后请更新目的。
## 需求
### 需求:三源确定性采集

系统必须提供一组确定性采集器（collector），以程序而非 Agent 自由采集的方式拉取数据，并将每条结果以统一结构写入 `raw_items`。统一结构必须至少包含 `source`、`source_item_id`、`url`、`title`、`content`、`published_at`、`raw_type` 字段（对齐 QA.md §10.1）。禁止用 LLM/Agent 决定采什么或是否采。

采集器编排必须**由数组驱动的 collector registry 承载**，而非把每个源写死成独立的编排分支：新增一个写入 `raw_items` 的源（如本期的 arXiv、Product Hunt、后续的厂商 HTML 源）必须只需向 registry 注册该 collector，**不需要修改 `CollectorSource` 联合类型以外的编排结构**（消除「加一源改两处」）。本期 registry 必须至少覆盖：RSS（含多个一线大厂官方 feed）、Hacker News、GitHub、arXiv、Product Hunt。**Product Hunt 也是写入 `raw_items` 的普通 collector**（`source='product_hunt'`、`raw_type='product'`，对齐 QA.md「输出统一写入 `raw_items`」与 `raw_type` 含 `product`）——产品塌缩进 `ai_products` 是下游确定性步骤（见 product-discovery），不绕过原始证据层。各源仍以 `Promise.allSettled` 并发、单源失败隔离。

registry 必须**支持按 `source` 字段筛选子集供不同工作流复用**：日报工作流调用全集，实时告警高频工作流只调实时新闻源子集 `{rss, hacker_news, github}`（见 realtime-alerts）。即 registry 暴露按 source 过滤的能力（如 `collectSources(registry, allowedSources)`），而非写死全量调用——避免高频链路被迫连 arXiv（非实时）/PH（配额受限）一起跑。

#### 场景:registry 注册即接入新源
- **当** 新增一个写入 `raw_items` 的采集源
- **那么** 仅需向 collector registry 注册该 collector 即可被每日采集编排并发调用，无需改动既有源的编排分支

#### 场景:多源各自拉取并统一入库
- **当** 每日流水线触发采集
- **那么** registry 中的各 collector 分别拉取并将结果按统一结构写入 `raw_items`，`source` 字段如实标记来源

#### 场景:单源失败不拖垮整批
- **当** 多源中某一源（如 GitHub API 限流或 arXiv 429）抓取失败
- **那么** 该源失败被记录错误日志，其余源照常完成入库，整批采集不因单源失败而中止

### 需求:源内幂等采集

系统必须为每条采集结果生成稳定且**非空**的 `source_item_id`，依赖 `raw_items` 的 `UNIQUE(source, source_item_id)` 约束保障同一源重复抓取不产生重复行。`source_item_id` 必须按 fallback 链取值：Hacker News 用 item id、GitHub 用 repo 稳定 id（如 full_name 或数值 id）、arXiv 用其稳定 arXiv id（如 `2406.12345` 或带版本的 OAI identifier）、Product Hunt 用其稳定 `product_hunt_slug` 或 PH 数值 id；各源稳定原生 id 缺失时统一 fallback 到 `canonical_url`（对 PH 即产品页规范化 URL）；`canonical_url` 也为空时，必须终端 fallback 到内容哈希（如 `sha256(title ‖ content)`），**绝不允许 `source_item_id` 为 NULL**——因为 Postgres 中 `NULL` 不等于 `NULL`，`UNIQUE(source, NULL)` 对多行全部放行，会使源内幂等静默失效。禁止用易变值（如原始 URL 含追踪参数、纯标题）当 `source_item_id`。fallback 链中用到的 `canonical_url` 由 URL 规范化纯函数在采集阶段即时生成（见 dedup-and-normalization）。

**RSS guid 必须按 feed 命名空间化**：RSS 的 `guid` 仅保证**单个 feed 内**唯一（不少 feed 用裸序号/短 id 作 guid），而 RSS 全部 feed 共用 `source='rss'`，故直接用 guid 作 `source_item_id` 会让两个不同 feed 的相同 guid 在 `UNIQUE(source, source_item_id)` 下被误判为同一条而错误去重。因此 RSS 的 `source_item_id` 必须命名空间化为 `sha256(feed_url ‖ '\0' ‖ guid)`（guid 缺失时仍按上面的 `canonical_url` → 内容哈希 fallback，二者本身全局唯一、不受此影响）。

#### 场景:重复抓取同一条不产生重复行
- **当** 同一源在两次采集中返回同一条目（相同稳定标识）
- **那么** 第二次写入因 `UNIQUE(source, source_item_id)` 冲突而被跳过，`raw_items` 中该源该条目仅一行

#### 场景:RSS guid 缺失时回退 canonical_url
- **当** 某 RSS 条目缺少 guid
- **那么** 系统以其即时生成的 `canonical_url` 作为 `source_item_id`，仍保证源内幂等

#### 场景:不同 feed 相同 guid 不被误判为同一条
- **当** 两个不同大厂 feed 各有一条 `guid` 字面相同的条目
- **那么** 二者经 `sha256(feed_url ‖ '\0' ‖ guid)` 命名空间化后得到不同 `source_item_id`，`UNIQUE(source, source_item_id)` 不冲突，各自独立入库、不被误去重

#### 场景:arXiv 条目用稳定 arXiv id 作幂等标识
- **当** arXiv 采集返回某篇论文
- **那么** 系统以该论文稳定 arXiv id 作为 `source_item_id`，重复抓取该篇不产生重复行

#### 场景:Product Hunt 条目用稳定 slug 作幂等标识
- **当** Product Hunt 采集返回某产品并以 `source='product_hunt'`、`raw_type='product'` 写入 `raw_items`
- **那么** 系统以该产品稳定 `product_hunt_slug`（或 PH 数值 id）作为 `source_item_id`，重复抓取同一产品不产生重复 `raw_items` 行

#### 场景:guid 与 canonical_url 皆缺时终端回退内容哈希
- **当** 某条目既无稳定原生 id 又无可用 `canonical_url`
- **那么** 系统以内容哈希作为非空 `source_item_id`，源内幂等不失效

### 需求:采集外部调用带重试与错误日志

系统对所有外部源的网络调用必须带重试与错误日志（横切不变量）。失败时禁止静默吞掉，必须记录可观测的错误信息。

#### 场景:外部源瞬时失败时重试
- **当** 某外部源调用发生瞬时网络错误
- **那么** 系统按有限重试策略重试，并在最终失败时记录错误日志，不静默成功

### 需求:RSS 来源厂商标记

系统采集 RSS 时必须为每条目带上**来源厂商标记（vendor provenance）**并写入 `raw_items.metadata`（如 `{vendor, feed_url}`），使一线大厂官方发布（OpenAI / Google DeepMind / Hugging Face 等）与普通博客可区分。当前实现把所有 RSS 条目标成 `source='rss'` 并丢弃来源 feed，本期必须改为：每个配置的 feed 携带其厂商标识（由配置的 feed→vendor 映射决定），采集时落入 `metadata`，供后续重要性评分与日报展示区分「谁发布的」。`source` 字段可保持 `rss`（来源类别），厂商身份承载于 `metadata`，不得因加 vendor 标记而破坏既有 `source_item_id` fallback 链与源内幂等。

`RSS_FEEDS` 配置格式由「纯 URL 逗号列表」升级为「带 vendor 标记的 feed 配置」：**逗号分隔多个 feed 条目，每个条目必须含 `|` 分隔符、形如 `url|vendor`**。解析每个条目的算法必须钉死以下确定性顺序，消除「以是否含 `|` 区分新旧」与「URL 不得含 `|`」的环形依赖：① 按 **首个** `|` split 成两段；② 校验 split 出**恰好 2 段**（即条目含且仅含一个 `|`）——split 后第二段再含 `|`（即原 URL 含 `|`）则判**配置错误、启动报错**；③ 条目**不含 `|`**（split 仅 1 段）则判**旧裸 URL 格式、启动快速失败并提示新格式**。vendor 段（第二段）可空：`url|`（尾随空 vendor）→ `metadata.vendor` 取 `null`、不报错、不阻塞采集。这是破坏性 env 变更，禁止静默把所有 feed 的 vendor 置空入库。

#### 场景:大厂官方 RSS 条目带厂商标记入库
- **当** 采集 OpenAI / DeepMind / Hugging Face 官方 RSS feed
- **那么** 每条目的 `raw_items.metadata` 含其 vendor 标识与 feed_url，可据此区分发布厂商

#### 场景:加 vendor 标记不破坏源内幂等
- **当** 同一 feed 的同一条目被重复抓取
- **那么** vendor 标记写入 `metadata` 不改变 `source_item_id` 取值，第二次仍因 `UNIQUE(source, source_item_id)` 冲突被跳过

#### 场景:RSS_FEEDS 旧裸 URL 格式启动即报错
- **当** `RSS_FEEDS` 含不带 `|` 分隔符的裸 URL 条目（旧格式）并尝试启动
- **那么** env 校验以「条目无 `|`」机械判为旧格式、明确错误信息快速失败提示新格式，而非静默把 vendor 置空继续

#### 场景:url| 空 vendor 取 null 不阻塞
- **当** 某 feed 条目为 `url|`（含分隔符但 vendor 段为空）
- **那么** 其条目 `metadata.vendor` 为 `null`，采集照常完成、不报错

#### 场景:feed URL 含 | 字符时启动报错
- **当** 某 feed 条目按首个 `|` split 后第二段仍含 `|`（即原 URL 含 `|`、条目含多于一个 `|`）
- **那么** env 校验判为配置错误、启动快速失败，而非误把 URL 尾段当 vendor

### 需求:arXiv 采集遵守限流与退避

系统的 arXiv 采集器必须遵守 arXiv 的硬限流：**每 3 秒不超过 1 个请求、单连接串行**。采集必须内置**单采集进程内** ≥3 秒串行节流（前提：P2 采集由单实例承载，见下），并对 HTTP 429 响应做退避重试（2026-02 起 arXiv 收紧 429 执行）。退避重试必须**有上限**：超限则本轮该源放弃、记 error，由 `Promise.allSettled` 隔离——禁止无界退避让该源 promise 长期 pending 拖长整个 job；该放弃**不计入**「全部源采集返回 0」的系统级故障告警（仅单源失败）。arXiv 采集优先走 OAI-PMH 增量元数据接口（官方推荐的保持最新方式）。

**P2 范围限定**：arXiv 论文仅以 `raw_type='paper'` 采集落 `raw_items` 作**数据沉淀**，本期**不进事件塌缩、不进日报、不推送**（事件塌缩按 dedup-and-normalization 类型路由排除 `paper`；论文板块留 P3）。arXiv 作为**非实时源**，不得接入实时告警路径。

**OAI-PMH 增量游标必须 at-least-once**：增量游标（如上次 harvest 时间戳）**必须在条目成功入库后才推进**，禁止「先推进游标后入库」——否则进程在二者之间崩溃会跳窗漏论文（静默丢条）。重抓由 `UNIQUE(source, source_item_id)` 幂等吸收，故 at-least-once（宁可重抓不可漏窗）安全。

所有调用必须带重试与错误日志；但**鉴权类错误（HTTP 401/403）不进入退避重试**（重试不可恢复的鉴权错误只是浪费预算），直接按单源失败记 error、由 allSettled 隔离。

节流口径限定为**单采集进程内串行**：本期明确 arXiv（及全部采集）由单实例承载，进程内串行节流闸即满足 arXiv 侧限流；**不**承诺跨多 worker 的全局分布式节流（若未来多实例采集，再引入 Redis 令牌桶，不属本期）。

#### 场景:arXiv 请求按 ≥3 秒节流串行
- **当** arXiv 采集需要在单采集进程内发起多次请求
- **那么** 请求以 ≥3 秒间隔、单连接串行发出，不以并发连接绕过限流

#### 场景:遇 429 退避重试且有放弃上限
- **当** arXiv 返回 HTTP 429
- **那么** 采集器退避后重试、记录错误日志，不静默失败也不无视退避立即重打；持续 429 达重试上限时本轮该源放弃并记 error、由 allSettled 隔离，不无界 pending 拖长 job、不触发全失败告警

### 需求:RSS 源分层与次级源噪音治理

系统的 RSS 源清单 MUST 允许在 T1 大厂官方源（高信号，如 OpenAI / DeepMind / Hugging Face / Mistral / Microsoft）之外，纳入**次级 / 社区源**（较低信号、非 AI-only，如 GitHub Blog `github.blog/feed/`、GitHub Changelog `github.blog/changelog/feed/`、Lobsters `lobste.rs/rss`）。两类源 MUST 共用 `source='rss'`、**沿用**既有「三源确定性采集」「源内幂等采集」「RSS 来源厂商标记」需求的采集保障（`source_item_id` fallback 链 / 源内幂等 / 单源失败隔离 / vendor provenance 落 `metadata`）——本需求**不重定义**这些既有判定，仅声明次级源同样适用、不因信号高低而分裂出新 `source` 取值或新 collector。

次级源的**噪音治理 MUST 完全交由下游既有闸**承担，且 MUST 分清两类闸：① **LLM 语义判断**——Value Judge 输出的 `importance`（0-100，落库列 `importance_score`）评分与**语义布尔 `should_push`**（LLM 直出字段，非程序对 importance 的数值比较；prompt 不含任何如 75 的数值锚，代码亦无推导 `should_push` 的 `importance>=N` 程序闸——注意这指 `should_push` 的产生，不否认日报 `IMPORTANCE_FLOOR` 与告警 `ALERT_IMPORTANCE_THRESHOLD` 这两道独立的 importance 阈值闸）；② **程序确定性闸**——日报 `IMPORTANCE_FLOOR`（与噪音治理相关的必要闸为 `should_push=true AND importance_score >= IMPORTANCE_FLOOR`；这非 Top N 候选的完整条件，后者另含 `published_at` 时效窗口与 Model B 通道去重，见 `src/selection/top-n.ts`）与实时告警 `ALERT_IMPORTANCE_THRESHOLD`。系统 MUST NOT 在采集期对次级源做源级排除、关键词硬预过滤或专门的更高门槛——即「够好才挤进日报 / 告警」由上述语义判断 + 确定性闸共同把关，价值判断不下放给采集期规则（守「Agent 控语义、不把语义判断交给硬规则」分层原则）。**注意系统当前无「AI 相关性」确定性硬闸**（`is_ai_related` 经 schema 解析后被丢弃、无对应列），非 AI-only 内容的过滤依赖 Value Judge 的语义 `should_push` 判断而非规则。

#### 场景:次级源条目以 source='rss' 正常入库
- **当** 采集 GitHub Blog / GitHub Changelog / Lobsters 等次级 / 社区 RSS feed
- **那么** 每条目以 `source='rss'` 写入 `raw_items`，复用与 T1 源相同的 fallback 链与源内幂等，不被采集期源级排除

#### 场景:次级源噪音由下游评分闸吸收而非采集期硬筛
- **当** 某次级源条目经 Value Judge 评分后未获 `should_push=true`，或 `importance_score` 低于 `IMPORTANCE_FLOOR`
- **那么** 该条目自然不进日报候选 / 不占 Top N 名额，而采集层未对其做任何源级排除或关键词预过滤

### 需求:RSS vendor 多 feed 映射与社区源标记约定

系统的 vendor provenance 约定 MUST 支持**多个不同 feed 映射到同一 vendor**：当同一厂商提供多个 feed（如 GitHub Blog 与 GitHub Changelog 同属 GitHub，vendor 均为 `github`）时，两 feed MUST 共用同一 `metadata.vendor` 值，并 MUST 由 `metadata.feed_url` 落不同值以保留具体 feed 维度。此时跨 feed 的源内幂等（同 guid 不串号）由既有「源内幂等采集」需求的命名空间化 `source_item_id`（含 feed_url）保障——该不变量的键是 `feed_url`、**与 vendor 无关**，故本需求不重复定义它，仅声明「多 feed 同 vendor」不破坏该既有保障。

vendor 字段语义为「来源身份标识」（既往取值为公司名），且当前为**仅写入、下游尚无消费方按值读取**的 provenance 标签（保留以供未来评分 / 展示消费）。对**可识别的社区聚合源**（无单一厂商，如 Lobsters），系统 MUST 取**描述性来源标记**（如 `lobsters`）而非 `null`，以保留 provenance；`null` 仅保留给「无来源映射的普通博客」。此约定 MUST NOT 破坏既有「`url|` 空 vendor 取 null 不阻塞」与「feed→vendor 由配置映射决定」的行为。

#### 场景:多 feed 映射同一 vendor 由 feed_url 保留细分维度
- **当** 配置 GitHub Blog 与 GitHub Changelog 两个 feed、vendor 均标为 `github`
- **那么** 两 feed 的条目 `metadata.vendor` 均为 `github`，但 `metadata.feed_url` 落不同值，保留两 feed 的细分维度（本期仅落库留存 provenance，下游消费留待未来），且 `metadata.vendor` 共用 `github` 不会因此被任何下游逻辑误读（当前无代码按 vendor 值分支）

#### 场景:社区聚合源取描述性 vendor 而非 null
- **当** 采集 Lobsters（`lobste.rs/rss`）且配置 vendor 为 `lobsters`
- **那么** 其条目 `metadata.vendor` 为 `lobsters`（非 null），保留可识别的来源身份

### 需求:次级源经实时告警链由阈值过滤而非源级排除

由于实时告警高频链路的源子集 `REALTIME_NEWS_SOURCES` 含 `rss` 且为 **source 级粒度**（无 feed 级开关），纳入的次级 RSS 源条目 MUST 与 T1 RSS 源一样进入告警链采集与评分。是否真告警 MUST 继续服从 **realtime-alerts 主规范定义的全部候选条件**（不在本需求重复定义其判定）——其中 `ALERT_IMPORTANCE_THRESHOLD`（纯程序判定，严于日报）只是 **source-neutral 的重要性门槛、非唯一条件**：另含 `published_at` 非空且在时效窗口内、该事件按 realtime-alerts 的 **Model B（channel-agnostic「一生一次」：尚未 alert-success 投递给所有已配置通道）** 去重、单轮上限 `ALERT_MAX_PER_SCAN` 等。本需求不简化、不绕过这些既有候选条件。系统 MUST NOT 为压制次级源而把 `rss` 从告警子集摘除（会误伤 T1 大厂官方 RSS 的重大发布实时告警），本期亦 MUST NOT 引入 feed 级告警黑名单——次级源告警噪音的兜底是高阈值 + realtime-alerts 全部候选条件 + Model B 一生一次去重。

#### 场景:次级源与 T1 源同等套用 realtime-alerts 全部候选条件
- **当** 某次级源（如 GitHub Changelog）条目经评分，且满足 realtime-alerts 主规范的全部候选条件（含 `importance_score >= ALERT_IMPORTANCE_THRESHOLD`、`published_at` 在时效窗口内、按 Model B 尚未 alert-success 投递给所有已配置通道）
- **那么** 该事件按既有告警链触发实时告警（与 T1 源同等对待，达阈值是必要而非充分条件）

#### 场景:次级源未达阈值不告警且不被源级摘除
- **当** 某次级源条目 `importance_score` 低于 `ALERT_IMPORTANCE_THRESHOLD`（或不满足 realtime-alerts 其余候选条件，如时效窗口 / Model B 通道去重）
- **那么** 该事件不触发告警，但 `rss` 仍保留在 `REALTIME_NEWS_SOURCES` 中（T1 RSS 源的告警能力不受影响）


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

### 需求:Hugging Face Papers 采集（官方 JSON API）

系统 MUST 提供一个 HF Papers 采集器，经 **Hugging Face 官方 JSON API**（`GET https://huggingface.co/api/daily_papers`，**无鉴权**）拉取每日精选论文作**数据沉淀源**。采集器 MUST 把每条映射为统一 `CollectedItem`：`source='hugging_face_papers'`、`source_item_id = String(paper.id)`（HF 稳定论文 id，非空）、`url = https://huggingface.co/papers/{paper.id}`、`title = paper.title`、`content = paper.summary`、`published_at`=（`paper.publishedAt` 为有效日期则 `Date`，否则 `null`；解析 MUST 用与 arXiv `toDate` 一致的 NaN 守卫）、**`raw_type='paper'`**、**`collapsed=true`**、`metadata` 透传 `hf_paper_id` 及可得的 `submittedBy`/`organization`/`num_comments`。单轮条数 MUST 有上限（`HF_PAPERS_MAX_PER_RUN`）。

**缺字段处置（硬规定，比照 arXiv「无 identifier 跳过」先例）**：`paper.id` 缺失/null/空串时采集器 MUST **跳过该条并记日志**，MUST NOT `String(null|undefined)`（否则产 `'null'`/`'undefined'` 假 `source_item_id` 绕过 store 空 id 校验、互相 `ON CONFLICT` 吞掉致静默丢数据）。`paper.title` 缺失/空串时 MUST **跳过该条并记日志**（`raw_items.title` NOT NULL，无合理回退源时不降级、不写空 title）。所有来自 API 的字符串字段（`title`/`summary`/`organization`/`submittedBy`）在 `.trim()` 前 MUST 守卫为字符串（非字符串归空），防 HF 返非字符串致 `.trim()` 抛错拖垮整源。HF 为 JSON API 源（非 RSS），不受 RSS vendor-provenance 不变量约束，来源身份由 `metadata` 的 `organization`/`submittedBy`/`hf_paper_id` 承载。

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

#### 场景:HF Papers 字段为非字符串不崩整源
- **当** HF API 对 `paper.title`/`summary`/`organization` 返回非字符串（数字/对象等）
- **那么** 采集器经字符串守卫归空、按行优雅处理（title 归空→跳过该行 / content 归 null / organization 不写），绝不因 `.trim()` 抛错使整个 `hugging_face_papers` 源失败

#### 场景:HF Papers 单源失败被隔离
- **当** daily_papers API 调用失败（超时/非 2xx/解析错）且重试耗尽
- **那么** 记错误日志后由 `allSettled` 隔离，其余源照常完成、整批不中止、不触发全失败告警

### 需求:sitemap 增量采集（无 RSS 的 lab 一手新闻）

系统 MUST 提供一个**配置驱动的 sitemap 增量采集器**，用于接入「无原生 RSS、但有 `sitemap.xml` 且文章页服务端渲染含 `og:` 标签」的一手 lab 新闻源（首期：Anthropic News）。配置 MUST 为列表，每项含 `sitemap URL`、`路径前缀`（如 `/news/`）、`vendor`（如 `anthropic`）。

采集流程 MUST 为：① fetch `sitemap.xml`，**正则线性切块**解析每个 `<url>` 的 `<loc>` 与 `<lastmod>`（MUST 用 `indexOf` 切块/取标签而非整-xml lazy 捕获正则，防未闭合标签的二次方回溯 ReDoS；标准无前缀 `<loc>` 才取，排除 `image:loc` 等扩展命名空间标签）；② 对每个 `loc` 先 `c = normalizeUrl(loc)`（`normalizeUrl` 内部 try/catch、对畸形/非 http/相对无 base 的 loc 返 null 而不裸抛——MUST NOT 用裸 `new URL(loc)` 直接取 pathname，否则相对 loc 会抛 `TypeError` 中断该源）；`c === null` 跳过该 loc；否则按 `new URL(c).pathname` **以配置路径前缀开头**（`startsWith`，在已规范化的绝对 URL 上取 pathname，**非**裸字符串 `contains` 以免误匹配 query-string/fragment）、文章 host 与 sitemap host **同注册域**（剥 `www.` 后相等或为其子域，防 SSRF 抓内网/元数据 host）、`lastmod` 在近 `FIRST_SEEN_WINDOW_DAYS` 天窗内、**且 `c`（即 `canonical_url`）不在「DB 已见集」**（见下「增量语义」）同时满足才纳入；③ 对**每个窗内未见 URL** fetch 文章 HTML、提取 `og:title`（→ `title`）与 `og:description`（→ `content`）；④ 映射为 `CollectedItem`：`source='sitemap'`、`metadata.vendor=<配置 vendor>`、`metadata.feed_url=<sitemap URL>`、`metadata.lastmod=<lastmod>`、`url=文章 URL`、**`published_at=null`**（见下「时效正确性」）、**`raw_type='news'`**、`source_item_id = canonical_url(文章 URL)`（即步骤②的 `c`，恒非 null——null loc 已在②跳过、不发射），**仅 `c` 长度 > 255 时 MUST 折叠为既有 `contentHash(title, content)` 函数**（`raw_items.source_item_id` 为 `varchar(255)`，超界会在 store 阶段 INSERT 抛错且不被采集器隔离，故采集器侧前置折叠）。**无 `normalizeUrl=null → contentHash` 兜底**（与「null loc 过滤阶段跳过」一致，避免矛盾及 `canonical_url=NULL` 入库致去重失效）。`og:title` 缺失时 MUST 回退（如 URL slug 派生，回退值经危险字符净化）以保证 `title` 非空；`og:title` 与 `og:description` **同时缺失**时 MUST **跳过该篇、不发射**（防 slug-title + null-content 退化垃圾进日报候选）。

**文本安全（MUST）**：所有进 `raw_items` 文本列（`title`/`content`/`metadata` 字符串值）的值——无论来自 og 标签、实体解码、URL slug 派生——MUST 剔除 NUL/C0 控制字符（保留 `\t\n\r`）与 lone surrogate（保留合法 emoji 代理对），防 Postgres `text` INSERT 遇 NUL 抛错中止整批、lone surrogate 破坏下游 `JSON.stringify`。XML/HTML 实体解码 MUST 同时支持命名实体与数字字符引用（`&#NNN;`/`&#xHH;`），且数字实体解出的危险码点同样剔除。

**时效正确性（MUST，对齐既有 published_at recency 红线）**：采集器 MUST NOT 把 `lastmod` 写入 `published_at`。`lastmod` 是「最后修改」时间，改版老文会被 Top-N 时效闸误当「今天发布」纳入候选；且 published-at-inference 回填只对 `published_at IS NULL` 触发，非 NULL 的 lastmod 永不被纠正。故 `published_at` MUST 置 `null`、交由既有 published-at-inference 从 `og:` 内容推断真实发布日；`lastmod` 仅入 `metadata.lastmod`（可作推断 hint）+ 窗口 diff 粗筛。

**增量语义（MUST，无游标 → DB 已见集 + best-effort 窗口）**：sitemap 采集器无 arXiv 式游标。per-article fetch 前 MUST 查「DB 已见集」（`SELECT canonical_url FROM raw_items WHERE source='sitemap'`），跳过已入库 URL，使同一文章只 fetch HTML 一次（消除每轮重复抓取）。窗口（`FIRST_SEEN_WINDOW_DAYS`）仅作候选粗筛。该机制 MUST 显式声明为 **best-effort 窗口快照 + DB 去重、非 at-least-once 增量**；窗口默认应显著大于最坏调度间隔以降跳窗漏采概率。`lastmod` 缺失/解析为 NaN 的 URL MUST **保守跳过**（无法判定是否窗内、避免一次性灌入全站老文）；`loc` 经 `normalizeUrl` 为 null（畸形/非 http）的条目 MUST 在过滤阶段跳过（避免以 `canonical_url=NULL` 入库污染已见集去重）。**已见集查询失败语义（MUST）**：已见集查询失败（DB 不可达/超时）时采集器 MUST 让整源失败（抛出由 `allSettled` 隔离），MUST NOT 降级为空已见集（否则窗内 URL 全被当未见 → per-article 全量重抓风暴）。**first-fetch-wins（本期接受属性）**：按 `canonical_url` 跳过 + store `ON CONFLICT DO NOTHING` ⇒ 文章首次入库后其 og 内容/lastmod 后续更新永不重抓；对近 immutable 的 news 本期接受，P3 若需追更以 `metadata.lastmod` 变化触发。

**可观测契约（MUST，防站点改版静默归零）**：采集器 MUST 对每源记录 `loc_count`/`path_match_count`/`window_candidate_count`/`emitted_count`。sitemap 返回 2xx 但 **`loc_count=0`**（非 XML/结构变更/正则全失配）MUST `logError` 并使**整个 `sitemap` source 判失败**（throw → `runRegistry` 经 `allSettled` 计 perSource.ok=false、计入告警），MUST NOT 记为「成功 0 条」；`loc_count>0 && window_candidate_count=0` 才是正常「无窗内新文」。**粒度约束（P2）**：`perSource.ok` 按 `CollectorSource` 键控、`sitemap` 是单 registry 项聚合全部 `SITEMAP_SOURCES`，故 `loc_count=0` 的 throw 会失败**整个 sitemap source**（非「单个配置源」）；**P2 `SITEMAP_SOURCES` 仅含 Anthropic 一条**，整源=该配置源，语义无歧义。多配置源的 per-config 部分失败隔离（一个 lab 坏、其余照常 emit）须采集器内部聚合，留待第二个 sitemap lab 接入（见 design 待解决）。

sitemap 与文章 HTML 的解析 MUST 用确定性方式（如正则提取 `<loc>`/`<lastmod>`/`og:` 标签，与 arXiv OAI-PMH 正则解析同范式），**MUST NOT 引入 HTML 解析库（cheerio 等）或无头浏览器**；fetch MUST 限 body 大小上界 + 校验 content-type（防超大/畸形 body 拖垮解析）。每篇 fetch 与整源调用 MUST 带 `withRetry`，单篇失败跳过该篇、不拖垮该源，整源失败由 `allSettled` 隔离。`source='sitemap'`（通用机制）+ `metadata.vendor` 标识具体 lab；下游路由一律按 `raw_type` 不按 `source`，`raw_type='news'` 经事件塌缩正常纳入日报。多 sitemap 源共用 `source='sitemap'` 不需 RSS 式 feed 命名空间化，因去重键 `canonical_url(文章 URL)` 跨 vendor 本就全局唯一（含域名）；`UNIQUE(source, source_item_id)` 约束键正常即 `canonical_url`、仅 `len>255` 折叠为 `contentHash` 时由内容抗碰撞承载唯一，去重仍走 `canonical_url`。`CollectorSource` 与 registry MUST 扩入 `sitemap`，纳入 `collectAllSources`；MUST NOT 纳入 `REALTIME_NEWS_SOURCES`（per-article fetch 较重）或 `PRODUCT_SOURCES`。

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

#### 场景:图片扩展 image:loc 不被误当页面 loc
- **当** 某 `<url>` 块在标准 `<loc>` 前列出 Google 图片扩展 `<image:loc>`
- **那么** 采集器只取无命名空间前缀的标准 `<loc>` 作页面 URL，绝不把 `image:loc` 的图片地址误当文章去 fetch

#### 场景:文章 host 非 sitemap 注册域则跳过（SSRF 防护）
- **当** sitemap 列出的某 `/news/` loc 的 host 为内网/元数据/外域（如 `169.254.169.254`、`x.com.evil.com`）
- **那么** 采集器跳过该 loc、不对其 fetch；仅与 sitemap host 同注册域（剥 `www.` 后相等或其子域，apex 与 www 互通）的文章被采

#### 场景:sitemap 2xx 但解析 0 loc 判源失败（防静默归零）
- **当** sitemap.xml 返回 2xx 但正则解析出 0 个 `<loc>`（站点结构变更/正则失配）
- **那么** 采集器 `logError` 并将该源判为失败（perSource.ok=false、计入告警），绝不记为「成功 0 条」；仅 `loc_count>0` 且窗内候选为 0 时才视作正常「无新文」

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

### 需求:store 层统一文本净化（全源收口）

系统必须在 `store.ts`（`raw_items` 的唯一 text sink）对**所有源**入库的文本列（`title` / `content` / `url` 及 `metadata` 的字符串值）统一净化：剔除 NUL 与 C0 控制字符（保留 `\t` `\n` `\r`），剔除 lone surrogate（保留合法 emoji 代理对）。净化必须由 store 层集中执行而非依赖各采集器自觉——既有仅 `sitemap` 采集器在自身层净化、其余源（RSS/HN/GitHub/Product Hunt/Show HN/HF Papers）未净化的缺口必须由此收口补齐。sitemap 采集器自身的净化可保留作纵深防御（行为不变）。

> 动因：Postgres `text` 列遇 NUL 会在 INSERT 抛错，`jsonb` 遇 `\0` 同样报错，lone surrogate 会破坏下游 `JSON.stringify`；任一源的一条坏文本若未净化会中止整批入库。净化不改变可处理性判定（`canonical_url`/`title_hash` 的生成与 `processableCount` 口径不变）。

`metadata` 的净化必须**递归对每个字符串值施加、且在 `JSON.stringify` 之前**完成（现 `store.ts` 先 `JSON.stringify(metadata)` 再 INSERT；坏码点若留到 stringify 之后，`jsonb` 写入仍会因 NUL 报错）——先净化对象内各层字符串值、再序列化，绝不直接净化序列化后的整串（以免误伤 JSON 结构字符或漏掉嵌套值）。

#### 场景:任一源的 NUL/控制字符文本被净化后入库
- **当** 任一采集器（非仅 sitemap）产出的 `title`/`content`/`metadata` 字符串含原始 NUL/C0 控制字符或 lone surrogate
- **那么** store 层净化后再 INSERT（剔危险码点、保留 `\t\n\r` 与合法 emoji），绝不让 NUL 进 Postgres 致 INSERT 抛错

### 需求:store 层 per-item 入库隔离

系统必须把 `store.ts` 的逐条 INSERT 包在 per-item `try/catch` 中：单条目 INSERT 抛错时必须被捕获、记错误日志、计入新增的 `skippedError` 统计，循环继续处理后续条目，**绝不因单条坏数据中止整批入库**（与既有「单源失败不中止整批采集」对称）。`StoreResult` 必须新增 `skippedError` 字段；`received` / `attempted` / `inserted` / `processableCount` / `skippedInvalid` 等既有口径语义不变。

#### 场景:单条目入库抛错被隔离不中止整批
- **当** 一批待入库条目中某一条在 INSERT 阶段抛错（如净化后仍触发约束/编码错误）
- **那么** 该条被捕获、记错误日志并计入 `skippedError`，其余条目照常完成入库，整批不中止

#### 场景:skippedError 计入返回统计
- **当** 一批入库中有 N 条目触发 per-item 异常被隔离
- **那么** `StoreResult.skippedError` 等于 N，且 `inserted` 仅计真正新插入的行数
