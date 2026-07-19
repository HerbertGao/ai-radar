## Why

5e v2 解释层的证据装配 `assembleEvidence`（`evidence.ts`）用 `Promise.race([assembly, timeout])` 对三源装配设 `EVIDENCE_ASSEMBLY_TIMEOUT_MS` deadline，但 **race 只弃置不取消底层调用**：超时后 `resolve(empty)` 让请求继续，但挂起的 `assembly`（`searchKbCore` 的 embed API 调用 + KB DB 查询、`assemblePriceChanges` 的价格 DB 查询）**仍在后台跑到底**——占用 DB 连接池、继续烧 embedding API 成本。这是 5e v2 生产开 `llm` 登记的**第二条前置**（第一条「公开页成本边界」已交付 PR #91）；单请求下无害，但公开页开 `llm` + 高并发/爬虫下，累积的**不可取消**装配调用放大成本、拉长连接占用。本变更让超时的装配工作被真取消、及时释放连接。

## What Changes

给证据装配加**超时真取消**（下层共享 API 全 opt-in、其它消费者逐字节不变，见 design § Non-Goals / D5）：

- **统一 deadline + 取消门闩**：`assembleEvidence` **恒**建 `deadlineAt` 与 `AbortController`；deadline 触发时 `resolve(empty)`（返回契约不变），**`ac.abort()` 置于 `Promise.race` 的 `finally`——装配无论超时、还是某子源早失败致 assembly 早于 deadline 结束，都恒取消仍在飞的 embed**（仅在 deadline 回调 abort 会漏掉「早结束遗留兄弟 embed」路径）；**DB 查询由 `statement_timeout` 独立约束**（不认 signal），早结束路径的在飞 DB 查询仍跑到原 deadline 才自终结（有界、仍释放，见 design D4 残余）。`signal` 与 `deadlineAt` 一并推给两个底层子源（单一时钟）。
- **embed 侧经 AbortSignal 真取消**：`signal` 透传到 `embedMany` 的 `abortSignal`（Vercel AI SDK 原生），中止在途 embedding HTTP 请求；abort 不重试（见 D2）。**两条 embed 实现都改**——web 的 `embedTexts` 与 **MCP 的 `embedTextsClean`（`embed-clean.ts`）**，缺一则该路径 embed 不被取消。
- **DB 侧经服务端 `statement_timeout` 真取消**（**非** signal——node-postgres 查询不认 AbortSignal）：`deadlineAt` 非空时把 KB 查询与价格查询包进**单连事务**、设 `set_config('statement_timeout', <剩余预算ms>, true)`，由 PG 服务端计时器中止查询并释放连接。**剩余预算 = `deadlineAt - now`**（非满常量——KB 查询在 embed 之后起步，满常量会晚于 deadline，见 D4）。**embed 走 abortSignal、DB 走 statement_timeout「双保」**覆盖装配两类底层调用。

**架构接缝（保 env-clean）**：`signal`/`deadlineAtMs` 是纯参数（无值 import），穿 `KbEmbed`/`SearchKbCoreParams`/两条 embed API 与 web/MCP 装配 lambda——env-clean 铁律不破（见 D5）。

## Capabilities

### New Capabilities

（无——是 `model-radar-recommender` 既有解释层「证据装配 deadline」行为的资源效率强化，不成立新能力。）

### Modified Capabilities

- `model-radar-recommender`：解释层 v1 需求的**装配 deadline 子条**从「race 只弃置不取消底层调用」强化为「race + 超时真取消（embed `abortSignal` + DB 单连事务内 `set_config('statement_timeout',…,true)` 剩余预算）+ 及时释放连接」。**fail-open 语义不变**（超时仍三空 + 日志、绝不阻塞主流程）；召回 / 候选 schema / verdict / canonical / 三守卫 / 解释正确性 / 缓存 / 日上限均不变。

## Impact

- **代码**：
  - `src/mr/recommend/evidence.ts`：`assembleEvidence` 恒建 `deadlineAt` + `AbortController`、**返回时（`finally`）恒 abort**（覆盖超时与早结束两路径）；`assembleKbHits`/`assemblePriceChanges` 收 `signal`+`deadlineAt`（searchKbCore 参 + 价格查询单连事务 set_config）；子源 catch 对 `aborted` 降级不记（见 D1）。
  - `src/dedup/embedding.ts` **与 `src/kb/embed-clean.ts`**：各自 options 加 opt-in `signal?`；透传 `embedMany` 的 `abortSignal`；各自重试循环 abort 不重试（见 D2）。
  - `src/kb/retrieval-core.ts`：`KbEmbed` 加 opt-in `signal?` 第二参；`SearchKbCoreParams` 加 opt-in `signal?` 与 `deadlineAtMs?`；`embed([query], signal)` + KB 查询 `dbh.transaction` + `set_config(remainingMs, true)`（见 D4）。
  - web `src/mr/web/model-radar-page.tsx` / MCP `src/mcp/tools/recommend-coding.ts` 装配 lambda：转发 `signal`（web→`embedTexts`、MCP→`embedTextsClean`）。
- **依赖**：零新第三方依赖（`AbortController`/`AbortSignal` 全局；`embedMany` abortSignal 与 PG `set_config('statement_timeout',…)` 均既有能力）。
- **配置**：无新 env；沿用 `EVIDENCE_ASSEMBLY_TIMEOUT_MS` 经 `deadlineAt` 单一时钟传播。
- **行为变化**：仅装配超时路径可见——超时后底层 embed（两条）与 DB 查询**真被中止、连接释放**（此前后台跑到底）；未超时路径与所有 signal-缺省消费者**逐字节不变**。**残余（诚实登记，见 D4 Risks）**：`statement_timeout` 界定查询执行时长、不界定连接池获取等待——满池纾解为部分。
- **非目标**：见 design § Non-Goals（开 `llm` 本身 / 公开页成本边界(#91) / 改召回·verdict·三守卫·解释正确性 / 改其它 embed·searchKbCore 消费者现有行为 / SAG·多跳）。
