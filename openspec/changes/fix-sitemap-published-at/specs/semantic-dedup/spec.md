## MODIFIED Requirements

### 需求:事件 embedding 生成

系统必须为 `ai_news_events`（仅新闻事件，且 `merged_into IS NULL` 的非 tombstone 行）经 Vercel AI SDK（`embed`/`embedMany`）生成定长向量并落 `ai_news_events.embedding` 列。embedding 文本必须由 `representative_title` 与代表 `raw_item` 的 `content` 摘录（截断到 `EMBEDDING_TEXT_MAX_CHARS`，默认 2000）拼接构成；`main_entities` 若在该阶段已存在则附加。embedding 模型由 `EMBEDDING_MODEL` 配置（默认 `text-embedding-3-small`），向量维度由迁移钉死（默认 1536），更换不同维度模型属新的 forward-only 迁移。

**候选窗口 bootstrap（跨天去重前提）**：生成对象**不得**只限「本轮 collapse 新产出的事件」。因 D5 跨天去重要把今日新事件与**既有较早事件**（含 P3 之前入库、`embedding` 仍为 NULL 的历史行）比对，系统必须在候选检索之前，为候选时间窗内（`first_seen_at >= now() - SEMANTIC_WINDOW_DAYS`）**所有** `embedding IS NULL AND merged_into IS NULL` 的新闻事件补生成 embedding——否则历史存活者无向量、无法作为 pgvector KNN 候选被检索到，跨天合并静默失效。tombstone 行（`merged_into IS NOT NULL`）不生成 embedding、也不参与检索。为防 P3 首次部署时一次性嵌入整段窗口 backlog 撑爆外部调用/拖住日报锁，单轮 bootstrap 须设上限 `EMBEDDING_BOOTSTRAP_MAX_PER_RUN`（默认 500、可配）。**嵌入顺序**：先嵌**本轮新事件**（保证今日新事件本轮即可作为查询对象参与合并），再以 `first_seen_at` 升序填补剩余配额嵌历史存活者（作候选）；余量由后续日报轮次续嵌。
> 收敛窗口残留风险（如实登记）：首次部署 backlog 超单轮上限时，某历史存活者在被补嵌之前不会被检索为候选，故今日一条与之实为同一事件的新事件本轮无候选可并、会**独立推送**，待该历史存活者后续轮次补嵌后才合并——**这会在收敛窗口内产生一次跨天重复推送**（非数据损坏，仅一次性、首部署期）。「欠嵌=欠合并安全方向」仅就数据完整性而言，对推送去重而言此窗口内可见一次重复。缓解：首部署前可调高 `EMBEDDING_BOOTSTRAP_MAX_PER_RUN` 或先跑一次性全量 backfill 再开 push；稳态下单日新事件量远小于上限、不触发。

**空文本兜底（防退化向量误并）**：拼接后的 embedding 文本若经 trim 后为空或仅空白（`content` 为 NULL/空且 `representative_title` 为空串 `''`），系统必须**跳过该事件的 embedding 生成与语义合并**（记日志、保留为独立事件），**绝不**对空/空白文本求 embedding——空文本会产生退化向量，使彼此无关的空文本事件呈高相似度而被错误合并（过合并是危险方向）。

**全站样板正文绝不得进入语义层的文本入口（本需求修改点）**：上条「空文本兜底」只判**空或纯空白**（`trim()` 后为空），一段**非空的常量串按构造整个漏过**。当某源的**多篇互不相干的文章**共享同一段全站样板 `og:description`（实测 Anthropic News 14 篇最新文章中 **6 篇**逐字相同）并落进 `raw_items.content` 时，本能力的两个文本入口同时被污染：

- **embedding 文本**（`representative_title` ‖ `content` 摘录）：两条不同事件的向量**只在标题上有差异、`content` 摘录部分完全相同** → 余弦相似度被**系统性推高** → 更易越过 `SEMANTIC_DEDUP_LLM`（灰区）乃至 `SEMANTIC_DEDUP_HIGH`（**直接合并、不过 LLM**）；
- **灰区 LLM 二次判断的输入**（两侧的 `Content:` 段）：两侧是**同一个字符串** → 进一步诱导 `same_event=true`。

净效果是**过合并**——而本能力自己把过合并声明为**危险方向**（丢失独立事件、被吞者成 tombstone）。故：

- 该样板洞**必须由上游闭合**：采集器与判分前正文补全**两处**均须把已知全站样板 `og:description` **视同缺失**（`content = null`，见 source-collectors 与 source-content-enrichment），使这些事件的 embedding 文本退化为**仅标题**、`Content:` 段不再拼入，落回既有语义（标题不同 → 相似度按标题算，不再被同一段正文抬高）。
- 本能力**绝不**自行识别样板（语义层不做来源特定的文本清洗），亦**绝不**指望「空文本兜底」捕获它——**它捕获不到非空串**。「上游把样板视同缺失」是本能力反过合并保证的**前置条件**，须显式登记：该前置一旦失守（如样板串变更后上游判定失配），本能力的相似度分布会被**静默**抬高，而语义层**没有任何机制**能察觉。

> 偏离登记：QA.md §9.2 字面 embedding 文本为 `title + summary + key_entities`，但语义去重在 value-judge/中文摘要**之前**运行，`summary_zh` 此时尚未产出；故以代表 `raw_item` 的 `content` 摘录替代 `summary`，是有据偏离，不破坏"同事件收敛"目标。`content` 列可空（QA §8.1），故须经上面「空文本兜底」处理无可用文本的事件。

embedding 生成属外部 API 调用，必须带重试与错误日志；单条生成失败时该事件跳过语义合并（保留为独立事件，欠合并安全），不得中止整批。生成必须幂等：已有 embedding 的事件不重复生成。

#### 场景:新事件生成 embedding 落库
- **当** 硬去重塌缩产出一条 `embedding IS NULL` 的新闻事件
- **那么** 系统以 `representative_title` ‖ 代表 raw_item `content` 摘录为文本生成向量并写入 `ai_news_events.embedding`，再次运行不重复生成

#### 场景:全站样板正文不再让两篇不同文章共享同一段 embedding 文本
- **当** 某源两篇内容互不相干的文章，其页面 `og:description` 为**同一段全站样板文案**（如 `Anthropic is an AI safety and research company…`）
- **那么** 上游（采集器与判分前正文补全）已把该样板**视同缺失**（`content = null`），两条事件的 embedding 文本退化为**各自的 `representative_title`**（不再共享同一段正文摘录）、灰区 LLM 判定的两侧亦不再拼入同一串 `Content:`，二者不因样板相同而被推高相似度误并；若某事件的 `content` 与标题皆空，仍由「空文本兜底」跳过其 embedding 与语义合并

#### 场景:embedding 生成失败不中止整批
- **当** 某事件的 embedding 外部调用重试后仍失败
- **那么** 记错误日志、该事件跳过语义合并保留为独立事件，其余事件照常处理，整批不中止

### 需求:确定性事件合并

系统判定两事件同一时，必须由**程序 + DB 单事务**执行合并，绝不交给 LLM：存活者 = `first_seen_at` 较早者（并列取 `event_id` 字典序小者），两行 `FOR UPDATE` 锁定后，存活者 `source_count += 被吞 source_count`、`published_at` / `published_at_authority` 按**权威等级高者胜出**归集（见下「发布日按权威等级归集」）、`first_seen_at = LEAST(...)`、`last_seen_at = GREATEST(...)`；**禁止覆盖**存活者 `event_id` / `representative_raw_item_id` / `representative_title` / `dedup_key`。被吞事件不得物理删除，必须置 `merged_into = 存活 event_id`（tombstone），保留其 `dedup_key` 唯一占位；后续硬去重塌缩命中 tombstone 行时必须改投 `merged_into` 指向的存活者（不得新建重复事件）。合并必须在 value-judge 评分与 push 之前完成，以保证跨天幂等（存活者通常为前日已 push 的较早事件，push 候选"从未以该 channel success"据此跳过、同一现实事件次日不重推）。

**发布日按权威等级归集（本需求修改点，与硬去重塌缩同口径）**：合并**不得**再用 `published_at = COALESCE(存活, 被吞)`（单向 NULL-fill、存活者已有值即永久胜出）。存活者按 `first_seen_at` 定，与「谁的日期更精确」**毫无关系**——一条被 `hacker_news` 先塌缩出的事件（`published_at` = 投稿时刻，authority=2）若吞掉一条带**页面确定性提取发布日**的事件（authority=3），旧口径会把那个精确值**丢弃**。故：

```sql
published_at = CASE
  WHEN 被吞.published_at_authority > 存活.published_at_authority
    THEN 被吞.published_at
  ELSE 存活.published_at
END,
published_at_authority = GREATEST(存活.published_at_authority, 被吞.published_at_authority)
```

`published_at_authority` 的**四级**取值域（0 无日期 / 1 LLM 推断 / 2 程序取得的近似值 / 3 页面确定性提取）、推导规则（由 `raw_items.source` 得出：无日期 → 0、`sitemap`（页面确定性提取）→ 3、其余程序源 → 2；等级 1 只由 AI 回填写入）与不变量 `(published_at IS NULL) = (published_at_authority = 0)` 由 **dedup-and-normalization「基于 dedup_key 的硬去重塌缩」为权威**，本需求只承诺**同口径**、不另立一套。

**同权威等级 MUST NOT 覆盖**（保留存活者的值）⇒ 程序近似值之间（2 vs 2）行为与本需求修改前一致；**NULL-fill 是本口径的特例**（存活者 `published_at IS NULL` ⇒ authority=0 ⇒ 被吞者任何非空值 authority ≥ 1 > 0 ⇒ 自动填入），不需另设 `COALESCE` 分支。而**程序近似（2）严格高于 LLM 推断（1）** ⇒ 被吞者带真实时间戳、存活者只有 AI 猜的日期时，真实时间戳取代猜测（**程序 > LLM**，第一架构原则）。

**链式合并（transitive）解析到终态存活者**：存活者本身在后续轮次可能再被合并（A 吞 B 后，次日 A 被吞入 C，则 A 也成 tombstone）。任何「据 `merged_into` 找存活者」的解析（塌缩 tombstone 改投、合并前定位存活者）**必须沿 `merged_into` 链递归/迭代到终态**（`merged_into IS NULL` 的真正存活者），**不得只跳一跳**停在一个仍是 tombstone 的行；解析必须带**环路保护**（已访问集合，命中即报错告警，绝不无限循环）。新合并时存活者必须取链终态行，被吞链上所有 tombstone 的 `merged_into` 可路径压缩指向终态存活者。

**source_count 不重复计数**：合并时存活者**一次性**吸收被吞事件的 `source_count`（被吞 tombstone 的 `source_count` 冻结、不再变动）；其后硬去重塌缩命中该 tombstone 的 `dedup_key` 改投存活者时，仅对**真正新到的 raw_item** `source_count += 1`，**绝不**把被吞 tombstone 已冻结的 `source_count` 再次累加到存活者。

**并发与锁序**：
- **合并 vs 合并**：语义合并仅在日报链单例锁（`acquireDigestLock`）内执行，告警链**不做**语义合并，故同一时刻只有一个合并者（合并-合并不并发）。即便如此，`FOR UPDATE` 两行必须按**确定锁序**（如 `event_id` 字典序升序）加锁，作为防 AB-BA 死锁的纵深防御。
- **合并 vs 塌缩（关键，未被单例锁排除）**：塌缩入口 `collapseUncollapsedRawItems` 为日报链与**告警高频链共用**，而告警链塌缩**不持日报单例锁**（每 20min 跑），故告警链塌缩会与日报链语义合并**并发**地触碰同一被吞行。二者必须靠**冲突 `dedup_key` 那一行的行锁**串行化：合并对被吞行 `FOR UPDATE`，塌缩改投对命中行经 `ON CONFLICT DO UPDATE`/`SELECT FOR UPDATE` 持同一行锁；增量只落**链解析后的存活者**（命中 tombstone 时 `DO UPDATE` 加 `WHERE merged_into IS NULL` 守卫、改在事务内改投存活者），绝不加到 tombstone（详见 dedup-and-normalization「改投的并发原子性」，为权威）。两序皆自洽：合并先→塌缩读到 tombstone 改投存活者；塌缩先→合并 `源count += 被吞` 吸收该 +1。**两序对 `published_at` 亦自洽**：两条路径都按「权威高者胜出 + `GREATEST`」归集，该运算幂等且与顺序无关（取上确界）。

#### 场景:合并保留较早事件身份并累加来源数
- **当** 事件 A（`first_seen_at` 较早）与 B 判为同一事件
- **那么** A 存活、`source_count` 累加 B 的来源数，B 置 `merged_into=A.event_id`，A 的 `event_id`/`representative_*`/`dedup_key` 不变；A 的 `published_at` 仅在 B 的 `published_at_authority` **严格更高**时被 B 的值取代（如 A 的日期来自 HN 投稿时刻、B 的来自页面确定性提取），`published_at_authority` 取二者 `GREATEST`——**绝不可**按旧的 `COALESCE(存活, 被吞)` 口径把 B 的精确值丢弃

#### 场景:塌缩命中 tombstone 改投存活者
- **当** 后续一条 `raw_item` 的 `dedup_key` 命中已 tombstone（`merged_into` 非空）的事件行
- **那么** 该 `raw_item` 塌缩进 `merged_into` 指向的存活事件，不新建重复事件

#### 场景:合并发生在推送之前不致同事件次日重推
- **当** 今日新事件与昨日已 push 的事件判为同一事件，于评分/推送阶段之前合并
- **那么** 存活者为昨日已 success 的事件，今日推送候选据"从未以该 channel success"跳过，不重推
