# Tasks

## 1. Schema 与 env

- [x] 1.1 `src/mr/recommend/schema.ts`：新增 `RecommendEvidence`（design D2 形状：kbHits{docId,planId,title,url|null,cosine} / priceChanges{planId,vendorName,planName,from|null,to,currency,changedAt} / pendingReview: planName[]），`ExplanationInput.evidence` 定型为 `RecommendEvidence | undefined`（undefined ⇔ 未装配；三空数组 = 装配过但无证据）；`Explainer` 签名不变；evidence 不建 Zod
- [x] 1.2 `src/config/env.ts`：新增 `MR_RECOMMEND_EXPLAIN: z.enum(['template','llm']).default('template')`；`src/mcp/env.ts` mcpEnvSchema 补 `MR_RECOMMEND_EXPLAIN` 与 `LLM_MODEL`（均 optional、**非致命款式**——整对象 safeParse 下非法枚举值不得炸解析：catch/preprocess + 解析后置检查发 stderr 一行、按未设置处理）；`.env.example` 补注释行；顺手更新 `parseMcpEnv` 模块头注（后置检查引入 stderr 发射）；测试钉：mcp env 含非法 `MR_RECOMMEND_EXPLAIN` 时 server 正常启动、值按未设置
- [x] 1.3 回归钉：`renderTemplate` 带/不带 `evidence` 输出逐字节相同

## 2. 证据装配层（新增 `src/mr/recommend/evidence.ts`，纯读、注入式）

- [x] 2.1 `assembleEvidence(candidates, deps)`（deps = {dbh, embed, log}；名称直接取 candidates 的 `vendorName`/`name`，**不引入索引结构**）：对排序后前 3 条候选以「vendorName + name」查 `searchKbCore`（top-k=3/候选，只调用不改核心），命中按 `EVIDENCE_COSINE_FLOOR`（模块常量 0.6）过滤后映射 kbHits（title=kbTitle??'(无标题)'；url=sourceUrls 为字符串数组时首个合法 http(s) 项否则 null；带 docId/planId）
- [x] 2.2 priceChanges：SQL 读 `mr_price_history` 近 `PRICE_CHANGE_WINDOW_DAYS=30`（模块常量，非 env）内全部候选 plan 行——from=old_value（可 null）、带 currency、changedAt 渲染只到日（YYYY-MM-DD，**UTC 口径** `toISOString` 前 10 位）；kbHits 跨候选按 docId 去重（保最高 cosine）；pendingReview：从 `candidates[].reasons`（kind='pending_review'）派生（planName=candidate.name），**零 SQL**
- [x] 2.3 失败语义：任一子源抛错 ⇒ 该子源空数组 + 结构化日志 + 继续；**装配整体以 `EVIDENCE_ASSEMBLY_TIMEOUT_MS=5000`（模块常量）Promise.race 设 deadline**，超时按全失败（三空 + 日志）——挂起的 embed/DB 不得拖住请求
- [x] 2.4 单测：KB 子源失败仍返回价格变更；全失败三空不抛；装配超时三空不抛；30 天窗口边界（31 天前不入）；cosine 地板过滤（全低分 ⇒ kbHits 空）；old_value NULL 行 from=null

## 3. LLM 渲染器与机械守卫（新增 `src/mr/recommend/explain-llm.ts`——**env-clean：MUST NOT import agents/llm-client 与 config/env**）

- [x] 3.1 统一提取管线 `extractNumbers(text)` 与守卫① `numberWhitelistGuard(narrative, whitelist)`——**管线四步、符号上下文、Cf 剔除与白名单构造规则以 spec「统一提取管线」「守卫①」段为唯一权威**，实现照抄不另述；比对在剥除合法 `[n]` 后的叙述段上跑；白名单外 ⇒ 弃用 + 原因
- [x] 3.2 守卫② `conclusionWordGuard(narrative)` 与守卫③ `citationGuard(narrative, kbHitsCount)`——消费文本、词表、编号域、越界/邻接/全角/URL 形态规则**均以 spec「机械守卫」段为唯一权威**（含 canonical 化与剥离次序）
- [x] 3.3 `buildExplainer({credentials:{apiKey,baseUrl,model}, dbh, embed, log, generateObjectFn?})` 工厂返回 Explainer（**主体整包 try/catch**——守卫/拼装/净化自身抛错同样回落；`generateObjectFn` 可选注入缝，默认真实调用 + VITEST 真调用守卫，对齐 embed-clean 款式）：`evidence = input.evidence ?? await assembleEvidence(input.candidates, deps)`；三源全空 ⇒ 返回 `renderTemplate(input)` 原值 + 标记 template；否则 canonical 化素材（见 spec canonical 段：sanitizeText + NFKC 归一 + 负号映射 + 剔 Cf，**再**每段封顶 `EVIDENCE_TEXT_MAX_LEN=200`，**prompt 与白名单从同一份 canonical 截断后素材构造**）拼 prompt（编号素材=kbHits、URL 不入、**不含 query**；明令只用平记法阿拉伯数字、不复述现价与结论、历史变更只按提供的 from→to@日期 字段叙述）→ 注入凭据构造 provider、`generateObject` + `{narrative: z.string()}`（**显式 `maxRetries: 0`——重试唯一控制权在本层**；`EXPLAIN_LLM_TIMEOUT_MS=8000` 总预算；**非超时瞬态错（网络错/429/5xx）且剩余预算 ≥ `EXPLAIN_RETRY_MIN_REMAINING_MS=2000` 时重试 1 次、预算不扩大**，错误日志经观测行）→ **叙述段 canonical 化 → canonical 后 trim 空 ⇒ 回落** → 守卫③①②（消费 canonical） → 通过 ⇒ `renderTemplate 原值 + '\n\n' + canonical 叙述段 + '\n\n' + 参考清单`（参考清单代码拼接、与编号同序、**每 hit 恒一物理行——标题折叠 CR/LF/tab 与连续空白为单空格并按素材封顶常量截断**：URL 闸仅 http/https 放行**且拒 userinfo、验证后只渲染 `parsed.href`**，解释层内实现、不 import web 层；无 KB 命中整段省略）+ 标记 llm；失败/超时/空叙述/弃用 ⇒ renderTemplate 原值 + 标记 llm-fallback-template；成功与回落路径的 log 调用自身均包 try（sink 抛错不上抛）；工厂对 credentials 三件做防御断言
- [x] 3.4 逐字节断言：回落与跳过路径在**最终 `RecommendationResult.explanation` 层**（经 recommend() 拼装后）与 v1 逐字节相等——覆盖普通 / 空召回 / 全待核 / **他币种**路径；另加结构断言：**guidance 非空（如他币种并存）且 LLM 成功时，最终 explanation = guidance + `\n\n` + 模板段 + …（确定性权威前缀恒在 LLM 段之前）**
- [x] 3.5 观测：v2 渲染器辖域内每次渲染经 deps.log 记 renderedBy 三值 + KB 条数 / top cosine / 价格变更条数 / 待复核条数 + 弃用原因（若有）
- [x] 3.6 守卫单测（对抗样例）：白名单外杜撰价格 ⇒ 弃用；独立「-25」与**「跌到-25」**（白名单只有 25）⇒ 均弃用；证据行 `"25.00"` vs 叙述「25」⇒ 通过；候选名「GLM-4.6」与叙述裸写「4.6」/「GLM 4.6」⇒ 均通过（符号上下文规则）；**含 `[1]`/`[2]` 合法引用 ⇒ 不弃用**；越界 `[9]` ⇒ 弃用；「[2]5」邻接 ⇒ 弃用；**「推[1]荐」/「recom[1]mended」⇒ 弃用（守卫②消费剥离后文本）**；**「2​5」零宽拼接 ⇒ 弃用（canonical 剔 Cf 后按 25 走守卫①）**；**纯零宽/RLO 返回值 canonical 后为空 ⇒ 回落、不标 llm、不产空段**；**`﹣25`(U+FE63)/`⁻25`(U+207B) 经 NFKC+负号映射 ⇒ -25 ⇒ 弃用**；**「推​荐」canonical 后词表命中 ⇒ 弃用**；**RLO bidi 案例：发射文本 = canonical（无 Cf）⇒ 视觉=逻辑序**；**URL 含 CR/LF/tab ⇒ 参考清单只渲染 parsed.href、恒单行**；**mock 断言 generateObject 收到 maxRetries: 0**；**kbHits>0 且零引用 ⇒ 合法（引用可选）**；`［１］`全角引用归一后按 `[n]` 处理；changedAt=2026-07-01 vs 叙述「7 月 1 日」⇒ 通过；「20, 25」不并成 2025；全角归一（含 U+2212）；千分位「1,000」；「首选」/「Primary」⇒ 弃用；KB 标题含「首选」但只在参考清单 ⇒ 不弃用；**KB 标题含 `\n\n【首选】…` ⇒ 参考清单单行渲染、不产生新段落**；叙述含 `http://`/`HTTP://` ⇒ 弃用；LLM 返回空叙述 ⇒ fallback；渲染器内部任意抛错（守卫抛错注入）⇒ fallback、不向上抛；**log sink 抛错（成功与回落路径）⇒ 返回值不受影响、不向上抛**

## 4. 调用方装配（层选择不进 recommend() 本体；**recommend.ts 零改动**）

- [x] 4.1 Web `src/mr/web/model-radar-page.tsx`：`env.MR_RECOMMEND_EXPLAIN==='llm'` ⇒ 采集主 env 凭据 + 标准 embed + db + stdout logger，`buildExplainer` 注入第三参（**构造包 fail-open**：构造抛错 ⇒ 不传第三参走模板 + 记错）；否则不传第三参（默认模板）
- [x] 4.2 MCP `src/mcp/tools/recommend-coding.ts`：经 `getContext().env` 读 `MR_RECOMMEND_EXPLAIN` 与四 key（LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / EMBEDDING_MODEL）；配置 llm 且四项齐 ⇒ env-clean embed 变体（`src/kb/embed-clean.ts`）+ buildExplainer 注入、log sink 注 **stderr**（console.error——stdout 是 JSON-RPC 通道，MUST NOT 写观测）（**构造包 fail-open**：构造抛错 ⇒ 模板层 + stderr 记错）；**配置 llm 且任一缺** ⇒ 模板层 + stderr 一行列出缺失变量名（未配置 llm 不刷 stderr）；工具签名与返回 schema 不变
- [x] 4.3 env-clean 钉子：① 静态 import 链测试（沿 query-chain-env.test.ts 款式）——explain-llm.ts / evidence.ts 不含 `config/env`、`agents/llm-client`、`db/index` 的值 import；② 剪裁 env（**仅 DATABASE_URL + 分支所需的 `MR_RECOMMEND_EXPLAIN=llm` 开关、无四 key**）子进程**运行期真调用** MCP 推荐 handler（缺 key 分支须触发动态 import 才测得到，`src/mcp/tools/search-kb.ts` 先例），断言不触全局 parseEnv、正常返回模板结果
- [x] 4.4 集成测试（mock LLM 经 `generateObjectFn` 注入）：web llm 路径 explanation = 模板段+叙述段+参考清单且**断言装配确实发生**（evidence 非 undefined 传到叙述子渲染）；MCP 缺 key 回落 + stderr 提示行；调用方构造抛错 ⇒ fail-open 模板层；默认 template 零 LLM 调用、零证据装配

## 5. 验收

- [x] 5.1 全量 `pnpm typecheck && pnpm lint && pnpm test` 通过
- [x] 5.2 `npm run spec:validate add-model-radar-recommender-rag-explanation` 通过（config.yaml 归档纪律：一律经仓内钉版 CLI，不裸调）

## 6. 文档

- [x] 6.1 ROADMAP：更正「读路径尚未建——全仓无相似度检索」过时记述（retrieval-core 已建）；5e v2 标记完成 + 一行状态（默认 template、生产开启是独立运营动作）
- [x] 6.2 主规范 `openspec/specs/model-radar-recommender/spec.md`「目的」段：删「v2 LLM 解释……不在本规范」半句、改为「解释层 v2（可选 LLM 证据叙述，恒可回落模板）在本规范解释层需求内」——否则归档合入 v2 需求后「目的」自相矛盾
