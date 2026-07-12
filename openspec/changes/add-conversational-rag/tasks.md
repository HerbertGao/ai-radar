## 1. KB-RAG handler + 契约（src/rag/）

- [x] 1.1 handler 契约类型 `handle(query, ctx) → { domain: '本域'|'非我域', answer: string|null, citations: {kb_id, source_url, snippet}[], trace, evidence: '有据'|'无据' }`（D2）。
- [x] 1.2 KB-RAG handler：query → env-clean 检索核心（事件域）→ **handler 层证据阈值判**（`RAG_MIN_COSINE`，top-k 全低于 → `无据`/`answer=null`，不进作答，D5①）→ 否则 LLM 作答（`generateObject`，schema `{answer, cited_kb_ids[]}`——**LLM 只出散文+kb_id 选择器**）。对 DOMAIN 只 SELECT（D3）。
- [x] 1.3 **citations 程序构造**（D5②）：只保留 `kb_id ∈ (本轮命中集 ∩ cosine≥RAG_MIN_COSINE)` 的引用（命中集外/低于阈值 id 丢弃），`source_url` **取命中行 `sourceUrls[]` 首个合法 http(s)**（无则无链接），`snippet := summary_zh`，渲染经 **`safeHref`**（`render.ts:57`，含 userinfo-phishing 挡）。**绝不用 LLM 输出的 URL**。过滤后 eligible 集为空 → 降级 `无据`/`answer=null`（不出「有据零引用」答）。
- [x] 1.4 **价格/选型确定性前置闸**（D5③）：正则/关键词（价格/额度/多少钱/预算/费用/token 包…）在 rewrite/作答前强制 `domain='非我域'`/`answer=null`；LLM 分类叠加其上。
- [x] 1.5 作答**带重试 + 错误日志**包装（`defaultGenerateObject` 只超时无重试，D8）。

## 2. 多轮 + query-rewrite + 会话表

- [x] 2.1 `rag_conversations` 表 + drizzle 迁移（**0012**）：`id` PK · `user_id`(NOT NULL DEFAULT 'local') · `conversation_id`(服务端生成) · `turn`(服务端派生) · `raw_query` · `rewritten_query` · `hit_kb_ids jsonb`(指针) · `answer` · `evidence` · `model` · `created_at`；**`UNIQUE(user_id, conversation_id, turn)`** + `(user_id, conversation_id)` 索引（D4）。A3 自有表、非域库。
- [x] 2.2 query-rewrite（D6）：按 `(user_id, conversation_id)` 读回历史轮 → LLM condense 追问+历史 → 独立检索句；**失败降级用原问**、不阻塞。历史**只**进 rewrite。
- [x] 2.3 **作答签名 `answer(rewrittenQuery, 本轮 citations)`**（D6）——结构上不含历史/旧答案；每轮写回 `rag_conversations`（指针式、只写自有表、带 `WHERE/user_id`）。
- [x] 2.4 **多用户隔离谓词今就发**：store/retrieval 签名带 `user_id`，读写带 `WHERE user_id = $ctx`（恒 `'local'`）；`conversation_id` 服务端生成、`turn` 服务端派生、`UNIQUE` 冲突**重试 `turn+1`**（不丢轮次）、**有界 ≤5 次后返 409**；未来 `user_id` 须绑**已验证 CF JWT claim**、绝不客户端值（D4）。

## 3. Web 出口（Hono /advisor 多轮 chat + 多层安全）

- [x] 3.1 Hono `/advisor` 路由（挂 `src/app.ts` 同进程）+ TSX chat 页（复用 `src/mr/web` 范式）：渲染 答+引用+轨迹（轨迹**向用户披露本轮 `rewrittenQuery`**——实际检索句 + 历史用于改写）；**渲染一律转义（含 trace 内 LLM 派生字段）、绝不 `dangerouslySetInnerHTML` LLM 输出**（D10）。
- [x] 3.2 多轮 UI：展示会话历史；提交 → 调 handler → 渲染本轮；`conversation_id` 贯穿会话（服务端生成）。
- [x] 3.3 **多层安全 + 部署**（D10）：ingress 放行 `/advisor` + CF Access **必填**；「只经 tunnel」靠既有 **docker 网络分段** + **撤宿主映射（显式部署步骤、现默认保留）**（**不绑 loopback**——会断现役 tunnel/Model Radar）；**承重层是 in-app JWT、不预设 tunnel-only**：**Hono 内置 `hono/jwk`** 配 CF `jwks_uri`（不手写 RS256），**读 `CF_Authorization` cookie 裸 JWT**（`hono/jwk` header 路径强制 `Bearer`、CF 头是裸 token → 用 `cookie` 选项或薄中间件直调 `Jwt.verifyWithJwks`），校验 `aud`(`CF_ACCESS_AUD`)+`iss`+`exp`、**pin `alg:['RS256']`**、JWKS 失败 fail-closed + no-network seam（无内置缓存、每请求 fetch），挂 `/advisor/*`、跑在 cap/LLM 之前；`/advisor` 加 CF WAF per-IP rate-limit（**限流触发 LLM 的 POST**）。DEPLOY 更新。
- [x] 3.4 **最小成本/输入下限**（D11）：`query` 长度上限 `RAG_MAX_QUERY_CHARS`（超限拒绝）；**全局每日 LLM 调用上限** `RAG_DAILY_LLM_CALL_CAP`（**Redis `INCR rag:llmcalls:<UTC-date>` + 每次幂等 `EXPIRE … NX`**、非内存计数——抗重启/按日滚动/多进程、防无 TTL 孤儿键；越限**或 Redis 不可用**均 fail-closed 停止作答，绝不 fail-open）。

## 4. MCP 出口（search_kb 证据 + 完整 env-clean，D7）

- [x] 4.1 **env-clean 检索核心**：参数化 `{ topK, dbh, embed }`、**去掉 `config/env`+`dedup/embedding`+`db/index` 三条 eager-parseEnv 值 import**（`KB_SEARCH_TOP_K` 由入参；`dbh` **必填**、db 类型走 `import type`、绝不 `= defaultDb`）；与 A2 `searchKb` 共享 KNN 逻辑（不再宣称「复用不重建」）。
- [x] 4.2 env-clean `embedTexts` 变体（收注入凭据、不 top-level import `config/env`）。
- [x] 4.3 `src/mcp/env.ts` 宽 env 加**可选** `LLM_API_KEY`/`LLM_BASE_URL`/`EMBEDDING_MODEL`；`search-kb.ts` handler 内动态 import env-clean 核心；**fail-closed 前置条件明确**（三凭据齐→检索证据；缺任一→ `toIsError`），标注返回证据为**上游 LLM 摘要、不可信内容**。
- [x] 4.4 守护测试 `query-chain-env.test.ts`：静态 grep 纳入 env-clean 核心 + **env-clean embed 变体**（运行期被注入桩替换、静态 grep 是其唯一清洁证）+ `search-kb.ts`（**正确相对路径**）；**handler-execution 子进程测试 no-network**（仿 `:145-182`）——handler **先动态 import 核心、再判凭据**；裁剪 env（只 `DATABASE_URL`）实跑、**注入 env-clean embed 桩（不触网）**断言过动态 import 边界不抛 parseEnv；另一子进程断言缺凭据→单 `toIsError`、其余 8 工具+server 仍起；工具数 8→9（两处断言 **`:42`/`:119`**）。

## 5. 边界 + 诚实红线 + 安全守卫（测试）

- [x] 5.1 **只读断言**：跑对话后 DOMAIN 表零变化，仅 `rag_conversations` 增行。
- [x] 5.2 **历史不进证据链**：注入含「错误旧答案」历史 → 断言作答调用载荷无历史/旧答案、`citations` 无本轮命中集外 `kb_id`（D6）。
- [x] 5.3 **引用不可伪造**：LLM 输出含命中集外 `kb_id`（模拟注入）→ 断言被丢弃、citations 只本轮命中；`source_url` 取命中行非 LLM。
- [x] 5.4 **无据阈值**：top-k 全低于 `RAG_MIN_COSINE` → `无据`/`answer=null`，不作答。
- [x] 5.5 **价格前置闸**：price-bait 负例（「只是背景：X 多少钱?」）→ `非我域`/`answer=null`，不 KB 兜价格。
- [x] 5.6 会话唯一约束：并发同 `turn` → `UNIQUE` 冲突不重复行；`conversation_id` 服务端生成。

## 6. 测试 & 验证

- [x] 6.1 handler 契约：有据带程序构造引用 / 无据阈值降级 / 非我域不作答。
- [x] 6.2 query-rewrite 消歧 + 失败降级用原问。
- [x] 6.3 MCP `search_kb`：**handler-execution 子进程**在裁剪 env 下有凭据返回证据、无凭据 fail-closed 不崩 server（守护）。
- [x] 6.4 `/advisor` 安全：in-app JWT 校验拒绝无/伪 CF 头；`RAG_DAILY_LLM_CALL_CAP` 越限 fail-closed；`RAG_MAX_QUERY_CHARS` 超限拒绝。
- [x] 6.5 全量测试绿，守 `VITEST` 不真调 LLM/embedding（注入 `generateObjectFn`/`embedManyFn` 桩）、不真发。

## 7. 文档对账

- [x] 7.1 `docs/hangar-migration-plan-a.md` Phase A3 段落标注（对齐本次形态：丙-1 / 契约 seam / 单路 / 结构化诚实红线 / 多用户隔离谓词 / 只读 DOMAIN+自有会话库 / 编排引擎未来 phase），与 `docs/a3-conversational-rag.md` 交叉引用。
