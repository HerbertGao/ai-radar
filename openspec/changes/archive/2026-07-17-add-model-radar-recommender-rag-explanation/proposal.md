## Why

推荐器（5e，即 Model Radar 推荐器）的解释层 v1 是纯模板：固定话术填候选事实与规则原因，`query`/`evidence` 被显式忽略——用户问「重度 Claude Code + GLM-4.6 选谁」时，答案的**结论与数字**可靠（规则 + DB 事实），但**解释**讲不出「为什么此刻值得信 / 最近发生了什么」：套餐上周刚降价（`mr_price_history` append-only 历史）、厂商额度口径刚被标待复核（`reviewStatus.pending`）、KB 里有一篇该套餐的实测精选（`long_term_value≥70`）——证据都在库里，却没有任何一条路把它们送进解释。5e v1 交付时已为此留好缝：`ExplanationInput { query, candidates, evidence?: unknown }`、「v1 接口 = v2 接口，杜绝换层重构」（`model-radar-recommender` 规范逐字）。本变更即兑现该缝：**召回与候选 schema 一行不动，只换解释层**。

## What Changes

- **证据装配层（新增，纯读）**：对已排序的 `RankedCandidate[]` 组装类型化 `evidence`——
  - **KB 证据**：复用既有 env-clean 检索核心 `searchKbCore`（`src/kb/retrieval-core.ts`）按候选厂商/套餐名检索精选 KB 文档，命中按装配层余弦地板过滤；
  - **变更流证据**：候选套餐近 30 天的 `mr_price_history` 价格变更行（直接 SQL 读事实表）+ 待复核标（从 `candidates[].reasons` 派生、零 SQL——与 verdict 判定同源）；
  - 装配任一子源失败 ⇒ 该子源为空、继续；三源全空 ⇒ 跳过 LLM（装配层绝不阻塞推荐）。
- **LLM 解释渲染器（新增）**：经**同一** `Explainer` 接口消费 `evidence`。红线③落地为**产出权结构**：权威结论由程序侧（guidance + 模板段构成的确定性前缀）独家承载，叙述段数字来源封闭（守卫白名单）——LLM 只叙述「最近发生了什么」，引用 KB 证据时以编号（引用可选），KB 标题/URL 的参考清单由代码机械拼接；prompt 素材经净化与长度封顶。
- **机械守卫（新增，确定性）**：LLM 叙述段落地前过三道**程序**守卫——①叙述段数字必须 ∈ 白名单（统一提取管线 + 数值比对；白名单 = 全部入 prompt 素材文本的数字 ∪ 显式数值字段 ∪ 框架数值）；②含封闭词表内结论词即弃用；③引用形态（`[n]` 编号须在 kbHits 条数内——价格变更行以模式话术引用、不编号；URL 形态文本即弃用）——任一弃用即整段回落模板（守卫是程序比对，不是再问一次 LLM）。
- **可插拔 + 降级**：解释层选择经新主 env `MR_RECOMMEND_EXPLAIN`（`template` | `llm`，默认 `template`）；`llm` 模式下 LLM 失败 / 超时 / 守卫弃用 ⇒ 回落 v1 模板（最终 explanation 逐字节 = v1），推荐主流程永不因解释层失败而失败。
- **观测**：`llm` 模式下结构化记录渲染层（`template` / `llm` / `llm-fallback-template`）与证据命中统计（KB 条数 / 价格变更条数 / 待复核条数 / top cosine）——同时为 ROADMAP 定序第②步（「量哪些查询败在跨文档实体串联」）积累观测口径。
- **文档更正**：ROADMAP「RAG 检索路径选型」段中「读路径尚未建——全仓无相似度检索」的记述已过时（`add-conversational-rag` 已建 `retrieval-core`），随本变更顺带更正。

> 红线③指 CLAUDE.md「Model Radar（P5）专属约束」：价格/兼容/额度是精确事实，绝不交 LLM 判定，LLM 只解释。

## Capabilities

### New Capabilities

（无——证据装配与 LLM 解释都是 `model-radar-recommender` 既有解释层需求的 v2 语义，不成立新能力。）

### Modified Capabilities

- `model-radar-recommender`：「解释层 v1 为模板、带规则依据 + provenance、LLM 不参与、接口对 v2 留证据缝」——① `evidence` 槽由 `unknown` 定型为类型化证据结构（KB 命中 + 价格变更 + 待复核标）；② 新增 LLM 渲染器需求（结论独家承载 + 数字来源封闭，含机械守卫与弃用-回落语义）；③ 新增层选择 env 与降级链需求（`llm` 失败恒回落模板、主流程不阻塞）；④ 新增渲染层与证据命中的可观测需求。

## Impact

- **代码**：新增 `src/mr/recommend/evidence.ts`（证据装配）、`src/mr/recommend/explain-llm.ts`（LLM 渲染器 + 守卫 + 回落，env-clean）；改 `src/mr/recommend/schema.ts`（`evidence` 类型化）、`src/config/env.ts`（`MR_RECOMMEND_EXPLAIN`）、`src/mcp/env.ts`（mcpEnvSchema 补 `MR_RECOMMEND_EXPLAIN` / `LLM_MODEL`）、两调用方 `src/mr/web/model-radar-page.tsx` 与 `src/mcp/tools/recommend-coding.ts`（选层与装配）。**`src/mr/recommend/recommend.ts` 零改动**——既有第三参即注入点，选层与装配全在调用方与注入的渲染器内。
- **依赖**：复用既有 LLM 基础设施的参数口径（Vercel AI SDK；provider 以注入凭据构造，**不 import** 绑定主 env 的 `llm-client`）与既有 KB 检索核心；零新第三方依赖。
- **配置**：新增 1 个主 env（`MR_RECOMMEND_EXPLAIN`，默认 `template`）+ mcpEnvSchema 两个 optional 项；生产开启是独立运营决策。
- **行为变化（用户可见）**：仅当生产显式设 `llm` 后，`recommend_coding_subscription`（MCP）与 `/model-radar` hero 的解释文案由模板话术变为「模板段 + 证据叙述段 + 参考清单」；**模板段的结论与数字逐字节不变、候选排序不变**；叙述段可追加过白名单的证据数字（历史价格、变更日期）。
- **文档**：ROADMAP 上述过时记述更正 + 5e v2 状态行。
- **非目标**：召回/候选 schema/verdict 任何改动；SAG（pgvector 之上的轻量实体-事件索引库，评估记录见 ROADMAP「RAG 检索路径选型」）/ 多跳索引 / `chunk→entity` 侧表；`search_coding_plans` 横切检索；其他桶（IDE 会员 / Token 包 / 企业席位）推荐；KB 检索核心改动（装配只调用、不修改）；`RAG_MIN_COSINE` 语义改动；`/advisor` 链任何改动。
