# 设计

## Context

`assembleEvidence`（`evidence.ts:171-199`）现状（评审已核）：
- `const deadline setTimeout(EVIDENCE_ASSEMBLY_TIMEOUT_MS)` → `resolve(empty)`；`Promise.race([assembly, timeout])`；`finally { clearTimeout }`。
- `assembly` = `Promise.all([assembleKbHits, assemblePriceChanges])`（+ 同步 `derivePendingReview`）。超时时 race 取 `timeout` 分支返回 `empty`，但 `assembly` 的 promise **无人取消**——底层 `searchKbCore`（embed API + KB DB 查询）与 `assemblePriceChanges` 的价格 DB 查询继续跑到底。
- **两条 embed 实现**：web 装配走 `embedTexts`（`embedding.ts:98`）；**MCP 装配走 `embedTextsClean`（`embed-clean.ts:63`）**（`recommend-coding.ts:152` 注入）——二者各自有 `maxAttempts` 重试循环、各自调 `embedMany`（from `'ai'`，`abortSignal` 原生支持）。**两条都要接 signal，否则该路径 embed 不被取消。**
- `searchKbCore`（`retrieval-core.ts:72`）：`const { query, dbh, embed } = params`；`[queryVec] = await embed([query])`（:97，embed 先跑）；`rows = await dbh…query`（:105，DB 后跑）。`KbEmbed = (texts) => Promise<number[][]>`（:23，现无 signal）。`dbh` 是 `import type` 的 `DbLike`（env-clean）——**其 `.transaction()` 支持是 D4 机制的前提，实现时须核**（全仓 `dbh.transaction` 有 20+ 处先例）。
- **env-clean 铁律**：`evidence.ts`/`retrieval-core.ts`/`embed-clean.ts` 链不值 import `config/env`/`db/index`/Redis；`EVIDENCE_ASSEMBLY_TIMEOUT_MS` 是 `evidence.ts` 内**非导出** const——`src/kb` 够不着它，故 DB 超时预算 MUST 由参数传入、绝不跨模块 import（见 D4）。

## Goals / Non-Goals

**Goals**：装配超时时底层 embed（两条实现）与 DB 查询被**真取消 + 及时释放连接**（成本/资源效率）；下层共享 API 的**其它消费者逐字节不变**；保 env-clean。
**Non-Goals**：开 llm 本身；公开页成本边界（已交付 #91）；改 fail-open 语义（超时仍三空 + 日志、绝不阻塞主流程）；改召回/候选/verdict/canonical/三守卫/解释正确性；改 `embedTexts`/`searchKbCore` **其它消费者**（去重管线、`search-kb` MCP）的行为；SAG/多跳。

## D1 assembleEvidence：统一 deadlineAt + AbortController（**恒取消**，返回契约不变）

`assembleEvidence` **恒**（非 opt-in——它是 mr-recommend 层、取消即其期望行为）建 `const deadlineAt = Date.now() + EVIDENCE_ASSEMBLY_TIMEOUT_MS` 与 `const ac = new AbortController()`；deadline 的 `setTimeout(…, EVIDENCE_ASSEMBLY_TIMEOUT_MS)` 回调只 `resolve(empty)`，**`ac.abort()` 放在 `Promise.race` 的 `finally`——装配无论经哪条路径返回都恒取消仍在飞的底层调用**（不止超时分支）。`ac.signal` 与 `deadlineAt` **一并**传给 `assembleKbHits`/`assemblePriceChanges`（deadlineAt 供 DB 侧算剩余预算，见 D4；单一时钟——embed abort 与 DB statement_timeout 共用同一 deadline）。
- **abort 恒在 finally（非仅 deadline 回调）**：某子源早失败（如一条 KB 候选 embed 立即抛非取消错）会让 `Promise.all`→`assembleKbHits` 早返 `[]`、assembly **早于 deadline** resolve，此时 timer 被 `clearTimeout`、deadline 回调永不触发；若 abort 只写在该回调里，早结束路径遗留在飞的**兄弟 embed** 就不被取消（原设计的漏取消路径）。故 abort 落 finally = 「装配停止等待即取消仍在飞的 **embed**」，覆盖**超时**与**早结束**两条路径。
- **finally-abort 只掐 embed，DB 由 statement_timeout 独立约束**（node-postgres 不认 signal，见 D4）：**超时路径**二者时点重合（deadline ≈ abort ≈ statement_timeout 到期）；**早结束路径**在飞的 DB 查询**不在早结束时点被取消**，仍跑到其 `statement_timeout`（≈ 原 deadline）才自终结——**仍有界、仍释放连接**（较本变更前「跑到底、无界」是改善），但「早结束即释放」在 DB 侧只兑现到「≤ 原 deadline」而非「≤ 早结束时点」。此早结束 DB 残余登记于 Risks。
- **返回契约逐字节不变**：超时仍取 `timeout` 分支返回 `empty`、按「三空 + 日志」fail-open；`finally` 仍 `clearTimeout`。正常完成时 assembly 的全部底层调用已 settle，finally 的 `ac.abort()` 落在已完成调用上是 **no-op**、不改结果（signal 事后置位属 assembleEvidence **自身**行为、非返回契约，辖域见 D5）。变化仅是仍在飞的底层调用被中止（而非跑到底被丢弃）。
- **预期取消不记为失败**（防增噪）：`assembleKbHits`/`assemblePriceChanges` 的既有子源 catch MUST 把「预期取消」降级为 debug/不记（标「预期取消」），非既有的「evidence.kbHits failed」错误日志。取消判定（`isExpectedCancel`）= embed 的 `AbortError` ∪ DB 查询取消错误（PG `57014` query_canceled / `statement timeout` 文案）∪ `signal.aborted` 门闩。**DB 侧判定 MUST 沿 `.cause` 链查**（此为本 D 段 SOT，tasks/spec 从此）：Drizzle 把 pg 错误包成外层 `Error`（外层 `.message='Failed query: …'`、`.code` 空），真 SQLSTATE `57014`/取消文案住 `.cause`（对真 PG 实测；仿 `pipeline/ops-alert-sink.ts` 同款 `.cause` 教训）——只查顶层则 DB 取消错逐条漏检、把有意取消记成失败噪声。`signal.aborted` 门闩与错误形态无关地兜底各式 abort 现身（未必都带 `name==='AbortError'`）；其对「abort 后真失败」的过宽代价登记见 Risks（单一权威、此处不复述）。

## D2 embed 侧真取消：signal → embedTexts **与 embed-clean.ts** → embedMany abortSignal（abort 不重试）

**两条 embed 实现都改**（缺一则该路径 embed 不被取消）：
- `embedTexts`（`embedding.ts`）：`EmbedTextsOptions` 加 opt-in `signal?: AbortSignal`；`run({ model, values, ...(signal ? { abortSignal: signal } : {}) })`。
- `embedTextsClean`（`embed-clean.ts`）：`EmbedCleanOptions` 加 opt-in `signal?`；同样 `abortSignal` 透传；MCP 装配 lambda 转发 signal。**它有独立重试循环、须同样改。**
- `EmbedManyFn` 最小契约类型加 opt-in `abortSignal?`（**全仓一个定义 `embedding.ts:41`、`embed-clean.ts` 经 `export type` 复用同一契约——改一处即覆盖两条 embed 实现**）。
- **abort 不重试**：两处重试循环的 catch 中，`if (signal?.aborted || isAbortError(error)) throw error`（不进下一 attempt——abort 是主动取消、非瞬态错，重试违背取消意图）。`isAbortError` 来源（`'ai'` 导出 vs `err.name==='AbortError'`）实现时定位。
- **缺省不传 signal ⇒ `abortSignal` 不出现 ⇒ 与现状逐字节等价**（保护 embed-clean 的其它调用面同理）。

## D3 signal + deadlineAt 穿透（KbEmbed / SearchKbCoreParams / 装配 lambda）

- `KbEmbed` 从 `(texts)=>Promise<number[][]>` 加 opt-in 第二参 → `(texts, signal?: AbortSignal)=>Promise<number[][]>`（**类型兼容**：既有 `(texts)=>…` lambda 少参可赋、兼容；要真取消的 lambda 才转发）。`searchKbCore` 内 `embed([query], params.signal)` 转发。
- `SearchKbCoreParams` 加 opt-in `signal?: AbortSignal` **与 `deadlineAtMs?: number`**（绝对 epoch 截止时刻——DB 超时预算的唯一来源，见 D4；缺省不传即现状）。
- 装配 lambda：web `(texts, signal)=>embedTexts(texts, { signal })`；MCP `recommend-coding.ts` 回调 `(texts, signal)=>embedTextsClean(texts, credentials, { signal })`（保持 env-clean、纯参数）。

## D4 DB 侧真取消：dbh.transaction + set_config（服务端计时器，非 signal 掐；剩余预算钳制）

**关键框架**：node-postgres 查询**不认 `AbortSignal`**（`ac.abort()` 对 DB 查询零作用）。故 DB 侧不由 signal 取消，而是——**`deadlineAtMs` 非空时**（非 signal——signal 只当 embed 侧门闩）——把查询包进事务并设 **服务端 `statement_timeout` 计时器**独立中止。embed 走 abortSignal、DB 走 statement_timeout，**二者「双保」覆盖装配两类底层调用**。

- **剩余预算，非满常量，且在事务回调内重算**（因 `searchKbCore` 内 embed 先跑、DB 后跑，且 `dbh.transaction` 获取连接本身可能等待）：`remainingMs = deadlineAtMs - Date.now()` MUST 在 **`dbh.transaction` 回调内、`set_config` 之前**算（即拿到连接之后）；`remainingMs <= 0` ⇒ **回调内不启动业务查询**（返空/`[]`——deadline 已过、embed 通常也已 abort），否则钳为合法正整数用于 statement_timeout。**绝不在 `transaction()` 调用之前算**——满池时连接获取等待可能跨过 deadline，事务前算的正预算已过期、查询会带过期预算继续跑近满预算（破坏「≤0 不启动」与单一时钟）。**绝不用满 `EVIDENCE_ASSEMBLY_TIMEOUT_MS`**（同理：embed 耗 4.9s 后才起步的查询会远晚于 deadline）。KB 与价格查询**均由 `deadlineAtMs` 非空驱动、均在各自事务回调内算剩余量**。
- **单连事务 + 自动 ROLLBACK**（MUST）：`dbh.transaction(async tx => { const remainingMs = deadlineAtMs - Date.now(); if (remainingMs <= 0) return <空/[]>; await tx.execute(sql\`select set_config('statement_timeout', ${String(remainingMs)}, true)\`); return <该查询跑在 tx 上>; })`。**MUST 用 `dbh.transaction`**（Drizzle 异常自动 ROLLBACK——statement_timeout 中止查询 ⇒ 抛错 ⇒ 自动回滚 ⇒ 连接干净归还池）；**不得**用手搓分步 `BEGIN/SET LOCAL/查询/COMMIT`（statement_timeout fire 时跳过 COMMIT ⇒ 连接留在 failed-tx 态污染池；且裸 `dbh.execute` 分步可能落到池中不同连接 ⇒ SET 与查询不同连、机制静默失效）。
- **`set_config('statement_timeout', <ms文本>, true)` 而非 `SET LOCAL statement_timeout = <ms>`**：PG 的 `SET` 命令不吃扩展协议绑定参数（drizzle `sql\`SET LOCAL … = ${ms}\`` 生成 `= $1` ⇒ 运行期语法报错）；`set_config(…, is_local=true)` 是函数调用、值可绑定参、且 `is_local=true` = 事务本地（同 `SET LOCAL` 语义、COMMIT/ROLLBACK 后复位）。全仓零 `statement_timeout` 先例（净新机制），此形态须钉死。

## D5 opt-in 范围 + env-clean

- **谁 opt-in**：`assembleEvidence` **恒取消**（D1，非 opt-in）。opt-in 在**下层共享 API**：`embedTexts`/`embedTextsClean`/`KbEmbed`/`SearchKbCoreParams`——**其它消费者**（`src/dedup` 去重管线、`search-kb` MCP 工具）不传 signal/deadlineAtMs ⇒ 无 abortSignal、无 tx、逐字节等价现状。「逐字节不变」承诺的辖域是**这些其它消费者**，不是 assembleEvidence 自身（它的返回契约不变、但行为新增了取消）。
- **env-clean**：`signal`/`AbortSignal`/`AbortController` 是全局，`abortSignal`/`set_config` 均既有能力，`deadlineAtMs` 是纯数值参——`evidence.ts`/`retrieval-core.ts`/`embed-clean.ts` 链**不新增任何值 import**；补 query-chain-env 静态 grep 覆盖不回退。

## Risks / Trade-offs

风险与处置就地登记：**裸 SET 污染池 / 手搓事务漏 ROLLBACK** → D4（MUST `dbh.transaction` + `set_config(...,true)`）；**满常量对晚起步 KB 查询不及时** → D4（钳为 `deadlineAt - now` 剩余量、≤0 不启动）；**abort 被当瞬态错重试** → D2（两处 catch 检 aborted/AbortError 直接抛）；**MCP embed 漏取消** → D2（embed-clean.ts 纳入范围）；**signal 破 env-clean** → D5（纯参数、无值 import、grep 锁）；**波及其它消费者** → D5（opt-in、缺省逐字节不变、少参可赋）；**fail-open 语义被改** → D1（超时仍三空 + 日志、返回契约不变）；**恒建 ac ⇒ llm 装配查询恒进事务**（多一对 BEGIN/COMMIT 往返）→ accepted-degraded（真取消的既定代价、正确性中性）。
**残余（诚实登记）**：
- **连接释放非绝对——`statement_timeout`/abort 不界定的三处**：`statement_timeout` 只界定**在飞查询的执行时长**、abort 只掐 embed；二者均不界定 **(a)** 连接池**获取等待**（满池时 `dbh.transaction()` 拿到连接**之前**阻塞）；**(b)** 事务**外壳语句** `BEGIN`/`set_config`/`ROLLBACK`（`statement_timeout` 是服务端 GUC，只作用于其后的**业务查询**，不掐外壳往返）；**(c)** **连接黑洞**（TCP 静默断而无 RST）——本池仅 `new Pool({connectionString})`、无 `connectionTimeoutMillis`/socket 超时（**全仓 `dbh.transaction` 通性、非本变更引入**），故一条在 (a)/(b)/黑洞下卡住的连接会滞留池 client 直到 OS TCP keepalive 超时、可跨过 5s fail-open 返回。本变更只令「**已在跑的业务查询**更快自终结、更快还连接」，对 (a)(b)(c) 无缓解——缚之需**池级** socket/连接超时（改共享池、波及所有消费者）＝**非本变更目标**。Why 的「耗尽连接池」纾解为**部分**（减小正常路径的占用时长、非消除上述滞留）。
- **早结束路径的 DB 查询只掐到原 deadline、非早结束时点**：finally-abort 立即掐 embed，但在飞的 DB 查询不认 signal（D4/node-postgres），仍跑到其 `statement_timeout`（≈ 原 deadline）才自终结。故 assembly 因某子源早失败而早于 deadline 返回时，一条已进 `runQuery` 的兄弟 DB 查询最多再占该连接至原 deadline（≤ 装配 timeout）。**仍有界、仍释放**，且较本变更前「跑到底、无界」是改善——但「早结束即释放」在 DB 侧只兑现到「≤ 原 deadline」。按需掐 DB 查询（`pg_cancel_backend` 另连发取消）属净新机制、非本变更目标。
- **`signal.aborted` 门闩把 abort 后到达的真失败也可能标「取消」**（accepted-degraded、log-only 折衷，此为该权衡的单一权威）：`isExpectedCancel` 以 `signal.aborted` **与错误形态无关**地兜底各式 abort 现身——两条 embed 实现 / `ai` SDK / node fetch / 自定义 abort reason 未必都带 `name==='AbortError'`（注：`DOMException` 在 Node ≥20 本就 `instanceof Error` 且 `name==='AbortError'`，能被形态检测捕获——门闩兜的是**不带该 name 现身**的那些 abort，非 DOMException）。**代价**：`ac.abort()` 只在 finally（`Promise.race` 落地后、`assembleEvidence` 已返回）置位 signal——此后某子源 catch 收到的**首个** reject 若是真故障（如一条仍在 pool-wait 的查询随后以 `ECONNREFUSED` 率先冒泡到 `Promise.all`），会因 `signal.aborted` 已置位被标「预期取消」不进 failed（更晚的兄弟 reject 由 `Promise.all` 吸收丢弃、根本不经此 catch）。**log-only**（取消/失败两分支同 `return []`、fail-open 结果不变）、**有界**（仅返回**后**的弃置分支——装配期 signal 恒 false、真失败照常记 failed）、**不藏系统性故障**（DB 真宕在众多**未超时**同步 DB 路径 signal 未置位处正常记 failed）。弃门闩、仅按错误形态判的替代会漏标不带 `name==='AbortError'` 的 abort 现身，故保门闩。

## Open Questions

（无——统一 deadlineAt、两条 embed 接线、DB 剩余预算 + 单连事务 + set_config、opt-in 范围、env-clean 均已裁决。`EVIDENCE_ASSEMBLY_TIMEOUT_MS` 沿用现常量、经 deadlineAt 单一时钟传播。）
