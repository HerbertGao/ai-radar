# semantic-dedup 规范

## 目的
待定 - 由变更 add-semantic-dedup-and-store-hardening 同步创建。归档后请更新目的。
## 需求
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

### 需求:embedding 相似度候选检索与阈值分流

系统必须对每条待判事件，在时间窗内（`first_seen_at >= now() - SEMANTIC_WINDOW_DAYS`，默认 14 天）、排除自身与 tombstone（仅取 `merged_into IS NULL` 候选）、按 pgvector 余弦距离 `embedding <=> $q` 取最近 K（默认 10）个候选，`cosine_sim = 1 - distance`。阈值分流必须为（边界语义显式钉死，避免浮点 `==` 歧义）：`cosine_sim > SEMANTIC_DEDUP_HIGH`（默认 0.88）→ **高相似直接合并**；`SEMANTIC_DEDUP_LLM`（默认 0.82）< `cosine_sim` ≤ `SEMANTIC_DEDUP_HIGH` → 交 **LLM 二次判断**；`cosine_sim ≤ SEMANTIC_DEDUP_LLM` → 不合并。阈值与窗口必须可配置，默认取 QA.md §9.2 值。

> 偏离登记 + 风险闸：QA.md §9.2 把 `>0.88` 字面表述为「高度疑似重复」（判断**建议**），并未要求「直接合并、跳过 LLM」。本期 D4 决定对 `>0.88` 直接确定性合并、不过 LLM，是对 QA §9.2 措辞的**有意偏离**，须满足两项安全约束以控过合并（过合并丢失独立事件，是危险方向，且本期阈值未实测调优属非目标）：① 合并为 tombstone（非物理删除），始终**可回溯/可恢复**；② 系统必须**记录每次合并的 provenance**（被吞与存活 `event_id`、`cosine_sim`、触发档位 `high-auto` / `llm-confirmed`、LLM `reason`（若经 LLM）），落可观测日志或轻量审计记录，使误并可被事后审计与回滚。无 provenance 记录的自动合并不满足本需求。

#### 场景:高相似度直接判同事件
- **当** 待判事件与某窗内候选事件的 `cosine_sim` 大于 0.88
- **那么** 二者直接判为同一事件、进入确定性合并，不调用 LLM

#### 场景:灰区相似度交 LLM
- **当** 待判事件与候选事件的 `cosine_sim` 落在 (0.82, 0.88]
- **那么** 系统调用 LLM 二次判断决定是否同事件

#### 场景:低相似度不合并
- **当** 所有窗内候选与待判事件的 `cosine_sim` 均不大于 0.82
- **那么** 待判事件保留为独立事件，不合并、不调用 LLM

### 需求:LLM 二次判断灰区同事件

系统必须对灰区候选对调用 LLM（Vercel AI SDK `generateObject`），输出经 Zod 校验的结构化 JSON `{ same_event: boolean, same_product: boolean, reason: string }`（QA.md §9.2 第四层），带重试与错误日志。LLM 失败或 schema 校验不过时必须**降级为"不合并"**（视为不同事件）——欠合并（最多重复一条）安全，过合并会丢失独立事件。是否合并的**最终落库决定由程序据 `same_event` 执行**，LLM 仅产语义建议，绝不由 LLM 直接改写去重身份或唯一约束。

> `same_product` 字段本期**仅采集留存、不消费**（与 QA §9.2 JSON 形对齐、为后续产品语义合并预留），**绝不**据此触发任何 `ai_products` 合并或改写——产品语义合并是本期非目标，实现禁止把 `same_product` 接到产品塌缩。

#### 场景:LLM 判定同事件则合并
- **当** 灰区候选对的 LLM 输出 `same_event=true` 且通过 Zod 校验
- **那么** 程序对两事件执行确定性合并

#### 场景:LLM 调用失败降级为不合并
- **当** 灰区候选对的 LLM 调用重试后仍失败或输出未通过 Zod 校验
- **那么** 系统记错误日志并保留二者为独立事件（不合并），不中止整批

### 需求:确定性事件合并

系统判定两事件同一时，必须由**程序 + DB 单事务**执行合并，绝不交给 LLM：存活者 = `first_seen_at` 较早者（并列取 `event_id` 字典序小者），两行 `FOR UPDATE` 锁定后，存活者 `source_count += 被吞 source_count`、`published_at` / `published_at_authority` 按**权威等级高者胜出**归集（见下「发布日按权威等级归集」）、`first_seen_at = LEAST(...)`、`last_seen_at = GREATEST(...)`；**禁止覆盖**存活者 `event_id` / `representative_raw_item_id` / `representative_title` / `dedup_key`。被吞事件不得物理删除，必须置 `merged_into = 存活 event_id`（tombstone），保留其 `dedup_key` 唯一占位；后续硬去重塌缩命中 tombstone 行时必须改投 `merged_into` 指向的存活者（不得新建重复事件）。合并必须在 value-judge 评分与 push 之前完成，以保证跨天幂等（存活者通常为前日已 push 的较早事件，push 候选"从未以该 channel success"据此跳过、同一现实事件次日不重推）。

**发布日按权威等级归集（本需求修改点，与硬去重塌缩同口径）**：合并**不得**再用 `published_at = COALESCE(存活, 被吞)`（单向 NULL-fill、存活者已有值即永久胜出）。存活者按 `first_seen_at` 定，与「谁的日期更接近发布日」**毫无关系**——一条被 `hacker_news` 先塌缩出的事件（`published_at` = 投稿时刻，authority=1）若吞掉一条带**页面确定性提取发布日**的事件（authority=2），旧口径会把那个精确值**丢弃**。故：

```sql
published_at = CASE
  WHEN 被吞.published_at_authority > 存活.published_at_authority
    THEN 被吞.published_at
  ELSE 存活.published_at
END,
published_at_authority = GREATEST(存活.published_at_authority, 被吞.published_at_authority)
```

`published_at_authority` 的**两级非空**取值域（0 无日期 / 1 一切非页面提取的日期值：rss `pubDate`、hacker_news 与 show_hn 的投稿时刻、github 的 push 时刻、AI 推断 / 2 页面确定性提取的发布日）、推导规则（由 `raw_items.source` 得出：无日期 → 0、`sitemap`（页面确定性提取）→ 2、其余源 → 1；AI 回填亦写 1）与不变量 `(published_at IS NULL) = (published_at_authority = 0)` 由 **dedup-and-normalization「基于 dedup_key 的硬去重塌缩」为权威**，本需求只承诺**同口径**、不另立一套。

**同权威等级 MUST NOT 覆盖**（保留存活者的值）⇒ 第 1 档内部（1 vs 1）行为与本需求修改前的 `COALESCE` 一致；**NULL-fill 是本口径的特例**（存活者 `published_at IS NULL` ⇒ authority=0 ⇒ 被吞者任何非空值 authority ≥ 1 > 0 ⇒ 自动填入），不需另设 `COALESCE` 分支。**唯一新增的覆盖关系是「页面提取（2）> 一切」**——**MUST NOT 在第 1 档内部再排序**（含「程序时间戳 > LLM 推断」）：该阶梯排的是「离**文章发布日**有多近」而非「时间戳来源有多可信」，任何档内排序都会引入一条能把日期**往后推**的覆盖关系（老文被推成今日突发），而页面提取读的是文章自己印的日期、结构上不可能让老文看起来新。

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

### 需求:语义去重仅作用于日报链新闻事件

系统的 embedding 相似度层、LLM 二次判断层与事件合并必须**仅在日报链**执行（在硬去重塌缩之后、value-judge 之前），实时告警高频链保持硬去重快路径、不做语义去重（对齐既有"仅日报链"的熔断模式）。语义层必须仅作用于 `ai_news_events`（新闻事件），不作用于 `ai_products`（产品仍沿用确定性硬规则合并）。语义层必须**无条件执行**、不设启停开关（原 `SEMANTIC_DEDUP_ENABLED` 门控已随该层转正删除）；其正确性由阈值与确定性护栏保障，不由运行期开关兜底。

#### 场景:告警链不触发语义合并
- **当** 实时告警链运行硬去重塌缩
- **那么** 不执行 embedding 相似度/LLM 判断/事件合并，仅按硬去重 + 一生一次幂等告警

#### 场景:日报链无条件执行语义层
- **当** 日报链完成硬去重塌缩
- **那么** 语义层照常执行，不存在可跳过它的运行期开关（grep 全仓无 `SEMANTIC_DEDUP_ENABLED`）

### 需求:tombstone 对所有下游消费者不可见（合并的核心闭环）

语义合并把被吞事件置 `merged_into IS NOT NULL`（tombstone），但 tombstone 仍是 `ai_news_events` 中一条物理行，其 `*_score` / `should_push` / `summary_zh` / `published_at` 等列原样保留。**因合并发生在 value-judge 评分之前，被吞 tombstone 的 `importance_score` 此刻为 NULL，若不显式排除，会被 value-judge 重新选中评分（"复活"为已评分事件）、进而被 Top N 选中并独立推送——与存活者重复推送同一现实事件，使合并不仅无效、反而比不合并更糟**。故系统必须确立一条横切不变量：

> **凡把 `ai_news_events` 的一行当作「独立事件」用于评分 / 选择 / 推送 / 查询 / 聚合统计的读取，都必须在 `WHERE` 上排除 tombstone（`merged_into IS NULL`）；凡按 `event_id` 定位写入的，要么命中的是终态存活者（经链式解析），要么显式跳过 tombstone。**

declared-coverage（合并闭环所需的全部受影响读点）必须覆盖以下**实际生效集**（按当前代码消费者枚举，新增同类消费者须一并纳入）：

| 消费者 (`file`) | 用途 | 必须的处理 |
|---|---|---|
| `src/agents/value-judge/score-events.ts`（候选 SELECT `importance_score IS NULL`；claim CAS `UPDATE … WHERE event_id=? AND importance_score IS NULL …`；评分写 CAS `UPDATE … SET *_score/should_push WHERE event_id=?`） | 选未评分事件送判 | 候选 SELECT **与 claim CAS、评分写 CAS 三处 `WHERE` 都**加 `AND merged_into IS NULL`——**不可只在 SELECT/claim 收口**：告警链跑 `scoreUnscoredEvents` 不持日报锁，SELECT→claim→评分写均为分离语句，任一间隙日报链都可把 B 置 tombstone（TOCTOU）；谓词落每个 CAS 自身 `WHERE` 才使「tombstone 绝不被 claim/评分/复活」成立 |
| `src/selection/top-n.ts`（Top N 候选 SELECT） | 选日报推送候选 | 加 `AND merged_into IS NULL`——tombstone 绝不入选推送 |
| `src/agents/published-at-inference/backfill.ts`（候选 SELECT 与回填 CAS `UPDATE … WHERE event_id=? AND published_at IS NULL …`） | 回填 published_at | 候选 SELECT **与回填 CAS 的 `WHERE` 都**加 `AND merged_into IS NULL`——同 value-judge 的 TOCTOU 理由（告警链 `backfillPublishedAt` 不持日报锁），谓词必须落 CAS 自身 `WHERE`，不浪费推断预算、不在 tombstone 落 `published_at` |
| `src/pipeline/alert-scan.ts`（告警候选 SELECT） | 实时告警候选 | 加 `AND merged_into IS NULL`——不对已被日报链合并掉的死 event_id 告警 |
| `src/mcp/tools/source-quality.ts`（`count(distinct event_id)`） | 来源质量统计 | 加 `AND merged_into IS NULL`——不因 tombstone 虚增「事件数」 |
| `src/mcp/tools/search-events.ts` / `get-today.ts` / `mark-event.ts` / `push-event-now.ts` | MCP 查询/标记/手动推送 | 排除 tombstone——不向 agent/用户暴露重复行、不手动推 tombstone、不在 tombstone 上落写 |
| KB 入库候选选择（见 knowledge-base「准入闸」候选域） | 选高价值/已推送事件入库 | 加 `AND merged_into IS NULL`——否则存活者与 tombstone 各得不同 `target_id`，`UNIQUE(target_type,target_id,kb_provider)` 不去重、产生重复 KB 文档 |

**无锁告警链的 CAS 必须自带谓词（SELECT 收口不充分）**：日报链的合并在单例锁内，但告警高频链跑 `scoreUnscoredEvents` / `backfillPublishedAt` / 塌缩**均不持日报锁**，与日报合并并发。凡告警链可达、按 `event_id` 定位的 **CAS 写**（claim `judge_claimed_at`、评分写 `*_score`/`should_push`、回填 `published_at`、塌缩 `source_count`），其 tombstone 排除谓词**必须落在该 CAS 自身的 `WHERE`**，不可仅靠上游候选 SELECT 或上一步 claim（claim 与评分写亦为分离语句，claim 后、评分写前仍可被合并置 tombstone）——SELECT 与 CAS 是分离语句，二者之间日报合并可置 tombstone（TOCTOU），仅 SELECT 收口挡不住。谓词落 CAS 后，最坏情形退化为「无害空写/空 claim」（命中已 tombstone 行时 `WHERE` 不满足、0 行受影响），既不复活 tombstone、也不浪费 LLM/推断（CAS 0 行即跳过后续外部调用）。**例外（有意豁免）**：`releaseJudgeClaim`（清 `judge_claimed_at`）**无需**加该谓词——清 claim 仅「重新允许被 claim」，而再 claim 已被加谓词的 claim CAS 挡住，故清在 tombstone 上是无害空操作、非复活向量；勿误把它当遗漏「顺手补上」。

注：`src/dedup/collapse.ts`（ON CONFLICT 改投存活者）与 `semantic-search.ts`（候选检索 `merged_into IS NULL`）已在各自需求中处理，是闭环的另两点。改投在事务内对「冲突行 + 链解析后的存活者行」两行加锁，与并发合并（对被吞行 + 其存活者 `FOR UPDATE`）可能 AB-BA——依赖与「合并 vs 合并」同一套 Postgres 死锁检测 + BullMQ 重试 + 幂等重塌缩兜底（见「确定性事件合并」锁序），非声称无死锁协议。以下按键读/写**经上游收口而传递性安全**（枚举完备、非偶然完备）：`src/pipeline/run-daily-workflow.ts`(`loadCanonicalUrls`) 与 `src/agents/digest/persistence.ts`（`UPDATE … WHERE event_id=?` 写 summary）的 `event_id` 全部来自 Top N 选集（已排除 tombstone），故不会落在 tombstone 上；`src/mcp/lib/canonical-url.ts` 由 get-today/push-event-now 喂入（均已收口）。`get-today.ts` 经 `push_records.status='success' AND push_date=今日` 还原：tombstone **可能保留被合并前某历史 push_date 的 success 记录**，但因 tombstone 已被 value-judge/Top N 排除、当日绝不被新推送，故**今日**的 success 集只含存活者——结论安全（措辞按「今日 push_date 集只含存活者」，非「tombstone 无 success 记录」）。上述按键路径实现仍须在 `event_id` 来源不可信（如 MCP 入参）时显式排除 tombstone。

#### 场景:被吞事件不被 value-judge 复活、不被 Top N 重复推送
- **当** 今日新事件 B 与存活者 A 合并、`B.merged_into=A.event_id`（B 此前 `importance_score` 为 NULL），随后 value-judge 与 Top N 阶段运行
- **那么** B 因 `merged_into IS NOT NULL` 被 value-judge 候选查询排除、不被评分，Top N 候选查询同样排除 B，B 绝不进入推送，当日仅存活者 A 一条参与（A 若昨日已 success 则据幂等跳过）

#### 场景:并发下被吞事件即便被告警链选中也不被 claim/评分/回填（CAS 自带谓词）
- **当** 告警链（无日报锁）候选 SELECT 已选中 B，其后日报链把 B 置 `merged_into=A`，告警链再执行 claim CAS / 评分写 CAS / 回填 CAS（含 claim 成功后、评分写前 B 才被置 tombstone 的链内二次 TOCTOU）
- **那么** 各 CAS 自身 `WHERE … AND merged_into IS NULL` 不满足、命中 0 行：B 不被 claim、不送 LLM 评分、`*_score`/`should_push` 不被写、`published_at` 不被回填，tombstone 绝不复活（SELECT→claim→评分写的每个 TOCTOU 间隙都被各 CAS 自带谓词兜住）

#### 场景:tombstone 不出现在告警/MCP 查询/KB/统计
- **当** 一条 tombstone 事件存在于 `ai_news_events`
- **那么** 告警候选、MCP `search-events`/`get-today` 结果、KB 入库候选、`source-quality` 的 `count(distinct event_id)` 统计均不包含它（各读点带 `merged_into IS NULL`）

### 需求:合并前确定性精度护栏（数字/版本 token）

系统在语义去重判定两事件同一、调用确定性事件合并**之前**，必须经一个**纯确定性程序护栏**（不调用 LLM、不查 embedding）二次否决：护栏从两侧 `ai_news_events.representative_title` 抽取**数字/版本 token 集合**，两集合不相等时必须**否决该候选合并**。护栏为前置否决条件，**对 `high-auto`（直接合并）与灰区 `llm-confirmed` 两路均生效**，且**优先于阈值分流与 LLM 的合并结论**——即便 `cosine_sim > SEMANTIC_DEDUP_HIGH`，token 集不同仍不得合并。护栏须**前置于 LLM 调用**：灰区候选 token 集不同时在调用 LLM 之前即被否决（不为其调用 LLM，省成本）。

token 抽取必须满足：① 吃**原始** `representative_title`，**禁止**复用 `normalizeTitle`（其标点剥离会把 `3.1` 塌为 `31`、删除 `#`，毁掉区分 token）；② 仅小写化后以正则抽数字 token，小数/多段版本号（如 `5.3`、`1.2.3`）作**原子串**保留，**禁止**拆成独立整数（否则 `GPT-5` 与 `GPT-5.5` 的 token 集会相等而漏判）；③ 以**集合**（去重）而非多重集比较。两侧 token 集均空时视为相等（放行，交由既有合并逻辑），一侧有一侧无时视为不等（否决）。

护栏只会**减少**合并（更保守方向），**禁止**新增任何合并或赋予 LLM 决策权；残留偏差必须落在**欠合并**方向（最多保留一条重复），绝不引入新的过合并。护栏否决某候选后必须**继续评估该待判事件的下一个候选**（不得据此终止该事件的候选扫描），以免高相似度的版本变体邻居埋掉更低相似度的真同事件候选。系统必须对护栏否决次数计数并随语义合并统计返回，供可观测。

> 已知限制（如实登记，非缺陷）：本护栏仅捕获**数字/版本/序号/年份变体**误合。专名差变体（如 Europe↔Asia、Schibsted↔Guardian、Teen↔Child）无数字差异、护栏不否决——确定性专名护栏会大面积误否决正确跨源合并（标题共享大量专名），违反「不误否决真同事件」，故不做；其灰区部分靠 `SEMANTIC_DEDUP_LLM` 收口、auto 区残留依赖合并 provenance 事后审计与后续迭代。

#### 场景:版本/序号变体在 high-auto 路被否决

- **当** 待判事件与某候选 `cosine_sim > SEMANTIC_DEDUP_HIGH`（本应直接合并），但两侧 `representative_title` 数字/版本 token 集不同（如 `OpenAI o1 System Card` 的 `{1}` 与 `OpenAI o3-mini System Card` 的 `{3}`）
- **那么** 系统否决该候选合并、不调用 `mergeEvents`，二者保持为独立事件，护栏否决计数 +1

#### 场景:灰区 token 不同前置否决（不调 LLM）

- **当** 某候选落入灰区（`SEMANTIC_DEDUP_LLM < cosine_sim ≤ SEMANTIC_DEDUP_HIGH`），但两侧标题数字/版本 token 集不同（如 `Mistral Small 3` 的 `{3}` 与 `Mistral Small 3.1` 的 `{3.1}`）
- **那么** 系统在调用 LLM 之前即否决合并（护栏前置，不为该对调用 LLM），二者保持为独立事件，护栏否决计数 +1

#### 场景:token 集相等的真同事件正常合并

- **当** 两侧标题数字/版本 token 集相等（如 `Introducing GPT-5` 与 `GPT-5 for developers` 均为 `{5}`），或两侧均无数字 token（如跨源改写的同一新闻、仅大小写差的同一标题）
- **那么** 护栏放行，交由既有阈值分流/LLM/确定性合并逻辑正常处理

#### 场景:否决后继续评估下一候选

- **当** 待判事件的最高相似度候选被护栏否决（如版本变体邻居），而其更低相似度的另一候选与之 token 集一致、实为同一事件
- **那么** 系统继续评估后续候选并对真同事件候选执行合并，不因前一候选被否决而终止该事件的候选扫描

