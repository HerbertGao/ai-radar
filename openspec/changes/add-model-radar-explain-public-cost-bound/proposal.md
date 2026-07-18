## Why

5e v2 解释层已上线（PR #90），默认 `MR_RECOMMEND_EXPLAIN=template`。要在生产把 `/model-radar` 掰到 `llm`，第一条硬前置是**公开页无成本边界**：`/model-radar` 是**无鉴权公开 GET**（`jwt-middleware` 明令 CF Access 只挂 `/advisor`、不挂 model-radar）。开 `llm` 后每请求触发证据装配 + 1 次 LLM 调用；爬虫/刷新可无限放大 LLM 花销——同仓 `/advisor` 正因是公开 LLM 面才有日调用上限（`RAG_DAILY_LLM_CALL_CAP`）+ CF Access，而 `/model-radar` 二者皆无。本变更给公开页加**缓存 + 独立日上限**，使开 `llm` 成为安全的运营开关。**不打开 `llm` 本身**（仍是独立运营决策）。

## What Changes

`/model-radar` 的 `llm` 路径加两道成本边界（web 侧；MCP 排除——见非目标）：

- **整条解释缓存**：按 `(快照 version 内容哈希, 归一化 setup 参数哈希)` 缓存 `renderedBy='llm'` 的 **explainer 返回叙述串**（模板段+叙述段+参考清单、**不含 `recommend()` 的 guidance 前缀**）——它是 `(candidates, evidence)` 的纯函数、与 live `render_now` 无关（`renderTemplate`/`renderReferenceList` 均不读 `now`；相对 age 徽标在 web 组件、不在串内），故可安全缓存。命中 ⇒ 注入缓存串、由 `recommend()` 现拼 guidance 返回、**不调 LLM、不装配证据**（同时省 LLM 与 embed/DB 装配）；只写 `renderedBy='llm'` 成功产物（回落/模板不写，不固化一次性失败）。**单飞**（进程内 `inFlight` promise map，仿快照 `cache.ts`；单实例部署故进程内足够）防 version 翻转/TTL 过期后同键并发首请求各自调 LLM（cache stampede）。缓存层 fail-open + **调用方顶层兜底 try/catch**（Redis/单飞/produce/explainer 任一抛错 ⇒ 回落默认模板、页恒 200，绝不 500）。
- **日 LLM 调用上限**：复用 `src/rag/daily-cap.ts` 的 `checkAndBumpDailyCap`，给 model-radar **独立 namespace 键**（`mr:llmcalls:<date>`）+ **独立 cap**（新 env `MR_EXPLAIN_DAILY_LLM_CAP`，调用点显式传 `cap`）；advisor 用尽不拖累 model-radar。**上限计逻辑作答（permit）**（非请求数）——经注入 buildExplainer 的 permit-gate 回调在**证据非空、真发起 LLM 前**计数一次（空证据跳过 LLM 的请求不占配额）；因 `callLlm` 至多瞬态重试 1 次，**每 permit 至多 2 次真 LLM ⇒ 日真调上界 ≈ 2× cap**（该重试是**应用侧**对 provider 瞬态错的重试、罕见、非攻击者可控），operator 按 2× 设 cap。**超限或 Redis 不可用 ⇒ fail-open 回落模板**（区别 advisor 的 fail-closed 拒服务——公开展示页 MUST 恒可用，只退化解释）；`DailyCapResult` 加 `reason`（`quota-exceeded` / `infra-error`）供两态分别观测（infra-error 是可用性降级、非成本放大）。

**架构接缝**：缓存/日上限只在 web 调用方；`buildExplainer` 加 opt-in `onRender`/`beforeLlmCall` 回调，MCP 不注入 ⇒ Redis 绝不进 `explain-llm.ts`。**被缓存串 = explainer 返回的叙述串**（web 包裹注入的 explainer 截获其返回、**不含 `recommend()` 的 guidance 前缀**）——机制见 design D1/D2。

## Capabilities

### New Capabilities

（无——成本边界是 `model-radar-recommender` 既有解释层的生产就绪扩展，不成立新能力。）

### Modified Capabilities

- `model-radar-recommender`：解释层需求扩展——web 公开页 `llm` 路径的成本边界（整条解释缓存 + 单飞 + 独立 namespace 日上限 + permit-gate 计逻辑作答（真调 ≈ 2× cap），超限/Redis 不可用 fail-open 回落模板、调用方顶层兜底页恒 200），经 buildExplainer 的 opt-in 回调实现（MCP 不注入、env-clean 不破）。**召回 / 候选 schema / verdict / canonical / 三守卫 / 解释正确性逻辑均不变**（5e v2 已定）。

## Impact

- **代码**：
  - `src/rag/daily-cap.ts`：`dailyCapKey`/`checkAndBumpDailyCap` 加 opt-in `namespace`（默认 `'rag'` ⇒ advisor 键逐字节不变）；`DailyCapResult` 加 `reason`；错误日志去 advisor 专属措辞（中性/带 namespace）。
  - `src/mr/recommend/explain-llm.ts`：`buildExplainer` 加两个 opt-in 回调 `onRender`/`beforeLlmCall`（机制见 design D2）；`RenderedBy` type-only 导出；**`Explainer` 签名不变**。
  - 新建 web 侧缓存模块（如 `src/mr/web/explain-cache.ts`）：整条 explanation 串按 `mr:explain:<version>:<setupHash>` 缓存（Redis、TTL 模块常量、单飞、fail-open）；`setupHash` = `RecommendInput` 固定字段序 + 数值 canonical 化的稳定哈希。
  - `src/mr/web/model-radar-page.tsx`：`llm` 路径接缓存查/写 + 注入 `beforeLlmCall`（daily-cap `{namespace:'mr', cap: env.MR_EXPLAIN_DAILY_LLM_CAP}`，`allowed=false ⇒ 回落模板`）+ `onRender`（仅 `renderedBy='llm'` 写缓存）+ **整条 llm 路径顶层兜底 try/catch**（现 `:219-221 await recommend()` 无 try/catch，新机器引入新 reject 源须补——任一 reject 回落默认模板、页 200）。
  - `src/config/env.ts`：新增 `MR_EXPLAIN_DAILY_LLM_CAP`（具体默认值，见 tasks）。
- **依赖**：复用既有 Redis（web 已用）+ daily-cap；零新第三方依赖。
- **配置**：新增 1 个 env（`MR_EXPLAIN_DAILY_LLM_CAP`）；缓存 TTL 为模块常量。
- **行为变化**：仅生产设 `llm` 后可见——命中缓存不重复调 LLM、日上限保护、超限退化模板；`template` 默认路径**零变化**、MCP 路径**零变化**。
- **非目标**：
  - **装配 deadline 真取消**（AbortSignal 穿 embedTexts/searchKbCore/DB 释放连接）——原与本变更捆绑，评审揭示它 MODIFY 基装配条款 + 穿 6 模块共享基础设施、体量与影响面独立，**拆为独立后续变更**（`add-model-radar-assembly-deadline-cancel`）；现「race 只弃置不取消」是资源效率项、非本前置阻塞。
  - **开 `llm` 本身**（独立运营决策）；给 `/model-radar` 加 CF Access/鉴权（保持公开只读）；**MCP 侧成本边界**（MCP env-clean 禁 Redis、逐客户端低频非公开放大面——排除）；改召回/候选/verdict/canonical/三守卫；SAG/多跳；其他桶。
