## MODIFIED Requirements

### 需求:RunContext 镜像目标脊柱形状且不依赖它

`RunContext` SHALL 暴露 `input` / `trigger` / `config` / `logger` / `emit` / `propose`,形状镜像 hangar;MUST NOT `import @hangar/*`。`trigger` SHALL 携带每 lane 已定义的值(daily→`digest`、alert→`alert-scan`),使其可测、非 undefined。经 Zod 校验的 `env` 单例 MAY 被业务逻辑 import 作**可移植配置**(随 pilot 迁 hangar、非 driver 耦合);`ctx.config` 承载每 run 运维可调值。

#### 场景:本地镜像不引脊柱依赖
- **当** grep `run-context.ts`
- **则** 无 `import` 任何 `@hangar/*` 包

#### 场景:trigger 每 lane 有定义值
- **当** 某 lane 经 `run(ctx)` 执行
- **则** `ctx.trigger` 持其已定义值(`digest`/`alert-scan`),不为 undefined

### 需求:lane 业务与 BullMQ driver 解耦(直接 import 层面)

各 lane 的**业务模块**(`run-daily-workflow.ts` / `alert-scan.ts`)MUST NOT **直接 import** BullMQ driver 符号(`bullmq` 的 `Queue`/`Worker`/`Job`/`job.data`,或经 `./queue.js` 转手的连接符号如 `buildConnection`),MUST NOT 读原始 `process.env` 做生产流程分支。BullMQ 调度/连接住在专门 driver 文件(`queue.ts`/`alert-queue.ts`/`worker.ts`),守卫**排除**这些 driver 文件(它们合法 import bullmq)。`env` 单例明确允许。

> 注:守卫是**直接 import** 的 grep 检查;transitive 依赖不在 A0 工具范围(仓内无 madge)。承重项是 BullMQ driver;daily/alert 现状本就无直接 bullmq import,故此闸对它们是回归护栏。

#### 场景:业务模块直接 import 无 driver 符号
- **当** grep 两个 lane **业务模块**(排除 driver 文件)的直接 import
- **则** 无 `from 'bullmq'` / `Job` / `job.data` / 经 `./queue.js` 的连接符号(`env` 单例 import 允许)

#### 场景:调度行为不变
- **当** A0 落地(worker-main 重指)
- **则** cron 注册(schedule/timezone)行为逐字不变;仅"构造 ctx→调 run(ctx)"的处理器 shim 改动

### 需求:按 lane 实有阶段的 run-event 发射与结局

每条 lane SHALL 在其**实有阶段边界(进入阶段时)** emit 一条粗粒度事件——daily 七(collect/dedup/score/select/digest/push/kb;`digest`=中文摘要写稿,是 `WorkflowAbortError` 两个抛出相之一(:769),另一在 score/value-judge(:631),故两个 abort 相都有前置 stage 事件;更细的 semantic-dedup/enrich/published-at/product/experience 折入相邻粗粒度阶段)、alert 五(collect/dedup/score/select/push,**无 kb、无 digest**)。结局/失败事件**按 lane 形态**:

- **daily 的 run 级正常早退**(仅 `{skipped-locked, skipped-no-candidates}`——`aborted-degrade` 不在此列,见下)SHALL emit 一条 run 级终态事件;
- **alert** 的锁/跳过是**逐 channel / 逐 candidate**(run 不早退),SHALL emit **逐项**结局事件(不设 run 级 rollup);**alert 无降级熔断**;
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

