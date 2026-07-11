## 1. RunContext seam

- [x] 1.1 新增 `src/pipeline/run-context.ts`:`interface RunContext`(`input/trigger/config/logger/emit/propose`,`propose` 形状 `{tool:string;args:object}`),镜像 hangar,**不 import 任何 `@hangar/*`**
- [x] 1.2 实现 `makeLocalCtx({ trigger, config, input })`:`emit(kind,payload)`→ 结构化 stderr(pino 兼容 `Logger` 接口,不加 pino;可选写 `run_events`,默认不建表);`propose(action)`→ 直接执行 handler、`emit action.executed`、resolve 结果
- [x] 1.3 `run-context` 单测:emit 落结构化日志;**propose 单测层**验证(桩 handler 直执行、发 `action.executed`、resolve,不 park);断言模块不引 `@hangar/*`

## 2. lane 保留 options 核心 + 加薄 run(ctx) 包装(纯重构)

- [x] 2.1 `runDailyWorkflow(options)` **保持为 driver 无关核心**,options **新增 `emit` 字段**(缺省 no-op)供阶段发事件;新增薄包装 `runDaily.run(ctx)`:把 ctx 映射到 options 运维子集(`emit:ctx.emit`、trigger=`digest`、input),生产默认补齐 DI,委托核心。**DI/测试 seam 留在 options 核心、不进 ctx**。逻辑零改
- [x] 2.2 daily 在**七个**阶段(collect/dedup/score/select/digest/push/kb)进入时经 `options.emit` 各发一条事件;run 级正常早退(仅 `skipped-locked`/`skipped-no-candidates`)发 run 级终态;**抛错(降级熔断 `WorkflowAbortError`(:631 value-judge / :769 digest)、lease-lost、dispatch-failed)由 `run(ctx)` 包装 emit `run.failed` 后 RE-THROW 原错误**(`run(ctx)` 仍 reject → BullMQ job 失败可重试,守 `worker.ts:7-11`;**单测须断言该路径既 emit `run.failed` 又 `await expect(run(ctx)).rejects.toThrow(WorkflowAbortError)`**);`aborted-degrade` 不作返回值
- [x] 2.3 `runAlertScan` 同 2.1 模式(trigger=`alert-scan`);发**五**阶段(collect/dedup/score/select/push,**无 kb**);结局**逐 channel/candidate**、**无 aborted-degrade**;逻辑零改
- [x] 2.4 `runWeeklyReport` 同 2.1 模式(trigger=`weekly-report`);发**两**阶段(select/push);结局**逐 channel**;逻辑零改

## 3. 拆调度 & 驱动接线

- [x] 3.1 把 `weekly-report.ts` 的 `import {Queue,Worker,Job} from 'bullmq'`(:48)、`import {buildConnection} from './queue.js'`(:71)、`createWeeklyReportQueue/Worker`、`scheduleWeeklyReport`、以及 `WEEKLY_REPORT_QUEUE`/`WeeklyReportJobData` 支撑符号**一并拆到新 `src/pipeline/weekly-queue.ts`**,`weekly-report.ts` 成纯业务(直接 import 无 bullmq)
- [x] 3.2 `worker-main.ts:38-41` 的 weekly 工厂 import 从 `./weekly-report.js` **重指 `./weekly-queue.js`**(唯一外部 importer);**cron 注册(schedule/timezone)逐字不变**
- [x] 3.3 worker 处理器 shim:`worker.ts`(daily)、`alert-queue.ts`(alert,:104)、`weekly-queue.ts`(weekly)各改为"构造 ctx → 调 run(ctx) 包装";cron 接线不动
- [x] 3.4 一次性入口 `src/pipeline/smoke.ts`:继续经保留的 `runDailyWorkflow(options)` 核心调用,**不改**,验证 dry-run 冒烟不破

## 4. 解耦出口闸

- [x] 4.1 确认各 lane 业务体读 `env` 单例即可(**不搬**其位置、不改评估时机);无需把 `env.*` 塞进 ctx.config
- [x] 4.2 grep/lint 出口闸:对**三个 lane 业务模块**(`run-daily-workflow.ts`/`alert-scan.ts`/`weekly-report.ts`,**排除** driver 文件 `queue`/`alert-queue`/`weekly-queue`/`worker.ts`——它们合法 import bullmq)断言 **import 语句**(匹配 import 行、非裸标识符,避免误伤 `WeeklyReportJobData` 等)无 `from 'bullmq'` / 从 bullmq 导入的 `Job` / `job.data` 用法 / 经 `./queue.js` 的连接符号(`env` 单例允许);辅以"无原始 `process.env` 生产流程分支"防回归。落一个可跑守卫。**注:限直接 import,transitive 不在 A0 范围**

## 5. 行为一致性 & 幂等验证

- [x] 5.1 parity oracle:在既有 mock LLM/embedding 集成测试(**钉 `now`**)下,断言**确定性面**(入选 event ID 集+排序、`push_records` 行)改造前后一致(baseline=现有测试钉定期望);daily+alert 做,weekly 轻量比对。**阶段 emit 计数为前向断言**(daily 7/alert 5/weekly 2),非前后 parity
- [x] 5.2 推送幂等回归(**真集成 Postgres 双跑,钉 `now`**,不靠 mock dbh):断言**同一条**约束 `UNIQUE(target_type,target_id,channel,push_date)` 只落一行——daily+alert 用一般值;**weekly 单独覆盖 `target_type='weekly'`/`target_id=iso_week` 值特化**(其合成 push_date 最易漂、且是被物理拆分的 lane;钉 now 防跨周一 00:00 flake);pending→success 状态机不变
- [x] 5.3 全量测试绿(含现有 3 个 lane 集成测试经保留核心仍绿),守 `VITEST` 不真发飞书/Telegram 护栏(钉 channels/注入 sender mock)
