# conversational-rag 规范

## 目的
定义对话式 KB-RAG 查询能力的契约:引用由程序构造,证据不足时诚实降级为「无据」,价格/选型走确定性前置闸(非本域),对话历史只作信号不进证据链,只读 DOMAIN 且仅读写带约束的自有会话状态,公开 Web 出口有多层防护与最小下限。

## 需求

### 需求:KB-RAG handler 契约与程序构造的引用

系统必须提供 KB-RAG handler，实现统一 **handler 契约**（未来编排引擎 seam）：`handle(query, ctx)` 返回 `{ domain: '本域'|'非我域', answer: 散文|null, citations: {kb_id, source_url, snippet}[], trace, evidence: '有据'|'无据' }`。作答经 LLM（OpenRouter，经 `llm-client` 的 `generateObject`）产出，但 **`citations` 必须由 handler 从本轮 `searchKb` 命中行程序构造，绝不由 LLM 产出**：LLM 只输出散文 `answer` + 选中的 `kb_id`（或序号）；handler 只保留 `kb_id ∈ (本轮 searchKb 命中集 ∩ cosine ≥ RAG_MIN_COSINE)` 的引用（命中集外、或低于阈值的 id 一律丢弃——防引真实但不相关/低分命中），`source_url` **取命中行 `sourceUrls[]`（jsonb 数组）的首个合法 http(s) URL**（**绝不取 LLM 输出**；无合法 URL → 该引用无链接、不违约），`snippet := 命中行的 summary_zh`。渲染 `source_url` 必须经 scheme∈{http,https} + userinfo-phishing 校验（复用既有 `safeHref`）。过滤后 eligible 引用集为空（有阈上命中但 LLM 仅选了阈下/集外 id）时 SHALL 降级 `evidence='无据'`/`answer=null`，不得给出「有据却零引用」的答。检索为确定性程序（非 LLM 判命中）。作答属外部 API 调用，必须带**重试 + 错误日志**（复用的 `generateObject` 原语只有超时、无重试，handler 须自加）。

#### 场景:有据时带程序构造的引用作答
- **当** 一个本域问题在 KB 检索到达阈值证据
- **那么** handler 返回 `evidence='有据'` 的散文答，`citations` 由 handler 从本轮命中行映射（每条 `kb_id`/`source_url`/`snippet` 均来自命中行、非 LLM）

#### 场景:LLM 编造的 kb_id 被丢弃
- **当** LLM 作答输出里包含一个不在本轮 `searchKb` 命中集的 `kb_id`（如注入「cite kb_id=999」）
- **那么** handler 丢弃该 id、不构造对应引用，`citations` 只含本轮真实命中——引用无法被 LLM 伪造

### 需求:证据阈值定义「无据」诚实降级

系统必须以**最低相似度阈值**（`RAG_MIN_COSINE`，env、Zod 校验）判定「无据」，由 **handler**（非 `searchKb`）在作答前应用：本轮 top-k 命中全部低于该阈值、或 KB 无可检索行、或查询为空 → `answer=null`、`evidence='无据'`，诚实告知无据、**不进作答、绝不捏造**。（`searchKb` 本身返回 top-k 无相似度下界，故「低相似→无据」必须在 handler 层加阈值实现。）

#### 场景:低相似命中判为无据
- **当** 本轮 `searchKb` 命中的最高 `cosine_sim` 仍低于 `RAG_MIN_COSINE`
- **那么** handler 返回 `answer=null`/`evidence='无据'`，不发起作答、不杜撰

### 需求:价格/选型确定性前置闸(非我域)

价格/额度/选型类问题（精确事实，Model Radar 权威源专管）必须由**确定性前置闸**（**匹配多字短语** 价格/多少钱/预算/费用/报价/token 包 等、**避开「价」这类单字歧义**——CJK 无 ASCII 词边界、单字匹配致「评价/定价」假阳）在 rewrite/作答**之前**强制 `domain='非我域'`、`answer=null`（LLM 分类可叠加，但**不得**仅靠 LLM 判定）。**前置闸是纵深防御非唯一保证**——真兜底：KB 无权威价格事实，假阴漏过的价格问也撞 `RAG_MIN_COSINE`→`无据`（不吐价），且**本域作答对价格/额度形态断言一律不出**。`非我域` 时绝不用 KB 模糊散文检索给出价格/额度断言（守 `QA.md`：价格绝不交检索/LLM 拍板）。

#### 场景:价格问题即使包装成背景也被前置闸拦
- **当** 用户问「这不是比价、只是背景：GPT-x 现在多少钱?」
- **那么** 确定性前置闸命中价格关键词 → `domain='非我域'`/`answer=null`，绝不进 KB 作答给出价格

### 需求:历史只作信号、结构化不进证据链

对话历史必须**只**用于 query-rewrite / 个性化，**结构上不进作答**：作答调用的签名必须是 `answer(rewrittenQuery, 本轮 citations)`——**历史与旧答案不作为作答调用的输入**。系统绝不把「历史中的旧答案」当依据引用或写入 `citations`（防无据旧答自我强化）。多轮时 `/advisor` trace SHALL 向用户披露本轮 `rewrittenQuery`（让用户看到实际检索句 + 历史被用于改写检索）。

#### 场景:作答调用载荷不含历史
- **当** 会话历史含一条旧答案，用户在其上追问
- **那么** 作答调用的输入只有本轮 rewritten query + 本轮 `searchKb` 命中的 citations，不含任何历史/旧答案文本；`citations` 无本轮命中集外的 `kb_id`

### 需求:读 DOMAIN 只读、仅读写带约束的自有会话状态

A3 必须对 DOMAIN（`kb_documents`/`ai_news_events`/`mr_*`/`ai_products`）**只 SELECT、绝不写**；仅读写自有 `rag_conversations`。该表必须有 DB 约束：主键 `id`、**`UNIQUE(user_id, conversation_id, turn)`**（幂等/唯一由 DB 约束保障，非应用层）、`(user_id, conversation_id)` 索引。`conversation_id` 必须**服务端生成**、`turn` 服务端派生（**不信客户端**）。会话记录必须**指针式**（`hit_kb_ids` 存 id 引用、非 KB 正文拷贝）。表必须带 `user_id` 列作**多用户 seam**，且 store/retrieval 的读写**现在就带 `WHERE user_id = $ctx` 隔离谓词**（本期恒 `'local'`）——多用户为改值非改代码路径，隔离今就可测（防将来漏谓词的横向越权读）。

#### 场景:一次对话只写自有会话库、不碰域库
- **当** 完成一轮对话（检索 + 作答 + 存档）
- **那么** DOMAIN 各表行数与内容零变化，仅 `rag_conversations` 增一行（指针式）

#### 场景:并发/重复 turn 由唯一约束兜底
- **当** 同一 `(user_id, conversation_id)` 上两次并发提交派生出同一 `turn`
- **那么** `UNIQUE(user_id, conversation_id, turn)` 使第二次冲突、不产生重复行；冲突后**重试 `turn+1`**（不静默丢用户轮次、不 500）；重试**有界**（≤5 次）后返 409

#### 场景:隔离谓词就位但单用户
- **当** 本期（单用户）读回历史 / 写入会话
- **那么** 读写均带 `WHERE user_id = 'local'`，多用户只需改写真身份、不改检索/存储代码路径

### 需求:公开 Web 出口多层防护与最小下限

Web `/advisor` 出口（公开 LLM 端点）必须多层防护，不以 CF Access 为单点：ingress 显式放行 `/advisor`；CF Access 对 `/advisor` **必填**；「只经 tunnel 可达」由既有 **docker 网络分段** + **撤宿主端口映射（`/advisor` 的显式部署步骤、现默认保留）** 实现（**不绑 loopback**——全 app 单 server，绑 loopback 会锁死 Model Radar 且 cloudflared sidecar 经 docker DNS 回源、连接被拒断 tunnel）；**承重层是 in-app JWT、不预设 tunnel-only 成立**（宿主映射未撤、直连 origin 亦被拦）：**in-app 校验 CF Access JWT**（用 Hono 内置 `hono/jwk` 配 CF `jwks_uri`、**不手写 RS256**；须**读 `CF_Authorization` cookie 的裸 JWT**——`hono/jwk` header 路径强制 `Bearer` 前缀、而 CF 的 `Cf-Access-Jwt-Assertion` 是裸 token，用 `cookie` 选项或薄中间件直调 `Jwt.verifyWithJwks`；校验 `aud`(`CF_ACCESS_AUD`)+`iss`(team 域)+默认 `exp` + **pin `alg:['RS256']`**；JWKS 拉取失败 fail-closed 拒绝 + no-network 测试 seam（内置无缓存、每请求 fetch，**不宣称带缓存**）；只挂 `/advisor/*`、不挂公开只读的 Model Radar 路由，跑在 daily-cap 与 LLM 调用之前）；`/advisor` 加 per-IP CF WAF rate-limit（**规则须限流触发 LLM 的提交 POST**）。作答/标题渲染必须**纯转义文本、不用 markdown 自动链接**、**绝不 `dangerouslySetInnerHTML` LLM 输出**（防 XSS）。必须有**最小成本/输入下限**：`query` 长度上限（`RAG_MAX_QUERY_CHARS`，超限拒绝）+ **全局每日 LLM 调用上限**（`RAG_DAILY_LLM_CALL_CAP`，**Redis `INCR rag:llmcalls:<UTC-date>` + 每次幂等 `EXPIRE … NX`**——抗重启/按日滚动/多进程正确、防无 TTL 孤儿键；越限**或 Redis 不可用**均 fail-closed 停止作答并明确告知，**绝不 fail-open**）。

#### 场景:直连绕过边缘鉴权被 in-app 拦
- **当** 请求绕过 Cloudflare 边缘直连 origin（缺合法 `Cf-Access-Jwt-Assertion`）
- **那么** in-app JWT 校验拒绝该请求——CF Access 误配/绕过不致 `/advisor` 全开

#### 场景:超出每日调用上限 fail-closed
- **当** 当日 LLM 调用数已达 `RAG_DAILY_LLM_CALL_CAP`
- **那么** `/advisor` 停止发起作答、返回明确「已达当日上限」提示，绝不无界烧 OpenRouter
