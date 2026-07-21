## Why

运维告警 sink 的一条自陈不变量**在最需要它的故障形态下是假的**。

`src/pipeline/ops-alert-sink.ts` 文件头（:32-34）写着：**「DB 挂了时不哑火」——认领本身抛错 → 降级为不去重直接发**。该降级分支确实存在且正确（:288-295）。**但它只对「抛错」实现了，对「无响应」没有**：认领 `insert`（:265-284）与 `setStatus`（:328-355）是**无超时**的 DB 调用（只有 `sender.send` 被罩住，:300），而 `src/db/index.ts:17` 的共享池**未设 `connectionTimeoutMillis`** ⇒ 池耗尽时 `pool.connect()` **无限排队、不抛错** ⇒ `catch` 抓不到一个不发生的异常 ⇒ 告警既不发出、也不留痕。

影响面是仓内**全部 12 处生产 `await alert(...)`**（`run-daily-workflow.ts` 7 · `product-digest.ts` 3 · `alert-scan.ts` 1 · `mr/freshness/staleness.ts` 1），它们都直接坐在 run 的 await 路径上。**同一个坑本仓已在 `src/mr/recommend/evidence.ts` 与 `src/kb/retrieval-core.ts` 各记录过一次**（连接池获取等待不受服务端 `statement_timeout` 约束）。

## What Changes

- **给 sink 内两处无界 DB 调用各加客户端超时**（`DB_OP_TIMEOUT_MS = 5_000`），复用本文件既有的 `withTimeout`（:105）。两处**语义不同，分开定义**（design D1）：认领超时走既有降级分支（不去重直发 + `RATE_LIMIT_UNAVAILABLE` 标注）；终态写回超时只能有界返回 + 留痕。
- **写死单通道的串行 I/O timeout 配置预算**：`5s + SEND_TIMEOUT_MS(10s) + 5s = 20s`；通道间 `Promise.allSettled` **并发，取最大值不叠加**。**它是配置预算、不是墙钟 MUST**：20s 是**可趋近的上确界**（认领 4.999s 不超时 + 发送 10s + 写回 5s ≈ 19.9s，三项**并非互斥**），而 `setTimeout` 无最大调度延迟上界、渲染与 send 的同步前段又在计时器外——实测 2 通道全挂为 **15004ms**，已超**该场景**对应算术的 15000ms（那一场景认领确实超时 ⇒ 无认领 id ⇒ 写回直接返回）。该预算进规范，并由一条常量断言钉住。
- **让 `success` 成为吸收态**（`setStatus` 写入附 `status <> 'success'`）。**该竞争今天就存在、与超时无关**：认领语句只要**认领时该行 `status <> 'success'`** 就返回同一 id，两个 attempt 各持它、后到的 `failed` 即可倒写先写的 `success`（实测无 guard 时 `UPDATE 1`）。超时只是放大交错窗口。故本条是**顺带修复的既有缺陷**，不得写成「超时引入的竞争」。完整归因见 design D3 与规范。
- **补上真正没被 try 覆盖的那一段**：`:252-253`（`getPushDate(now())` / `detailLines(detail)`）在所有 try 之外，抛错会让 `alert()` **真的 reject**，打到 10/12 个无本地 catch 的调用点——其中 3 处紧接抛出（2 处 `WorkflowAbortError`、1 处租约已失的普通 `Error`），2 处在自陈「整步永不向上抛」的函数里。把 sink 返回的函数体整体纳入 try/catch，catch 内**回落 `consoleAlertSink` 语义**（打出原始 `message` 再打 err），使 `alert()` 恒 resolve。
- **`withTimeout` 报错文案把动词交给调用方**，避免 DB 挂住时打出「发送超时」——**一个字节都没发出去却指向发送子系统**，会把排障引向错误的子系统。（该串**不落库**：`error_message` 只由 `:311` 从 `sendErr` 取，认领与终态写回的超时都只 `console.error`。）

## Capabilities

### Modified Capabilities

- `platform-foundation`: 「运维告警落真实通道并由 DB 唯一约束限频」增补——有界性与客户端超时判据、单通道串行 I/O timeout 配置预算（连同「它不是墙钟上界」的两条理由）、两种超时语义的三轴时序矩阵、`success` 吸收态、best-effort 覆盖真 sink 整个函数体；并校正该需求中已过期的接线现状陈述与 `createOpsAlertSink` 的契约签名。

## Impact

- **代码**：`src/pipeline/ops-alert-sink.ts`、`src/pipeline/__tests__/ops-alert-sink.integration.test.ts`。
- **回归面**：除上述测试文件的既有 10 条外，还含 **`src/pipeline/__tests__/alert-scan.integration.test.ts:1258-1440`**（真 `createOpsAlertSink` + 真 PG，其 `:1345` 直压「发送失败置 `failed` → 下轮重新认领重发」，正是 `success` 吸收态触碰的路径）。
- **不改**：`src/db/index.ts` 池配置 · `AlertSink`/`AlertDetail` 类型形状 · 12 个调用点 · 幂等四元组 · 限频判据。
- **行为**：**未触发超时、且无并发双 attempt 交错时**，payload 与最终状态与今天等价。两处**有意的**差异：① 超时把「慢但活着」的库重新分类为故障（新增的可观察 fail-open 语义）；② 吸收态改变了既有并发倒写场景的最终状态（`failed` → 保持 `success`）。
- **DB / 迁移 / 部署**：无。

## 非目标

- **不给 `src/db/index.ts` 加 `connectionTimeoutMillis`**（根因另一半，影响全仓每次查询）。**登记为残余**：池耗尽仍会拖住其它调用方。
- **不改 12 个调用点**、限频判据、幂等四元组、类型形状。
- **不引入新 env / 依赖 / 进程**。
- **不承诺告警必达**；**不声称超时释放了连接**（`withTimeout` 不取消底层）。
- **不追求「终态一定落成某个值」**：被放弃的写入可能迟到落地，最终状态取决于时序（见规范的时序矩阵）。真正的确定性需要可取消查询或 fencing，属独立变更。
- **不把确定性状态交给 LLM**：超时、降级、限频、幂等全在程序与 DB 侧。
