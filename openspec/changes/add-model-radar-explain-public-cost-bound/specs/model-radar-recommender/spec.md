## ADDED Requirements

### 需求:公开 web 页 llm 解释的成本边界——整条解释缓存 + 单飞 + 独立 namespace 日上限（permit 计逻辑作答、真调 ≈ 2× cap 上界、超限/Redis 故障 fail-open 回落模板），经 buildExplainer opt-in 回调实现、MCP 不注入

> 5e v2 解释层的**生产就绪扩展**：不改解释正确性（召回/候选/verdict/canonical/三守卫由「解释层 v1 为模板…」需求管），只给公开 web 页开 `llm` 加成本边界。**不打开 `llm` 本身**（独立运营决策）。装配 deadline 取消不在本需求（拆独立变更）。

**适用面（web-only，MCP 明确排除）**：成本边界（缓存 + 日上限）MUST 只作用于 **web `/model-radar`（无鉴权公开 GET、主进程有 Redis）**。**MCP `recommend_coding_subscription` 路径 MUST NOT 引入 Redis 缓存/日上限**——MCP 是 env-clean 纯查询进程（铁律「只 `DATABASE_URL`」），引入 Redis 即破 env-clean；且 MCP 逐客户端低频、非公开爬虫放大面。

**架构接缝（保 env-clean）**：`buildExplainer`（`explain-llm.ts`）MUST 加两个 **opt-in 注入回调**——`onRender?(renderedBy)`（渲染末尾调，供调用方判缓存写）与 `beforeLlmCall?(): Promise<boolean>`（在证据非空、真发起 LLM 之前 await，返 `false` ⇒ 跳过 LLM、走回落模板）。`Explainer` 签名不变（`(input)=>Promise<string>`）——回调是 buildExplainer 选项。**web 调用方注入两回调（内含 Redis daily-cap + 缓存）；MCP 调用方 MUST NOT 注入 ⇒ Redis 绝不进 explain-llm.ts、env-clean 不破。**

**整条解释缓存（web 侧）**：`llm` 模式 MUST 按 `(快照 version 内容哈希, setupHash)` 缓存 `renderedBy='llm'` 的 **explainer 返回串**——
- **被缓存串 = explainer 的返回值**（模板段 + 叙述段 + 参考清单），**MUST 排除 `recommend()` 拼接的 guidance 前缀**（guidance 从不进 explainer、命中时由 `recommend()` 现拼、逐字节重导；误缓存含 guidance 的 `result.explanation` ⇒ guidance 非空场景双写——机制见 design D1、由 tasks 4.2 断言）。
- **写侧捕获**：web MUST **包裹**注入的 explainer 截获其返回值作被缓存串；`onRender(renderedBy)` 保持 `void`、仅作写闸（`renderedBy==='llm'` 才写）。整串是 `(candidates, evidence)` 的纯函数、与 `render_now` 无关（`renderTemplate`/`renderReferenceList` 均不读 `now`；相对 age 徽标在 web 组件、不在 explanation 串），命中注入 `()=>cachedNarration`、**不装配证据、不调 LLM**（同时省 embed/DB 与 LLM；且缓存整个 explainer 返回绕开「叙述段单缓存时参考清单缺 kbHits ⇒ `[n]` 悬空」的断链）。
- `setupHash` = `RecommendInput` **固定字段序 + 数值 canonical 化**的稳定哈希（`maxMonthlyPrice` 数值归一、currency/usageProfile 枚举、model/tool/protocol）——等价输入 MUST 同 hash；排除 `render_now` 与 web-only `tokensPerRound`（不入 `RecommendInput`）。
- **只写 `renderedBy='llm'` 成功产物**——`llm-fallback-template`/`template` MUST NOT 写缓存（不固化一次性失败）；调用方经 `onRender` 得 `renderedBy` 后决定是否写。
- **单飞防 cache stampede**：同 `(version, setupHash)` 的并发首请求 MUST 经**进程内单飞**（仿快照 `cache.ts` 的进程内 Promise 单飞模式，本模块因存在多个缓存键扩为 `Map<key, Promise>`——并发 miss 复用同一 `produce()` promise、其余 await 得同结果、settle 后仅清对应键）收敛为**近乎至多 1 次真 LLM 调用**（异步缓存 GET 与 Map 插入非原子，罕见交错可致第 2 次 produce——与 `cache.ts` inFlight 同性质、由日上限兜底、非硬保证）。部署单实例、进程内足够（多实例升级路径见 design D4）。单飞故障 ⇒ fail-open（`produce` 抛错清键、各自回落、被日上限兜底）。
- 缓存层 MUST fail-open：Redis 不可用 / 读写抛错 ⇒ 视为未命中、继续正常路径，绝不阻塞或使页面失败。
- **web 调用方兜底 fail-open（页恒 200）**：`llm` 路径的调用方 MUST 用兜底 try/catch 包住整条链（`getCachedExplanation` + `withSingleFlight` + `produce` + 注入 explainer 的 `recommend()`）——任一 rejection（Redis、单飞、produce、explainer 意外抛）MUST 记错后回落默认模板 `recommend(snapshot, input)`（无第三参）、页 200；**绝不依赖内层各自 fail-open 而无顶层兜底**（本变更新增的缓存/单飞/包裹机器引入新 reject 源，不得冒泡成 500）。
- **新鲜度界 = TTL（模块常量 `EXPLAIN_CACHE_TTL_MS = 15 * 60 * 1000`），非 version**：**现价变化会同时改快照 currentPrice ⇒ version bump ⇒ 旧键失效**（这部分非正交）；与 version 正交的叙述证据不止 KB——`kb_documents` 新增、`mr_price_history` 的**非现价变更/回填**（不改 currentPrice 故不 bump version）与 30 天窗随 `now` 滑动、`pendingReview` 待复核文本（live DB 读、不入快照 DTO）——均由 **TTL** 统一兜住陈旧（TTL 是叙述—证据新鲜度的唯一界，短 TTL 权衡新鲜度与命中率——叙述段非权威）。

**日 LLM 调用上限（web 侧，复用 daily-cap + 独立 namespace + 显式 cap + permit 计逻辑作答 + fail-open）**：
- 复用 `src/rag/daily-cap.ts`：`dailyCapKey` / `checkAndBumpDailyCap` MUST 加 opt-in `namespace` 参数，**默认值 MUST 保持 advisor 现有键 `rag:llmcalls:<date>` 与行为逐字节不变**；model-radar 调用点 MUST **显式传 `{namespace:'mr', cap: env.MR_EXPLAIN_DAILY_LLM_CAP}`**——键 `mr:llmcalls:<date>`、额度取新 env（否则 `cap` 兜底取 `RAG_DAILY_LLM_CALL_CAP`、额度错）。两面预算独立、一面用尽不拖累另一面。
- `DailyCapResult` MUST 加 `reason`（`quota-exceeded` / `infra-error`）供两态分别观测——infra-error 是可用性降级（宕机期无 LLM 叙述）、非成本放大；daily-cap 的错误日志 MUST 去 advisor 专属措辞（中性或带 namespace），且 daily-cap 函数只覆盖 infra-error 通用日志——**两态分别记日志/指标的落点 MUST 在 web 注入的 `beforeLlmCall` 回调体内**（那里持完整 `DailyCapResult`），调用点只取 `.allowed` 会丢弃 `reason`。
- **permit-gate 计数（计逻辑作答，非请求数、非逐次真调）**：INCR MUST 经注入的 `beforeLlmCall` 在 explain-llm.ts「证据非空、真发起 `callLlm` 之前」执行一次——**凡到达 gate 的请求计一次**（含 callLlm 后输出被三守卫弃用而回落的：LLM 已真调、成本已生）；**三源全空（callLlm 前早返）MUST NOT 占配额**；命中缓存不触 gate ⇒ 不计。**每 permit 对应至多 2 次真 `generateObject`**——`callLlm` 在 8s 预算内至多瞬态重试 1 次、不重复 gate（一次准入=一次逻辑作答，与 advisor「一次作答计一次」同口径）——故**日真调上界 ≈ `2× cap`**（瞬态重试 provider-side、罕见、非攻击者可控，攻击者得约 1× cap）；**operator MUST 按 2× 设 cap**。（INCR-then-check「恰放行 cap 次」的机制见 design D3。）
- **fail-open 语义（区别于 advisor 的 fail-closed）**：`beforeLlmCall` 得 `allowed=false`（超限**或** Redis 不可用，两者皆 `false`）⇒ **跳过 LLM、装模板层**（公开展示页恒可用、只退化解释）——绝不像 advisor 那样拒绝服务。**不存在「Redis 故障 ⇒ 放行无界 LLM」分支**：Redis 故障 ⇒ `allowed=false` ⇒ 模板（零 LLM、成本最安全）。

#### 场景:同快照版本内重复精确查询命中缓存、不重复调 LLM 也不装配
- **当** `/model-radar` `llm` 模式，同一 setup 参数在快照未 rebuild 期内被再次请求（真实用户刷新）
- **那么** 首次经单飞装配 + LLM 产 `renderedBy='llm'` 的 narration 串并写缓存（键含 version + setupHash）；后续请求命中缓存、注入 `()=>cached` 交 `recommend()` 现拼 guidance 返回、不调 LLM、不装配证据、不计日上限；快照 rebuild 内容变换 version 后旧键失效、重新装配

#### 场景:cache stampede 被单飞收敛为一次 LLM 调用
- **当** version 翻转或 TTL 过期后，同 `(version, setupHash)` 有 N 个并发首请求（同时未命中）
- **那么** 进程内 `inFlight` 使至多 1 个请求真装配 + 调 LLM 并写缓存，其余 `await` 同一 `produce()` promise 得同结果；不出现 N 个请求各自调 LLM

#### 场景:permit 计数只对发起 LLM 的请求生效、空证据不占配额
- **当** `llm` 模式缓存未命中，但候选证据三源全空（无 KB 命中、无近 30 天变价、无待复核）
- **那么** explainer 跳过 LLM 调用（`renderedBy='template'`）、`beforeLlmCall` 未被触发 ⇒ **不 INCR `mr:llmcalls`**、不占配额；仅证据非空、真发起 generateObject 前才计数

#### 场景:日上限触顶或 Redis 不可用时 fail-open 回落模板、两态可分辨
- **当** `llm` 模式缓存未命中、证据非空，`beforeLlmCall` 内 `checkAndBumpDailyCap({namespace:'mr', cap})` 返 `allowed=false`（当日达 `MR_EXPLAIN_DAILY_LLM_CAP`，reason=`quota-exceeded`；或 Redis 不可用，reason=`infra-error`）
- **那么** 跳过 LLM、装模板解释层、页正常 200 返回（fail-open、恒可用）；不像 advisor 拒服务；两 reason 分别记日志/指标（infra-error 是可用性降级非成本放大）；`mr` 与 advisor `rag` 预算独立互不影响

#### 场景:web 调用方任一环 rejection 兜底回落模板、页恒 200
- **当** `llm` 模式下缓存读 / `withSingleFlight` / `produce` / 注入 explainer 的 `recommend()` 任一 rejected（如 Redis 读抛错、produce 意外抛、包裹 explainer 意外抛）
- **那么** 调用方兜底 try/catch 捕获、记错、回落默认模板 `recommend(snapshot, input)`（无第三参）、页正常 200 返回模板解释——绝不 500、绝不依赖内层各自 fail-open 而无顶层兜底

#### 场景:MCP 路径不注入回调、不引 Redis、env-clean 不破
- **当** MCP `recommend_coding_subscription` 在 `llm` 模式装配 buildExplainer
- **那么** MCP 调用方**不注入** `onRender`/`beforeLlmCall` ⇒ 无缓存、无日上限、无 permit-gate（每次真调 LLM，MCP 非公开放大面可接受）；explain-llm.ts import 链仍不含 Redis / `config/env` 值 import（env-clean 铁律不破）

#### 场景:namespace 默认 'rag' 时 advisor 逐字节不变
- **当** advisor 调 `checkAndBumpDailyCap()`（不传 namespace）
- **那么** namespace 取默认 `'rag'`、键 `rag:llmcalls:<date>`、cap 取 `RAG_DAILY_LLM_CALL_CAP`、fail-closed 拒服务语义——与本变更前逐字节相同（`namespace` 是纯 opt-in 扩展）
