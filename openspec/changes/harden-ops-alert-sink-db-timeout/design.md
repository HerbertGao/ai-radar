## Context

事实与行号见 `proposal.md` 的 Why，不在此重复。本节只记评审**实测**确认、且直接决定设计形状的几条。

> **本节行号是变更前的基线快照**，实现落地后即失效——引用时按符号名（`setStatus` / 认领 UPSERT / `withTimeout`）找，别按行号跳。

- 认领 `insert`（:265-284）在 try 内，其超时 reject **会**落进既有 `catch (claimErr)`（:288）。
- `setStatus`（:328-355）**不在**那个 try 内：由 :312（**发送失败**路径）与 :318（发送成功路径）调用，自带独立 catch。故终态写回超时**无法**走认领的降级分支、**无法**补标注；且 `:312` 那条意味着**消息未必已发出**，只有 `:318` 能确认已投递。
- `withTimeout`（:105）到点 reject、**不取消底层**；被弃 promise 已有 handler，不产生 unhandledRejection。
- drizzle builder 可赋值给 `Promise<T>`，但 **`QueryPromise.then()` 每次调用都重跑 `execute()`、无 memo**（见 D7 的围栏）。
- `:252-253`（`getPushDate(now())` / `detailLines(detail)`）在**所有 try 之外**——sink 体内唯一真能让 `alert()` reject 的区域。
- 12 处调用点**全部 `await`**；通道间 `Promise.allSettled` 并发，逐通道自带 catch（外层 try/catch **不会**吞掉逐通道隔离，已实测）。
- **今天就能倒写 `success`**：认领语句 `INSERT … ON CONFLICT DO UPDATE … WHERE status <> 'success' RETURNING id` 的复现条件只有一条——**认领时该行 `status <> 'success'`**。真 PG 实测**两条认领 SQL 顺序执行**即返回同一 id，`failed` 态同样。⇒ 「`pending` 态」不是前提；倒写本身需要两个 attempt 生命周期交错，但**不需要认领 SQL 并发、不需要超时**（详见 D3）；`alert-scan.ts:434` 与 `run-daily-workflow.ts:518` 共用 `dedupKey='source-health:<source>'` 只是提高撞上的频率。
- **状态机主键是 `(dedupKey, channel, push_date)`**：`channels` 由 `Object.keys(senders)` 派生（:247），**每通道各自认领、各占一行唯一键**。任何按 `dedupKey` 单维度写的量级都会漏掉一个维度。

## Goals / Non-Goals

**Goals:** 让「DB 挂了时不哑火」对 **DB 无响应**也成立；让 `alert()` 每次调用在**写明的**上界内 settle；让 best-effort 覆盖真 sink 的整个函数体。

**Non-Goals:** 见 `proposal.md` 非目标，逐条一致。

## Decisions

### D1：超时语义按「认领 / 终态写回」二分，各自落在不同的既有处置上

- **认领超时** ⇒ 落既有 `catch (claimErr)` ⇒ 不去重直发 + `RATE_LIMIT_UNAVAILABLE` 标注。这条兑现「宁可重复一条，不可哑火」。
- **终态写回超时** ⇒ 发生在发送**之后**、有独立 catch ⇒ 只能有界返回 + 留痕，**补不了标注**。

替代方案「在 sink 外层再包一层超时」：被否——外层超时只让**观察**有界，不进 `catch (claimErr)`，**告警照样不发**。

### D2：两条超时路径的结局是**时序相关**的，规范必须写成矩阵而不是断言

`withTimeout` 不取消底层写入，故被放弃的那次 DB 操作**仍可能迟到落地**。任何「行必然滞留 `pending`」「次轮必然重发」的确定性表述都是假的。矩阵按**操作类型 × 底层结局 × 认领时该行已有状态**三轴写：

| 操作 | 底层结局 | 认领时已有状态 | 本 attempt 的观察 | 该行的最终落点 |
|---|---|---|---|---|
| 认领 | 被弃写永不落地 | 任意 | `claimedId=null` ⇒ 降级直发 | 无本 attempt 写入；行保持原状 |
| 认领 | 被弃写迟到落地 | 无行 / `failed` / 陈旧 `pending` | 同上 | 迟到 UPSERT 置 `pending` ⇒ **无人收尾的孤儿 `pending`**；`failed` 的 `error_message` 被抹成 NULL |
| 认领 | 被弃写迟到落地 | `success` | 同上 | UPSERT 的 `WHERE status <> 'success'` 不生效 ⇒ 行保持 `success` |
| 终态写回 | 被弃写永不落地 | — | 有界返回 + 留痕 | 行滞留 `pending` ⇒ 次轮可重新认领重发 |
| 终态写回 | 被弃写迟到落地 | 该行仍非 `success` | 同上 | 落成 `success`（`:318` 路径）或 `failed`（`:312` 路径），取决于哪条路径的写迟到 |
| 终态写回 | 被弃写迟到落地 | 该行已被另一 attempt 置 `success` | 同上 | `status <> 'success'` 拦下 ⇒ 保持 `success`（D3 的吸收态即为此设） |
| 认领 | 被弃写**跨日**落地 | 昨日无行 | `claimedId=null` ⇒ 降级直发 | `pushDate` 在语句构造时已算成常量绑进 SQL ⇒ 迟到落地时仍带**昨天**的 `push_date` ⇒ 新插一行历史 `pending`。**无自愈路径**：认领只写今天、`hasAlertedToday` 只看 `success`，没有任何车道会再碰过去日期的行 |

**登记的降级（量级按三轴写实）**：认领超时时，本 attempt **在超时前没有观察到认领结果**（`claimedId=null`）⇒ 无条件走降级直发。**这才是 fail-open 的成因，不是「DB 里没有 `success` 行」**——迟到的认领可能确实写了行，本 attempt 也看不见。⇒ 慢库持续期内**每一轮、每一通道各重发一条**（状态机主键含 `channel`：2 通道即 2×）；alert-scan 每天 72–96 轮 × 每失败源一次 × 每通道一次。且日报链与告警链的**跨链去重同时失效**（二者共用同一 `dedupKey`）。方向仍是「宁可重复，不可哑火」，但这不是「多一条」，是「每轮每通道各一条」。

### D3：`success` 吸收态——修的是**既有**并发竞争，超时只是放大它

`setStatus` 写入附 `status <> 'success'`。**归因必须写到证据的精度，且只写到证据的精度**：

- **认领语句**的唯一条件是「认领时该行 `status <> 'success'`」——真 PG 实测**两条认领 SQL 顺序执行**（不必并发）即返回同一 id，`failed` 态同样。
- **倒写**需要的是**两个 attempt 的生命周期交错**（一个的终态写回还没落库，另一个已经认领并写了终态）——**但不需要认领 SQL 并发，也不需要任何超时**。

故**不得**把「`pending` 态」写成前提（不是判据），也**不得**把这条竞争说成「零并发即可发生」——交错本身就是一种并发。超时不取消底层写入，只是把交错窗口从毫秒级拉到秒级。

实测确认它**不破坏** `failed` 重试语义（`failed` 行仍满足 `<> 'success'`，可被重新认领、`error_message` 清空）。

**吸收态只挡「倒写」，挡不住「已经发生的发送」（边界要写死）**：只要认领时该行还不是 `success`，认领语句就返回**同一个 id**——不论此刻是无行（后到者等一会儿再拿到同一行）还是已有非 `success` 行。于是每一个在首个 `success` 落库前完成认领的 attempt 都各持该 id、**各自都会走到发送**。

⇒ 吸收态收敛的是**最终行状态**，**不是发送次数**：它把重复压到「在首个 `success` 落库前完成认领的 attempt 数」，**不是 1**。当前两条链共用 `source-health:<source>` ⇒ 常见取值是 2，但**那是取值不是上界**。故文件头与规范的口径必须是「每 dedupKey 每通道每天至多一条 `success` **行**」，**不得**写成「至多一条告警」；「当天只告一次」那条场景的前提也必须收窄为「**前一个 `success` 已落库之后**再触发」。真要限制发送次数需认领即持锁到终态或 fencing，属独立变更。

> 这段刻意不写 PG 内部机制（锁模式名、冲突重试路径、speculative insertion）——那些是我没有实测手段的具体性，写错过一次了。**可复核的事实只有一条**：真 PG 下认领语句在「该行非 `success`」时返回同一 id，这条有用例钉着。

**反向未关闭（接受的降级）**：被放弃的**认领** UPSERT 迟到落地时会把 `failed` 行倒回 `pending` 并把 `error_message` 抹成 NULL——去重语义不受损（两者同属可重认领），损失的是失败留痕。为一条 `error_message` 加 SQL 复杂度不划算。

### D4：超时值写死，**串行 I/O timeout 配置预算**进规范，并由常量断言钉住

`DB_OP_TIMEOUT_MS = 5_000`（**不是「5s 量级」**——预算算术依赖它是这个确切值）。不加 env 旋钮：这是内部故障判据。两个常量都 MUST `export`，否则下面那条断言只能内联字面量、恒绿。

**单通道串行 I/O timeout 配置预算 = `5s + SEND_TIMEOUT_MS(10s) + 5s = 20s`；通道间取最大值不叠加。** 配一条常量断言 `DB_OP_TIMEOUT_MS * 2 + SEND_TIMEOUT_MS <= 20_000`（**两个超时常量都必须从模块 `import`**，不得内联——右侧的预算值 `20_000` 本就是这条断言要守的那个数，写成字面量是对的）——否则「未来有人调高 `SEND_TIMEOUT_MS` 撞不到任何检查」这个自陈风险没有被消除。

**它是配置预算，不是墙钟 MUST。** 两条理由，规范里必须一并写到：

1. **20s 是可趋近的上确界，三项并非互斥。** 反例：认领耗时 `4.999s`（**不超时**）⇒ 拿到 `claimedId` ⇒ 发送挂起 `+10s` 超时 ⇒ `setStatus('failed')` 挂起 `+5s` 超时 ⇒ 合计 **≈19.9s**。「首尾互斥」只在「两端都**超时**」这个窄读法下成立，而预算的首项是「认领**消耗**至多 5s」，不是「认领超时」。断言的形状本身就是证据：它把三项**直接相加**——若真互斥，正确的断言该是 `DB_OP_TIMEOUT_MS + SEND_TIMEOUT_MS <= 15_000`。
2. **常量断言只证名义常量之和，证不了真实 settle**：`setTimeout` 无最大调度延迟上界，且渲染（`renderAlert`）与 `sender.send` 的同步前段跑在计时器之外。实测 2 通道全挂为 **15004ms**——已超过该场景对应算术的 15000ms（该场景认领确实超时 ⇒ `claimedId=null` ⇒ 写回直接返回，只命中 `5s+10s` 那一支）。任何写成「`alert()` MUST 在 20000ms 内 settle」的墙钟断言都是买不起的支票。

**这 5s 自 builder 交给 `withTimeout` 起算，覆盖「连接获取排队 + 握手 + 执行」全程**——计时器在 `Promise.race` 构造时同步挂上，此刻 drizzle 尚未 `execute()`、更没拿到连接。共享池上还跑着 pgvector KNN 与日报链批量写，故它实际更接近一个**池竞争阈值**而非「DB 病了」的判据；误触发的代价是重复告警 + 一条迟到落地的孤儿 `pending`。**不改值、不加 env 旋钮**（决定不变），但成因登记要包含「本进程自己的重活占满共享池」，不能只写成 DB 病理。

**有界性对入参规模沉默（登记，不加代码）**：`detailLines(detail)` 与 `renderAlert(...)` 的实参求值都跑在**任何计时器之外**，巨大/深层 detail 的 `JSON.stringify` 可以任意久。12 处调用点的入参全部有界（`ps.error` 是 Error，`formatError` 有 `CAUSE_CHAIN_MAX`），故非现实风险；为它加长度门是本变更不需要的机制。

**该预算是单次 `alert()` 的，不是 run 的。** 源级告警坐在**逐源循环**里（`alert-scan.ts:432-440` / `run-daily-workflow.ts:517-525`），DB 挂住时一个 run 的告警耗时按告警点数**串行叠加**：

- **告警链（alert-scan）**：其唯一调用点就在循环内，遍历 **4 源** ⇒ 每轮最坏 **≈80s**。
- **日报 job**：`run-daily-workflow.ts` 7 处中 **6 处在循环外**，`product-digest.ts` 3 处同属该 job ⇒ **9 个非循环点**；而日报的逐源循环遍历的是**全 9 源注册表**（不是 alert-scan 的 4 源）⇒ 最坏 **≈(9+9)×20s = 360s**。

必须登记，且不得让读者把 20s 读成 run 级上界——按 `dedupKey` 单维度或按 alert-scan 的 4 源去估日报链，会把量级低估约 3 倍。

**租约安全性（自设义务，此处兑现）**：`run-daily-workflow.ts:1017` 那处告警在 `lock.isHeld()` **已返 false 之后**（租约本就已失），20s 只推迟随后的 throw → BullMQ 重试；持锁区内的其余告警点也安全，因为续租是 `src/push/lock.ts:137` 的 `setInterval`，**不被 `await alert(...)` 阻塞**。

**对既有预算不变量的影响（两层都不兜）**：`src/config/env.ts:744-786` 启动期强制 `N×(F+A×L+W) < ALERT_SCAN_CRON 周期`（默认余量约 135s）。① **告警耗时不在该式内**——源循环最坏 ≈80s 是式外项；② 更根本的是，该 `superRefine` 以 `ALERT_SCAN_ENABLED === 'true'` 为**合取门**（`env.ts:753`），**车道未开时整条根本不求值**（当前生产正是此态，见部署备忘）。故**不得**写成「预算不变量会兜住这 +80s」。今天该路径无界（∞），本变更属严格改善、不触发启动拒绝；但该不变量**在两层意义上都不完备**，登记。

### D5：best-effort 覆盖**真 sink** 的整个函数体，而不是惰性包装

**不要动 `buildOpsAlertSink` 的惰性包装**：12 处调用点全 `await`，同步抛与 rejected promise 在 `await` 点不可区分 ⇒ 改它是可证的空操作。

真正的缺口在 `:252-253`。故把 `createOpsAlertSink` 返回的函数体整体纳入 try/catch，catch 内**回落 `consoleAlertSink` 语义**：打出原始 `message` 再打 err——只打 err 会让那条告警的**内容彻底消失**，正是本需求自己论证过的失效模式。

该 MUST 的主语是**真 sink**；`consoleAlertSink` 与惰性包装不在其内（前者不做渲染/时间计算，后者已有构造期 try/catch）。

### D6：`withTimeout` 的动词交给调用方

文案硬编码 `${label} 发送超时`，复用到 DB 后会打出 `[ops-alert][claim] 发送超时`——**一个字节都没发出去却指向发送子系统**，把排障引向错误的子系统。模板改为 `${label}超时（${ms}ms）`（无空格），三个 label 定死：`[ops-alert][claim] 认领` / `[ops-alert][setStatus] 终态写回` / `[ops-alert][<channel>] 发送`。

**别把理由写成「会污染 `error_message`」**：`error_message` 只由 `:311` 从 `sendErr` 取，即**只有发送超时**会落库（而它的 label 本来就正确）；认领与终态写回的超时串**永不落库**，只进 `console.error`。这条的收益全在 stderr 的可诊断性上。

### D7：为何不用仓内那套「真取消」写法

本仓已有可真取消的有界 DB 写法：单连事务内 `set_config('statement_timeout', …, true)`（`src/kb/retrieval-core.ts:154` / `src/mr/recommend/evidence.ts:195`，真 PG 57014 已被集成测试钉住）。它能取消在飞写入，从而让 D2/D3 的两条迟到写竞争**根本不存在**。

**收益不止 `statement_timeout`**：那套写法**取得连接后会重算剩余预算、`remainingMs <= 0` 就根本不启动查询**。它同样取消不了已在排队的 pool waiter，但把「僵尸 waiter」变成「拿到连接但不写」——**D2 矩阵里凡「被弃写迟到落地」的格子都会消失**（孤儿 `pending`、跨日孤儿、以及「落成 `success` 还是 `failed` 取决于时序」那一格）。

**仍不采用，理由只有成本**：为每处 DB 调用加一层单连事务壳，代价与收益不成比例。（**不要**把理由写成「它管不到连接池获取等待、故不采用」——那是 non sequitur：两者可叠加，`withTimeout` 管有界性、事务壳管取消，池耗尽仍由客户端超时兜住。）该收益属**未取的**，可在需要确定性时与「真取消 / fencing」同一变更里立项。**记录在此，免得下一个读者重问一遍。**

**围栏（承重）**：drizzle 的 `QueryPromise.then()` **每次调用都重跑 `execute()`、无 memo**。故被 `withTimeout` 包住的 builder **只许交给一个 `.then()` 消费者**——任何「给被弃 promise 补 `.catch()` 防 unhandledRejection」的加固都会让该 INSERT **跑两次**——告警路径上 DB 往返翻倍，而这正是池耗尽时最不该加压的地方；**不会**自动导致双发（真 PG 实测：两次认领要么各返 0 行、要么返同一 id，`sender.send` 仍只调一次）。且桩 `dbh` 测不出来。

## Risks / Trade-offs

- **[慢库被判坏]** → 新增的可观察 fail-open 语义（非「无变化」）；方向正确（噪音优于哑火）。
- **[认领超时期间每轮每通道各重发一条 + 跨链去重失效]** → **接受的降级**，量级按 `(dedupKey, channel, push_date)` 三维写实（D2）。
- **[迟到写造成的状态不确定]** → 结局按 D2 的三轴时序矩阵；确定性需可取消查询或 fencing，属独立变更。
- **[迟到认领抹掉 `failed` 留痕]** → 接受的降级（D3）。
- **[run 维度按源数扇出]** → 已登记（D4）；预算不变量不再完备也已登记。
- **[爆炸半径 = 全仓告警]** → 缓解：两个测试文件的既有用例零改动必须全绿（含真 PG 的 `alert-scan.integration.test.ts:1258-1440`）。
- **[两 attempt 重叠时仍双发]** → 吸收态只收敛行、不收敛发送（D3）；口径写作「至多一条 `success` **行**」。
- **[被弃的 waiter 不摘队，且排队先于新认领]** → 未设 `connectionTimeoutMillis` 时，没有任何东西会把 JS 侧已放弃的 waiter 从连接池的等待队列摘出（设了才会摘队 + reject），而该队列先进先出。故 ① **一旦有连接空出**，被弃的写就会拿到连接并执行——这正是 D2「迟到落地」那几行的机制；库彻底无响应、无连接归还时它一直排队，对应「永不落地」那几行（**两者不是矛盾，是同一队列的两种结局**）。② 每轮超时**新增**一个 waiter，池一空出先服务的是已经没人要的旧 UPSERT。本表语句是毫秒级，**方向登记、不写量级**。
- **[外部持锁时，被弃的认领会占住池位，时长不受本超时约束]** → 客户端超时让 `alert()` 有界，**不缩短连接占用**：被弃的认领拿到连接后仍会发出 UPSERT。自家 UPSERT 是 autocommit、毫秒级提交，**故占位要靠外部持锁者**（如生产库 psql 直连 `BEGIN` 后走开）：那时无 `lock_timeout` 会让它无限等锁、连接不归还，而共享池未设 `max`（取 node-postgres 默认 10）⇒ 少量这样的请求即让全进程 DB 消费者一起排队。即本变更不只是「仍被拖住」，它**按轮次持续往里加可能长期占位的请求**。最便宜的真缓解是连接级 `lock_timeout`，**属独立变更**。
- **[池耗尽仍拖住其它调用方]** → 接受的残余。

## Migration Plan

无迁移、无部署动作、无 env。回滚 = revert commit。

## Open Questions

无（D4 已兑现租约与预算不变量两笔自设义务）。
