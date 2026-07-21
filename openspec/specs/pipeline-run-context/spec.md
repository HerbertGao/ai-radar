# pipeline-run-context 规范

## 目的
定义流水线运行上下文接缝(run-context seam)的契约:driver 无关核心 + 薄 run(ctx) 包装,RunContext 镜像目标脊柱形状但不依赖它,lane 业务与 BullMQ driver 在直接 import 层解耦,按 lane 实有阶段发射 run-event 与结局。
## 需求
### 需求:driver 无关核心 + 薄 run(ctx) 包装

每条 lane 现有的 `run*(options)` 函数 SHALL 保持为 **driver 无关的核心**(`options` = 生产默认的 DI 注入面:`dbh`/`senders`/`channels`/`judge`… 生产默认值,测试可覆盖;新增可选 `emit` 字段供阶段发事件,**缺省 no-op**)。每条 lane SHALL 另暴露一个**薄 `run(ctx)` 包装**:把 `ctx` 映射到 `options` 的**运维可调子集**(含 `emit: ctx.emit`、`trigger`、`input`),以生产默认补齐其余 DI,委托核心。**driver 无关的契约是 `RunContext` 的形状**;`options` 是内部 DI 面,二者角色不同、不冲突。A0 MUST NOT 引入统一 `switch(ctx.trigger)`(Phase M)。

#### 场景:worker 经 run(ctx),测试与 smoke 直调核心
- **当** BullMQ worker 处理器触发某 lane
- **则** 它调 `run(ctx)`(包装把 `ctx.emit` 等映进 options 后调核心);而现有 3 个 lane 集成测试与 `smoke.ts` **继续直调 `run*(options)` 核心**注入 mock,不受 `run(ctx)` 包装影响(核心签名仅新增可选 `emit`,故直调方零破坏)

#### 场景:A0 不引入统一 trigger switch
- **当** 审视 A0 三条 lane
- **则** 无一 lane 引入 `switch(ctx.trigger)` 分派(仅 per-function seam)

### 需求:RunContext 镜像目标脊柱形状且不依赖它

`RunContext` SHALL 暴露 `input` / `trigger` / `config` / `logger` / `emit` / `propose`,形状镜像 hangar;MUST NOT `import @hangar/*`。`trigger` SHALL 携带每 lane 已定义的值(daily→`digest`、alert→`alert-scan`、weekly→`weekly-report`),使其可测、非 undefined。经 Zod 校验的 `env` 单例 MAY 被业务逻辑 import 作**可移植配置**(随 pilot 迁 hangar、非 driver 耦合);`ctx.config` 承载每 run 运维可调值。

#### 场景:本地镜像不引脊柱依赖
- **当** grep `run-context.ts`
- **则** 无 `import` 任何 `@hangar/*` 包

#### 场景:trigger 每 lane 有定义值
- **当** 某 lane 经 `run(ctx)` 执行
- **则** `ctx.trigger` 持其已定义值(`digest`/`alert-scan`/`weekly-report`),不为 undefined

### 需求:lane 业务与 BullMQ driver 解耦(直接 import 层面)

各 lane 的**业务模块**(`run-daily-workflow.ts` / `alert-scan.ts` / `weekly-report.ts`)MUST NOT **直接 import** BullMQ driver 符号(`bullmq` 的 `Queue`/`Worker`/`Job`/`job.data`,或经 `./queue.js` 转手的连接符号如 `buildConnection`),MUST NOT 读原始 `process.env` 做生产流程分支。BullMQ 调度/连接住在专门 driver 文件(`queue.ts`/`alert-queue.ts`/`weekly-queue.ts`/`worker.ts`),守卫**排除**这些 driver 文件(它们合法 import bullmq)。weekly 现在 `weekly-report.ts` 里经 `import {Queue,Worker,Job} from 'bullmq'`(:48)与 `import {buildConnection} from './queue.js'`(:71,`buildConnection` 定义在 `queue.ts:38`、由 daily 共享)传递依赖——拆分时把这两条 **import 行**及 queue/worker 工厂(含 `WEEKLY_REPORT_QUEUE`/`WeeklyReportJobData` 等支撑符号)搬入 `weekly-queue.ts`(`buildConnection` **定义留在 `queue.ts`**、仅 import 迁移),使 `weekly-report.ts` 业务在**直接 import** 层面无 bullmq。`env` 单例明确允许。

> 注:守卫是**直接 import** 的 grep 检查;transitive 依赖不在 A0 工具范围(仓内无 madge)。承重项是 BullMQ driver;daily/alert 现状本就无直接 bullmq import,故此闸对它们是回归护栏,对 weekly 是承重的实解耦。

#### 场景:业务模块直接 import 无 driver 符号
- **当** grep 三个 lane **业务模块**(排除 driver 文件)的直接 import
- **则** 无 `from 'bullmq'` / `Job` / `job.data` / 经 `./queue.js` 的连接符号(`env` 单例 import 允许)

#### 场景:调度行为不变
- **当** A0 落地(含 weekly-queue 拆分、worker-main 重指)
- **则** cron 注册(schedule/timezone)行为逐字不变;仅"构造 ctx→调 run(ctx)"的处理器 shim 改动

### 需求:按 lane 实有阶段的 run-event 发射与结局

每条 lane SHALL 在其**实有阶段边界(进入阶段时)** emit 一条粗粒度事件——daily 七(collect/dedup/score/select/digest/push/kb;`digest`=中文摘要写稿,是 `WorkflowAbortError` 两个抛出相之一(:769),另一在 score/value-judge(:631),故两个 abort 相都有前置 stage 事件;更细的 semantic-dedup/enrich/published-at/product/experience 折入相邻粗粒度阶段)、alert 五(collect/dedup/score/select/push,**无 kb、无 digest**)、weekly 二(select/push)。结局/失败事件**按 lane 形态**:

- **daily 的 run 级正常早退**(仅 `{skipped-locked, skipped-no-candidates}`——`aborted-degrade` 不在此列,见下)SHALL emit 一条 run 级终态事件;
- **alert / weekly** 的锁/跳过是**逐 channel / 逐 candidate**(run 不早退),SHALL emit **逐项**结局事件(不设 run 级 rollup);**alert 无降级熔断**;
- **降级熔断及其他抛错**(daily 在 value-judge/digest 阶段降级率超阈 `throw new WorkflowAbortError`(`run-daily-workflow.ts:631/:769`);lease-lost、dispatch-failed 等)由 **`run(ctx)` 包装捕获、emit 一条 `run.failed` 终态、随后 RE-THROW 原始错误**——使 `run(ctx)` 仍 reject,BullMQ job 照旧失败并按现有"整 job 重试外壳"重试(`worker.ts:7-11` 契约),`行为不变` 与"整 job 重试"不被破坏。`aborted-degrade` **不是**被返回的正常早退结局(它经 throw 表达),故不列入 daily 正常早退集。

事件默认落结构化 stderr(pino 兼容 `Logger` 接口,不加 pino);`run_events` 表可选。**阶段 + 结局**发射序列 SHALL 可经**单测 logger spy** 断言。

#### 场景:daily 时间线
- **当** 一次完整 daily run 完成
- **则** collect→dedup→score→select→digest→push→kb 七阶段事件齐备且有序

#### 场景:alert 时间线(无 kb)+ 逐 channel 结局
- **当** 一次 alert-scan run 完成
- **则** collect→dedup→score→select→push 五阶段事件齐备(无 kb 事件);每个推送 channel 发一条逐项结局事件(无 aborted-degrade)

#### 场景:降级/抛错 → run.failed 且 re-throw
- **当** daily 因降级熔断(`WorkflowAbortError`)或 lease-lost / dispatch-failed 抛错
- **则** `run(ctx)` 包装 emit 一条 `run.failed` 终态后 **re-throw 原错误**;`run(ctx)` reject,BullMQ job 失败并可按现有重试外壳重试

#### 场景:daily 正常早退发 run 级终态
- **当** daily run 因锁被占(`skipped-locked`)或无候选(`skipped-no-candidates`)正常早退
- **则** emit 一条 run 级终态结局事件(logger spy 可断言其存在)

#### 场景:weekly 时间线 + 逐 channel 结局
- **当** 一次 weekly run 完成
- **则** select→push 两阶段事件齐备;每个推送 channel 发一条逐项结局事件

### 需求:propose 为前向兼容 shim,A0 定义但不调用

`RunContext` SHALL 含 `propose(action: {tool: string; args: object})`,形状镜像 hangar。本地驱动上 `makeLocalCtx` 的 `propose` SHALL 直接执行该动作 handler(无审批)、emit `action.executed`、resolve 结果。**A0 各 lane 业务体 MUST NOT 调用 propose**(现有自动推送仍直排);propose 存在仅为 RunContext 形状完整、支撑 Phase M 机械替换,**仅在 `makeLocalCtx` 单测层**验证。

#### 场景:makeLocalCtx propose 单测
- **当** 单测以桩 handler 调 `ctx.propose({tool,args})`
- **则** handler 执行、发一条 `action.executed`、结果 resolve(不 park、不审批)

#### 场景:A0 无调用方
- **当** 审视 A0 各 lane 业务体
- **则** 无一处调用 `ctx.propose`
