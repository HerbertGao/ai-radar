## Why

流水线编排(`runDailyWorkflow`/`runAlertScan`/`runWeeklyReport`)目前与 BullMQ worker、进程调度、CLI(`smoke.ts` 直调)耦合;将来把写侧内核 re-host 到 hangar 脊柱(见 `docs/hangar-migration.md` / `docs/hangar-migration-plan-a.md` Phase A0)时,这些耦合就是重写成本。本变更**纯解耦**:在每条 lane 现有 `run*(options)` 核心之上加一层 driver 无关的 `run(ctx)` 薄包装,让"谁驱动它"成为可替换项——今天 BullMQ 调,闸后 hangar 直接调同一个 `run(ctx)`。零功能变化,即使最终不迁 hangar 也是净收益,并提前暴露哪个 lane 偷偷直接依赖 BullMQ driver(现状:仅 weekly)。

## What Changes

- 新增 `src/pipeline/run-context.ts`:本地 `interface RunContext`(镜像 hangar 的 `input/trigger/config/logger/emit/propose`,`propose` 形状 `{tool,args}`)+ `makeLocalCtx({ trigger, config, input })`。`emit`→结构化 stderr 日志(**pino 兼容的 `Logger` 接口 + console/stderr 默认实现,不加 pino**;pino 未在本仓安装);`propose`→本地直执行 handler + `emit action.executed`(A0 无调用方,仅为形状完整 + 单测验证)。
- **每条 lane 保留 `run*(options)` 作 driver 无关核心**(options=生产默认 DI 面,**新增 `emit` 字段**),另加一层**薄 `run(ctx)` 包装**:把 ctx 映射到 options 运维子集(`emit:ctx.emit`/trigger/input)、生产默认补齐 DI、委托核心。**DI/测试注入面(dbh/senders/channels…约 20 字段)留在 options 核心,不进 ctx**——现有 3 个 lane 集成测试继续直调核心注入 mock,VITEST 不真发生产护栏、`smoke.ts` 均零破坏。
- 各 lane 在**其实有阶段边界(进入阶段时)** `emit` 粗粒度事件:daily 七(collect/dedup/score/select/digest/push/kb)/ alert 五(无 kb)/ weekly 二(select/push);结局按 lane 形态(daily 正常早退 `{skipped-locked,skipped-no-candidates}` 发 run 级;alert/weekly 逐 channel);**抛错(降级熔断 `WorkflowAbortError`、lease-lost、dispatch-failed)由 `run(ctx)` 包装 emit `run.failed` 后 RE-THROW,job 照旧失败可重试**。
- **拆调度**:把 `weekly-report.ts` 的 BullMQ queue/worker + `buildConnection`(:71,transitive→bullmq)+ 支撑符号拆到新 `weekly-queue.ts`,`worker-main.ts` 重指,使 `weekly-report.ts` 业务在**直接 import** 层面无 bullmq。
- worker 处理器 shim(`worker.ts` / `alert-queue.ts` / `weekly-queue.ts`)改为"构造 ctx → 调 run(ctx)";**cron 注册(schedule/timezone)行为逐字不变**。
- **行为不变**:digest/alert/weekly 产出的确定性面(入选 ID/排序/`push_records`)须与改造前一致(纯重构 + 拆调度)。

## Capabilities

### New Capabilities
- `pipeline-run-context`: 一个 driver 无关的流水线执行契约——`RunContext`(`input/trigger/config/logger/emit/propose`)+ `makeLocalCtx` 装配器 + 保留的 `run*(options)` 核心 + 薄 `run(ctx)` 包装 + 按 lane 实有阶段的 run-event 发射;核心不变量"lane 业务模块**直接 import** 不得含 BullMQ driver 符号(`bullmq`/`Job`/`job.data`/经 `./queue.js` 的连接符号),不得读原始 `process.env` 做流程分支;`env` 单例作可移植配置明确允许"。

### Modified Capabilities
<!-- 无。daily-intel-pipeline / realtime-alerts / weekly-report 的入口加一层 run(ctx) 薄包装（options 核心不变），其 REQUIREMENTS（阶段顺序、去重/幂等/评分行为、产出）零变化，属实现细节，不需要 delta spec。 -->

## 非目标(Non-Goals)

- **不引入任何 hangar 依赖**;`RunContext` 是本地镜像。
- **不改任何流程行为、不改 cron 注册行为**;不动去重分层、推送幂等、评分、选择——仍由程序与 DB 保障,绝不交 LLM。
- **不把约 20 字段 DI 注入面塞进 ctx**(它们在阶段深处被消费,留在 options 核心);**不把 `env` 单例读搬进 ctx.config**(env 是可移植配置,非 driver 耦合)。
- **不把现有自动推送改走 `propose`**;`propose` A0 无 lane 调用方。
- **不引入统一 `switch(ctx.trigger)`**(Phase M);**不引入 transitive 依赖图工具**(出口闸限直接 import)。
- **不碰 MR / MCP / web**;不碰 BullMQ durable 特性;**run_events 落库可选**。

## Impact

- **改动代码**:`src/pipeline/run-context.ts`(新增)、`weekly-queue.ts`(新增,拆自 weekly-report)、`run-daily-workflow.ts`、`alert-scan.ts`、`weekly-report.ts`、`worker.ts`、`alert-queue.ts`(处理器 shim,:104)、`worker-main.ts`(weekly 工厂 import 重指 `./weekly-queue.js`,:38-41)。
- **不改**(仅验证):`smoke.ts` 经保留的 `runDailyWorkflow(options)` 核心,不编辑、dry-run 冒烟验证不破。
- **cron 注册行为不改**:`worker-main` / `queue` / `alert-queue` / `weekly-queue` 的 schedule/timezone 逐字不变——**仅**worker 处理器 shim 改动。
- **不改**:`src/config/env.ts` 加载语义;所有 collectors / dedup / agents / push / kb 域逻辑;domain DB schema。
- **依赖**:无新增运行时依赖(logger 用 pino 兼容接口 + console/stderr,**不加 pino**;不引 madge)。
- **测试**:新增 `run-context` 单测;parity(daily+alert,钉 now)+ 真集成 Postgres 幂等双跑(**同一条** `UNIQUE(target_type,target_id,channel,push_date)`:daily+alert 用一般值、weekly 用 `target_type='weekly'` 值特化,钉 now);现有 3 个 lane 集成测试经保留核心仍绿(守 `VITEST` 护栏)。
- **后续解锁**:Phase A1 及之后各 Phase 建立在此 seam;Phase M re-host 时业务零改、只换驱动(把本地 `RunContext` 换成 `@hangar/core`)。
