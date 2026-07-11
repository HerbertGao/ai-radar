## Context

Plan A Phase A2（见 `docs/hangar-migration-plan-a.md` + memory `hangar-migration-positioning`）。两份权威文档定序冲突已在提案 Why 记录并抉择：采纳 `ROADMAP.md`「RAG 检索路径选型」的 **baseline-先行**（先朴素 pgvector 余弦检索 → 量多跳瓶颈 → 真有据再引 SAG），不采 plan-a A2 的「现在就建 SAG 结构化 KB」。

**现状（代码核实）：** `src/kb` 纯写侧。`runKbIngestion`（`src/kb/index.ts:180`，日报 Stage 7、push 成功后、never-throw）把 `long_term_value >= KB_ADMISSION_FLOOR(70)` 精选事件经 `storeKbDocument` 原子写 `kb_documents`（`schema.ts:279`）+ 幂等账本 `kb_ingestion_records`。关键事实：(a) `kb_documents.embedding` 只嵌 `kb_title + "\n" + summary_zh`（`kb/index.ts:237`，**摘要级、非全文**），embed 失败留 NULL；(b) `kb_documents` 是**混表**，`runExperienceKbIngestion`（`experience-chain.ts:23`）也写 `target_type='experience'` 行；(c) `kb_documents` **无 `merged_into` 列**，但事件可在入库后被语义合并塌缩（survivor=较早 `first_seen_at`，`merge-events.ts:8`；14 天窗口 + 500/run embed 上限 `env.ts:439` 造回填积压 → 某较早事件晚于某已入库较新事件被处理并把后者塌缩 → 后者 tombstone 但其 `kb_documents` 行仍在）。**全仓无读 `kb_documents` 的检索**（grep 核实）；`embedTexts`（`dedup/embedding.ts:98`）用 `env.EMBEDDING_MODEL`；cosine KNN 范式在 `semantic-search.ts`。MCP 查询进程用**宽 env**（`src/mcp/env.ts` 只 `DATABASE_URL` 必填），工具禁 top-level import `config/env`（守护测试 `query-chain-env.test.ts`）。

## Goals / Non-Goals

**Goals:** 交一个只读、事件域、tombstone 安全的 KB 语义检索原语（查询 embed → `kb_documents` cosine KNN → 诚实带分 top-k）+ 一个 worker 环境跑的测量 CLI + 多跳缺口可观测，供实测「单跳够不够、要不要建 SAG」。

**Non-Goals:** 见提案「非目标」。核心：不建 SAG 结构化表/抽取/多跳/rerank/chunk/全文重嵌；不做对话 RAG（A3）；**不进 MCP 纯查询进程**；不建独立读服务/ANN 索引；不检索经验卡；不回填 embedding；**绝不写域库**。

## Decisions

**D1. 采纳 ROADMAP baseline-先行定序，不建 SAG（先量再建）。** 抉择理由：(a) 延后不浪费——baseline 检索函数是 SAG 读路径**第一跳**、被扩展不被推翻；源数据留、将来建结构化是**一次便宜回填**（仓已有 `src/kb/backfill.ts` 范式 + 小语料）。(b) 现在盲建 SAG 坏处实：多半猜错 entity/relation schema 照样迁；每日每条多跑抽取 LLM（KB 入库现无 per-run 上限）持续烧、无读侧验证；未用 schema 死重；抽取会漂。(c) 测量非干等——产出「哪些查询败在多跳」是把 SAG 一次建对的输入。

**D2. 检索原语只读 + 复用 `semantic-search.ts` KNN 范式。** `src/kb/retrieval.ts` 的 `searchKb(query, opts, dbh=defaultDb)`：`embedTexts([query])` → 参数化原始 SQL（见 D8 完整谓词）→ 返回 `{id: String, kbTitle, summaryZh, entities, sourceUrls, eventDate, longTermValue, cosineSim}[]`。确定性、非 LLM。`ORDER BY embedding <=> $q, id`（加 `id` 次序键，消 cosine 并列时的任意序、结果稳定）。`id` 为 `bigserial(bigint)` → **`String(id)`** 供 JSON 序列化（仿 `store.ts:193`，防 `bigint` JSON 崩）。

**D3. 精确 seq-scan KNN，不建 HNSW/ANN 索引（小语料）。** ≥70 精选、每日涓流（低千行），精确 seq-scan cosine 即「最朴素 baseline」且无 ANN 召回损失。ponytail: 不加 HNSW（`schema.ts:277` 已 defer）；升级路径=行数越阈值加 `USING hnsw (embedding vector_cosine_ops)` 迁移，检索 SQL 不变。`topK` 缺省 `KB_SEARCH_TOP_K`（默认 8），**在 `searchKb` 原语内双向归一化**（`Math.max(1, Math.min(Math.trunc(topK), 50))`，**非仅 CLI 参数层**——防 A3/绕过 Zod 的直调复用）：上限 50 防全表输出；下限 1 + `trunc` 防直调方传 `0`（`LIMIT 0` 静默空）/ 负数（`LIMIT -1` Postgres 报错）/ 小数（非整 `LIMIT` 强转错）。越界归一不抛、记一条日志（测量工具友好；语义=永远合法 `[1,50]` 整数 LIMIT）。

**D4. 测量界面=worker 环境的 CLI，不进 MCP 纯查询进程。** `src/kb/search-cli.ts`（`package.json` 加 `kb:search`）跑在 worker 环境（已有 `LLM_API_KEY`/`EMBEDDING_MODEL` 全 env），调 `searchKb` 打印带分 top-k。**为何不做 MCP `search_kb` 工具（评审否掉）：** MCP 查询进程故意只需 `DATABASE_URL`（宽 env `src/mcp/env.ts`、守护测试 `query-chain-env.test.ts` 断言 8 工具仅 `DATABASE_URL` 启动）；而 `searchKb→embedTexts→config/env.ts` 会在 import 期跑全 `parseEnv`（需 LLM/REDIS/TELEGRAM/PH 凭据）→ 工具 barrel 静态 import 会**崩掉整个 MCP server**。KB 语义检索需 embedding 凭据、不属纯查询边界。故 MCP 暴露延到 **A3 读服务**（正式设计读侧 env/拓扑）。CLI 是测量所需的最小界面，非一次性废件（A3 复用 `searchKb`）。

**D5. P0…（多跳缺口）可观测：结构化 stderr 日志 + 人工判读，不建自动多跳检测器。** 每次 `searchKb` 经 `console.error`/可注入 `logError`（仿 `embedding.ts:107`/`store.ts:153`）记录 `{query, results:[{docId, kbTitle, cosineSim, entities}], scoreStats:{max,min,mean}}`。**必走 stderr**（即便 CLI 无 stdio-JSON-RPC 约束，也守本仓「日志走 stderr」约定；且若 A3 后续把它移进 MCP，stdout 是 JSON-RPC 专用不可污染）。**绝不落表**（落表=写，破只读边界；持久化观测若真需要另提独立提案）。人工据记录判「单跳够不够/败多跳否」，不自建自动判定（反向复杂度）。**判读须扣除三个压低召回的混淆项**（缺一都会误读）：① **摘要级 embedding**（只嵌标题+摘要非正文，现状 a）；② **NULL-embedding 覆盖缺口**（embed 失败行不可检索，且既有 bootstrap 不修 `kb_documents`）；③ **tombstone 反连接排除**（D8 正确排除「入库后被塌缩、survivor 未入 KB」的内容，正确但压召回）。
- **故测量解读非对称（必守规则）**：**高 cosine + 召回到对的文档、但答案仍需跨文档实体串联** → 干净的「**需 SAG**」正信号；而**低召回不构成「单跳够用」的证据**（可能是上面任一混淆项）→ 结论**不确定**。**绝不可把一次弱召回读成「不需 SAG」。** 只有正信号可下结论、负信号存疑——这是 baseline 能与不能回答的边界。
- 可观测计数分两类：`returned`（本次结果数，query 相关、免费=结果长度）记在 `searchKb` 每次调用；而**语料级覆盖计数** `searchableTotal`（有 embedding 的事件行）/ `null`（无 embedding）/ `tombstoneExcluded`（被反连接排除）是 **query 无关的语料常量**（同一入库态下每查都一样、且各需一次额外聚合扫描），故**由测量 CLI 每次运行只算一次**——**不放进 `searchKb` 每查热路径**（保原语=单条 KNN，防 A3 复用时每查多一次全表 COUNT）。四项一起使三项混淆项可见可量、避免被误当「检索弱」。

**D6. 只读、绝不写域库（守读写分离迁移边界）。** `searchKb` 与 CLI 对 Postgres **只 SELECT**；无 INSERT/UPDATE/DELETE（`embedTexts` 调 embedding API 是外部读、非域库写）。以代码审计 + 测试断言（查询后 `kb_documents`/`kb_ingestion_records` 零变化）守住。

**D7. 查询与文档同 embedding 模型，复用 `env.EMBEDDING_MODEL`（cosine 可比不变量）。** cosine 只在同一向量空间有意义。CLI 跑 worker 环境、与入库同 `env.EMBEDDING_MODEL` → 天然一致。维度硬钉 1536。**残留风险（披露、不在此闸）：** 换到**另一个 1536 维模型**不报错、无 per-row 模型标签或启动守卫 → 混空间 cosine 静默失真；**跨时间**改 `EMBEDDING_MODEL`（旧行按旧模型嵌、新查询按新模型）亦然。属既有约束（换模型=forward-only 迁移 + 重嵌），本变更只在 Risks 披露 + 建议将来记录入库模型名比对，不在 baseline 建守卫。

**D8. tombstone 事件域只读反连接（守「tombstone 对所有下游消费者不可见」）。** `kb_documents` 无 `merged_into`，事件入库后可被塌缩（现状 c，经 embed 积压可达）。检索 SQL 谓词：
```
WHERE k.target_type = 'event'                                  -- D9 事件域
  AND k.embedding IS NOT NULL                                  -- 排除不可检索
  AND NOT EXISTS (SELECT 1 FROM ai_news_events e
                  WHERE e.event_id = k.target_id
                    AND e.merged_into IS NOT NULL)             -- tombstone 反连接（只读）
ORDER BY k.embedding <=> $q, k.id LIMIT $k
```
对齐 `search_ai_events`（`src/mcp/tools/search-events.ts:76` 的 `isNull(mergedInto)`；`event_id` 为 PK，故 `NOT EXISTS(merged_into IS NOT NULL)` ⟺ `merged_into IS NULL`，精确等价）。只读、无 schema 改。**反连接是事件域限定的**（`ai_experiences` 无 tombstone 概念，若不限定会错删经验行——但 baseline 本就只事件域，见 D9）。**include-on-missing 为有意安全缺省**：某 `kb_documents` 事件行若无对应 `ai_news_events` 行（正常不会发生——`merge-events.ts` 只置 `merged_into`、不硬删被吸收行），`NOT EXISTS` 为真 → 该行仍返回（「非 tombstone 即可检索」，绝不因缺行误删）。

**D9. 检索域=`target_type='event'`（经验卡延后）。** `kb_documents` 混表（事件 + 经验卡）。baseline 只检索事件：(a) 使 tombstone 反连接口径干净（经验无 tombstone）；(b) 多跳测量的核心语料是事件/实体链；(c) 最小。经验卡检索（无 tombstone、字段不同）延后作独立小提案。

## Risks / Trade-offs

- **[个别 kb_documents.embedding 为 NULL 不可检索]** → 入库 embed 失败留 NULL（`kb/index.ts` 非阻塞降级）。以 `embedding IS NOT NULL` 排除。**诚实口径**：既有 `EMBEDDING_BOOTSTRAP_MAX_PER_RUN` 回填的是 `ai_news_events`、**不修 `kb_documents`**，故这些行「入库但暂不可检索」是真限制；可观测记录 total/searchable/null 计数体现覆盖面；KB 侧 embedding 修复属独立事项、不在本变更。
- **[测量可被误读成「不需 SAG」——baseline 的头号风险]** → 低召回叠加**三个压低召回的混淆项**：摘要级 embedding（只嵌标题+摘要）、NULL-embedding 覆盖缺口（bootstrap 不修 kb_documents）、tombstone 反连接排除（D8）。故解读**非对称**：只有「高 cosine+召回对+答案仍需跨文档串联」是干净的「需 SAG」正信号，**低召回不构成「单跳够用」的证据**。对策=D5 的解读规则 + 可观测分项计数（returned/searchableTotal/null/tombstoneExcluded）使混淆可见；**绝不把弱召回读成「不需 SAG」**。这直接关系 baseline 的唯一目的（决定要不要建 SAG），故列为头号风险。
- **[换 embedding 模型静默失真]** → 见 D7：同维不同模型 / 跨时间换模型无守卫。披露为已知约束，不在 baseline 加守卫（换模型本就需重嵌迁移）。
- **[tombstone 事件被检索]** → D8 事件域只读反连接排除，已闸 + 测试断言。
- **[MCP 只读工具误暴露 / 崩进程]** → 不做 MCP 工具（D4）；CLI 跑 worker 环境，零 MCP 面。
- **[精确 KNN 随语料增长变慢]** → D3 ceiling：越阈值加 HNSW 迁移，SQL 不变。

## Migration Plan

- 普通 PR（实现代码）。零 schema 迁移、零新基建、无新增运行时依赖。
- 回滚 = 撤 PR（纯新增只读函数 + CLI 脚本，无状态变更、无破坏面）。
- 部署：CLI 随 worker 镜像已有 env；MCP 进程不动。

## Open Questions

- **`kb:search` 是否需可选 `topK` 之外的过滤（如 `event_date` 窗口 / 最低 cosine 阈值）？** 倾向 baseline 只 `query`+`topK`（最朴素），过滤延到测量显示需要；实现期定。
- **（已定，round-3 评审）覆盖计数粒度**：`returned` 每查一行（免费）；`searchableTotal`/`null`/`tombstoneExcluded` 语料级、由 CLI 每次运行算一次（非每查），保 `searchKb` 原语=单条 KNN、A3 复用无隐藏每查全表 COUNT。
