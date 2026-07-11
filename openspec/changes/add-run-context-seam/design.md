## Context

写侧流水线(`runDailyWorkflow`:416 / `runAlertScan`:277 / `runWeeklyReport`:531)当前与 BullMQ worker、`acquireDigestLock`(Redis)、CLI(`smoke.ts` 直调)耦合。Plan A(`docs/hangar-migration-plan-a.md`)最终要把写侧内核 re-host 到 hangar 脊柱(以 `run(ctx)` 驱动、零域)。本变更是 **Phase A0**:立起该 seam,让"谁驱动流水线"可替换,且**闸在 hangar 之外**(inbox Phase-1 未过、monitor 契约未定)。约束:本仓第一架构原则不变(确定性状态由程序+DB 保障,不交 LLM);纯重构、行为不变。

**现状要点(经代码核实,决定下方多处决策):**
- `RunDailyWorkflowOptions`(:153-237)约 **20 个顶层字段**,绝大多数是**测试 DI 注入面**(dbh/collect/judge/digest/sender/senders/channels/lock/staleness/semantic/kb/experienceMining…),且**在各阶段深处被消费**(collect 用 dbh、push 用 senders/channels);`worker.ts`、`smoke.ts`、3 个 lane 集成测试都经它注入,VITEST 不真发生产靠钉 `channels`/注入 sender mock(memory `test-no-prod-sends`)。`runAlertScan` 现为单参 `runAlertScan(options: RunAlertScanOptions = {})`(alert-scan.ts:277)。
- 三条 lane 阶段**不齐**:daily 七个粗粒度阶段(collect/dedup/score/select/digest/push/kb;两个 abort 相 value-judge(score:631)与 digest(:769)都在其中);alert 无 kb、无 digest、无语义层、**无降级熔断**(`alert-scan.ts:26-28`);weekly 只 select+push(读 DB 已评分事件)。
- 业务模块读**原始 `process.env` = 0**(全走 `env` 单例)。`weekly-report.ts` 把 `runWeeklyReport` 与 `import {Queue,Worker,Job} from 'bullmq'`(:48)+ `import {buildConnection} from './queue.js'`(:71,transitive→bullmq)+ `createWeeklyReportWorker`(:702)**同文件**共置;alert worker 处理器在 `alert-queue.ts`(:104/:108);`worker-main.ts:38-41` 是 weekly 工厂的**唯一外部 importer**。
- 结局/失败形态**按 lane 不同**:daily **返回**的正常早退仅 `{skipped-locked, skipped-no-candidates}`(`aborted-degrade` 是 `WorkflowOutcome` union 声明值但**从不返回**——降级经 `throw new WorkflowAbortError`(:631/:769)表达;lease-lost/dispatch-failed 同样 throw)。alert/weekly 的锁/跳过是**逐 channel/逐 candidate**、run 不早退。**幂等只有一条物理约束** `push_records_target_type_target_id_channel_push_date_key = UNIQUE(target_type,target_id,channel,push_date)`(schema.ts:200);weekly 是它的**值特化**(`target_type='weekly'`、`target_id=iso_week`、push_date=合成 ISO 周周一),非另一条约束。

## Goals / Non-Goals

**Goals:**
- 每条 lane 保留 `run*(options)` 作 driver 无关**核心** + 一层薄 `run(ctx)` 包装(driver 面)。
- `RunContext` 形状镜像 hangar、不引其依赖 → 闸后机械替换。
- 按 lane 实有阶段发射粗粒度 run-event。
- 出口闸:lane 业务模块**直接 import** 无 BullMQ driver 符号。

**Non-Goals:**
- 不引 `@hangar/core`;不做真正迁移(pilot 拆分/app.yaml/compose = Phase M)。
- 不改任何流程行为、不改调度 cron 注册行为、不动去重/幂等/评分/选择。
- 不把现有自动推送改走 `propose`。
- **不把约 20 字段 DI 面塞进 ctx**(见 D2);**不把 `env` 单例读搬进 ctx.config**(见 D7)。
- 不引入 transitive 依赖图工具(madge 等);出口闸限直接 import。
- 不碰 MR / MCP / web;不碰 BullMQ durable 特性;`run_events` 表可选。

## Decisions

**D1. 本地 `RunContext` 镜像,而非现在 `import @hangar/core`。** hangar 未就绪、契约未冻;本地镜像让 A0 成"即使永不迁也净收益"的纯解耦,闸后把本地类型换成 `@hangar/core` 即可。

**D2. 保留 `run*(options)` 作 driver 无关**核心**,`run(ctx)` 是薄包装(不是反过来)。**
- 关键事实:约 20 字段 DI(dbh/senders/channels/judge…)在**各阶段深处**被消费,**无法**"留在适配层不进核心"。故:
  - **核心 = 现有 `run*(options)`**:options = 生产默认的 DI 面(生产走默认值,测试覆盖),**新增 `emit` 字段**供阶段发事件(缺省 no-op)。这就是 hangar 闸后要驱动的 driver 无关单元。
  - **`run(ctx)` = 薄包装**:把 `ctx` 映射到 options 的运维可调子集(`emit: ctx.emit`、`trigger`、`input`),生产默认补齐 DI,委托核心。
  - `ctx` = **driver 契约**(driver 传什么);`options` = 内部 DI 面(测试/生产接线)。二者角色不同——**ctx 不是 cosmetic**,它是 driver 面;options 不进 ctx。
- 备选①"把 20 字段塞 ctx.config":否决(hangar ctx 不承载 judge/senders mock,破机械替换)。备选②"ctx 外再挂 deps 参数":否决(破 run(ctx) 契约)。备选③"run(ctx) 是核心、options 是薄适配":否决——**这正是 round-2 查出的不可实现项**(DI 在阶段深处,薄适配层拿不到)。
- 收益:核心 20 字段基本不动,只加 `emit` + 一层薄包装 + weekly-queue 拆分;现有 3 个集成测试**继续直调 `run*(options)`** 注入 mock、VITEST 护栏原样,`smoke.ts` 经保留核心不破。

**D3. `emit` → 结构化 stderr 默认(pino 兼容 `Logger` 接口,**不加 pino**——本仓未装);`run_events` 表可选。** 观测性终交 hangar monitor;A0 的结构化 stderr 已够重建时间线,表在 Phase M 被 hangar `RunEvent` 取代。Logger 接口取 pino 形状,Phase M 换成脊柱/真 pino logger 零改接口。

**D4. 按 lane 实有阶段 emit + 按 lane 形态的结局/失败事件。**
- 阶段 emit **在进入阶段时**发:daily 七(collect/dedup/score/select/digest/push/kb)/ alert 五(无 kb)/ weekly 二。
- 结局:daily 正常早退(仅 `{skipped-locked, skipped-no-candidates}`)发 run 级终态;**alert/weekly 的锁/跳过逐 channel/candidate、run 不早退**,发**逐项**结局事件(不设 rollup);**alert 无降级熔断**。
- **失败:降级熔断(`WorkflowAbortError`)与 lease-lost/dispatch-failed 抛错,由 `run(ctx)` 包装 emit 一条 `run.failed` 终态后 RE-THROW 原错误**——`run(ctx)` 仍 reject,BullMQ job 照旧失败可重试(守 `worker.ts:7-11` 的"整 job 重试外壳"+ 行为不变)。`aborted-degrade` 非返回值、不入正常早退集。
- 序列经**单测 logger spy** 断言。备选"所有 lane 统一阶段集 + 统一单终态"否决(给 alert/weekly 造假阶段/错配终态)。

**D5. 区分"调度注册行为不变"与"worker 处理器 shim 可改"。** alert 处理器在 `alert-queue.ts`、weekly 处理器在 split 后的 `weekly-queue.ts`——必须改(构造 ctx+调 run(ctx));而 `worker-main`/`queue`/`alert-queue`/`weekly-queue` 的 cron 注册(schedule/timezone)**行为逐字不变**。

**D6. 把 weekly 的 queue/worker + 其 bullmq/连接 import 拆到 `weekly-queue.ts`。** `weekly-report.ts` 现把业务与 `import 'bullmq'`(:48)+ `import {buildConnection} from './queue.js'`(:71)+ worker 工厂共置。拆出时把这两条 **import 行**及 queue/worker 工厂(含 `WEEKLY_REPORT_QUEUE`/`WeeklyReportJobData` 支撑符号)搬入 `weekly-queue.ts`;**`buildConnection` 的定义留在 `queue.ts:38`**(由 daily 经 `worker.ts`/`worker-main` 共享、不可移动),仅 weekly 侧的 import 迁移。`worker-main.ts:38-41` 重指新文件,使 `weekly-report.ts` 业务在直接 import 层面无 bullmq。cron 行为逐字不变。

**D7. 出口闸定在 BullMQ driver 的直接 import,`env` 单例明确允许(取代 plan-a 早前口径)。**
- 承重耦合是 **BullMQ driver**(必须可替换);`env` 单例是经 Zod 校验的**可移植配置**,随 pilot 迁 hangar(inbox 也自带 config),**不是 driver 耦合**。
- 闸 = "lane 业务模块**直接 import** 无 `bullmq`/`Job`/`job.data`/经 `./queue.js` 的连接符号" + "无原始 `process.env` 生产流程分支";**不**把 `env.*` 搬进 ctx.config。transitive 图不在 A0 工具范围,故限直接 import、不宣称传递无耦合。
- **口径协调:本决策取代 `docs/hangar-migration-plan-a.md` §A0 早前括注"env 只在 ctx.config 装配处读"**(plan-a 已同步更新),避免两处真理源冲突。
- 推论(消解"不改流程行为"假绿):A0 **不搬 `env` 读的位置**,故不把某阈值/降级判定从 lazy-at-stage 改成 eager-at-assembly——评估时机不变。

**D8. `propose` 保留于类型、A0 不调用,仅单测层验证。** seam 目的是镜像 hangar 的 `RunContext`(它有 propose),省掉会破 Phase M 机械替换——"照 hangar 形状"是显式要求、属 never-simplify。类型含 `propose({tool,args})`;`makeLocalCtx` 给最小直执行实现;**A0 lane 体不调它**;scenario 定在单测层 + "A0 无调用方" grep。(承认:这是为 Phase M 的前向 scaffolding,Phase M 本身闸在 hangar 之后、可能不落地——刻意保留、非疏忽。)

**D9. ctx.trigger 每 lane 定值、A0 不 switch。** 携 `digest`/`alert-scan`/`weekly-report`;A0 不引 `switch(ctx.trigger)`。

**D10. `acquireDigestLock` 保留;emit 与锁的关系分三种。** 锁包整个 daily 核心(finally 释放)。**(a)** stage emit 与 `skipped-no-candidates` 终态(:934,在 try 内)在**锁内**;**(b)** `skipped-locked`(:436,`lock===null`、根本没持锁的 pre-lock 早退)其 emit 在**锁外/锁前**——本就无锁可入;**(c)** `run.failed` 由包装 emit,抛错时 finally 先释放锁、异常才到达包装,故在**锁外**(包装位于核心之外的设计使然)。三者均非漂移。Phase M 由 hangar run-lock 归并。

## Risks / Trade-offs

- **[纯重构行为漂移]** → parity oracle(非"逐字节"):在既有 mock LLM/embedding 集成测试下(**钉 `now`**——push_date/push_records 由注入 now 派生),断言**确定性面**(入选 event ID 集+排序、`push_records` 行)改造前后一致;baseline = 现有集成测试的钉定期望(可构建、非另存快照)。**阶段 emit 计数是前向断言**(daily 7/alert 5/weekly 2,before=0),非前后 parity。daily+alert 都做,weekly 见下。
- **[options→ctx 迁移丢测试护栏]** → D2 核心保留 `run*(options)`,3 个集成测试直调它注入 mock,VITEST 护栏原样。
- **[幂等回归被 mock 假绿 / weekly 覆盖最弱]** → 对**真集成 Postgres 双跑**(**钉 `now`**,防跨周一 00:00 落不同 ISO 周而 flake)断言**同一条**约束 `UNIQUE(target_type,target_id,channel,push_date)` 只落一行:daily+alert 用一般值,**weekly 单独覆盖其 `target_type='weekly'`/`target_id=iso_week` 值特化**(push_date 是合成 ISO 周周一、最易漂,且 weekly 正是被物理拆分的 lane,必须覆盖)。不靠 mock dbh、不只靠 `computePendingSet`。
- **[weekly-queue 拆分回归]** → 只搬 queue/worker/连接符号、不改 cron 行为;`worker-main` 重指新文件,行为逐字对齐。
- **[emit 契约在 monitor 落地时变动]** → kind 少而稳、视为临时契约,Phase M 对齐。

## Migration Plan

- 普通 PR 交付。纯重构 + 拆 weekly-queue,风险低。回滚 = revert;不建表、无 schema 变更、无数据迁移。
- 部署无特殊步骤;worker 镜像照旧,调用路径经 `run(ctx)` 薄包装/保留核心。

## Open Questions

- **`run_events` 表是否在 A0 落地?** 倾向否——只 emit 到结构化 stderr;想要本地 run 历史再加(Phase M 后由 hangar `RunEvent` 承接)。
- **emit kind 词表**:A0 用临时集合(`stage.collect`/…/`stage.kb` + `outcome.*` + `run.failed` + `action.executed`),待 hangar monitor 契约定稿再规整。
