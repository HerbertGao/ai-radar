## Why

Plan A Phase A3（定位见 `docs/a3-conversational-rag.md` + `docs/hangar-migration-plan-a.md`）。重心迁向「持续 KB + 对话 RAG」的读侧抓手：让「去问它」成立——问一句、得到**有 KB 依据、带引用**的答案（出口闸 = 你日常开始去问它，比翻日报更快解决「这是什么/发生了什么」）。A2 刚 ship 单跳 `searchKb`（KB 检索 baseline），A3 是它之上的**对话面**。

**定性（重要）：A3 是「先踩坑的第一版」**，不是取舍后的精简产品——刻意把**会话存档 / 多轮 / 多用户 seam / 历史即信号**这些坑先踩出来，为将来产品级化少踩坑；RAG 内核的深度优化（历史喂多少、成本上限、检索栈是否换更专业 RAG）留给未来专业化迭代。

## What Changes

- **KB-RAG handler**（新 `src/rag/`，实现 **handler 契约** `{ domain: '本域'|'非我域', answer: string|null, citations, trace, evidence: '有据'|'无据' }` = 未来编排引擎 seam；`domain`/`evidence` 两轴分开，真值表见 design）：query → 价格前置闸 →（多轮）**query-rewrite** 消歧 → env-clean 检索核心（事件域）→ handler 证据阈值判 → **OpenRouter LLM `generateObject`** grounded 作答（LLM 只出散文+kb_id 选择器）。对 DOMAIN 只读。
- **Web 出口（本期重心，演示脸）**：`/advisor` 多轮 chat 页，挂现有 Hono app（`src/app.ts`，与 Model Radar web 同进程，复用 `src/mr/web` 的 TSX/SSR 渲染范式）；渲染 答 + 引用 + 检索轨迹；本地建 + **Cloudflare Tunnel** 暴露 + **CF Access** 边缘鉴权。
- **服务端会话存档**：新 `rag_conversations` 表（A3 **自有状态**、读+写；**指针式** schema：命中存 `kb_id` 不存 KB 拷贝；带 `user_id` 列 **预留多用户 seam**）。
- **MCP 出口（自用）**：`search_kb` 工具暴露 `searchKb` **证据**（Claude 自己作答/路由/存档）——接上 A2「延到 A3」那块，须解 A2 评审记下的 MCP-env 崩溃（纯查询进程只需 `DATABASE_URL`）：**env-clean 检索核心**（`searchKb` 参数化 `{topK,dbh,embed}`、**去掉 `config/env`+`dedup/embedding`+`db/index` 三条值 import**——注意 `searchKb` 自己就 top-level import `config/env`+`db/index`，只 env-clean `embedTexts` 不够）+ mcp 宽 env 可选凭据 + handler 动态 import + 缺凭据 **fail-closed** + **handler-execution 子进程守护测试**（仿 `query-chain-env.test.ts:145-182`，实跑而非仅装载）。
- **诚实红线——结构化强制（非提示口头）**：① **`citations` 由 handler 从本轮 `searchKb` 命中程序构造**（LLM 只出散文+kb_id 选择器、命中集外 id 丢弃、`source_url` 取命中行非 LLM、渲染校验 http(s) scheme）→ 注入无法伪造引用/钓鱼/XSS；② **证据阈值** `RAG_MIN_COSINE` 由 handler 判「无据」（`searchKb` 无相似度下界，低相似→无据须在 handler 加）；③ **价格/选型确定性前置闸**强制 `domain='非我域'`（不靠 LLM 分类）；④ **作答签名 `answer(rewrittenQuery, 本轮citations)`** 结构上不含历史。
- **Web 公开面安全 + 最小下限**：`/advisor` ingress 显式放行 + CF Access **必填** + **in-app JWT 校验**（Hono 内置 `hono/jwk`、读 `CF_Authorization` cookie 裸 JWT、pin RS256、JWKS fail-closed；**in-app JWT 为直连兜底承重层、不预设 tunnel-only**；「只经 tunnel」靠 docker 网络分段 + 撤宿主映射的显式部署步骤）；渲染转义不 `dangerouslySetInnerHTML`；`RAG_MAX_QUERY_CHARS` 输入上限 + `RAG_DAILY_LLM_CALL_CAP` 每日调用上限 fail-closed（最小成本地板、非延后的专业成本栈）。

## Capabilities

### 新增能力(New)
- `conversational-rag`：KB 之上的对话 RAG 面——KB-RAG handler（契约、grounded 作答、诚实降级）+ Web 多轮出口（会话存档、带引用作答）+ 只读 DOMAIN / 自有会话状态边界。

### 修改能力(Modified)
- `mcp-query`：新增 `search_kb` 证据工具，并为**需 embedding 凭据的查询工具**引入「宽 env 加可选 LLM 凭据 + env-clean embedTexts 变体 + fail-closed」范式（守既有「纯查询只需 `DATABASE_URL`」不变量：无凭据时该工具 fail-closed，绝不崩整个 MCP server）。

## 非目标(Non-Goals)

- **不建编排引擎**（组合 A3-KB-RAG / Model-Radar-选型 / get-today 的意图路由总入口）——A3 单路，引擎是**未来独立 phase**，站在 handler 契约上做；A3 只把契约铺好。
- **不做 SAG 多跳**（A2b，gated 在实测）、**不检索经验卡**（`ai_experiences`，另一路）、**不换更专业 RAG 栈**（本期单跳 `searchKb`）。
- **不做多用户身份逻辑**：本期单用户；`user_id` 列 + per-user 检索口径**只留 seam**，未来接 CF Access 身份 + per-user 隔离 RAG。
- **不做流式作答**（`streamText` 未导出 + 无 VITEST 守卫会破「测试不触网」）：本期 `generateObject` only，流式延到独立提案。
- **不定「历史喂多少上下文」+ 不建专业成本模型**：等更专业 RAG 化时定（可能换栈）；本期只加**最小成本/输入下限**（query 长度上限 + 每日调用上限），不做 per-user 成本栈。
- **不做选型/价格作答**：Model Radar recommender 专管精确事实；A3 单路只答「是什么/背景」，选型 handoff 是未来引擎的事。
- **绝不写任何域库**（KB/`ai_news_events`/`mr_*`/`ai_products`）——A3 对 DOMAIN 只读、只读+写自己的 `rag_conversations`。
- **不建独立进程**（挂现有 Hono app）；**历史绝不进证据链**（只作信号）。

## Impact

- **新增代码**：`src/rag/`（KB-RAG handler + query-rewrite + 程序构造引用 + 阈值/前置闸/重试）、Hono `/advisor` 路由 + TSX chat 页 + in-app CF JWT 中间件、`rag_conversations` 表 + drizzle 迁移（**0012**，带 `UNIQUE(user_id,conversation_id,turn)`）、`src/mcp/tools/search-kb.ts` + env-clean 检索核心 + mcp 宽 env 可选凭据。新增 env：`RAG_MIN_COSINE` / `RAG_MAX_QUERY_CHARS` / `RAG_DAILY_LLM_CALL_CAP` / `CF_ACCESS_AUD`（+ CF team `jwks_uri` 部署项）。
- **复用不重建**：`searchKb`（A2）、`llm-client`(`buildModel` OpenRouter)、`src/mr/web` 渲染范式、`src/mcp/tools/search-events.ts` 工具范式 + `recommend-coding` 的 fail-closed 凭据范式、`String(id)` 序列化。
- **不改**：KB 写侧 / `kb_documents` schema / `ai_news_events` / Model Radar recommender 与 `mr_*` / 去重链 / daily/alert/weekly 车道。
- **成本**：每轮 1–2 次 OpenRouter 调用（query-rewrite + 作答）；CF Access 把「谁能问」收口（成本天然收敛到已鉴权用户）；会话表随用量增长（指针式、不存 KB 拷贝）。
- **测试**：handler 契约（有据带引用 / 无据诚实降级 / 历史不进证据链）；只读断言（跑对话后 DOMAIN 表零变化，仅 `rag_conversations` 增行）；query-rewrite 消歧；MCP `search_kb` 在**无 LLM 凭据**下 fail-closed 不崩 server（守护测试）；守 `VITEST` 不真调 LLM/embedding（注入桩）。
- **部署**：Web 随现有 Hono 进程；CF Tunnel + CF Access（参考 hangar 前端 / Model Radar web 的 Cloudflare 路径）；`rag_conversations` 迁移。
