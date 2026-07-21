## MODIFIED Requirements

### 需求:运维告警落真实通道并由 DB 唯一约束限频

系统必须提供一个**运维告警 sink**，把工作流的 `AlertSink` 接到**真实推送通道**（复用既有 sender），并把「同一告警今天已发过」的限频状态**放进 DB 的推送幂等唯一约束**里。

**装配现状（截至本次修订）**：真 sink 已在三处注入——日报链 `run-daily-workflow.ts` 的薄 `run(ctx)` 包装、告警链 `alert-scan.ts` 的同层包装、以及 staleness 车道的 worker 装配；生产 `alert()` 调用点共 12 处。下文的「只落 stderr」描述的是**未注入时的回落**，不是当前现状。

**sink MUST 有界，其 DB 调用 MUST 用客户端超时。** `alert()` 的每次调用必须在有界时间内 settle，**即使 DB 无响应**——全部调用点都直接坐在业务 run 的 await 路径上。限频所依赖的 DB 调用必须各自带**客户端**超时：服务端 `statement_timeout` **管不到连接池获取等待**，而池耗尽时连接获取会无限排队且**不抛错**，于是任何只捕获异常的降级分支都不会被触发。

**单通道的串行 I/O timeout 配置预算 = 「认领耗时 + 发送耗时 + 终态写回耗时」的超时上限之和 = 5s + 10s + 5s = 20s；通道间并发，取最大值不叠加。** 该预算 MUST 由一条常量断言钉住，**两个超时常量 MUST 从模块 `import`**（故它们 MUST `export`）——否则断言恒绿、「调高任一超时常量会撞到检查」这句话就是假的。

它是**配置预算，不是墙钟上界**：20s 是可趋近的上确界（认领耗时 4.999s 而不超时时三项并不互斥），且 `setTimeout` 无调度延迟上界、渲染与发送的同步前段在计时器之外。该超时自 builder 交给超时包装时起算，覆盖「连接获取排队 + 握手 + 执行」全程，因此它同时是一个池竞争阈值——本进程自身的重查询占满共享池也会触发它。它是**单次 `alert()` 的**预算，不是 run 的：源级告警坐在逐源循环里，一个 run 的告警耗时按告警点数串行叠加（告警链每轮最坏 ≈80s；日报 job 最坏 ≈360s）。推导见变更的 `design.md` D4。

**两处 DB 调用的超时语义 MUST 分开定义**：
- **认领超时**：与「认领抛错」同路——不去重直接发 + 「限频不可用」标注。
- **终态写回超时**：发生在认领之后、且其失败分支的调用意味着消息未必已发出，MUST 只做有界返回 + 留痕；它**无法**补标注。

**客户端超时不取消底层写入**，被放弃的那次操作仍可能迟到落地，故本需求**不保证**任何确定终态。结局按「操作类型 × 底层结局 × 认领时该行已有状态」三轴判定：

- **认领超时**：本 attempt 永不写终态（无认领 id）。迟到的认领落地时——原状态非 `success` ⇒ 置 `pending`，留下无人收尾的孤儿行、且把 `failed` 的 `error_message` 抹成 NULL；原状态已是 `success` ⇒ 被 `status <> 'success'` 拦下。
- **终态写回超时**：被弃写永不落地 ⇒ 行滞留 `pending`、次轮可重新认领重发；迟到落地且该行仍非 `success` ⇒ 落成 `success` 或 `failed`，先后顺序决定次轮是否重发；该行已被另一 attempt 置 `success` ⇒ 被吸收态拦下。
- **被弃的认领跨日落地**：`push_date` 在语句构造时即算成常量绑进 SQL，故障跨日界时它仍带昨天的 `push_date`，可新插一行历史 `pending`。该行**无自愈路径**（认领只写今天、限频判据只看 `success`）。

**登记的降级**：状态机主键是 `(dedupKey, channel, push_date)`——每通道独立认领、独立占一行唯一键。认领超时时本 attempt 在超时前**没有观察到认领结果**，故无条件走降级直发（迟到的认领可能确实写了行，本 attempt 依然看不见）⇒ 慢库持续期内每一轮、每一通道各重发一条，且与日报链共用同一 dedupKey 的跨链去重同时失效。方向是「宁可重复，不可哑火」。

**`success` MUST 是吸收态**：终态写回 MUST 附带 `status <> 'success'` 条件。该竞争**并非由超时引入**：认领语句的唯一条件是「认领时该行 `status <> 'success'`」，两条认领 SQL 顺序执行（不必并发）即返回同一行 id；倒写还需两个 attempt 的生命周期交错，但不需要超时。超时只是把交错窗口拉大。归因的完整推导见变更的 `design.md` D3。

**吸收态收敛的是「行」，不是「发送」**：只要认领时该行还不是 `success`，认领语句就返回同一个 id ⇒ 每一个在首个 `success` 落库前完成认领的 attempt 都各发一条。故限频口径是「每 dedupKey 每通道每天至多一条 `success` **行**」——重复被压到「这样的 attempt 数」而非 1（当前两条链共用同一 dedupKey 使常见取值为 2，但那是取值不是上界）。限制发送次数需认领即持锁到终态或 fencing，属独立变更。反向（迟到的认领把 `failed` 倒回 `pending` 并清空 `error_message`）**未关闭**，属接受的降级：去重语义不受损，损失的是失败留痕。

**best-effort MUST 覆盖真 sink 的整个函数体**（detail 摘要与时间计算若在任何 try 之外，畸形入参就能让 `alert()` 真的 reject，打到无本地 catch 的调用点上——其中一些紧接抛出、另一些自陈「整步永不向上抛」）。其兜底日志 MUST 打出原始告警文本，只打异常对象会让该告警内容彻底消失。该 MUST 的主语是**真 sink**，不含默认的 `console.error` 实现与惰性构造包装。

**逐通道隔离 MUST 不被 best-effort 兜底吞掉**：单通道失败 MUST NOT 中断其余通道的投递——否则「所有调用点 MUST `await` ⇒ 投递有完成保证」这条收益在多通道下当场为假。

**为何必须有这条需求**（历史动机；本需求已落地，装配现状见下）：`AlertSink` 的默认实现是 `console.error`（`[pipeline][ALERT] …`），本需求落地前生产常驻进程**不注入任何其它实现** ⇒ 所有「系统级故障」告警（采集全挂 / 全 unprocessable / 源陈旧 / 降级熔断 / 租约已失 / 本变更新增的日期提取归零）**只落 stderr**。规范反复区分的「记日志 ≠ 告警」在实现里是**同一个 `console.error`，只差一个前缀**。故规范里任何一条「MUST 告警」在本需求落地前都是**空的**。

#### `AlertDetail` MUST 收窄为「必填 `dedupKey`」——由类型系统枚举全部调用点

sink 的限频与幂等**全部**建立在 `dedupKey` 上，而 `push_records.target_id` 是 `varchar(128) **NOT NULL**`。若 `AlertSink` 的 detail 仍是宽松的可选 `unknown`：

- 既有调用点**不传 `dedupKey`** ⇒ `target_id = undefined` ⇒ **NOT NULL 违反** ⇒ 被 sink 自己的 best-effort catch 吞掉 ⇒ **这些告警连 stderr 都不再有**（今天至少还进 stderr）；
- 而 sink 的单测（都会传 `dedupKey`）**全绿** ⇒ 假绿。

⇒ **为了让新告警落地而引入的 sink，会把已经存在的告警变成静默。** 故：

```ts
interface AlertDetail { dedupKey: string; [k: string]: unknown }
type AlertSink = (message: string, detail: AlertDetail) => void | Promise<void>;
```

**detail MUST 必填、`dedupKey` MUST 必填。** 理由是**枚举必漏、编译器不漏**——收窄类型会让**每一个**既有调用点编译报错，逼实现者逐个分配 `dedupKey`，而不是靠人去数有几处。

**`AlertSink` MUST 允许返回 `Promise<void>`，且所有调用点 MUST `await`**：sink 要做 DB INSERT + 网络发送 + 状态 UPDATE，全是异步。而工作流中数个告警调用点**紧接着就 `throw`**（降级熔断中止、租约已失）——不 `await` 则告警是一个游离的 Promise、工作流已在栈上抛错、job 已失败 ⇒ **投递零完成保证**。

#### 契约（MUST）

```text
createOpsAlertSink({ senders, dbh?, now? }): AlertSink
  // senders: Partial<Record<Channel, MessageSender>>——**通道集由 Object.keys(senders) 派生，
  //          不是一个独立入参**；dbh / now 均可选（默认共享池 / 系统时钟），供测试注入。

alert(message, detail) →
  ① dedupKey = detail.dedupKey                       // 类型上必填
  ② push_date = dateInTimeZone(now())                // 时区口径见下，MUST NOT 用 UTC 日
  ③ INSERT push_records (target_type='ops-alert', target_id=dedupKey,
                          channel, push_date, status='pending')
     ON CONFLICT DO UPDATE SET status='pending', error_message=NULL
       WHERE push_records.status <> 'success'          // 仅【未成功】行可被重新认领
     RETURNING id
     → 命中 0 行 ⇒ 今天已就该 dedupKey 在该 channel 告过【成功】 ⇒ 直接 return，不发
     → 命中 1 行 ⇒ 认领当日名额（含崩溃残 pending / 上次 failed 的重新认领）
  ④ 经 sender 发送（复用既有 sender，如 createFeishuSender）
  ⑤ 成功 → status='success'
     失败 → status='failed'（不删行）；MUST NOT 让该失败占用当日限频名额（见下）
```

**`push_date` 的时区口径 MUST 为 `dateInTimeZone(now, PUSH_TIMEZONE)`（`Asia/Shanghai`），MUST NOT 用 UTC 日**（`toISOString().slice(0,10)` 是最常见的错误写法）。**理由 MUST 逐字保留**：**UTC 日界 = 08:00 CST，而日报链恰在 08:03 CST 运行**——只差 3 分钟。用 UTC 日则 07:49 那一轮高频链的告警落 `push_date = D-1`、08:03 日报链的同一告警落 `push_date = D` ⇒ **唯一键不冲突** ⇒ 「跨两条链自动去重」这条收益**当场为假** ⇒ 持续故障期**天天双响**。`createOpsAlertSink` MUST 支持注入 `now`（可测），两条链 MUST 传同一口径的运行时刻。

**发送失败 MUST NOT 占用当日限频名额**：若把任意冲突都视为「今天已告过」（`ON CONFLICT DO NOTHING`），则失败留下的 `failed`（乃至崩溃残留的 `pending`）会挡死同一 `dedupKey` 当天的后续告警 ⇒ **一次发送失败 / 一次崩溃 = 该告警当天彻底哑火**。故限频判据 MUST 为「**仅 `status='success'` 的行才算今天已告过**」：认领用 `ON CONFLICT DO UPDATE ... WHERE status <> 'success'`（`failed` / 陈旧 `pending` 可被重新认领重发），失败时把该行置 `failed`（**不删行**、留痕）。此为实现所采形态，MUST 显式落地，不得留给实现者临时发明。

**通道选择 MUST 定死**：sink 的通道集 MUST 由注入的 `senders` **派生**（`Object.keys(senders)`），即「**已配置通道全集**」（与业务推送同口径），并逐个发送——MUST NOT 另收一个可与 `senders` 不一致的 `channels` 入参。**未配置任何通道时 MUST 回落 `console.error`，且 MUST NOT 写任何 `push_records` 行**——否则限频键会把「根本没有通道可发」也算成「今天已告过」，使通道配好之后当天仍然静默。

#### 限频状态住在 DB 唯一约束里

限频状态**必须**住在既有的 `UNIQUE(target_type, target_id, channel, push_date)` 里（推送幂等地基），**MUST NOT** 另建 Redis 键或进程内 Map。三条理由 MUST 一并读到：

- **零新状态**：进程内 Map 会在每次 redeploy 复位 ⇒ 任何「今天已告过 / 连续 N 轮」的判断永不达标 ⇒ **静默不告警**（正是本需求要修的失效模式的翻版）。
- **跨进程 / 跨重启 / 跨链自动去重**：日报链与高频告警链用同一个 `dedupKey` ⇒ 一条链先告了，另一条自动命中唯一键冲突而跳过（**该收益以上面的时区口径为前提**——用 UTC 日则跨链去重为假）。
- **与第一架构原则一致**：幂等由 DB 唯一约束保障，绝不交给应用层自由发挥。

#### `ops-alert` 命名空间的必然代价（MUST 显式登记）

**`target_type = 'ops-alert'` MUST 扩入 `target_type` 枚举的权威全集**（见「数据库 Schema 可迁移」：枚举集中收口、禁止散落字面量），与推送用的 `alert`（P0 实时告警的**内容**推送）**分属两个命名空间**、绝不复用——前者是运维告警（收件人是维护者、幂等键是故障 kind），后者是产品内容。

**代价**：任何**不按 `target_type` 过滤**的既有 `push_records` 查询会被 `ops-alert` 行污染。已核实一处：MCP 的「今日已推送内容」查询按 `push_date + status='success'` 取记录、**不过滤 `target_type`** ⇒ 一条 ops-alert 的 success 行会使「今日尚未推送」判定翻转为「已推送」，返回**空要闻段 + 空产品段**、且通道集合被 sink 的通道污染。故新增本 `target_type` 时 MUST 同步给该类查询加 `target_type IN ('event','product')` 谓词。**这是引入新 `target_type` 命名空间的必然代价，不是可选清理。**

#### 注入点

**告警 sink MUST 被常驻运行时注入**。注入点 MUST 落在**常驻 worker 实际调用的那一层**——worker 调的是薄 `run(ctx)` 包装（其职责自陈为「生产默认补齐 DI」），**不是**直调 `runDailyWorkflow(options)`。**MUST NOT** 把注入写成「worker 把 sink 传进 `runDailyWorkflow`」——那会把实现者指到一个 worker 根本不经过的入口，sink 照旧不生效。未注入时回落 `console.error` 的默认实现**只是本地 / 测试兜底**；若生产不注入，本需求全部落空。

**best-effort（MUST）**：sink 内部任何异常（DB 不可达、发送失败）MUST 仅记错误日志、**绝不向上抛**——告警链路不得反过来把它监视的工作流搞崩。

#### 场景:告警经真实通道送达并写推送记录
- **当** 工作流判定系统级故障并 `await alert(message, { dedupKey })`
- **那么** sink 以 `target_type='ops-alert'`、`target_id=dedupKey`、`push_date=dateInTimeZone(now, PUSH_TIMEZONE)` 写入 `push_records`（先 `pending`），经 sender 真实送达后置 `success`

#### 场景:前一次告警已成功后，同一 dedupKey 当天不再发送（跨进程、跨重启、跨链）
- **当** 同一 `dedupKey` 的告警**在前一次已写入 `success` 行之后**、于同一天被再次触发（同一进程重复轮次、进程重启后、或另一条链触发）
- **那么** `INSERT ... ON CONFLICT DO UPDATE ... WHERE status <> 'success'` 命中 0 行（已有 `success` 行）⇒ sink 直接 return、**不发送**——限频状态住在 DB 唯一约束里，不依赖任何进程内状态（进程内 Map 会在 redeploy 复位而使限频/连续计数永久失效）

#### 场景:push_date 用 Asia/Shanghai 日而非 UTC 日（否则跨链去重为假）
- **当** 高频告警链在 07:49 CST、日报链在 08:03 CST 各触发一次同 `dedupKey` 的告警
- **那么** 二者的 `push_date` **相同**（同为 `Asia/Shanghai` 的当天）⇒ 第二次命中唯一键冲突而跳过、**只响一次**。**绝不可**用 UTC 日——UTC 日界恰是 08:00 CST，与日报链的 08:03 只差 3 分钟，会把这两次告警落进 `D-1` 与 `D` 两个不同的 `push_date` ⇒ 唯一键不冲突 ⇒ 持续故障期**天天双响**

#### 场景:发送失败不占用当日限频名额
- **当** sink 写入 `pending` 行后，sender 发送失败
- **那么** 该失败 **MUST NOT** 使同一 `dedupKey` 当天的后续告警被限频跳过——限频判据为「仅 `status='success'` 行算已告过」，失败置 `failed`（不删行）后，下一轮的 `ON CONFLICT DO UPDATE ... WHERE status <> 'success'` 可重新认领该行重发。**绝不可**留下一行 `failed` 就让唯一键把当天的该告警彻底哑火；异常仅记错误日志、不向上抛

#### 场景:未配置任何推送通道时不写 push_records
- **当** 运行环境未配置任何推送通道
- **那么** sink 回落 `console.error` 输出告警，且**不写任何 `push_records` 行**——否则限频键会把「没有通道可发」也记成「今天已告过」，使通道配好之后当天仍然静默

#### 场景:生产常驻运行时必须注入本 sink
- **当** 常驻 worker 触发日报工作流
- **那么** MUST 在 worker 实际调用的那一层（薄 `run(ctx)` 包装——「生产默认补齐 DI」的那一层，**非** `runDailyWorkflow(options)` 直调入口）注入本 sink；不注入则回落到只落 stderr 的 `console.error` 默认实现，使规范里所有「MUST 告警」在生产里等于「MUST 记一行日志」

#### 场景:DB 无响应时告警仍经真实通道发出
- **当** 认领所需的 DB 调用挂住不返回（如连接池耗尽）
- **那么** 该调用在客户端超时后被判为限频不可用，告警**照常经真实通道发出**并带「限频不可用」标注；`alert()` 有界 settle

#### 场景:认领超时期间同一 dedupKey 每轮每通道各重发一条
- **当** 慢库导致认领持续超时
- **那么** 每一轮的每个已配置通道都因**本 attempt 未观察到认领结果**而各自走降级分支重发一条（状态机主键含 `channel`，两通道即两条），跨链去重同时失效——这是登记的降级，不得被描述为「多一条」，其成因亦不得被写成「DB 里没有 `success` 行」

#### 场景:终态写回超时只有界返回，最终状态取决于时序
- **当** 终态写回的 DB 调用挂住
- **那么** `alert()` 仍有界 settle；被放弃的写可能迟到落地，最终状态与是否重发按三轴时序矩阵判定，不得断言某个确定终态

#### 场景:迟到的失败写回不得覆盖已成功的行
- **当** 被放弃或并发的失败写回在另一 attempt 已写 `success` 之后才落地
- **那么** 该写入因 `status <> 'success'` 条件不生效，行保持 `success`，同一告警不因此被重复发送

#### 场景:单通道失败不中断其余通道
- **当** 多通道装配下其中一个通道的发送失败或抛错
- **那么** 其余通道 MUST 照常完成投递并各自写入自己的终态行；`alert()` 仍 resolve。**绝不可**让单通道失败中断整批——那会使「所有调用点 MUST `await` ⇒ 投递有完成保证」在多通道下为假，且该回归被 best-effort 兜底压成一行普通日志、从调用点看不出来

#### 场景:畸形入参不得让告警向业务路径抛
- **当** 传入的 detail 在 detail 摘要或时间计算阶段抛错
- **那么** `alert()` 仍 resolve，兜底日志中出现原始告警文本——调用点紧接的抛出不被替换，自陈「整步永不向上抛」的调用方不被击穿

