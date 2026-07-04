/**
 * Model Radar 价格 curation proposer 的 BullMQ 四件套（add-model-radar-price-curation-approval，design D4，task 6.2）。
 *
 * 镜像 `src/mr/scrape/scrape-queue.ts` 范式：`*_QUEUE`/`*_JOB` 常量 + `create*Queue` + `schedule*` +
 * `create*Worker` + `defaultJobOptions{attempts, exponential backoff, removeOnComplete/Fail}`；重试耗尽
 * 保留 failed job 供人工排查（**失败不改事实**——proposer 本就只 propose）。
 *
 * **主镜像 lane**（worker-main），日级 cron（`MR_PRICE_CURATION_CRON`），**http-only 无 Playwright**。
 * 门控（`MR_PRICE_CURATION_ENABLED` 且 `TELEGRAM_APPROVER_IDS` 就绪才注册）+ `notify`（真实 Telegram/飞书
 * sender）装配由后续接线 group 做；本文件只给 queue/worker 工厂 + job body，暴露注册所需导出。
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import {
  runPriceCuration,
  type CurationNotify,
  type RunPriceCurationResult,
} from './propose.js';
import type { db as defaultDb } from '../../db/index.js';
import type { SafeFetchOptions } from '../scrape/http-tier.js';

type DbLike = typeof defaultDb;

export const MR_PRICE_CURATION_QUEUE = 'mr-price-curation';
export const MR_PRICE_CURATION_JOB = 'mr-price-curation';

const CRON_JOB_ID = 'mr-price-curation-cron';

/** curation job payload（cron 触发不带负载）。 */
export type PriceCurationJobData = Record<string, never>;

/** BullMQ 连接（复用 env.REDIS_URL；调用方负责 quit）。 */
export function buildCurationConnection(): ConnectionOptions {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  }) as unknown as ConnectionOptions;
}

function curationJobOptions() {
  return {
    // 复用 MR 抓取 job 的重试次数（同为「日级只 propose 的 MR lane」，不另设 env）。
    attempts: env.MR_SCRAPE_JOB_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: 30_000 },
    // 重试耗尽保留 failed job 供人工排查（失败不改事实）。
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  };
}

export function createMrPriceCurationQueue(
  connection: ConnectionOptions = buildCurationConnection(),
): Queue<PriceCurationJobData> {
  return new Queue<PriceCurationJobData>(MR_PRICE_CURATION_QUEUE, {
    connection,
    defaultJobOptions: curationJobOptions(),
  });
}

/** 注册日级 cron（幂等：稳定 jobId）。TZ 复用 `MR_SCRAPE_CRON_TZ`。 */
export async function scheduleMrPriceCuration(
  queue: Queue<PriceCurationJobData>,
): Promise<Job<PriceCurationJobData>> {
  return queue.upsertJobScheduler(
    CRON_JOB_ID,
    { pattern: env.MR_PRICE_CURATION_CRON, tz: env.MR_SCRAPE_CRON_TZ },
    { name: MR_PRICE_CURATION_JOB, data: {} },
  );
}

export interface MrPriceCurationWorkerOptions {
  /** 出站发卡回调（必传——接线 group 从真实 Telegram/飞书 sender 装配）。 */
  notify: CurationNotify;
  connection?: ConnectionOptions;
  dbh?: DbLike;
  /** 透传 safeFetch 的 SSRF/超时选项（测试注入）。 */
  safeFetchOptions?: SafeFetchOptions;
  concurrency?: number;
}

/** 创建 curation worker（主镜像可跑）。调用方负责 worker.close()。 */
export function createMrPriceCurationWorker(
  options: MrPriceCurationWorkerOptions,
): Worker<PriceCurationJobData, RunPriceCurationResult> {
  const connection = options.connection ?? buildCurationConnection();
  return new Worker<PriceCurationJobData, RunPriceCurationResult>(
    MR_PRICE_CURATION_QUEUE,
    async () =>
      runPriceCuration({
        notify: options.notify,
        ...(options.dbh ? { dbh: options.dbh } : {}),
        ...(options.safeFetchOptions ? { safeFetchOptions: options.safeFetchOptions } : {}),
      }),
    { connection, concurrency: options.concurrency ?? 1 },
  );
}
