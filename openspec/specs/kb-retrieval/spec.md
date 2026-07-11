# kb-retrieval 规范

## 目的

提供知识库读侧只读语义检索 baseline，供实测单跳 cosine 是否够用、决定是否引入 SAG 结构化 KB。

## 需求

### 需求:知识库语义检索原语(只读、确定性、事件域)

系统必须提供一个**只读**的知识库语义检索原语:给定查询串,经与 `kb_documents.embedding` **同一 embedding 模型**向量化后,对 `kb_documents` 中 `target_type='event'` 的行做**精确 cosine KNN**(`cosine_sim = 1 - (embedding <=> 查询向量)`),返回按 `cosine_sim` 降序的 top-k,每条含 `{id, kb_title, summary_zh, entities, source_urls, event_date, long_term_value, cosine_sim}`。检索为**程序确定性**——由向量相似度排序决定命中,**绝不交 LLM 判定是否命中**;`cosine_sim` 并列时以稳定次序键(如 `id`)消歧,结果可复现。检索必须**只读**(仅 SELECT),**绝不写任何域库**(无 INSERT/UPDATE/DELETE),守读写分离迁移边界。

**排除口径(必守):**
- **不可检索行**:`embedding` 为 NULL 的行(入库向量化失败降级)必须排除、不进结果、不报错。
- **tombstone 不可见**:`kb_documents` 无 `merged_into` 列,而事件可能在入库后被语义合并塌缩为 tombstone。检索必须以**事件域只读反连接**排除对应 `ai_news_events.merged_into` 非空的事件——对齐既有不变量「tombstone 对所有下游消费者不可见」(与 `search_ai_events` 同口径),使新的检索消费者不泄露已塌缩事件。该反连接**限定 `target_type='event'`**(经验卡无 tombstone 概念)。**缺行安全缺省(include-on-missing)**:某事件 `kb_documents` 行若无对应 `ai_news_events` 行(正常不发生,合并只置 `merged_into`、不硬删),视为「非 tombstone」、仍可检索——绝不因缺行误删。
- **域限定**:baseline 只检索 `target_type='event'`;`target_type='experience'`(经验卡)不在本能力范围。

**返回与配额:**
- `id`(`kb_documents.id`,`bigint`)必须以**字符串**返回,保证结果可 JSON 序列化(不因 `bigint` 序列化失败而崩)。
- top-k 的 k 由调用方给定或取配置缺省,且必须在检索原语内**双向归一化为 `[1,50]` 整数**(`Math.max(1, Math.min(Math.trunc(k), 50))` 语义):上限 50 防巨量 seq-scan 输出;下限 1 + 取整防直调方传 `0`(`LIMIT 0` 静默空)/负数(`LIMIT` 负值 Postgres 报错)/小数(非整强转错)。归一化**须在检索原语内**(非仅调用方/CLI 参数层校验),使任何复用方(含将来 A3、绕过 Zod 的直调)都不能绕过——越界即归一,绝不返回超上限行、绝不无界扫描或产生非法 LIMIT。

#### 场景:按语义相似度返回带分 top-k
- **当** 对已入库的精选知识库(事件域)发起一个查询串
- **那么** 系统返回按 `cosine_sim` 降序、截断到 top-k 的事件 `kb_documents`,每条带 `cosine_sim` 与 `id`(字符串)/`kb_title`/`summary_zh`/`entities`/`source_urls`

#### 场景:embedding 为 NULL 的行被排除
- **当** 某 `kb_documents` 行 `embedding` 为 NULL
- **那么** 该行不参与检索、不进结果,检索照常返回其余可检索行、不报错

#### 场景:已塌缩(tombstone)事件不被检索泄露
- **当** 某事件已入库 `kb_documents`,其后被语义合并塌缩(`ai_news_events.merged_into` 非空)
- **那么** 检索经事件域只读反连接将其排除,不返回该已塌缩事件的知识库文档(守「tombstone 对所有下游消费者不可见」)

#### 场景:经验卡不在事件域检索范围
- **当** `kb_documents` 含 `target_type='experience'` 行
- **那么** 事件域检索不返回经验卡行(域限定 `target_type='event'`)

#### 场景:空知识库或空查询诚实返回空
- **当** 无可检索行,或查询串为空/纯空白
- **那么** 系统返回空结果——查询串**经 `.trim()` 判定为空**时在检索原语内短路、不发起向量化调用(不可依赖底层 embed 原语兜底:它只挡空数组、不挡纯空白,纯空白会嵌成退化向量),不报错、不编造命中

#### 场景:检索只读不改库
- **当** 一次检索完成
- **那么** `kb_documents` 与 `kb_ingestion_records` 的行数与内容零变化(检索绝不写域库)

### 需求:查询与文档同 embedding 模型(cosine 可比不变量)

查询向量化**必须复用产出 `kb_documents.embedding` 的同一 embedding 模型**(`env.EMBEDDING_MODEL`,经既有 `embedTexts` 原语)。cosine 相似度只在**同一向量空间**有意义:用不同模型或不同维度向量化查询会使相似度失真、命中无意义,故禁止。维度硬钉与既有约束一致。**已知残留约束(披露)**:同维不同模型、或跨时间更换 `EMBEDDING_MODEL`(旧行按旧模型嵌、新查询按新模型)不会报错且无守卫 → 混向量空间静默失真;这属既有约束(换模型需 forward-only 重嵌迁移),本能力不在 baseline 加运行时守卫,但须在文档/风险中披露。

#### 场景:查询走与文档一致的 embedding 模型
- **当** 系统把查询串向量化以检索 `kb_documents`
- **那么** 使用与入库时产出 `kb_documents.embedding` 相同的 embedding 模型,保证 cosine 在同一向量空间可比

### 需求:多跳缺口可观测

系统必须为每次知识库检索提供可观测口径,支撑「单跳 cosine 检索是否够用、还是败在跨文档实体串联(多跳)」的**人工抽检**——这是决定是否引入 SAG 式结构化 KB 的实测信号。每次检索完成后,系统必须以**结构化 stderr 日志**(非 stdout——守本仓日志纪律,亦防将来移入 MCP 时污染 JSON-RPC)记录本次:查询串、返回的 top-k(各文档 id/标题与 `cosine_sim`)、各命中文档的 `entities`、分数统计、以及本次 `returned`(结果数)。而**语料级覆盖计数** `searchableTotal`(有 embedding 的事件行) / `null`(无 embedding 行) / `tombstoneExcluded`(被反连接排除的已塌缩事件)是 query 无关的语料常量,须**每测量会话由测量入口算一次**(非每次检索——避免在被复用的检索原语热路径上每查多一次全表聚合扫描),与逐查记录一并供判读。记录必须为**确定性程序输出**(非 LLM 判断质量),不得改变检索行为、**不得写任何域库**(绝不落表——落表即破只读边界)。

多跳是否发生由**人工据记录判读**,且判读**必须遵守解读非对称规则**:召回受**三个压低混淆项**约束——① 摘要级 embedding(只嵌标题+摘要非正文)、② NULL-embedding 覆盖缺口(bootstrap 不修 `kb_documents`)、③ tombstone 反连接排除(排除入库后被塌缩、survivor 未入 KB 的内容)。故**只有「高 cosine + 召回到对的文档、但答案仍需跨文档实体串联」才是干净的「需 SAG」正信号;一次低召回不构成「单跳够用」的证据**(可能是任一混淆项)、结论不确定——**绝不可把弱召回读成「不需 SAG」**。分项计数使三项混淆项可见可量,防其被误当「检索弱」。

#### 场景:每次检索记录多跳缺口口径
- **当** 一次知识库检索完成并返回 N 条结果(N ≥ 0)
- **那么** 系统经结构化 stderr 日志记录查询串、top-k 的文档 id/标题/`cosine_sim`、各命中文档 `entities`、分数统计与本次 `returned`;语料级 `searchableTotal`/`null`/`tombstoneExcluded` 由测量入口每会话记一次,供人工按解读非对称规则抽检单跳是否够用

#### 场景:记录不改变检索行为、不写库
- **当** 记录多跳缺口可观测口径
- **那么** 该记录为纯旁路观测(走 stderr),不改变 cosine 排序与 top-k 结果、不阻塞、**不写任何域库**
