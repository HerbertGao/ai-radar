## Why

Plan A Phase A2。重心从「每日精选日报」迁向「持续 KB + 对话 RAG」需要**读侧**先有抓手。但仓内两份文档对 A2 定序冲突：`docs/hangar-migration-plan-a.md` Phase A2 主张**现在就建 SAG 结构化 KB**（`kb_events`/`kb_entities`/`kb_relations` + 抽取 agent + rerank），而 `ROADMAP.md` 的「RAG 检索路径选型」决策记录主张**先上最朴素 pgvector 余弦检索 baseline → 量出真实多跳瓶颈 → 真有瓶颈再引 SAG**（理由：SAG 与本仓同栈=可放心推迟、SAG 的多跳散文召回碰不到 Model Radar 钱路、当前语料小且多为单跳）。**本变更采纳 ROADMAP 的 baseline-先行定序**：A2 = 检索 baseline + 多跳缺口测量；SAG 结构化抽取延到实测有据再作独立提案。

现状（代码核实）：`src/kb` **纯写侧**——`runKbIngestion`（`src/kb/index.ts`，日报 Stage 7）把 `long_term_value >= 70` 精选事件写 `kb_documents`（`schema.ts:279`，含 `embedding vector(1536)` 可空），但**全仓无任何检索/相似度查询读 `kb_documents`**（grep 核实）；唯一 pgvector KNN 在 `src/dedup/semantic-search.ts`（去重用、读 `ai_news_events`）。故 baseline 几乎零新基建：复用已存 embedding + 现成 KNN 原始 SQL 范式 + `embedTexts`。

## What Changes

- **KB 语义检索原语**（新 `src/kb/retrieval.ts`，**只读**）：查询串经 `embedTexts` 向量化 → 对 `kb_documents` 做**精确 cosine KNN**（复用 `semantic-search.ts` 的 `embedding <=> $q::vector`、`cosine_sim = 1 - distance`、`toPgVectorLiteral` 范式）→ 返回 top-k `{id(字符串), kb_title, summary_zh, entities, source_urls, event_date, long_term_value, cosine_sim}`。纯读、确定性（非 LLM）。
  - **检索域=事件**：`kb_documents` 是混表（`target_type` ∈ {`event`,`experience`}）；baseline 只检索 `target_type='event'`（经验卡检索延后）。
  - **tombstone 不可见（守既有不变量）**：`kb_documents` 无 `merged_into` 列，而事件可能在入库后被 14 天窗口语义合并塌缩（embed 回填有积压→可达）；检索必须加**事件域只读反连接**排除 `ai_news_events.merged_into IS NOT NULL` 的事件——对齐 `search_ai_events`（`search-events.ts:74`）对同一「tombstone 对所有下游消费者不可见」不变量的执行。
  - `embedding IS NULL` 行排除；`id` 为 `bigint` 须 `String(id)` 序列化（防 JSON 崩，仿 `store.ts:193`）；`topK` 带**上限**（Zod `.max`，防巨量 seq-scan）；低相似度**诚实带分返回不编造**。
- **测量 CLI**（新 `src/kb/search-cli.ts` + `package.json` 脚本，跑在 **worker 环境**、已有全 env/LLM 凭据）：`npm run kb:search -- "查询串"` 调 `searchKb` 打印带分 top-k，作 baseline 的**测量界面**。**不进 MCP 纯查询进程**——KB 语义检索需 embedding/LLM 凭据，而 MCP 查询进程故意只需 `DATABASE_URL`（`src/mcp/env.ts` 宽 env + 守护测试 `query-chain-env.test.ts`）；把检索塞进去会 top-level import `config/env` 崩掉整个 MCP server。故 MCP 暴露（`search_kb` 工具）**延到 A3 读服务**（那里正式设计读侧 env/拓扑）。
- **多跳缺口可观测**：每次检索经**结构化 stderr 日志**（`console.error`/可注入 `logError`，仿 `embedding.ts:107`）记录 query + top-k 文档 id/标题 + cosine 分分布 + 各命中文档 `entities` + 分项计数（returned/searchableTotal/null/tombstoneExcluded），供人工判「单跳 cosine 够不够、还是败在跨文档实体串联」。**人工判读**，不自建自动多跳检测器。**测量口径提醒（baseline 头号风险）**：低召回叠加**三混淆项**——摘要级 embedding（只嵌 `kb_title+summary_zh`、非全文，`kb/index.ts:237`）、NULL-embedding 覆盖缺口（bootstrap 不修 `kb_documents`）、tombstone 反连接排除——故解读**非对称**：只有「高 cosine + 召回到对的文档、但答案仍需跨文档实体串联」是干净的「**需 SAG**」正信号，**低召回不构成「单跳够用」的证据、绝不读成「不需 SAG」**（详见 design D5）。

## Capabilities

### 新增能力(New)
- `kb-retrieval`：知识库读侧语义检索原语——查询向量化 + `kb_documents` 事件域精确 cosine KNN（tombstone 只读反连接排除）+ 诚实带分 top-k + 多跳缺口可观测。纯读、确定性、复用现有 embedding 与 KNN 范式；经测量 CLI 暴露。

## 非目标(Non-Goals)

- **不建 SAG 结构化 KB**（`kb_events`/`kb_entities`/`kb_relations`/chunk 表、实体/关系抽取 agent）——**本变更存在的理由正是「先量再建」**：延到实测多跳瓶颈后再作独立提案（守 ROADMAP 定序）。
- **不做多跳 SQL 遍历**：baseline 是单跳 cosine。
- **不引 rerank**（`RERANK_MODEL`）：纯向量；延后。
- **不切 chunk / 不嵌全文正文**：检索既有的摘要级 embedding（`kb_title+summary_zh`），不重嵌全文（重嵌属独立成本决策、延后）。
- **不做对话式 RAG / LLM 生成答案 / 带引用作答**：那是 A3（读侧独立服务）；本变更只交检索原语 + CLI 测量。
- **不进 MCP 纯查询进程 / 不建 `search_kb` MCP 工具**：需 embedding 凭据、不属 MCP「纯查询只需 DATABASE_URL」边界；MCP 暴露延到 A3。
- **不建独立常驻读服务**：拓扑留给 A3。
- **不建 HNSW/ANN 索引**：当前精选小语料，精确 seq-scan cosine 即「最朴素 baseline」且无 ANN 召回损失；索引延到语料规模真需要（标 ceiling）。
- **不检索经验卡**（`target_type='experience'`）：baseline 只事件域；经验检索延后。
- **不回填缺失 embedding**：`kb_documents.embedding` 个别 embed 失败为 NULL 的行直接排除（既有 `EMBEDDING_BOOTSTRAP` 回填的是 `ai_news_events`、**不修 `kb_documents`**，KB 侧 embedding 修复属独立事项、非本变更）。
- **绝不写 KB / 改域事实**：只读，守读写分离（迁移边界：读侧不写域库）。
- **不改写侧**：`runKbIngestion`、`kb_documents`/`kb_ingestion_records` schema、准入闸 `KB_ADMISSION_FLOOR` 全部不动。

## Impact

- **新增代码**：`src/kb/retrieval.ts`（检索原语 + 可观测）、`src/kb/search-cli.ts`（测量 CLI）、`package.json` 加 `kb:search` 脚本。可能新增可选 env `KB_SEARCH_TOP_K`（默认 8，Zod `int().positive()`）+ `KB_SEARCH_TOP_K_MAX`（或直接 `.max(50)` 硬上限）。
- **复用不重建**：`embedTexts`(`src/dedup/embedding.ts`)、cosine KNN 原始 SQL 范式 + `toPgVectorLiteral`(`src/dedup/semantic-search.ts`)、`String(docId)` 序列化范式(`kb/store.ts:193`)。
- **不改**：`kb_documents`/`kb_ingestion_records` schema 与写侧；`ai_news_events`；去重链；日报/告警/周报车道；**MCP 查询进程（不加工具、不动其宽 env）**；Model Radar / web。**零 schema 迁移、零新基建、无新增运行时依赖**。
- **成本**：每次查询一次 `embedTexts`（查询串 embed）+ 一条 KNN SQL（带 tombstone 反连接）；无 LLM 生成。小语料精确 KNN 可接受。
- **测试**：cosine 排序正确性（构造已知 embedding 断言 top-k 顺序 + `topK` 截断 + tie 稳定）；**tombstone 事件被排除**（seed 一个 `merged_into` 非空的已入库事件、断言不出现在结果）；`embedding IS NULL` 行排除；`target_type='event'` 域限定（experience 行不返回）；空 KB / 空查询 / 低相似度诚实降级不报错；`String(id)` 可 JSON 序列化；**只读断言**（查询后 `kb_documents`/`kb_ingestion_records` 零变化）；守 `VITEST` 不真调 LLM embed（注入 `embedManyFn` 桩，memory `test-no-prod-sends`）。
- **部署**：CLI 跑 worker 环境（已有全 env）；MCP 进程不动；无破坏性迁移。
