## 1. 实现（全部落在 `src/pipeline/ops-alert-sink.ts`）

- [x] 1.1 新增模块常量 `DB_OP_TIMEOUT_MS = 5_000`（**确切值，非「量级」**——预算算术依赖它），置于 `SEND_TIMEOUT_MS`（:93）邻位。不加 env 旋钮。**两个常量都必须加 `export`**（`SEND_TIMEOUT_MS` 今天是裸 `const`）——否则 2.6 的断言只能内联字面量、恒绿（design D4）。
- [x] 1.2 `withTimeout`（:105）文案模板改为 `${label}超时（${ms}ms）`（**无空格**）；三个 label 定死：`[ops-alert][claim] 认领` / `[ops-alert][setStatus] 终态写回` / `[ops-alert][<channel>] 发送`。**先做这条**——否则下面两处复用会在一个字节都没发出去时打出「发送超时」，把排障引向发送子系统（design D6）。⚠️ 理由**不得**写成「污染 `error_message`」：`error_message` 只由 :311 从 `sendErr` 取，认领与终态写回的超时串永不落库。顺带更新 :104 的 JSDoc。
- [x] 1.3 用 `withTimeout` 包住**认领** `insert(...)`（:265-284）。超时由既有 `catch (claimErr)`（:288）接住 → `rateLimitDown = true` → 附既有 `RATE_LIMIT_UNAVAILABLE`。**不新增降级分支、不改文案、不改限频判据。** ⚠️ 该 builder **只许交给一个 `.then()` 消费者**——drizzle 的 `QueryPromise.then()` 无 memo，**绝不要**给被弃 promise 补 `.catch()`，那会让 INSERT 跑两次（design D7 围栏）。
- [x] 1.4 用 `withTimeout` 包住 `setStatus`（:328-355）的 DB 写入。同 1.3 的围栏。**它与 1.3 语义不同**：在发送之后、有独立 catch，超时只能有界返回 + 留痕（design D1/D2）。
- [x] 1.5 **`success` 吸收态**：`setStatus` 写入条件加 `AND status <> 'success'`。注释只写「这是既有缺陷、与超时无关」+ 指向主规范该 requirement，**不要在注释里复制归因论证**——它的真值依赖实测，放在代码里没有任何机械守卫，改一次就会与规范漂移（这正是本变更 review 三轮的主要 findings 来源）。
- [x] 1.6 **把 `createOpsAlertSink` 返回的函数体整体纳入 try/catch**，覆盖 `:252-253`（在所有 try 之外）。catch 体**回落 `consoleAlertSink` 语义**：`console.error('[pipeline][ALERT] ' + message, err)`——**只打 err 会让该告警内容彻底消失**。**不要**改惰性包装为 `async`（design D5：可证空操作）。
- [x] 1.7 文件头注释校正（同一段里现有四处陈旧/不完整）：① :32-34「认领本身**抛错**」→「**抛错或无响应**」；② :21-26 的接线——`run-daily-workflow.ts` 实为 **7 处** `alert()`、`alert-scan.ts` **有 1 处调用（:434）且 :662 已注入**、staleness 经 `worker-main.ts:196` 也已接；③ :22-23「重复告警的真实来源是 BullMQ 重试」已失效（跨链共用 `source-health:<source>`、每天 72–96 轮才是主来源）；④ :8-19 的状态机叙述与 `setStatus` 的 JSDoc（:324-327）补「`success` 是吸收态」。

## 2. 测试

> **落位**：2.1 / 2.3 / 2.5 是纯行为用例，可用桩；**2.2 / 2.4 必须进既有的真 PG `describe`**（`d(...)`，:31-32）——它们断言的是**真实行状态**与 **SQL 谓词求值**，桩 `dbh` 里既没有「行」也不会求值 `status <> 'success'`，断言的只会是桩自己的实现（该测试文件 :4-6 自陈的教条）。构造 deferred 用「转发真 `db`、但把那一次 update/insert 延迟释放」的**薄代理**。
> **不要**以「无 `DATABASE_URL` 会被静默跳过」为由把它们移出门控——该前提为假：`src/config/env.ts:4` 自动加载 `.env`、:830 立即校验缺失即 throw，`hasDb` 恒真、`describe.skip` 分支不可达。
> **假时钟**在 `it` 体内启用，用 `await vi.advanceTimersByTimeAsync(...)`（同步版不 flush microtask），`afterEach` 恢复。

- [x] 2.1 认领 `insert` **永不 resolve** ⇒ 推过 `DB_OP_TIMEOUT_MS` 后：`sender.send` 被调用、消息含 `RATE_LIMIT_UNAVAILABLE`、`alert()` resolve。
- [x] 2.2 **（真 PG）** `setStatus` 写入 deferred ⇒ `alert()` 在界内 settle；随后释放该写，断言最终状态**按三轴时序矩阵**成立（不要断言「必然滞留 `pending`」——被弃的写会迟到落地，design D2）。
- [x] 2.3 dbh 与 sender **全挂** ⇒ `alert()` 在界内 settle 且 stderr 留痕。
- [x] 2.4 **（真 PG）`success` 吸收态**：deferred 构造「旧 attempt 的 `setStatus('failed')` 被弃 → 新 attempt 写 `success` → 再释放旧写」⇒ 断言最终仍为 `success` 且后续不重发。**真 SQL 必须打到 PG，谓词由 PG 判**。另加一条**无 timeout、且顺序（非并发）两次认领**的用例——该竞争今天就存在且不需要并发（design D3）。
- [x] 2.5 **best-effort 覆盖 sink 体**（钉 1.6）：入参必须是**确实会在 `:252-253` 抛错**的——`formatDetailValue`（:139-151）的 `JSON.stringify` 已自带 try/catch 回退，故**循环引用与普通 `toString` 抛错都不会抛**（实测分别得 `"[object Object]"` / `"{}"`）。用 `{ toJSON(){throw}, toString(){throw} }`、`ownKeys` 抛错的 Proxy，或注入抛错的 `now()`。断言 `alert()` **resolve** 且 **stderr 中出现原始 `message` 文本**。
- [x] 2.6 **常量断言**（钉 D4 的**配置预算**）：`expect(DB_OP_TIMEOUT_MS * 2 + SEND_TIMEOUT_MS).toBeLessThanOrEqual(20_000)`。一行，无夹具。⚠️ **两个常量必须从模块 `import`（由 1.1 export），禁止内联字面量**——内联的断言恒绿，「调高 `SEND_TIMEOUT_MS` 会撞到检查」就是假话。**它只钉名义常量之和，不是墙钟断言**：不得据此加「`alert()` 必在 20000ms 内 settle」的计时用例（实测双通道全挂 15004ms > 算术 15000ms，design D4）。
- [x] 2.7 **回归**：① `ops-alert-sink.integration.test.ts` 既有 10 条（:78/:95/:111/:134/:161/:179/:189/:209/:247/:317）零改动全绿，特别是 :189-207 的 `brokenDb`（同步抛）仍落进同一 catch；② **`alert-scan.integration.test.ts:1258-1440`**（真 sink + 真 PG）零改动全绿，其 `:1345` 直压「发送失败置 `failed` → 下轮重新认领重发」，正是 1.5 触碰的路径。
- [x] 2.8 `npm run typecheck && npm run lint && npm run test` 全绿；守 `test-no-prod-sends`。

## 3. 收尾

- [x] 3.1 `git diff` 复核：**未触发超时、且无并发双 attempt 交错时**行为与今天等价。**注意两处有意的差异**：慢库被重新分类为故障；吸收态改变了既有并发倒写场景的最终状态。人眼动作，机械保证来自 2.6/2.7。
- [x] 3.2 `npm run spec:validate harden-ops-alert-sink-db-timeout` 通过。
- [x] 3.3 提 PR；合并后 `/opsx:archive`。
- [x] 3.4 **部署无动作**：无迁移、无新 env。
