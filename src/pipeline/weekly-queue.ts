/**
 * 周报的**独立** BullMQ 调度入口 / driver（weekly-report / design D5、D6）。
 *
 * 从 weekly-report.ts 拆出：把 `bullmq` 的 queue/worker 工厂 + 其 `./queue.js` 连接 import 移到本文件，
 * 使 weekly-report.ts 业务在**直接 import 层面无 bullmq**（出口闸，design D7）。业务全在 runWeeklyReport
 * （纯顺序，见 ./weekly-report.js），worker 只「构造 ctx → 调 run(ctx) 包装」（design D5 处理器 shim）。
 *
 * 与日报（queue.ts/worker.ts）、告警（alert-queue.ts）并列独立：独立队列名 WEEKLY_REPORT_QUEUE、
 * 独立 cron（每周一 09:07 Asia/Shanghai）。cron 注册（schedule/timezone）行为逐字不变（design D5）。
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { env } from '../config/env.js';
import { buildConnection } from './queue.js';
import { makeLocalCtx } from './run-context.js';
import {
  run,
  type RunWeeklyReportResult,
} from './weekly-report.js';

/**
 * 周报默认 cron（BullMQ repeat.pattern）：每周一 09:07（Asia/Shanghai）。
 * **分钟字段避整点/半点（∉ {0,30}）**降低飞书限流（同日报 DAILY_DIGEST_CRON 默认意图）；
 * 周一触发使汇总窗口恰为「刚结束的完整一周」（上周一→本周一）。
 *
 * 注：周报 cron 配置未引入新 env（本组文件归属边界禁改 config/env.ts）；用本常量作默认，
 * 可经 scheduleWeeklyReport 的 cron/tz 参数覆盖（wiring 层注入）。cron 时区默认与 push_date
 * 同源 Asia/Shanghai，防触发时区与汇总周口径漂移。
 */
export const DEFAULT_WEEKLY_CRON = '7 9 * * 1';
/** 周报 cron 时区（与 push_date 同源 Asia/Shanghai，防漂移）。 */
export const DEFAULT_WEEKLY_CRON_TZ = 'Asia/Shanghai';

/** 周报队列名（独立于 daily-digest / product-digest，绝不复用）。 */
export const WEEKLY_REPORT_QUEUE = 'weekly-report';
/** 周报 job 名。 */
export const WEEKLY_REPORT_JOB = 'weekly-report';
/** cron 重复任务稳定标识，防重复注册同一 cron。 */
const WEEKLY_CRON_JOB_ID = 'weekly-report-cron';

/** weekly-report job 的 payload（预留 now 供手动触发指定时刻）。 */
export interface WeeklyReportJobData {
  /** 可选参考时刻 ISO 串（手动触发回填特定周；cron 触发不带，worker 用当前时刻）。 */
  nowIso?: string;
}

/** 创建 weekly-report 队列实例（独立队列，调用方负责 close）。 */
export function createWeeklyReportQueue(
  connection: ConnectionOptions = buildConnection(),
): Queue<WeeklyReportJobData> {
  return new Queue<WeeklyReportJobData>(WEEKLY_REPORT_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: env.DAILY_DIGEST_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  });
}

/**
 * 注册周报周级 cron 重复任务（幂等：稳定 jobId 防重复注册同一 cron）。
 *
 * 默认 cron = DEFAULT_WEEKLY_CRON（每周一 09:07 Asia/Shanghai，避整点/半点降飞书限流）；
 * 可由参数覆盖（wiring 层注入）。cron 时区默认与 push_date 同源 Asia/Shanghai，防漂移。
 *
 * @param queue 周报队列。
 * @param pattern cron 表达式（默认 DEFAULT_WEEKLY_CRON）。
 * @param tz cron 时区（默认 DEFAULT_WEEKLY_CRON_TZ）。
 */
export async function scheduleWeeklyReport(
  queue: Queue<WeeklyReportJobData>,
  pattern: string = DEFAULT_WEEKLY_CRON,
  tz: string = DEFAULT_WEEKLY_CRON_TZ,
): Promise<Job<WeeklyReportJobData>> {
  return queue.upsertJobScheduler(
    WEEKLY_CRON_JOB_ID,
    { pattern, tz },
    {
      name: WEEKLY_REPORT_JOB,
      data: {},
    },
  );
}

export interface WeeklyReportWorkerOptions {
  /** BullMQ 连接（默认复用 env.REDIS_URL）。 */
  connection?: ConnectionOptions;
  /** 并发度（周报由 per-channel 单例锁兜底，默认 1）。 */
  concurrency?: number;
}

/**
 * 创建并启动 weekly-report worker（独立 worker，调用方负责 worker.close()）。
 * job.data.nowIso 存在时用它作参考时刻（手动回填特定周）；否则用当前时刻（cron 触发）。
 *
 * 处理器 shim（design D5）：构造本地 ctx（trigger='weekly-report'，input 携可选 now）→ 调薄
 * run(ctx) 包装（生产默认补齐 DI，抛错经包装 emit run.failed 后 re-throw → job 失败可重试）。
 */
export function createWeeklyReportWorker(
  options: WeeklyReportWorkerOptions = {},
): Worker<WeeklyReportJobData, RunWeeklyReportResult> {
  const connection = options.connection ?? buildConnection();

  return new Worker<WeeklyReportJobData, RunWeeklyReportResult>(
    WEEKLY_REPORT_QUEUE,
    async (job: Job<WeeklyReportJobData>) => {
      const now = job.data?.nowIso ? new Date(job.data.nowIso) : undefined;
      const ctx = makeLocalCtx({
        trigger: 'weekly-report',
        input: now ? { now } : {},
      });
      return run(ctx);
    },
    {
      connection,
      concurrency: options.concurrency ?? 1,
    },
  );
}
