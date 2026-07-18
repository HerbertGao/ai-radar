# 设计

## Context

5e v2 解释层默认 `template`。两个 `llm` 消费面：

| 面 | 进程 | 成本放大 |
|---|---|---|
| `/model-radar` web（`model-radar-page.tsx:181`） | 主 app（全 env、有 Redis） | **无鉴权公开 GET**——爬虫每请求 1 次 LLM，无边界 |
| MCP `recommend_coding_subscription` | **env-clean 纯查询（只 DATABASE_URL、无 Redis）** | 逐客户端低频、非公开——无放大面 |

关键既有事实（评审已核）：
- `checkAndBumpDailyCap`（`daily-cap.ts`）：Redis 日计数、键**硬编码** `rag:llmcalls:<date>`、`cap = deps.cap ?? env.RAG_DAILY_LLM_CALL_CAP`、**fail-closed**（Redis 抛错 ⇒ `{allowed:false, count:null}`）；唯一现消费者 = advisor（无参调用）。
- `CachedSnapshot { snapshot, version }`——`version` = 快照 DTO 的 SHA-256 内容哈希；**不含** `kb_documents` / `mr_price_history`（二者与 version 正交）。快照 `cache.ts` 有 `inFlight` 单飞。
- `renderTemplate`（explain.ts）用 `candidates`（`lastCheckedDate`/`stale` 已烘进 version）、`renderReferenceList`（explain-llm.ts）用 `kbHits.title/url`——**两者均不读 `new Date()`**；相对 age 徽标只在 `AnswerCard`/`EvidenceDrawer`（另收 `now`），**不在 explanation 串**。
- `Explainer = (input) => Promise<string>`——只回串，`renderedBy` 仅内部 `safeLog`、不返回；「三源全空跳过 LLM」的决定在 explainer 内。

## Goals / Non-Goals

**Goals**：公开 web 页开 `llm` 后有成本边界（整条解释缓存 + 单飞 + 独立 namespace 日上限、permit 计逻辑作答、真调 ≈ 2× cap 上界）且恒可用（超限/Redis 故障退化模板、调用方兜底 fail-open 页恒 200）；保 MCP env-clean（Redis 不进 explain-llm.ts）。
**Non-Goals**：装配 deadline 真取消（拆独立变更）；开 llm 本身；/model-radar 加鉴权；MCP 成本边界；改解释正确性（召回/候选/verdict/canonical/三守卫）；SAG/多跳。

## D1 缓存整条 explanation 串（非只叙述段）——render_now-free 使其安全

评审证实：`renderTemplate`/`renderReferenceList` 均与 `render_now` 无关，`renderedBy='llm'` 的 explainer 返回串（模板段 + 叙述段 + 参考清单）是 `(candidates, evidence)` 的纯函数。故：
- **被缓存串 = explainer 的返回值**（`renderTemplate 段 + 叙述段 + 参考清单`），**显式排除 `recommend()` 拼接的 guidance 前缀**——`recommend.ts:367-368` 把 explainer 返回当 narration、另做 `[guidance, narration].join`，guidance 从不进 explainer（只传 `{query, candidates}`）、命中时由 `recommend()` 现拼（guidance 是 `(version, setupHash)` 的纯函数、render_now-free、逐字节重导）。**误缓存 `result.explanation`（含 guidance）⇒ 命中注入 `()=>cached` 后 `recommend()` 再前置一次 ⇒ guidance 非空场景（无 primary 的 `composeNoEligible`、他币种说明）双写 guidance**（primary 存在时 guidance 空、不显、潜伏）。不缓存叙述段单独（会逼出「命中时参考清单需 kbHits 却禁装配」的悬空引用矛盾）——缓存 explainer 整个返回即绕开。
- **写侧捕获机制**：web **包裹**注入的 explainer、截获其返回值作 narration 串；`onRender(renderedBy)` 保持 `void`、仅作**写闸**（`renderedBy==='llm'` 才写该 narration）。命中 ⇒ 注入 `() => cachedNarration` 作 explainer、`recommend()` 现拼 guidance、**不装配、不调 LLM**（同时省 embed/DB 与 LLM）。
- 键 `mr:explain:<version>:<setupHash>`；`version` = 快照内容哈希（rebuild 内容变 ⇒ 新 version ⇒ 旧键不命中）。
- **只缓存 `renderedBy='llm'` 成功产物**：`llm-fallback-template`/`template` 不写（不固化一次性失败）。

## D2 buildExplainer 注入两回调——把 web-only 的 Redis 逻辑挡在 explain-llm.ts 外（保 MCP env-clean）

problem：只缓存 llm 成功段要 web 知道 `renderedBy`；permit 计数要在 explainer 内部「决定真发起 LLM」处 gate——但 explainer 是 env-clean（MCP 用）、Redis 不能进它。solution：`buildExplainer` 加两个 **opt-in 注入回调**（web 注入、MCP 不注入）：
- `onRender?(renderedBy: RenderedBy): void`——渲染末尾调，**只携 `renderedBy`**（保持 `void`），供 web 判「是否写缓存」（仅 `'llm'` 写）。被缓存的 narration 串由 web **包裹 explainer 截获**（见 D1），非经此回调传递。`RenderedBy` type-only 导出供 web 标注（编译期擦除、零 env-clean 代价）。
- `beforeLlmCall?(): Promise<boolean>`——**在证据非空、真发起 `callLlm` 之前** await；返 `false` ⇒ 跳过 LLM、走回落模板（`renderedBy='llm-fallback-template'` 或专门标记）。web 注入的实现 = daily-cap 检查（见 D3）。
- `Explainer` 签名不变（`(input)=>Promise<string>`）——回调是 buildExplainer 的选项，5e v2 的「v1 接口 = v2 接口」延续。**MCP 装配 buildExplainer 时不传这两回调 ⇒ 无 Redis、无 cap、无缓存、env-clean 铁律不破。**

## D3 日 LLM 上限：daily-cap namespace + 显式 cap + reason + permit 计数（真调 ≈ 2× cap）

- `dailyCapKey(now, namespace='rag')` / `checkAndBumpDailyCap({..., namespace, cap})`：加 opt-in `namespace`（**默认 `'rag'` ⇒ advisor 键 `rag:llmcalls:` 与行为逐字节不变**）；model-radar 调用点 **显式传 `{namespace:'mr', cap: env.MR_EXPLAIN_DAILY_LLM_CAP}`**（否则 `cap` 兜底取 `RAG_DAILY_LLM_CALL_CAP`——额度错）。
- `DailyCapResult` 加 `reason?: 'quota-exceeded' | 'infra-error'`（超限 vs Redis 抛错），供两态分别 log/指标——infra-error 是**可用性降级**（宕机期无 LLM 叙述），非成本放大。
- **permit 计数（permit-gate，计逻辑作答）**：web 注入的 `beforeLlmCall` 读 `checkAndBumpDailyCap({namespace:'mr', cap})` 的完整结果、**按 `reason` 分别记日志**后返 `.allowed`。它在 explain-llm.ts 的「证据非空、真发起 `callLlm` **之前**」被 await ⇒ **凡到达 gate 的请求都计一次**，含输出被三守卫弃用后回落模板的（callLlm 已真调、成本已生、不能不计）；**只有三源全空（LLM 从未调、gate 之前早返）不占配额**。`checkAndBumpDailyCap` 是 INCR-then-check：到达 gate 即 INCR、恰放行 cap 次 permit（超出者 INCR 了但回落模板）；命中缓存经平凡 explainer、不触 gate ⇒ 不计。（每 permit 至多 2 次真 `generateObject`，见下「重试口径」。）`false`（超限或 Redis 故障，两者 `allowed=false`）⇒ 跳过 LLM、模板层（fail-open：页恒可用）。advisor 的 `allowed=false ⇒ 拒服务` 是它调用点的解读，daily-cap 函数不变。
- **重试口径 + 真调上界（诚实登记）**：`callLlm` 在 8s 预算内「1 次 + 至多瞬态重试 1 次」（explain-llm.ts:349-367，每次 `run` 是一次真 `generateObject`）；`beforeLlmCall` 只在**首次** attempt 前 gate 一次（一次准入=一次逻辑作答，与 advisor「一次作答计一次」同口径）——故 permit 计的是**逻辑作答**，**每 permit 对应至多 2 次真 `generateObject`**，日真调上界 ≈ `2× cap`。选此（非逐 attempt gate）因：该重试是**应用侧**对 provider 瞬态错的重试（`maxRetries:0` 关 SDK 内建重试、`callLlm` 手动循环）、罕见、**非攻击者可控**（攻击者得约 1× cap），2×-bounded 已达「无限放大 → 有界」的成本安全目标，且逐 attempt gate 会把 Redis INCR 塞进 env-clean explain-llm.ts 的 `callLlm` 循环、破坏接缝。**operator 设 cap 时按 2× 计入**（headline「硬顶」故降为「permit 计逻辑作答、真调 ≈ 2× cap 上界」）。

## D4 单飞防 cache stampede——进程内 inFlight（非 Redis 租约）

version 翻转/TTL 过期后，对同 `(version, setupHash)` 的并发首请求会各自未命中 ⇒ 各自 gate + 装配 + 调 LLM。**仿快照 `cache.ts` 的进程内 `inFlight`**（`Map<key, Promise>`——注意 `cache.ts` 的 inFlight 本就是**裸进程内 Promise、零 Redis**）：同键并发 miss **复用同一 `produce()` promise**（首个装配+LLM+写缓存，其余 `await` 同一 promise 得同结果、settle 后清键）⇒ 至多 1 次 LLM。**部署单实例（compose app、deploy 无 replica/scale 提示）故进程内单飞足够**——不引 Redis 跨进程租约（免 leaseMs/PX 调参、免「lease < 最坏 produce 时长 ⇒ 锁中途过期 ⇒ 第二请求再调 LLM」的下界陷阱、免唯一 token + Lua compare-and-delete 释放）。fail-open：`produce()` 抛错 ⇒ 清键、各自回落模板、不缓存、不崩、下次可重试。（未来 web 多实例共享 Redis 缓存时再升级为 Redis 租约、`leaseMs ≥ 装配 deadline + 8s LLM + 重试余量`——届时独立处理。）

## D5 setupHash 稳定性 + 缓存新鲜度诚实登记

- **setupHash**：对 `RecommendInput` 的**固定字段序** + 数值 canonical 化（`maxMonthlyPrice` 数值归一、currency/usageProfile 枚举、model/tool/protocol）稳定序列化后哈希——等价输入同 hash（测试向量钉）。**先应用 recommend() 缺省**（`currency??CNY`、`usageProfile??medium`）再哈希，使 `{}` 与 `{CNY,medium}` 同 hash（免语义同而 hash 异的额外未命中；此为过缓存安全向、非错缓存）。**排除** `render_now` 与 web-only 的 `tokensPerRound`（不入 `RecommendInput`）。
- **预算连续、缓存按精确值**：`maxMonthlyPrice` 是连续数值（非「档」）——**不离散化**（不同预算 ⇒ 不同推荐 ⇒ 不能共享缓存，离散化会返错误解释）。故缓存只对**重复的精确查询**（真实用户刷新）省成本；**对抗性预算迭代（`?maxMonthlyPrice=1..N`）缓存被击穿——此时日上限封顶 LLM 花销**（对抗下无瞬态重试 ⇒ 爬虫至多耗尽 `mr` 当日 permit ≈ cap 次 LLM ⇒ 之后全退模板，按 namespace 隔离）。**诚实登记**：cap 只封顶 LLM，**不封顶证据装配**（embed + DB）——`beforeLlmCall` 必在装配之后（须先知证据空否才能「空证据不计数」），故对抗洪流/空证据查询仍每请求跑装配、且候选不随预算变时**重复 embed 同一素材 N 次**（纯浪费）；此装配成本削减是**已拆出的 `add-model-radar-assembly-deadline-cancel`** 范围，本变更 scope 到 LLM 成本、**不加装配 cap**（`..._LLM_CAP` 命名已界定，加装配 cap 即 scope creep）。
- **缓存新鲜度界 = TTL（非 version）**：**现价变化会同时改快照 currentPrice ⇒ version bump ⇒ 旧键失效**（这部分并非正交）；与 version 正交、须靠 TTL 兜的叙述证据**不止 KB**——`kb_documents` 新增、`mr_price_history` 的**非现价变更/回填**（不改 currentPrice 故不 bump version）、近 30 天窗随 `now` 滑动、`pendingReview` 待复核文本（assembleEvidence live DB 读、不入快照 DTO）——均与 version 正交、统一由 **TTL** 兜（`EXPLAIN_CACHE_TTL_MS = 15 * 60 * 1000`，模块常量；叙述段非权威、短 TTL 权衡新鲜度与命中率）。TTL 机制对全部正交项一致兜底、无洞。

## Risks / Trade-offs

风险与处置随各决策就地登记：Redis 不可用 → D3（`allowed=false` fail-open 回落模板、零 LLM，reason=infra-error 可见、不存在「无界 LLM」分支）；调用方任一环 reject → 顶层兜底 try/catch 回落默认模板、页 200（spec「web 调用方兜底 fail-open」）；对抗击穿 → D5（LLM 上限 + 装配成本拆出；真调 ≈ 2× cap 上界、瞬态重试所致）；叙述新鲜度 → D5（现价 ∈ version、KB 新增/price_history 回填/待复核 正交、TTL 统一兜）；单飞故障 → D4（清键各自回落 fail-open）；namespace 波及 advisor → D3（默认 `'rag'` 逐字节不变、测试钉）。

## Open Questions

（无——缓存整条串、回调注入接缝、permit 计数（真调 ≈ 2× cap）、单飞、调用方兜底 fail-open、新鲜度登记均已裁决。装配取消已拆出独立变更。）
