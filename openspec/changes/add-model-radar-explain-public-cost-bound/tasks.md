# Tasks

## 1. daily-cap 扩展（namespace + cap + reason，向后兼容）

- [x] 1.1 `src/rag/daily-cap.ts`：`dailyCapKey(now, namespace='rag')` + `checkAndBumpDailyCap` deps 加 opt-in `namespace?: string`（默认 `'rag'`）；键 `<namespace>:llmcalls:<date>`。**默认 `'rag'` ⇒ advisor 键与行为逐字节不变**
- [x] 1.2 `DailyCapResult` 加 `reason?: 'quota-exceeded' | 'infra-error'`（超限 vs Redis 抛错）；错误日志去「拒绝作答」advisor 专属措辞、改中性（或带 namespace）——`mr` 调用方走模板不拒服务
- [x] 1.3 `src/config/env.ts`：新增 `MR_EXPLAIN_DAILY_LLM_CAP: z.coerce.number().int().positive().default(200)`（公开展示页、低于 advisor 500）；`.env.example` 补注释行
- [x] 1.4 测试钉：`dailyCapKey()`（无参）= `rag:llmcalls:<date>`、`dailyCapKey(now,'mr')` = `mr:llmcalls:<date>`；`checkAndBumpDailyCap({namespace:'mr',cap:3})` 与 `{namespace:'rag'}` **独立计数、独立 cap 值**（内存 Redis 桩，验 mr cap=3 触顶时 rag 不受影响）；Redis 抛错 ⇒ `{allowed:false, reason:'infra-error'}`；超限 ⇒ `reason:'quota-exceeded'`

## 2. buildExplainer 注入回调（onRender + beforeLlmCall；保 Explainer 签名 + MCP env-clean）

- [x] 2.1 `src/mr/recommend/explain-llm.ts` `buildExplainer` opts 加 opt-in `onRender?(renderedBy: RenderedBy): void`（**保持 `void`、只携 renderedBy**——被缓存串由 web 包裹截获、不经此回调）与 `beforeLlmCall?(): Promise<boolean>`；`Explainer` 签名不变；`RenderedBy` **type-only 导出**（供 web onRender 标注，编译期擦除、零 env-clean 代价）
- [x] 2.2 接线：`beforeLlmCall` 在**证据非空、真发起 `callLlm` 之前** await——返 `false` ⇒ 跳过 LLM、走回落（`renderedBy='llm-fallback-template'`，discardReason 如 `cap-declined`）；缺省（MCP 不注入）⇒ 不 gate、照常调 LLM。渲染各出口末尾（成功/回落/跳过）调 `onRender(renderedBy)`（缺省 no-op）。**gate 位置 = 三源全空早返（explain-llm.ts:388-395）之后、`callLlm`（:415）之前**；三守卫在 callLlm 之后（:431-446），故守卫弃用路径**已 INCR**（callLlm 已真调）——只有证据全空（callLlm 前早返）不 INCR。**重试不重复 gate**：`beforeLlmCall` 只在首次 attempt 前调一次——故每 permit 至多 2 次真 `generateObject`（≤1 瞬态重试）、日真调 ≈ 2× cap（登记见 spec / design D3）
- [x] 2.3 env-clean 钉：explain-llm.ts 仍不值 import config/env·agents/llm-client·db/index·Redis；回调注入不引入这些（回调实现体在 web 调用方）。补 query-chain-env 静态 grep 覆盖不回退；`recommend-coding.ts`（MCP 链）禁顶层 import `explain-cache`（web-only，静态钉住 web 缓存不漂进 MCP env-clean 链）
- [x] 2.4 单测：注入 `beforeLlmCall=()=>false` ⇒ 跳过 LLM、renderedBy=llm-fallback-template、onRender 收到该值；`beforeLlmCall=()=>true` ⇒ 正常调 LLM、onRender 收 llm；证据全空 ⇒ beforeLlmCall **不被调**、onRender 收 template；缺省不注入 ⇒ 行为与 5e v2 逐字节不变

## 3. 整条解释缓存模块（web 侧，Redis，单飞，fail-open）

- [x] 3.1 新建 `src/mr/web/explain-cache.ts`：`computeSetupHash(input: RecommendInput)`（固定字段序 + 数值 canonical 化稳定序列化哈希——maxMonthlyPrice 数值归一、枚举、model/tool/protocol；排除 render_now/tokensPerRound；**凡影响 recommend() 输出的 RecommendInput 字段皆入 hash**——按 recommend.ts 的 `RecommendInput` 全字段核对；**先应用 recommend() 缺省（`currency??CNY`、`usageProfile??medium`）再哈希**，使 `{}` 与 `{currency:'CNY',usageProfile:'medium'}` 同 hash——否则语义同而 hash 异 ⇒ 额外未命中，属过缓存安全向、非错缓存）；`getCachedExplanation(version, setupHash)` / `setCachedExplanation(version, setupHash, explanation)`（**`explanation` 参数 = explainer 返回的叙述串、非 recommend() 的 `result.explanation`——不含 guidance 前缀**）——Redis 键 `mr:explain:<version>:<setupHash>`、TTL 模块常量 `EXPLAIN_CACHE_TTL_MS = 15 * 60 * 1000`（叙述新鲜度唯一界）；读写抛错/Redis 不可用 ⇒ get 返 null（未命中）、set 静默不抛（fail-open）
- [x] 3.2 单飞 `withSingleFlight(key, produce)`：**进程内 `Map<key, Promise>`**（仿 `cache.ts` 的进程内 Promise 单飞、本模块因多缓存键用 Map；理由与多实例升级见 design D4）——首个 miss 存入 `produce()` promise，同键并发 `await` 同一 promise 得同结果；promise settle（成败）后清除该键。`produce()` 抛错 ⇒ 清键 + 各自回落（fail-open、不缓存、下次可重试）
- [x] 3.3 单测：computeSetupHash 等价输入同 hash / 不同 maxMonthlyPrice 或枚举不同 hash；**向量显式覆盖 model/tool/protocol/usageProfile 各自改动 ⇒ 不同 hash**（防漏字段回归：漏 usageProfile 会让异档请求撞缓存返错误解释）、`{}` 与显式缺省 `{CNY,medium}` 同 hash；写后读命中、不同 version/setupHash 不命中；Redis 抛错 ⇒ get null / set 不抛；单飞：并发 N 个未命中同键 ⇒ produce 至多 1 次（mock 计数）、其余 await 同一 promise 得同结果；produce 抛错 ⇒ 清键、各自回落不崩、下次可重试

## 4. web 调用方接线（llm 路径：缓存 → 单飞 → gate(beforeLlmCall) → 装配LLM → onRender 写缓存）

- [x] 4.1 `src/mr/web/model-radar-page.tsx` `llm` 路径（按 design D 顺序）：算 `(cached.version, computeSetupHash(input))` → `getCachedExplanation` 命中 ⇒ 注入 `() => cached` 作 explainer 交 `recommend()`、返回（不装配不调 LLM）；未命中 ⇒ `withSingleFlight(key, produce)`，`produce` 内：**包裹**注入的 explainer（`const narration = await inner(inp); return narration` 截获返回值）、`onRender` 仅置 `renderedBy`、`beforeLlmCall` = 读 `checkAndBumpDailyCap({namespace:'mr', cap: env.MR_EXPLAIN_DAILY_LLM_CAP})` 的**完整结果、按 `reason`（quota-exceeded / infra-error）分别记日志**后返 `.allowed` → 跑 `recommend()` → **`renderedBy==='llm'` 时 `setCachedExplanation(version, setupHash, narration)`**（narration = 包裹截获的 explainer 返回、**不含 guidance**）。**整条 `llm` 路径（缓存读 + `withSingleFlight` + `produce` + 注入 explainer 的 `recommend()`）MUST 包在兜底 try/catch 内**——任一 rejection ⇒ 记错 + 回落默认模板 `recommend(snapshot, input)`（无第三参）+ 页 200，不冒泡成 500（现 `model-radar-page.tsx:219-221` 的 `await recommend()` 无 try/catch、只裹了同步 `explainerFactory()`；新机器引入新 reject 源须补顶层兜底）。**`template` 默认路径与 MCP 路径零变化**
- [x] 4.2 集成测试（mock LLM + 内存 Redis 桩）：同 setup 二次请求第二次命中缓存、零 LLM 调用、零装配；**guidance 非空场景（无 primary 的 `composeNoEligible` 或他币种）命中路径 `result.explanation` 与首次 miss 路径逐字节相等**（证被缓存串不含 guidance、命中不双写）；证据全空请求不占 mr 配额（beforeLlmCall 未触发）；mr cap 触顶 ⇒ 回落模板、页 200；**cap 两态 `reason`（quota-exceeded / infra-error）分别被记日志/观测**；Redis 不可用 ⇒ fail-open（缓存未命中 + gate allowed=false ⇒ 模板、页 200 不崩）；**兜底 fail-open：缓存读 reject / produce reject / 注入 explainer reject 三类 ⇒ 均断言页 200 + 模板输出（非 500）**；并发同 setup 首请求经单飞至多 1 次 LLM；默认 template 零缓存/零 cap

## 5. 验收

- [x] 5.1 全量 `pnpm typecheck && pnpm lint && pnpm test` 通过（含 advisor daily-cap 回归——namespace 默认不变；5e v2 explain-llm 缺省回调回归——不变）
- [x] 5.2 `npm run spec:validate add-model-radar-explain-public-cost-bound` 通过

## 6. 文档

- [x] 6.1 README / ROADMAP：`MR_RECOMMEND_EXPLAIN=llm` 开启前置补一句（公开页有成本边界：整条解释缓存 + 独立日上限 fail-open；`MR_EXPLAIN_DAILY_LLM_CAP` 默认 200）；`.env.example` 已在 1.3 补
