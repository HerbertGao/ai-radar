/**
 * Model Radar browser 档 URL drift proposer 的 BullMQ 四件套（add-model-radar-browser-url-drift-agent，
 * design D4，task 7.1）。
 *
 * 镜像 `src/mr/curation/curation-queue.ts` 范式（其镜像 `scrape-queue.ts`）：`*_QUEUE`/`*_JOB` 常量 +
 * `create*Queue` + `schedule*` + `create*Worker` + `defaultJobOptions{attempts, exponential backoff,
 * removeOnComplete/Fail}`；重试耗尽保留 failed job 供人工排查（**失败不改事实**——proposer 本就只 propose）。
 *
 * **主镜像 lane**（worker-main），周级 cron（`MR_URL_DRIFT_CRON`，默认周一 09:33、错峰 browser scrape 09:17
 * 之后；TZ **复用 `MR_SCRAPE_CRON_TZ`**、不新立独立 TZ env，m1）。门控（`isMrUrlDriftApprovalReady()`——
 * `MR_URL_DRIFT_ENABLED` 且 `TELEGRAM_APPROVER_IDS`/`TELEGRAM_CHAT_ID` 就绪才注册）+ `notify`（真实 Telegram
 * sender）装配由 worker-main 做；本文件只给 queue/worker 工厂 + job body。
 *
 * `job.id` = BullMQ job 稳定 id（跨 attempts 不变）作 `run_id` 传入 `runUrlDriftCuration`（metric 回填 join
 * key、幂等，design D7/Codex#5）。
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import {
  runUrlDriftCuration,
  type RunUrlDriftCurationResult,
} from './url-drift-propose.js';
import type { CurationNotify } from './propose.js';
import type { db as defaultDb } from '../../db/index.js';

type DbLike = typeof defaultDb;

export const MR_URL_DRIFT_QUEUE = 'mr-url-drift';
export const MR_URL_DRIFT_JOB = 'mr-url-drift';

const CRON_JOB_ID = 'mr-url-drift-cron';

/** drift job payload（cron 触发不带负载）。 */
export type UrlDriftJobData = Record<string, never>;

/** BullMQ 连接（复用 env.REDIS_URL；调用方负责 quit）。 */
export function buildUrlDriftConnection(): ConnectionOptions {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  }) as unknown as ConnectionOptions;
}

function urlDriftJobOptions() {
  return {
    // 独立于 MR_SCRAPE_JOB_ATTEMPTS：LLM 调用成本远高于抓取 HTTP、attempts 须独立调优（task 7.2 ①②）。
    attempts: env.MR_URL_DRIFT_JOB_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: 30_000 },
    // 重试耗尽保留 failed job 供人工排查（失败不改事实）。
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  };
}

export function createUrlDriftQueue(
  connection: ConnectionOptions = buildUrlDriftConnection(),
): Queue<UrlDriftJobData> {
  return new Queue<UrlDriftJobData>(MR_URL_DRIFT_QUEUE, {
    connection,
    defaultJobOptions: urlDriftJobOptions(),
  });
}

/** 注册周级 cron（幂等：稳定 jobId）。TZ 复用 `MR_SCRAPE_CRON_TZ`（m1）。 */
export async function scheduleUrlDrift(
  queue: Queue<UrlDriftJobData>,
): Promise<Job<UrlDriftJobData>> {
  return queue.upsertJobScheduler(
    CRON_JOB_ID,
    { pattern: env.MR_URL_DRIFT_CRON, tz: env.MR_SCRAPE_CRON_TZ },
    { name: MR_URL_DRIFT_JOB, data: {} },
  );
}

export interface UrlDriftWorkerOptions {
  /** 出站发卡回调（必传——worker-main 从真实 Telegram sender 装配）。 */
  notify: CurationNotify;
  connection?: ConnectionOptions;
  dbh?: DbLike;
  concurrency?: number;
}

/** 创建 URL drift worker（主镜像可跑）。调用方负责 worker.close()。 */
export function createUrlDriftWorker(
  options: UrlDriftWorkerOptions,
): Worker<UrlDriftJobData, RunUrlDriftCurationResult> {
  const connection = options.connection ?? buildUrlDriftConnection();
  return new Worker<UrlDriftJobData, RunUrlDriftCurationResult>(
    MR_URL_DRIFT_QUEUE,
    async (job) => {
      // job.id = BullMQ 稳定 id（跨 attempts 不变）作 run_id；worker 内恒有值，缺失即 fail-fast（防空 run_id 毒化 metric）。
      const runId = job.id;
      if (!runId) throw new Error('mr-url-drift: job.id 缺失，无法作 run_id');
      return runUrlDriftCuration({
        notify: options.notify,
        runId,
        ...(options.dbh ? { dbh: options.dbh } : {}),
      });
    },
    { connection, concurrency: options.concurrency ?? 1 },
  );
}
