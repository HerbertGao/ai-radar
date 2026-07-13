# knowledge-base 规范

## 目的
待定 - 由变更 add-semantic-dedup-and-store-hardening 同步创建。归档后请更新目的。

## 需求

### 需求:知识摘要 Agent 产出入库元数据

系统必须提供知识摘要 Agent（QA.md §10.7 Knowledge Ingestion Agent），对候选事件经 LLM（Vercel AI SDK `generateObject`）产出经 Zod 校验的结构化 JSON：`{ kb_title, summary_zh, tags: string[], entities: string[], source_urls: string[], event_date, long_term_value: number }`。`long_term_value` 的 Zod 必须钉死取值域 `number().int().min(0).max(100)`——防越界值（如 200 或负数）绕过 `>= 70` 准入闸语义；越界即视为校验不过、跳过该条。该 Agent 属外部 API 调用，必须带重试与错误日志；输出未通过 Zod 校验时必须跳过该条、不入库（不污染知识库），不得中止整批。入库元数据的生成可由 LLM 完成，但**实际入库由程序执行**（QA.md §10.7）。

**新闻事件来源的 grounding 与 `summary_zh` 回写**：对新闻事件来源，知识摘要 Agent SHALL **grounding 于事件原文**（代表 `raw_items.content` / 代表标题等），**不得假设 `ai_news_events.summary_zh` 已由日报阶段预置**——日报 digest 已降级为只产 `headline_zh`（见 chinese-digest-agent），**日报 digest 不再产 `summary_zh`**——新闻事件的 `summary_zh` 改由本入库阶段生成、回写（消除原「日报 digest 与本入库各产一次」的重复生成；告警链仍可为 P0 事件预置 summary+headline，KB 回写因 `WHERE summary_zh IS NULL` 不覆盖）。**知识摘要 Agent SHALL 对每条候选照常运行**：它是 `long_term_value` 的唯一来源、须逐条跑供 `>= 70` 准入闸判定，**绝不能因 `summary_zh` 已存在而跳过 Agent 调用**（否则 P0/告警链已摘要的高价值事件会失 `long_term_value`、被误挡在 KB 外——严重回归）。Agent 产出并经校验的 `summary_zh` SHALL **回写到 `ai_news_events.summary_zh`**，回写为**原子条件写** `UPDATE ai_news_events SET summary_zh = ? WHERE event_id = ? AND summary_zh IS NULL`（`set` 仅含 `summary_zh`、绝不覆盖塌缩首建列；`WHERE ... IS NULL` 令回写**幂等**且与告警链并发写无损——列已非空即不覆盖，非「跳过 Agent」）。回写覆盖**所有已推送成功候选**（Agent 为算 `long_term_value` 本就跑遍它们），与准入 KB 写的 `>= 70` 过滤相互独立（`< 70` 未入 KB 者亦回写）。回写失败绝不阻塞已成功的推送（KB 入库是 push 成功后的 best-effort、never throw；Agent 对某候选失败则该候选无回写，见变更 Risks）。

#### 场景:Agent 产出结构化入库元数据
- **当** 一条候选事件送入知识摘要 Agent
- **那么** 返回经 Zod 校验的 `{ kb_title, summary_zh, tags, entities, source_urls, event_date, long_term_value }`

#### 场景:新闻事件入库回写 summary_zh 供 weekly 复用
- **当** 一条已推送新闻事件经 KB 入库、其 `ai_news_events.summary_zh` 为空
- **那么** 知识摘要 Agent grounding 于原文产出 `summary_zh`，程序以 `UPDATE ... WHERE event_id`（`set` 仅含 `summary_zh`）回写，weekly 报告后续零 LLM 复用该值；即便该事件 `long_term_value < 70` 未入 KB，回写仍发生

#### 场景:summary_zh 已存在时 Agent 照常跑、回写不覆盖
- **当** 某新闻事件入库时 `ai_news_events.summary_zh` 已非空（如告警链已产），知识摘要 Agent **仍照常运行**产出 `long_term_value`（供准入闸）
- **那么** `>= 70` 准入判定照常进行、该事件正常按闸入/不入 KB；回写的 `UPDATE ... WHERE summary_zh IS NULL` 因列非空**不覆盖**现值（Agent 调用**绝不跳过**，只是回写幂等无操作）

#### 场景:校验不过的输出被跳过不入库
- **当** 某候选事件的 Agent 输出未通过 Zod 校验或调用重试后仍失败
- **那么** 系统记错误日志并跳过该条、不写入知识库，其余候选照常处理

### 需求:知识库准入闸只入精选

系统必须仅把 `long_term_value >= 70` 的内容写入知识库（QA.md §13.1「知识库不是垃圾桶」），禁止写入每条 RSS 原文、重复转载、低价值营销稿、纯标题党。准入闸为程序判定（非 LLM 决定是否入库）。准入闸阈值复用 `long_term_value >= 70` 不变量（程序常量 `KB_ADMISSION_FLOOR`——**本变更须先把它从 `kb/index.ts` 私有 const 提升为可导出符号，详见下方候选域说明**）。

**候选域（显式钉死，消除歧义）——本变更扩为两类来源**：

- **事件来源（既有）**：候选 = 「本轮日报链**实际推送成功**（该 `event_id` 当日产生 `push_records.status='success'`）的事件」，**并**排除 tombstone（`merged_into IS NULL`，见 semantic-dedup「tombstone 对所有下游消费者不可见」）。以「已推送成功」为唯一候选界定（而非「importance≥某档的全部事件」），控成本且对齐 config 流水线 `Push → KB Ingestion` 顺序；其 `long_term_value` 由 KB 摘要 Agent 在入库阶段产出。
- **经验来源（本变更新增）**：候选 = `ai_experiences` 中 `long_term_value >= 70` 的经验卡片（`target_type='experience'`）。经验卡片的 `long_term_value` 已由经验提炼 Agent 在提炼阶段产出并 Zod 约束（0..100），故经验来源**直接以卡片自带 `long_term_value` 过准入闸、不再调 KB 摘要 Agent 重算**（避免双评分双 LLM + 口径分裂）；入库元数据（`kb_title`/`summary_zh`/`tags`/`source_urls`/`event_date`/`long_term_value`）直接取自经验卡片字段。经验来源**不以「已推送成功」为前提**（实践锦囊段每日只推 Top N，但全部 `≥70` 经验都应作顾问 RAG 证据语料沉淀，不被每日推送名额所限）。

两类来源都必须经同一 `KB_ADMISSION_FLOOR`（70）程序闸；该常量现为 `kb/index.ts` 模块私有 const，**必须提升为可导出符号**（或迁入共享常量模块），事件链与经验链共同 `import`，禁止写字面量 `70`。两类来源都复用既有 `storeKbDocument` 原语与 `kb_ingestion_records` 幂等（`UNIQUE(target_type,target_id,kb_provider)` 天然容纳 `target_type='experience'`）写入。但**经验来源不得复用 event 版编排 `runKbIngestion`**（其循环硬编码每条候选必调 KB 摘要 Agent `generateKbMetadata`+embedding，对经验卡片既违反「跳过重算」又因输入形状不符降级）——经验来源须走**独立编排 `runExperienceKbIngestion`**，**且必须在 `runDailyWorkflow` 的无候选早退之前执行**（经验入 KB 不以已推送为前提；push-empty 与 KB-empty 是不同集合——所有 ≥70 卡片昨日已推、push 候选空但今日有新 ≥70 卡片时，仍须入 KB；放早退之后会被 push 空早退劫持致 stranding）。`runExperienceKbIngestion`：经验候选 SELECT（独立于 `push_records`，与事件候选路径口径不同、不要求已推送）→ 直接以卡片字段组装**完整 `KbStoreItem`**（**10 字段全必填**）：`targetType = TARGET_TYPE.experience`、**`targetId = ai_experiences.id`**（与推送侧 `target_id` 同源；KB claim CAS 目标身份 + `kb_ingestion_records`/`kb_documents` 的 `target_id`，漏则 tsc 失败/幂等无锚）、`kbTitle = headline_zh ?? scenario`、`summaryZh = summary_zh`、`tags = tools`（卡片 `tools` 数组、空则 `[]`，卡片无独立 tags 字段）、`entities = []`、`sourceUrls = [canonical_source_url]`（有意 canonical-only）、`eventDate = published_at ? getPushDate(published_at) : 当日 pushDate`（镜像 `deriveEventDate` 的 NULL 回退，绝不写 NULL 进 `event_date` date 列）、`longTermValue = 卡片值`、`embedding = null` → `storeKbDocument`（`kbProvider='custom'` 经 options 传入、非 `KbStoreItem` 字段）。即经验来源**只复用入库原语与幂等表、不复用 event 候选编排**；统计自有形状，不复用 event 版 `KbIngestionResult` 的 `agentOk/agentFailed`（经验链不调 KB Agent）。

#### 场景:高价值事件入库
- **当** 某已推送成功事件的 `long_term_value` 为 78
- **那么** 该事件被写入知识库

#### 场景:高价值经验卡片入库
- **当** 某经验卡片（`target_type='experience'`）的 `long_term_value` 为 78
- **那么** 该卡片经 `storeKbDocument` 以 `target_type='experience'` 写入知识库，元数据取自卡片字段，且不再调 KB 摘要 Agent 重算评分

#### 场景:低价值内容被准入闸拦下
- **当** 某事件或经验卡片的 `long_term_value` 为 62（小于 70）
- **那么** 它不被写入知识库，记录为未达准入阈值

#### 场景:经验卡片入库不以已推送为前提
- **当** 某经验卡片 `long_term_value >= 70` 但当日未被实践锦囊段选入 Top N 推送
- **那么** 该卡片仍作为顾问 RAG 证据语料写入知识库（经验来源候选不要求 `push_records.status='success'`）

### 需求:本地表知识库存储

系统必须先以本地表实现知识库（符合 ROADMAP「本地表 → Dify HTTP」顺序）：新增 `kb_documents` 表承载入库内容（`id`、`target_type`、`target_id`、`kb_title`、`summary_zh`、`tags JSONB`、`entities JSONB`、`source_urls JSONB`、`event_date`、`long_term_value`、`embedding vector(1536)`（供未来检索）、`created_at`）。`kb_provider` 取 `custom` 指向本地表。Dify/RAGFlow HTTP 外接不在本期范围（`kb_provider` 预留其它取值但不接线）。

#### 场景:精选事件写入本地 kb_documents
- **当** 一条 `long_term_value >= 70` 的事件入库
- **那么** `kb_documents` 新增一行，含 `kb_title`/`summary_zh`/`tags`/`entities`/`source_urls`/`event_date`/`long_term_value`，`kb_provider='custom'`

### 需求:知识库入库幂等

系统必须以 `kb_ingestion_records` 表（QA.md §8.7）记录入库日志，并以 `UNIQUE(target_type, target_id, kb_provider)` 保障同一目标对同一 provider **最终只成功入库一次**。`kb_ingestion_records.kb_document_id` 必须回指 `kb_documents.id`。

**状态感知的认领（claim）——`success` 跳过、`failed`/僵尸 `pending` 可重试**：幂等闸是「`success` 终态只一次」，**不是「记录存在即跳过」**。因 `failed` 与崩溃残留的 `pending` 行也占用 `UNIQUE(target_type,target_id,kb_provider)`，认领**绝不可**用 `ON CONFLICT DO NOTHING`（那会让一条 `failed` 行把后续重试永久挡死、该 event 再不入库——与「失败可重试」自相矛盾，对齐 **value-judge 的 claim CAS** 状态感知范式；push dispatcher 同为状态感知但用「预算 pending-set + `ON CONFLICT DO NOTHING`」另一范式，此处取 value-judge 的 `DO UPDATE … WHERE status<>'success'` CAS）。认领必须为：`INSERT kb_ingestion_records(status='pending') ON CONFLICT(target_type,target_id,kb_provider) DO UPDATE SET status='pending', ingested_at=now() WHERE kb_ingestion_records.status <> 'success' RETURNING id`——已 `success` 者 `WHERE` 不满足、不返回行 → 跳过（不重入）；不存在 / `failed` / 僵尸 `pending`（可加 `OR ingested_at < now()-T` 回收）者被认领为 `pending` 并返回。

**两表写入原子性（防重复/孤儿 `kb_documents`）**：`kb_documents` 自身无业务唯一约束。认领成功（RETURNING 非空）后，**插入 `kb_documents` 与置该 record `status='success'`、回指 `kb_document_id` 必须在同一 DB 事务**内：成功则一并提交；任一步失败 → 事务回滚（**不留 `kb_documents`**）→ 再以独立 `UPDATE` 置 `status='failed'` 保留 `error_message`（下次认领因 `status='failed'` 重新抢到、重试；因失败已回滚故无残留文档，重试不产生重复）。KB 入库阶段运行在日报链单例锁内（单实例、无并发认领），认领 CAS + 两表同事务共同保证并发与崩溃下都无重复/孤儿 `kb_documents`。崩溃若发生在「事务回滚之后、独立置 `failed` 之前」，该行停在认领时写入的 `pending`（僵尸 pending），由下次认领的 `status<>'success'`（含僵尸 pending 回收）重新抢到重试，无正确性损失（回滚已确保无残留文档）。

#### 场景:已成功入库的事件重复触发被跳过
- **当** 同一事件（同 `target_type`/`target_id`/`kb_provider`）已有 `status='success'` 记录、再次触发入库
- **那么** 认领的 `ON CONFLICT DO UPDATE ... WHERE status <> 'success'` 不满足、不返回行，入库被跳过，不产生重复 `kb_documents`/`kb_ingestion_records` 行

#### 场景:入库失败保留可重试状态且能真正重试
- **当** 某次入库在写入阶段失败、置 `status='failed'` 保留 `error_message`，其后再次触发入库
- **那么** 认领据 `status <> 'success'` 重新抢到该行、置回 `pending` 重试（`failed` 行绝不把重试永久挡死）；重试成功后 `status='success'`、新增**恰一条** `kb_documents`（失败已回滚无残留，不重复）
