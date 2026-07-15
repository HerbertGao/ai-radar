## MODIFIED Requirements

### 需求:基于 dedup_key 的硬去重塌缩

系统必须为每条可处理的**新闻类** `raw_item` 计算 `dedup_key`，并以 `ai_news_events.dedup_key` 的 `UNIQUE` 约束 + `INSERT ... ON CONFLICT (dedup_key) DO UPDATE` 把同一事件的多条 `raw_item` 塌缩为同一条 `ai_news_events`。`dedup_key` 构造必须遵循 fallback 链：`canonical_url` 存在时 `dedup_key = sha256(canonical_url)`；否则 `dedup_key = sha256(title_hash)`。

**类型路由（P2 新增，绝不可省；本变更扩展排除集）**：自 P2 起 `raw_items` 含非新闻类型条目（`raw_type='product'` 来自 Product Hunt、`raw_type='paper'` 来自 arXiv）；自本变更起增 `raw_type='experience'`（来自 AI 博主经验源 `source='blogger'`，见 blogger-experience-mining 与 source-collectors）。事件塌缩（→ `ai_news_events`）必须**排除产品、论文与经验条目**，排除条件须用 **`raw_type IS DISTINCT FROM 'product' AND raw_type IS DISTINCT FROM 'paper' AND raw_type IS DISTINCT FROM 'experience'`**（而非 `raw_type NOT IN (...)`）——因 `raw_type` 列可空（QA §8.1 `raw_type VARCHAR(64)`），`NULL NOT IN (...)` 求值为 `NULL` 会**放行** NULL 条目；用 `IS DISTINCT FROM` 使 `NULL` 被当作新闻类纳入塌缩，保持 P1「现有三源（含 GitHub `repo` 等非 product/paper 类型）正常进事件流」的行为不回退。raw_type 全集归属显式闭合：**仅 `product`/`paper`/`experience` 排除出事件塌缩，`news`/`repo`/`post`/`NULL` 等其余值一律视作新闻类纳入塌缩**（QA §8.1 注释列 `news/product/repo/paper/post`，`experience` 为本变更新增值）。产品条目由 product-discovery 的确定性产品塌缩独占消费（→ `ai_products`），论文条目 P2 仅作数据沉淀留在 `raw_items`（不进事件、不推送），经验条目由 blogger-experience-mining 的经验提炼链独占消费（→ `ai_experiences`，不进事件、入要闻段被禁）。禁止把产品/论文/经验条目误塌缩进 `ai_news_events` 污染新闻事件流，也禁止产品条目被「事件塌缩 + 产品塌缩」双重消费。

**排除行不得停在 `collapsed=false` 被每轮无界重扫**：类型路由的排除必须在塌缩**查询层**完成（事件塌缩入口的 `WHERE` 增加 `raw_type IS DISTINCT FROM 'product' AND raw_type IS DISTINCT FROM 'paper' AND raw_type IS DISTINCT FROM 'experience'`，使 product/paper/experience 行不进 pending 集）；并且：产品行由产品塌缩成功后置 `collapsed=true`（见 product-discovery），论文行因 P2 无任何下游消费、入库即置 `collapsed=true`（标记为已路由/已沉淀），经验行同样**入库即置 `collapsed=true`**（沉淀，由经验链按 `canonical_source_url` 反连接选未提炼者消费，见 blogger-experience-mining）。否则被排除的行永远 `collapsed=false`，事件塌缩入口每轮重扫全部历史排除行，工作量随累计行数线性无界增长（与 P1 对新闻行严格置 `collapsed=true` 的设计不对称）。`collapsed` 列对 product/paper/experience 行语义为「已按 raw_type 路由处理完毕/已沉淀」，对新闻行语义为「已塌缩进 ai_news_events」。**前向护栏**：`collapsed` 是全局布尔却承载 per-chain 处理状态，三链（news/product/experience）靠 `raw_type` 谓词互斥切片——故**新增任何 `raw_type` 必须同步显式决定它属哪条塌缩链**（是否加入事件塌缩排除集、由哪条链置 `collapsed=true`），否则新 raw_type 会被默认当新闻类吞进 `ai_news_events`。各采集器**必须为每条 `raw_item` 标注非空 `raw_type`**（PH→`product`、arXiv→`paper`、blogger→`experience`、RSS→`news`、HN/GitHub→其类型），NULL `raw_type` 视为采集器 bug；类型路由对 NULL 的「视作新闻」是防御性兜底、非鼓励留空。

塌缩的 `INSERT` 分支必须**省略 `event_id`**，由数据库默认值 `gen_random_uuid()::text` 生成不透明身份；首次创建时必须写入 `representative_raw_item_id`、`representative_title`（取代表 `raw_item` 的**原始 title**——非归一化标题，保证 `NOT NULL`，供摘要降级时回退展示；原始 title 通常可读，极个别为空串 `''` 的情形由摘要降级兜底到 canonical_url）、`first_seen_at`、`published_at`（取代表 `raw_item` 的发布时间）与 `published_at_authority`（见下「发布日权威等级」），并初始化 `source_count=1`。`ON CONFLICT DO UPDATE` 分支必须累加 `source_count`、更新 `last_seen_at`，并按**权威等级高者胜出**归集 `published_at`（见下）。`ON CONFLICT DO UPDATE` 分支**禁止**覆盖 `event_id`、`representative_raw_item_id`、`representative_title`、`first_seen_at`——否则事件身份与「首建代表原文」语义被后到的 `raw_item` 破坏。

**发布日权威等级（`published_at_authority`，本需求修改点）**：`published_at` 的归集**不得**再是无条件的单向 NULL-fill（`COALESCE(已有, EXCLUDED)`，「先到者永久胜出」）。原口径下任何先到的非 NULL 值都会把后到的**页面提取值**挡在门外——而页面提取是全系统唯一一个「文章自己印的发布日」。

**这个阶梯排的是「这个值离【文章的发布日】有多近」，绝不是「这个时间戳的来源有多可信」。** 二者是两条不同的轴，按后者排会得到一个**错误的**阶梯（见下「MUST NOT 在第 1 档内部再排序」）：

| 来源 | 值测的是哪个事件 | 精确性 | 是文章的发布日吗 |
|---|---|---|---|
| `hacker_news` / `show_hn` | **投稿到站点的时刻** | 真实时间戳 | ❌ **测的是错误的事件** |
| `github` | 仓库 `pushed_at`（push 时刻） | 真实时间戳 | ❌ **测的是错误的事件** |
| `rss` | feed **声明**的 `pubDate`（转载 / 重新生成时会漂） | 声明值 | ❌ 近似 |
| AI 推断回填（published-at-inference） | **文章的发布日** | **猜的** | ✅ **猜的是正确的事件** |
| `sitemap` | **文章页面上自己印的发布日**（确定性页面提取，见 source-collectors） | 确定性提取 | ✅ |

**两个反直觉事实 MUST 逐字读到**：HN 的投稿时刻是一个**真实**的时间戳，但它测的是**错误的事件**（谁在何时把链接贴上了 HN）；AI 推断是**猜**的，但它猜的是**正确的事件**（文章何时发布）。⇒ **对错误事物的精确测量，比对正确事物的粗略估计更坏。**

故系统必须为 `ai_news_events` 维护一列 `published_at_authority smallint NOT NULL DEFAULT 0`（见 platform-foundation「published_at 权威等级列可迁移」），取值为**两级非空**：

```
0 = 无日期
1 = 一切【不是页面确定性提取】的日期值
    （rss 的 pubDate / hacker_news 与 show_hn 的投稿时刻 / github 的 push 时刻 / AI 推断）
    —— 【同档互不覆盖】，先到者胜出 = 与引入本列之前的 COALESCE 完全一致的行为，零回归
2 = 页面确定性提取的发布日（sitemap 从文章 HTML 抽取的、文章自己印的那个日期）
    —— 覆盖一切
```

**MUST NOT 在第 1 档内部再排序**——**任何**档内排序（含「程序取得的时间戳 > LLM 推断」这一种）都会引入一条**能把日期往后推**的覆盖关系：例如让一条转载 RSS 的**今日** `pubDate` 覆盖 LLM 已正确推断出的 2023 年发布日 ⇒ 老文又看起来是新的 ⇒ 过时效闸 ⇒ 被当成今日重大发布推出去，直接违反 `policy-push-timeliness`。而**页面提取读的是文章自己印的日期，结构上不可能让老文看起来新**——**故只有它有资格覆盖**。

**「一个 LLM 猜出来的日期会永久挡住一个真实的时间戳」这条反对意见 MUST 被显式驳回**：那个「真实的时间戳」测的是**投稿 / push**，不是**发表**。它挡住的不是「真相」，是**另一个近似值**。而放它进来的代价是把老文推成今日突发：

```
1. sitemap 采到 anthropic.com/news/x（2023 年老文）→ 无页面提取日期 ⇒ published_at = NULL、authority = 0
2. AI 回填推断出它【真实的发布日】(2023) ⇒ authority = 1
3. 同一 URL 被发上 HN ⇒ 同 dedup_key ⇒ 塌缩命中该事件
   若「程序时间戳」被排在「LLM 推断」之上：EXCLUDED 更高 ⇒ published_at := 【HN 投稿时刻】= 今天
⇒ 2023 年的老文 published_at 变成【今天】⇒ 过时效闸 ⇒ 当成今日重大发布推出去
```

**这不是理论风险，而是相对现状的净回归**：引入本列**之前**的 `COALESCE(已有, 来者)` 单向 NULL-fill 会**保住**第 2 步的真日期。且「AI 回填的值住在第 1 档」是**当前生产的真实形状**——sitemap 采集器在页面提取上线前一律置 `published_at = NULL` 交 AI 回填，生产实测 28 个 sitemap 事件里 10 个有日期、其 `raw_item.published_at` **全为 NULL** ⇒ **那 10 个日期全部来自 AI 回填**。（本变更给 sitemap 源加了推断豁免，故此后**新**的 sitemap 事件不再走这条路；但那 10 条存量、以及**所有非豁免源**的回填值仍住在第 1 档，覆盖关系一旦引入即刻生效。）

**不变量（MUST）**：`(published_at IS NULL) = (published_at_authority = 0)`（须由 DB `CHECK` 约束兜底）。

**等级推导 MUST 由 `raw_items.source` 得出，不给 `raw_items` 加列**：`sitemap` 源的 `published_at` **只可能**是页面确定性提取值（该源的 `lastmod` 已被 source-collectors 明令禁止写入 `published_at`），故：

```
authority = CASE
  WHEN raw_items.published_at IS NULL   THEN 0
  WHEN raw_items.source = 'sitemap'     THEN 2   -- 恒为页面提取值
  ELSE                                       1   -- 非页面提取（rss / hacker_news / show_hn / github …）
END
```

（`published-at-inference` 的 CAS 回填同样写等级 **1**——它与 rss / hn / github **同档、互不覆盖**，见下与 published-at-inference。）

**「页面提取源」的判定 MUST 是一张显式登记表（`source → boolean`），且 MUST 只认自有属性**：本判定的入参是 `raw_items.source`（DB 里的 `varchar`，运行时可为**任意字符串**），故 MUST 用 `Object.hasOwn(表, source) && 表[source] === true`。**MUST NOT** 用 `source in 表` 判「未知源」、**MUST NOT** 用 truthy 判「是否页面提取」——**两者都走原型链**：`'toString' in {…}` 为 `true`（来自 `Object.prototype`），而 `{…}['toString']` 取到的是一个**函数**（truthy）⇒ `toString` / `constructor` / `valueOf` / `hasOwnProperty` 这些键**既不触发「未知源」告警、又拿到「页面提取」的覆盖权**（实测：修复前该推导对 source=`'toString'` 返回最高档）。恰好在这道守卫要防的那一类输入上失效。未知源 MUST 记一行错误日志（按 source 去重，不刷屏）并按**非页面提取档**（1）处理——安全侧，不凭空获得覆盖权。

**塌缩的 raw_item 视图 MUST 携带 `source`，且该字段 MUST 为必填（非可选）**：上式的**全部依据**就是 `raw_items.source`，而塌缩今天读出的 raw_item 视图**不含 `source`**、其候选 SELECT 也**不投影 `source`**。故：

- 塌缩的 raw_item 视图 MUST 新增 `source: string`（**required**）；
- 塌缩候选 SELECT MUST 投影 `raw_items.source`。

**`source` 写成可选（`source?: string | null`）会让整条修改静默变成 no-op**（与既有的 `publishedAt?: Date | null` 同风格，正是最容易踩的那一脚）：所有既有调用点与测试 seed **不改就编译通过** ⇒ `source` 为 `undefined` ⇒ 推导退化为「有日期即 2」⇒ **sitemap 恒为 2** ⇒ **页面提取的日期永远覆盖不了 HN 的投稿时刻** ⇒ 本条对「上了 HN 的重大发布」**完全无效**——而 `CHECK` 满足、迁移正常、手工构造 item 的单测（构造时自然会传 `source`）**全绿**。required 会让每一个外部构造点**编译报错**，逼人显式处理。**该项的验收 MUST 走真实塌缩入口（读真库的集成测试），MUST NOT 只用手搭 item 的单测**——手搭时会记得传 `source`，陷阱不暴露。

**`ON CONFLICT DO UPDATE` 的归集口径 MUST 为「权威等级高者胜出」**：

```sql
published_at = CASE
  WHEN EXCLUDED.published_at_authority > ai_news_events.published_at_authority
    THEN EXCLUDED.published_at
  ELSE ai_news_events.published_at
END,
published_at_authority = GREATEST(ai_news_events.published_at_authority,
                                  EXCLUDED.published_at_authority)
```

**这两行就是全部——不需要再补一个 NULL-fill 分支**（易被后人误读为「漏了」）：不变量 `published_at IS NULL ⟺ authority = 0` 使 **NULL-fill 成为「权威高者胜出」的一个特例**——事件已有 NULL ⇒ 其 authority = 0 ⇒ 任何非 NULL 来者（authority ≥ 1）严格大于 0 ⇒ 自动填入。而**同等级不覆盖**（1 vs 1 ⇒ 保留已有）⇒ **非页面提取的日期值之间维持既有的「先到者胜出」，行为零变化**；页面提取（2）> 一切 ⇒ 覆盖，这正是本条要修的那一格、也是**唯一**新增的覆盖关系。

多条同 `dedup_key` 但日期不同的 `raw_item` 并发塌缩时，**同权威等级**内取**先抢到行锁那条**的值：取哪条依到达序、非全序确定，但**始终是某条真实 `raw_item` 的发布时间**（不丢、不臆造）；契约只承诺「同等级内填入某个真实值、更高等级到来时以之取代」，不承诺同等级内选最早/最晚，故无需 per-dedup 序列化锁或聚合子查询。

**存量 `published_at` MUST NOT 被触碰**（迁移只加列 + 回填 `authority`，见 platform-foundation）：同一 `canonical_url` 下 HN 与 RSS 的日期实测可差 ±12 天且**方向不定**（HN 常**早于** RSS），**哪个是文章真正的发布日，数据里根本没有**。任何「按源权威性排序去清洗存量」都是猜，且猜错的方向会把老事件的 `published_at` 往后推 ⇒ **让老文看起来更新** ⇒ 正是时效性红线要防的方向。本能力**只**引入「页面提取 > 其余一切」这一条覆盖关系，**不**引入第 1 档内部的任何排序（`rss` / `hacker_news` / `github` / AI 推断 谁更接近发布日**没有依据**，故不判——而任何一种判法都会引入一条能把日期往后推的覆盖关系）。

**tombstone 改投（P3 新增）**：当塌缩的 `ON CONFLICT (dedup_key)` 命中的既有事件已被语义合并置 `merged_into` 非空（tombstone，见 semantic-dedup「确定性事件合并」），系统必须把该 `raw_item` 改塌缩进 `merged_into` 指向的存活事件，禁止新建重复事件、也禁止把 `source_count` 累加到 tombstone 行。**改投必须沿 `merged_into` 链递归/迭代到终态存活者**（`merged_into IS NULL`）——存活者本身可能在后续轮次再被合并而成 tombstone，单跳改投可能仍落在 tombstone 上；解析须带环路保护（已访问集合，命中环即报错告警，绝不无限循环）。`source_count` 仅对真正新到的 `raw_item` `+1`，绝不重加被吞事件已冻结的 `source_count`（见 semantic-dedup「source_count 不重复计数」）。

**改投的并发原子性（关键：塌缩与语义合并跨链并发）**：塌缩入口 `collapseUncollapsedRawItems` **日报链与实时告警高频链共用**，而告警链**不持日报单例锁**（`alert-scan.ts` 每 20min 跑塌缩、`acquireAlertLock` 只裹分发不裹塌缩），故告警链塌缩会与日报链语义合并**并发**。因此 tombstone 改投**不可**用裸 `ON CONFLICT (dedup_key) DO UPDATE SET source_count = source_count + 1`——该写会落在被命中行上，若该行刚被合并置 tombstone，就把已冻结的 tombstone `source_count` 误加（违反冻结不变量）、且不改投。改投必须：①增量目标是**链解析后的终态存活者**而非被命中行——对命中行的 `DO UPDATE` 加 `WHERE ai_news_events.merged_into IS NULL` 守卫（命中 tombstone 时该 `DO UPDATE` 不动 tombstone），命中行为 tombstone 时改在**同一事务内**对命中行取行锁（`ON CONFLICT` 对冲突行本就持行锁，或显式 `SELECT ... FOR UPDATE`）读 `merged_into`、链解析到存活者后 `UPDATE 存活者 SET source_count = source_count + 1, last_seen_at = ...`；②靠**冲突 `dedup_key` 那一行的行锁**与并发的语义合并（合并对被吞行 `FOR UPDATE`）串行化——两侧争同一行锁，故无论谁先提交都自洽：合并先提交→塌缩读到 `merged_into` 非空→改投存活者（+1 落存活者）；塌缩先提交（+1 落尚未 tombstone 的命中行）→合并随后 `源count += 被吞`（把这 +1 一并吸收进存活者）。两序皆不丢不重。**改投到存活者时 `published_at` / `published_at_authority` MUST 同样按「权威高者胜出 + `GREATEST`」归集**（与 `DO UPDATE` 分支同口径，绝不因走改投分支而退回单向 NULL-fill）。**这是本需求修改点，不是重申**：改投函数今天**完全不写 `published_at`**（只累加 `source_count` + 更新 `last_seen_at`），而**改投分支是那条 `raw_item` 的唯一写入路径**——不改则一条 authority=2（页面提取）的日期在命中 tombstone 时被**整个丢弃**，且无任何后续路径会补。故改投函数的签名 MUST 携带该 raw_item 的 `published_at` 与推导出的 `published_at_authority` 两个参数，对终态存活者按同一口径归集。

流水线下游对同一事件行的后续写入（Value Judge 写 `*_score`/`should_push`、中文摘要写 `summary_zh`、published-at-inference 在所有关联 raw_item 均无发布时间时回填 `published_at`）必须以 `UPDATE ... WHERE event_id = ?` 定位、`set` 中**只含本阶段目标列**（published-at-inference 的回填须附 `AND published_at IS NULL` 的 CAS 守卫，且**必须同时把 `published_at_authority` 置 1**——**1 = 非页面提取档**，与 rss `pubDate` / hn 投稿时刻 / github push 时刻**同档、互不覆盖**：它既不能留在 0 而破坏 `published_at IS NULL ⟺ authority = 0` 不变量，也**绝不可**被排到那些时间戳之下——AI 推断猜的是**发布日**（正确的事件），而那些时间戳测的是**投稿 / push**（错误的事件），让后者覆盖前者会把老文的日期推成今天；豁免源不进回填域，见 published-at-inference），禁止用 `INSERT ... ON CONFLICT` 模板（P0 `persistEventScores` 的全列覆盖式 `set` 是反面模板），以免把 `published_at`/`representative_*`/`first_seen_at` 覆盖回 NULL 而使 Top N 排序静默退化。

去重判定的**最终事实**必须全程由程序与 DB 唯一约束保障，禁止交给 LLM。本需求只规定**硬去重层**（第一层硬去重 + 第二层 `title_hash`）行为；embedding 相似度（第三层）与 LLM 二次判断（第四层）在硬去重塌缩**之后**由 semantic-dedup capability 承接——其 LLM 仅产语义判断（结构见 semantic-dedup「LLM 二次判断」，`{same_event, same_product, reason}`），是否合并的最终落库仍由程序 + DB 单事务执行（见 semantic-dedup）。本需求不再禁止后续期次引入 embedding/LLM 语义层（原 P1/P2「本期仅做硬去重层、禁止引入 embedding 相似度或 LLM 二次判断」的期次限制随 P3 解除）。

#### 场景:同 canonical_url 的多条塌缩为一条事件
- **当** 两条新闻类 `raw_item` 经规范化得到相同 `canonical_url`（因而相同 `dedup_key`）
- **那么** 二者塌缩为 `ai_news_events` 中的同一行（同一 `event_id`），`source_count` 累加为 2

#### 场景:产品、论文与经验条目不塌缩进 ai_news_events
- **当** `raw_items` 中存在 `raw_type='product'`（PH）、`raw_type='paper'`（arXiv）与 `raw_type='experience'`（blogger）条目
- **那么** 事件塌缩显式排除三者、不为它们生成 `ai_news_events` 行；产品条目仅由产品塌缩消费进 `ai_products`，论文条目仅留存 `raw_items` 作数据沉淀，经验条目仅由经验提炼链消费进 `ai_experiences`

#### 场景:首建记录代表原文与时间列
- **当** 某 `dedup_key` 首次创建事件
- **那么** 该事件的 `representative_raw_item_id` 与 `representative_title` 记录为第一条命中的 `raw_item`，`first_seen_at` 与 `published_at` 被写入、`published_at_authority` 按代表 raw_item 的 `source` 推导（无日期 → 0、`sitemap`（页面确定性提取）→ 2、其余源 → 1），`event_id` 为数据库生成的 UUID 文本

#### 场景:再次塌缩不覆盖身份与代表原文
- **当** 第二条同 `dedup_key` 的 `raw_item` 经 `ON CONFLICT DO UPDATE` 命中已存在事件
- **那么** `event_id`、`representative_raw_item_id`、`representative_title`、`first_seen_at` 保持首建值不变，仅 `source_count` 累加、`last_seen_at` 更新；`published_at` 在后到者**权威等级不高于**已有值时保持不变（第 1 档内部 1 vs 1「先到者胜出」，行为与本需求修改前的 `COALESCE` 一致）

#### 场景:后到 raw_item 的确定发布时间补空（确定性优先于 AI）
- **当** 某事件首建时 `published_at` 为 NULL（首条 raw_item 无发布时间、`published_at_authority = 0`），后到的同 `dedup_key` raw_item 带确定 `published_at`
- **那么** 后到者的 authority（≥ 1）**严格大于** 0 ⇒ 经「权威高者胜出」把该值补入、`published_at_authority` 取 `GREATEST` —— NULL-fill 是本口径的一个特例，不需另设分支；该事件不再进入 AI 推断阶段（确定性事实优先、不交 LLM）

#### 场景:程序时间戳与 LLM 推断同档、互不覆盖
- **当** 某事件的 `published_at` 由 AI 推断回填写入（`published_at_authority = 1`，猜的是**文章的发布日**——正确的事件、粗略的估计），随后同 `dedup_key` 的 `hacker_news` / `rss` raw_item 带**投稿时刻 / feed `pubDate`**（亦为 authority = 1——它们是真实时间戳，但测的是**投稿**、不是**发表**）塌缩命中该事件
- **那么** `1 > 1` 不成立 ⇒ **不覆盖**，`published_at` 保持推断值不变（第 1 档内先到者胜出 = 引入本列之前 `COALESCE` 的行为，零回归）。**绝不可**把程序取得的时间戳排到 AI 推断之上**——那个「真实的时间戳」测的是投稿 / push，不是发表；它挡住的不是「真相」，是另一个近似值**。而放它进来会把一篇 2023 年的老文（其发布日由 AI 正确推断出）在被发上 HN 的当天改写成**今天** ⇒ 过时效闸 ⇒ 当成今日重大发布推出去，违反 `policy-push-timeliness`

#### 场景:页面提取的发布日覆盖已有的近似日期
- **当** 某事件已由 `hacker_news`（投稿时刻，authority=1）或 `rss`（feed `pubDate`，authority=1）先塌缩并写入 `published_at`，随后同 `canonical_url` 的 `sitemap` raw_item（页面确定性提取的发布日，authority=2）塌缩命中该事件
- **那么** `published_at` 被**覆盖**为页面提取值、`published_at_authority` 升为 2（`GREATEST`）——**绝不可**因「已有值非 NULL」而按旧的 `COALESCE` 口径丢弃它。这条正是「上了 HN 的重大模型发布」在旧口径下拿不到真实发布日的原因（HN 先到、值已非 NULL ⇒ 页面提取值被静默丢弃）。**页面提取是唯一有资格覆盖的档**——它读的是文章自己印的日期，结构上不可能让老文看起来新

#### 场景:塌缩候选未投影 source 时权威推导失效（必填而非可选）
- **当** 塌缩的 raw_item 视图把 `source` 写成**可选**字段、或候选 SELECT 未投影 `raw_items.source`
- **那么** 该实现**不合规**：`source` 为 `undefined` 时权威推导退化为「有日期即第 1 档」⇒ `sitemap` 恒为 1 ⇒ 页面提取的日期**永远覆盖不了** HN 的投稿时刻 ⇒ 本需求对「上了 HN 的重大发布」完全无效，而 `CHECK` 满足、迁移正常、手工构造 item 的单测**全绿**（假绿）。故视图的 `source` MUST 为**必填**（让每个外部构造点编译报错）、候选 SELECT MUST 投影它，且该项 MUST 由**读真库的塌缩集成测试**验收

#### 场景:原型链上的键不得拿到「页面提取」的覆盖权
- **当** `raw_items.source` 的值恰为 `toString` / `constructor` / `valueOf` / `hasOwnProperty` 等 `Object.prototype` 上的键名（该列是 `varchar`，运行时可为任意字符串，类型系统在 DB 读出口不再兜底）
- **那么** 权威推导 MUST 把它判为**未知源** ⇒ 记一行错误日志（按 source 去重）+ 按**非页面提取档（1）**处理。**MUST NOT** 用 `source in 表` 判未知、**MUST NOT** 用 truthy 判页面提取——**两者都走原型链**：`'toString' in {…}` 为 `true`、且 `{…}['toString']` 取到的是一个**函数**（truthy）⇒ 这些键**既不触发未知源告警、又拿到最高档的覆盖权**（实测：修复前该推导对 `'toString'` 返回最高档）。MUST 用 `Object.hasOwn(表, source)` + `=== true`

#### 场景:塌缩命中 tombstone 改投存活事件
- **当** 一条新闻类 `raw_item` 的 `dedup_key` 命中的既有事件已被语义合并置 `merged_into` 非空
- **那么** 该 `raw_item` 改塌缩进 `merged_into` 指向的存活事件，不新建重复事件、不向 tombstone 行累加 `source_count`；其 `published_at` / `published_at_authority` 对存活者按「权威高者胜出 + `GREATEST`」归集（与 `DO UPDATE` 分支同口径）——改投分支今天**完全不写 `published_at`**，而它是该 raw_item 的**唯一**写入路径，故不改则一条 authority=2 的页面提取日期在命中 tombstone 时被整个丢弃、且无任何后续路径会补
