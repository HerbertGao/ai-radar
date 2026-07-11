## 1. KB 检索原语（只读、事件域、tombstone 安全）

- [x] 1.1 `src/kb/retrieval.ts` 新增 `searchKb(query, opts, dbh=defaultDb)`：`embedTexts([query])`（复用 `env.EMBEDDING_MODEL`，守 D7）→ 参数化原始 SQL 对 `kb_documents` 做精确 cosine KNN（`1 - (k.embedding <=> $q::vector) AS cosine_sim`，复用 `toPgVectorLiteral`/`<=>` 范式），谓词与取序按 **D8**：`WHERE k.target_type='event' AND k.embedding IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_news_events e WHERE e.event_id=k.target_id AND e.merged_into IS NOT NULL) ORDER BY k.embedding <=> $q, k.id LIMIT $k`。**只 SELECT、绝不写**（守 D6）。
- [x] 1.2 返回行映射：`id` 经 **`String(id)`**（`bigint`→string，防 JSON 崩，仿 `store.ts:193`）；返回 `{id, kbTitle, summaryZh, entities, sourceUrls, eventDate, longTermValue, cosineSim}`。
- [x] 1.3 `topK` 缺省取 `env.KB_SEARCH_TOP_K`（新可选 env，默认 8，Zod `int().positive()`），**在 `searchKb` 原语内双向归一化** `Math.max(1, Math.min(Math.trunc(topK), 50))`（**非仅 CLI 参数层**——防 A3/绕 Zod 直调；下限 1+trunc 防 0/负/小数致 `LIMIT 0`/负/非整错，上限 50 防全表；越界归一不抛、记一条日志）；查询串经 **`.trim().length===0`** 判定为空 → 在 `searchKb` 内短路直接返回空数组、**不调 embed**（不依赖 `embedTexts` 兜底：它只挡空数组、不挡纯空白，纯空白会嵌成退化向量）；空 KB / 全 NULL embedding → 空数组、不报错。

## 2. 多跳缺口可观测（stderr、只读、含混淆项提醒）

- [x] 2.1 `searchKb` 每次调用经 `console.error`/可注入 `logError`（仿 `embedding.ts:107`，**必走 stderr**、绝不 stdout、绝不落表）逐查记录 `{query, results:[{docId, kbTitle, cosineSim, entities}], scoreStats:{max,min,mean}, returned}`——**只逐查免费字段，不含语料级 COUNT**（保 `searchKb` 原语=单条 KNN、A3 复用无每查全表 COUNT）；语料级覆盖计数移到 CLI（见 3.1）。纯旁路——不改返回、不阻塞、非 LLM 判质量。CLI 输出/文档注明**解读非对称规则**（D5）：召回受三混淆项（摘要级 embedding / NULL-embedding 缺口 / tombstone 排除）约束，只有正信号（高 cosine+召回对+答案仍需跨文档串联）可下「需 SAG」结论，**低召回不构成「单跳够用」、绝不读成「不需 SAG」**。

## 3. 测量 CLI（worker 环境）

- [x] 3.1 `src/kb/search-cli.ts`：读 `argv` 查询串（+ 可选 `topK`），调 `searchKb`，把带分 top-k 打印（stdout 结果、stderr 观测）。跑在 worker 环境（可正常 import `config/env`，已有 LLM/embedding 凭据）。**每次运行只算一次语料级覆盖计数** `searchableTotal`/`null`/`tombstoneExcluded`（3 条只读事件域 COUNT）经 stderr 记一次（非每查，D5）——供人工按解读非对称规则扣除三混淆项。
- [x] 3.2 `package.json` 加脚本 `"kb:search": "tsx src/kb/search-cli.ts"`（或与现有脚本风格一致的 runner）；用法 `npm run kb:search -- "查询串"`。**不注册任何 MCP 工具、不动 `src/mcp/*`**（守 D4）。

## 4. 只读守卫（守读写分离迁移边界）

- [x] 4.1 代码审计确认 `searchKb` 与 CLI 全程只 SELECT；测试断言跑查询后 `kb_documents` / `kb_ingestion_records` 行数与内容零变化（无 INSERT/UPDATE/DELETE）。

## 5. 测试 & 验证

- [x] 5.1 检索排序正确性（**真集成 Postgres**）：seed 若干 `target_type='event'` `kb_documents` 带**已知 embedding 向量**（与查询向量夹角可控），断言 `searchKb` 按 `cosine_sim` 降序、`topK` 截断正确、cosine 并列时 `id` 次序稳定；`embedding IS NULL` 行被排除。
- [x] 5.2 **tombstone 事件排除**：seed 一个已入库事件其 `ai_news_events.merged_into` 非空（模拟入库后被塌缩），断言 `searchKb` **不返回**它（守 D8 / 不变量「tombstone 对下游不可见」）；`merged_into IS NULL` 的正常事件照常返回。
- [x] 5.3 **事件域限定**：seed 一条 `target_type='experience'` `kb_documents` 行，断言 `searchKb` 不返回它（守 D9）。
- [x] 5.4 诚实降级 & 序列化：空 KB → 空数组；查询串空白 → 空数组且不调 embed；低相似度仍带分返回不编造、不报错；返回行 `id` 为 string、结果可 `JSON.stringify` 不抛（`bigint` 崩回归）。
- [x] 5.5 `topK` 上限：传入 > 50 的 topK 被 `searchKb` 原语钳制到 50（`Math.min`，不抛、返回 ≤50 行），断言钳制在原语层生效（不靠 CLI 参数校验）。
- [x] 5.6 全量测试绿，守 `VITEST` 不真发飞书/Telegram、不真调 LLM embed（注入 `embedManyFn` 桩，`embedTexts` 有 VITEST 守卫，memory `test-no-prod-sends`）。

## 6. 文档对账

- [x] 6.1 `docs/hangar-migration-plan-a.md` Phase A2 段落标注：已按 `ROADMAP.md`「RAG 检索路径选型」定序改为「检索 baseline 先行、SAG 结构化延后（本变更 add-kb-retrieval-baseline）」，SAG 结构化写侧延到实测多跳瓶颈后再作独立提案——消除两文档定序冲突。
