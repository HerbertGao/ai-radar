## MODIFIED Requirements

### 需求:判分与摘要前的确定性正文补全

系统必须在 Value Judge 判分**之前**、对**待判新闻事件**的**代表 raw_item** 执行一次确定性正文补全：当代表 raw_item 的 `content` 为**空或纯空白**（见下「空定义须单一谓词」）**且**其有可抓取 URL（`canonical_url` 或 `url`）时，抓取该 URL 的文章 HTML，用 `og:description`（缺失时可退回有限正文文本）提取正文并写回 `raw_items.content`。补全**必须**复用 `extractOgTag` 与 `defaultFetchArticle` 既有的 2xx / `content-type` 含 `html` / `MAX_BODY_BYTES` / `COLLECTOR_FETCH_TIMEOUT_MS` **校验逻辑**，**禁止**引入新的可读性/DOM 解析依赖（不做全文抽取）；但因 `defaultFetchArticle` 默认 `redirect:'follow'` 且无出网守卫，补全**不得裸调 `defaultFetchArticle` 随访**，须以下述「SSRF/出网信任边界」的受控抓取（`redirect:'manual'`/逐跳 host 重校验）执行。

**补全必须是判分入口内的第一步，禁止由调用链各自编排（本需求修改点）**：补全**禁止**作为某一条链（如日报链 `runDailyWorkflow()`）**独立编排的阶段**存在；它**必须**内联在**共享判分入口**（`scoreUnscoredEvents`）之内，位于该事件**原子 claim 成功之后、送 LLM 判分之前**。

**理由（结构而非约定）**：判分工作集（`importance_score IS NULL ∧ merged_into IS NULL`，无 source 闸、无 LIMIT）与补全工作集**同键**，后者是前者的**真子集**；而评分是**一生一次**（`importance_score` 一旦非 NULL 即永久离开两个工作集）。故只要有**第二条链**调用判分入口而不调补全（如实时告警链 `alert-scan`，每 15–20 分钟一轮），被它先判分的事件就**永久离开补全工作集**——补全阶段空转、本能力沦为死代码，且这些事件被 title-only 判分。

该缺口**不能**用 `judge_claimed_at` 锁结构化：它是**互斥量**（谁评分），不是 **happens-before**（先补全再评分）——其 claim 条件 `importance_score IS NULL` 在【正在补全】期间**恒为真**，链 A 抓取 og 时链 B 可合法 claim 并 title-only 评掉该事件；而把它扩成「补全感知锁」会使 best-effort 的补全失败**永久卡住评分**（比现状更糟）。**唯一的结构化手段是组合**：让工作集的拥有者同时拥有它的前置。由此，「先补全再判分」不再是一条散文规则，而是**单一函数内的语句顺序**——`scoreUnscoredEvents` 的**每一个**调用方（日报链、实时告警链、以及任何未来的第三个调用方）**不可能漏**。

**工作集不再是「两个查询的同口径约定」，而是「单一查询」的结构事实（本需求修改点）**：补全的对象**必须**就是判分入口本轮 claim 成功的那一个事件本身。判分入口的候选 SELECT 已 left join `raw_items`（经 `representative_raw_item_id` 取 `content`/`source`）；补全所需的 `raw_items.id` / `canonical_url` / `url` **必须**由**同一个 SELECT** 一并取出。**禁止**在补全侧另建一份「与判分集同口径」的工作集查询——两份查询必然漂移（一侧加了谓词、另一侧照旧），而本条要防的正是这种漂移。

**「是否为空」必须由 SQL 投影列判定，禁止在候选侧退回应用层 `trim()`（本需求修改点）**：判分入口的候选 SELECT **禁止**在 `WHERE` 里带空判定谓词（它必须判**所有**未评分事件，不只空正文的），故「该事件是否需要补全」的判定**必须**以**同一个空谓词**作为**投影列**由该 SELECT 一并取出：

```
isEmpty: sql<boolean>`(${rawItems.content} IS NULL OR ${rawItems.content} !~ '\\S')`
```

判分循环内**必须**以该投影列（而非 JS `String.trim()`）决定是否发起补全。**禁止**「选取侧 TS `trim()` + 写回侧 SQL `!~ '\S'`」——这正是下面「空定义须单一谓词」要禁的分叉，只是换了个位置：`content` 为 NBSP（`' '`）等非 POSIX 空白时，TS 判空 → **白抓一次 HTTP**，而原子写回的 SQL 谓词为**假** → 命中 0 行 → 打出**与事实相反**的「已被并发填充，跳过」日志。投影列使选取与写回复用**同一侧、同一个**谓词，该分叉在结构上不可能出现。

**补全必须把正文回传给本次判分，禁止只写库（本需求修改点）**：判分入口是**先把 `content` SELECT 进内存**再送 LLM 的；补全若只 `UPDATE raw_items.content` 而不回传，**内存里的 `content` 仍是空**——本次判分**照旧 title-only**，补全只在 DB 里留下一行给下一次（而评分一生一次，没有下一次）。故单条补全函数**必须**返回补全后的正文（`string | null`），调用侧**必须**以该返回值（而非 SELECT 时的旧值）作为 `judgeRawItem` 的 `content` 入参。仅断言「DB 被写入」的测试**不足以**证明本条成立——验证**必须**断言 **judge 的输入**拿到了补全后的正文。

**作用域为任何判分调用链、不再仅日报链（本需求修改点）**：本补全对**所有**经共享判分入口被判分的新闻事件生效，含实时告警链。**作用域仍仅新闻、不含产品**：产品条目（`raw_type='product'`）经独立 `product-collapse` 塌缩、且产品塌缩运行在判分之后，产品行此时不存在，故产品**无补全 grounding**（产品按名判定，见 product-discovery）。

**全站样板 `og:description` 必须视同缺失**：补全的正文来源就是 `og:description`，而部分源的文章页对**每一篇**都返回同一段**全站样板文案**（实测 Anthropic News 14 篇最新文章中 **6 篇**的 `og:description` 逐字相同：`Anthropic is an AI safety and research company that's working to build reliable, interpretable, and steerable AI systems.`）。采集器把该样板视同缺失（`content = null`，见 source-collectors）后，这些行**恰恰因此**落进本阶段的补全域；本阶段重抓的是**同一张页面**，拿回的是**同一段样板**——而它**非空**，`extractOgTag` 返回非空串即**成功路径**。若原样写回：

- `content` 由 `null` 变回**非空样板** → chinese-digest-agent 的 `hasContent`（判 `content` 非空）为 `true` → **「无正文不编造」护栏不触发** → LLM 拿一段全站公司简介当正文 grounding 去写这条事件的摘要。**这比无正文更糟**：无正文会触发护栏、只出 headline；样板则让模型理直气壮地拿无关内容当依据。
- 且 `content` 一旦非空，该行**永久离开本阶段的工作集**（工作集判 `content` 为空）——这段样板遂成为该 raw_item 的**终身正文**，此后无任何补全路径会再修正它。**这是本条为正确性 MUST（而非「不好看」）的全部理由**：空是**诚实降级**（下游护栏正常触发），样板是**构造性欺骗**（护栏不触发、且不可撤销）。

故本阶段**必须**在写回**之前**判样板：抽到的 `og:description` 命中已知全站样板时，**必须按抓取失败计**（失败计数 +1、记错误日志、`content` 保持为空、继续判分该事件），**禁止**写回 `raw_items.content`。该样板判定**必须与采集器共享同一个 `isSiteBoilerplate` 判定**（**单一定义、两处引用**）；**禁止**在采集器与补全阶段各写一份——两份判定必然漂移（样板串变更时只改了一处，另一处照旧放行），本条要堵的洞会从漂移的那一侧重新打开。

补全**必须**满足以下不变量：

- **空定义须单一谓词、选取与写回一字不差**：「空或纯空白」**必须**用**同一个 SQL 谓词**在候选载入（作为**投影列**，见上）与原子写回两处一致判定——`content IS NULL OR content !~ '\S'`（无非空白字符即空白；等价 `btrim(content, E' \t\n\r\f\v')=''`）。**禁止**一处用应用层 JS `String.trim()`、另一处用 Postgres 谓词：JS `trim()` 剥离 Unicode 空白（含 NBSP `U+00A0`、`U+3000`、`U+FEFF`），Postgres 的 `\S` 只认 POSIX `[:space:]`，二者对 NBSP / 全角空格 / BOM 类内容**分歧**——会致该行被判为需补全而**白抓**、却在写回谓词命中 0 行、永久不填、且打出「已被并发填充，跳过」这条**与事实相反**的日志（重开本条要消除的缺口）。
- **绝不覆盖已有非空 `content`（写回须原子判空）**：只对空/纯空白的行补写。写回**必须**将上述空判定与写入原子化——`UPDATE raw_items SET content=? WHERE id=? AND (content IS NULL OR content !~ '\S')`（0 行命中即已被并发填充，跳过、良性），**禁止**「先 SELECT 判空、后无条件 UPDATE」的非原子写（RSS/Ask HN 等并发再抓可能在两步间填入真实正文，被覆盖）。已有正文（如 RSS/Ask HN 自带 text、sitemap 抓到的**非样板** `og:description`）保持不变。
- **SSRF/出网信任边界（提交者可控 URL，绝不可复用假设为一方 URL 的裸抓取）**：补全抓取的 `canonical_url`/`url` 源自 HN / Show HN / Product Hunt / RSS 等**外部提交者可控**内容，与 sitemap 抓取的一方（Anthropic）URL **不同信任级**。`defaultFetchArticle` 自身**仅有** 2xx/content-type/大小/超时闸、**无 host/IP 出网守卫**（sitemap 的 host 同注册域守卫在 `collectOneSitemap` 内、不在 `defaultFetchArticle`，本路径不经过它）。故补全抓取**必须**在发起请求前施加出网守卫：**拒绝私网 / 环回 / 链路本地 / 云元数据地址**（含 `127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`（含 `169.254.169.254`）、`::1`、`fc00::/7`、`fe80::/10` 等）与无法解析为公网的主机，并处理**跳转**（`redirect:'manual'` 或逐跳 host 重校验，防经 302 跳到内网绕过首跳校验）。补全**不得**将提交者可控 URL 当作一方 URL 裸抓取；design「不抓内网」的成立以本守卫为前提。
- **逐条隔离、best-effort、永不拖垮任何调用链**：单条抓取失败（网络错误 / 非 2xx / 非 HTML / 超限 / 超时 / og 缺失 / **抽到全站样板** / 被 SSRF 守卫拒绝）必须 try/catch 隔离、记错误日志、该条 `content` 保持为空，**并继续判分该事件**（以仅标题输入）。补全**禁止 fail-closed**：补全失败**绝不**跳过、延后或阻止该事件的判分——否则 best-effort 的抓取失败会使事件**永不评分、永不推送**。补全**禁止**向上抛错中止任何调用链（`runDailyWorkflow()` / `alert-scan` / 未来调用方），**禁止**计入任何降级率熔断分母（判分/摘要熔断口径不变）。
- **一次补全 = 一条 deadline，绝不是「每跳一个新超时」（本需求修改点，绝不可省）**：受控抓取的 `AbortSignal` **必须**在**进入跳转循环之前创建一次**、贯穿**全部跳转**共用；**禁止**在循环内每跳各建一个 `AbortSignal.timeout(F)`——那使一次补全的真实上限变成 `(maxRedirects + 1) × F`（默认 6 跳 ⇒ **6F**），而回收阈值 `T` 的预算按 `F` 记账，二者**结构性不一致**。此外，SSRF 守卫的 DNS 解析（`dns.lookup`）**不受 `AbortSignal` 约束**，故每跳发起前**必须**显式比对一条 `deadline = 起点 + F` 并在超出时中止。由此 `F` 才**真的**等于「一次补全（含全部跳转与解析）的硬上限」，回收阈值的记账才成立。

- **抓取落在原子 claim 之内，回收阈值须覆盖它（本需求修改点）**：补全在事件 claim 成功之后执行，故被 claim 事件停留在「`importance_score IS NULL` 且 `judge_claimed_at` 已写」的最坏时长含**抓取硬超时**。`judge_claimed_at` 的僵尸回收阈值 `T` **必须**满足 **`T > F + A×L + W`**（`F`=**一次补全**的硬超时；`A`=判分 LLM 的最大尝试次数——重试重试的是**整个调用**，每次尝试**各自**一个 `AbortSignal.timeout(L)`，故 LLM 侧最坏是 `A×L` 而**不是** `L`；`L`=单条 LLM 尝试的硬超时；`W`=写分提交延迟上界），见 daily-intel-pipeline「降级逐条容错与降级率熔断」。原不变量写作 `T > L + W`（漏乘 `A`）**在本变更之前就已不成立**，只因当时只有一条判分链而未暴露；本需求一并修正。
- **注入 seam 必须随补全一起迁移，禁止只删不迁（本需求修改点，绝不可省）**：补全的外部 I/O（`fetchImpl` / `resolve` / `maxRedirects` / 错误日志 sink）**必须**始终有一个**可注入口**，且该注入口**必须**随补全的落点一起搬家——补全内联进共享判分入口后，判分入口的选项对象**必须**带上补全选项（`ScoreEventsOptions.enrich`），并透传给单条补全函数；**每一个**调用链的选项对象**必须**能经由它把桩送达补全（日报链经其判分选项、告警链经 `RunAlertScanOptions.judge`，不为任一条链另开平行的补全字段）。**禁止**删除补全在旧落点上的消费者而不给其注入口新家：那会使既有的测试桩「仍被传入、但无人读取」——外部 I/O 悄然回落到默认实现（真实 `fetch` + 真实 `dns.lookup`），**而测试依然全绿**（有网时真外发并通过；无网时抓取异常被 best-effort 的逐条 try/catch 吞成一次补全失败、事件照常仅标题判分并通过）。故「测试绝不触真实外部」这条红线**不能**靠默认实现的善意成立，**必须**由「注入口存在 + 每条链的集成测试都注入无网络桩 + **默认 `fetchImpl` 与默认 `resolve` 二者**在 `process.env.VITEST` 下于**函数体内**直接抛错 + 一条断言『未注入桩时二者调用次数为 0』的回归钉」四者共同结构化保证。守卫**只挂 `fetchImpl` 不成立**：SSRF 守卫的 `dns.lookup` 先于 `fetchImpl` 执行，只挡 HTTP 时未注入 `resolve` 的测试照样真发 DNS。且函数体内抛出的错会被逐条 try/catch 吞成一次补全失败 ⇒ **「测试全绿」不构成「零出站」的证据**，零出站**必须**由上述调用次数断言（或断网跑一遍并核补全失败计数为 0）机械核验。
- **不改采集源、不新增源、不启用 browser egress**：补全只对已入库的代表 raw_item 按其既有 URL 抓取，属判分入口内的确定性富化步骤。
- **可观测**：补全的命中数（成功写回）与失败数（含被 SSRF 守卫拒绝数、命中全站样板数）**必须**随判分入口的结果一并返回，并由**每一条**调用链（日报链与实时告警链）各自的日志暴露——**禁止**只挂在日报链上（否则告警链的补全成为盲区）。

补全后写回的 `content` 供 value-judge-agent（判分 grounding）与 chinese-digest-agent（摘要 grounding）消费；补全失败（`content` 仍空，含抽到全站样板而按失败计）时，下游判分/摘要**必须**退化为「仅标题」路径并受各自的「无正文不编造」护栏约束（见 chinese-digest-agent）。

#### 场景:空 content 链接帖补抓 og:description 写回
- **当** 某待判事件被判分入口原子 claim 成功，其代表 raw_item 的空判定**投影列** `isEmpty` 为真且有可抓 `canonical_url`（如 Hacker News 直链帖）、其 host 为公网地址，补全抓取其文章 HTML 并 `og:description` 非空**且非全站样板**
- **那么** 提取的正文经原子判空 `UPDATE ... WHERE content IS NULL OR content !~ '\S'`（与候选载入的投影列同一空谓词）写回该 `raw_items.content`，**且由补全函数作为返回值回传**、**在同一次调用内**被显式作为 `judgeRawItem` 的 `content` 入参（**不是**沿用 SELECT 时那个空的内存值），其后供摘要 grounding

#### 场景:content 为 NBSP 等非 POSIX 空白时选取与写回不分叉
- **当** 某代表 raw_item 的 `content` 是 NBSP（`' '`）/ 全角空格 / BOM 等「JS `trim()` 视为空、Postgres `\S` 视为非空」的字符串
- **那么** 候选侧的空判定**投影列**（SQL 谓词）返回 `false` ⇒ 该事件**不发起补全抓取**（无白抓的 HTTP、无与事实相反的「已被并发填充」日志），照常以其现有 `content` 送判；选取侧与写回侧对「空」的判定**恒一致**，不可能出现「抓了却写不回」

#### 场景:任一判分调用链自动先补全再判分
- **当** 任意调用方（日报链 `runDailyWorkflow()`、实时告警链 `alert-scan`，或未来的第三个调用方如事件回放/补评分运维脚本）调用共享判分入口 `scoreUnscoredEvents`
- **那么** 该调用方**无需自行编排**补全，其判分的**每一个**空正文且有可抓 URL 的事件都在送 LLM 之前先经过一次补全尝试；**不存在**「某条链只判分不补全、把事件永久踢出补全域」的路径（补全与判分同属一个函数内的语句顺序，非跨链的散文约定）

#### 场景:补抓到全站样板 og:description 按失败计、content 保持 null
- **当** 某待判事件代表 raw_item 的 `content` 为空（采集器已把该页的全站样板 `og:description` 视同缺失），补全重抓同一张页面、`extractOgTag` 又抽回**同一段全站样板**（非空串，属 `extractOgTag` 的成功返回）
- **那么** 补全在写回**之前**以**与采集器共享的同一个 `isSiteBoilerplate` 判定**识别出样板，**按抓取失败计**（失败计数 +1、记错误日志、不发起写回），`content` **保持 `null`**，该事件**照常以仅标题判分**；下游判分/摘要退化为仅标题路径，chinese-digest-agent 的「无正文不编造」护栏**正常触发**（只出 headline、绝不拿全站公司简介当正文编内容）

#### 场景:已有非空 content 不被覆盖(原子判空)
- **当** 某代表 raw_item 已有非空 `content`（如 RSS 自带正文，或 sitemap 抓到的非样板 `og:description`，或并发再抓在候选载入与 UPDATE 之间填入）
- **那么** 原子写回条件不命中（0 行）、跳过、不覆盖既有正文

#### 场景:提交者可控 URL 指向内网/元数据被 SSRF 守卫拒绝
- **当** 某代表 raw_item 的 `url` 指向私网 / 环回 / 链路本地 / 云元数据地址（如 `http://169.254.169.254/…` 或内网服务），或经 302 跳转指向此类地址
- **那么** 补全在发起（或逐跳）时被出网守卫拒绝、记失败日志与计数、`content` 保持为空、不抓取内网、不把响应体写回，该事件照常以仅标题判分、下游退化仅标题

#### 场景:单条抓取失败隔离不拖垮流水线
- **当** 某条补抓因网络错误 / 非 2xx / 非 HTML / 超 `MAX_BODY_BYTES` / 超时 / `og:description` 缺失 / 抽到全站样板 / SSRF 拒绝而失败
- **那么** 该条捕获异常（或按失败计）、记错误日志、`content` 保持为空，**该事件仍照常送 LLM 判分**（仅标题输入，绝不 fail-closed 地跳过判分）、继续下一条；补全不向上抛错、不中止任何调用链、不进熔断分母；下游对该事件退化为仅标题路径

#### 场景:补全落在原子 claim 之后、回收阈值覆盖抓取超时
- **当** 某事件被一条链原子 claim 成功，随后其补全**连同全部跳转与 DNS 解析**耗满那一条 deadline `F`（**不是**每跳各一个 `F`）、判分 LLM 的 `A` 次尝试**各自**耗满硬超时 `L`（最坏 `A×L`）、写分提交耗满 `W`
- **那么** 该事件停留在「`importance_score IS NULL` 且 `judge_claimed_at` 已写」的总时长恒 `< F + A×L + W < T`（回收阈值 `T` 经启动期跨字段校验保证），故另一条链不会因超时回收误重新 claim 它、不双评分覆写

#### 场景:无可抓 URL 或已是 tombstone 的事件跳过补全
- **当** 某代表 raw_item `content` 为空但既无 `canonical_url` 也无 `url`，或该事件 `merged_into` 非空（已被语义合并为 tombstone）
- **那么** 跳过该事件的补全、不产生外部请求；无可抓 URL 者照常以仅标题判分，tombstone 者本就不在判分工作集内（不被 claim、不被判分）
