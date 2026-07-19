# Tasks

（不变式的理由与口径以 design 各 D 段为单一权威；下列任务只列**动作 + 验收**，`（见 Dx）`指回权威。）

## 1. embed 侧真取消（**两条实现** embedTexts + embed-clean，abort 不重试，见 D2）

- [x] 1.1 `src/dedup/embedding.ts`：`EmbedTextsOptions` 加 opt-in `signal?: AbortSignal`；`EmbedManyFn` 加 opt-in `abortSignal?`；`run({ model, values, ...(signal ? { abortSignal: signal } : {}) })`；重试 catch 中 `if (signal?.aborted || isAbortError(error)) throw`（不重试）。缺省不传 ⇒ 逐字节等价现状
- [x] 1.2 `src/kb/embed-clean.ts`（MCP 装配 embed 经此、非 `embedTexts`）：`EmbedCleanOptions` 加 opt-in `signal?`；同样透传 `embedMany` 的 `abortSignal`；其**独立重试循环**同样 abort 不重试
- [x] 1.3 单测（两条实现各一组）：注入 `embedManyFn` 桩 + `AbortController`——abort 后抛、**不重试**（桩计数 = 1）、桩收到的 args 有 `abortSignal`；缺省不传 signal ⇒ args 无 `abortSignal`、逐字节等价现状；空数组仍直接返 `[]`

## 2. 检索核心 signal + deadlineAt + DB 单连事务（见 D3/D4）

- [x] 2.1 `src/kb/retrieval-core.ts`：`KbEmbed` 加 opt-in 第二参 `signal?`（少参可赋兼容既有 lambda）；`SearchKbCoreParams` 加 opt-in `signal?` **与 `deadlineAtMs?: number`**；`searchKbCore` 内 `embed([query], params.signal)` 转发。**`deadlineAtMs` 非空时** KB 查询走单连事务（`dbh.transaction`、自动 ROLLBACK；不用裸 `SET`/手搓 BEGIN）：**`remainingMs = deadlineAtMs - Date.now()` MUST 在事务回调内（拿到连接后）算、≤0 回调内不启动返 []、绝不在 `transaction()` 之前算**（防满池获取等待跨 deadline 后带过期预算跑），再 `set_config('statement_timeout', remainingMs, true)`——完整代码形态见 D4。缺省不传 ⇒ 裸查询路径逐字节不变
- [x] 2.2 单测：signal + abort ⇒ embed 收 aborted signal；`deadlineAtMs` 非空 ⇒ 走 tx + `set_config` 且断言发出语句里 timeout 值是**字面/绑定参**非 `SET …=$1` 语法错；**制造 statement_timeout fire（取消错桩用生产真形态：真 SQLSTATE 57014 在 `.cause`）⇒ 断言错误冒泡出事务（建模 ROLLBACK）、同一 dbh 可立即再查**（真 PG 的 ROLLBACK/`is_local` 不泄漏由 `retrieval-core.integration.test.ts` 真连库证：`max:1` 池令超时+回滚后同物理连接的 0.2s 查询照常成功）；`remainingMs<=0 ⇒ 跳过查询返 []`；**连接获取等待跨过 deadline（注入慢 `transaction` 桩使拿连接耗时越过 deadlineAtMs）⇒ 回调内重算 remainingMs≤0 ⇒ 不发业务查询**（验回调内算、非事务前算）；signal/deadlineAtMs 缺省 ⇒ 裸查询路径不动（现有 searchKbCore 测 + `search-kb` MCP + 去重管线消费者零影响）

## 3. assembleEvidence 统一 deadlineAt + AbortController（恒取消、返回契约不变，见 D1/D4）

- [x] 3.1 `src/mr/recommend/evidence.ts`：`assembleEvidence` **恒**建 `deadlineAt = Date.now() + EVIDENCE_ASSEMBLY_TIMEOUT_MS` 与 `AbortController ac`；deadline 的 `setTimeout` 回调**只** `resolve(empty)`，**`ac.abort()` 置于 `Promise.race` 的 `finally`——装配无论超时还是某子源早失败致早结束都恒取消仍在飞的底层调用（覆盖两路径；仅在 deadline 回调 abort 会漏「早结束遗留兄弟 embed」，见 D1）**；`ac.signal` + `deadlineAt` 一并传 `assembleKbHits`（→ `searchKbCore({..., signal, deadlineAtMs: deadlineAt})`）与 `assemblePriceChanges`（价格 SQL 同 KB 模式：单连事务、**回调内**算 `remainingMs`、≤0 不启动、`set_config(remainingMs, true)`，见 D4 / task 2.1）。**返回契约不变**（超时仍三空 + 日志、`finally` clearTimeout）。**子源既有 catch 对 `signal.aborted`/`AbortError` 及 DB `statement_timeout`/`57014` 降级为 debug/不记**（预期取消非失败，见 D1）——判定 MUST **沿 `.cause` 链查**：Drizzle 把 pg 错误包成外层 `Error`（外层 `.message='Failed query: …'`、`.code` 空），真 SQLSTATE `57014`/取消文案住 `.cause`（对真 PG 实测），只查顶层则 DB 取消错漏检、退化成纯靠 `signal.aborted`（仿 `pipeline/ops-alert-sink.ts` 同款 `.cause` 教训）
- [x] 3.2 单测：注入慢 embed/DB 桩使装配超 deadline ⇒ 返回三空（既有断言）**且** signal 被 abort、embed 桩 abortSignal.aborted=true；**KB 与价格查询各制造 statement_timeout（取消错桩 MUST 用生产真形态——外层 `Error` + 真 SQLSTATE 在 `.cause`，非顶层 `{code:'57014'}` 假绿）⇒ 断言错误冒泡出事务（建模 Drizzle 自动 ROLLBACK）+ 取消降级不记 failed**（真 PG 的 57014/ROLLBACK/`is_local` 不泄漏由 `src/kb/__tests__/retrieval-core.integration.test.ts` 真连库证）；**价格查询制造「连接获取等待跨 deadline」（慢 `transaction` 桩使拿连接越过 deadlineAt）⇒ 回调内重算 remainingMs≤0 ⇒ 不发价格业务查询、不 set_config**（与 KB 分支 tasks 2.2 的 pool-wait 测对称——两条独立事务实现均须验「回调内算、非事务前算」）；超时路径不多打「子源 failed」错误日志（aborted/statement_timeout 取消降级）；**2 候选早失败+兄弟 embed 在飞 ⇒ 返回前兄弟被取消**（证 finally 恒 abort 覆盖早结束路径）；未超时 ⇒ 正常三源返回（finally 恒 abort 对已完成调用是 no-op、不影响结果）

## 4. web / MCP 装配 lambda 转发 signal + env-clean 钉（见 D3/D5）

- [x] 4.1 web `src/mr/web/model-radar-page.tsx` embed lambda `(texts)=>embedTexts(texts)` → `(texts, signal)=>embedTexts(texts, { signal })`；MCP `src/mcp/tools/recommend-coding.ts` embed 回调 → `(texts, signal)=>embedTextsClean(texts, credentials, { signal })`。env-clean 钉：三链不新增 config/env·db/index·Redis 值 import（见 D5）；补 query-chain-env 静态 grep 覆盖不回退
- [x] 4.2 单测：web/MCP 缺省路径逐字节不变；其它 `embedTexts`/`embedTextsClean`/`searchKbCore` 消费者（去重管线、`search-kb`）零影响；env-clean grep 恒跑绿

## 5. 验收

- [x] 5.0 **前置核**：web/MCP 两侧注入的 `dbh`（含 `assembleKbHits→searchKbCore` 与 `assemblePriceChanges` 各自用的句柄）均暴露 `.transaction()`——`McpDb` 为 node-postgres 全实例，已见 `recommend-coding.ts`→`build.ts` 的 `dbh.transaction` 先例；实现时复核
- [x] 5.1 全量 `pnpm typecheck && pnpm lint && pnpm test` 通过（含 embed/embed-clean/searchKbCore 既有消费者回归——signal/deadlineAtMs opt-in 缺省不变；5e v2 装配/解释层回归——超时路径新增取消、返回契约不变）
- [x] 5.2 `npm run spec:validate add-model-radar-assembly-deadline-cancel` 通过

## 6. 文档

- [x] 6.1 README / ROADMAP：5e v2 生产开 llm 前置 #2「装配 deadline 传播取消」补一句已交付（超时经统一 deadlineAt——embed 走 AbortSignal、DB 走单连事务内 `set_config('statement_timeout',…,true)` 剩余预算——真取消、释放连接；signal/deadlineAtMs 全 opt-in 缺省不变）；`mr-5e-v2-rag-explanation-shipped` memory 标 follow-up #2 完成（归档后由会话更新）
