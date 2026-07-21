/**
 * BullMQ 常驻运行时入口（daily-intel-pipeline / realtime-alerts / product-discovery）
 * —— `npm run worker` 执行本文件。
 *
 * 把已有导出接成一个常驻进程：为多条**独立并列**的调度链各注册 cron 重复任务 + 启动 worker。
 * 本文件只做 wiring（编排已实现的工厂），不含任何业务逻辑——业务全在各自的 run* 函数
 * （runDailyWorkflow / runAlertScan 等，纯顺序，由 worker await）。
 * 产品发现已合并进日报链（日报内含「新品段」），不再有独立 product-digest 调度链。
 *
 * 调度链（互不嵌套、各自独立队列/worker/cron；告警与各 Model Radar 链按 env 门控注册）：
 *   1. 日报      daily-digest    每日 DAILY_DIGEST_CRON（含新闻要闻段 + 产品新品段）
 *   2. 实时告警  alert-scan      每 ALERT_SCAN_CRON（默认 4-59/15，15 分钟节奏）
 *
 * 用法：
 *   npm run worker   # 常驻：三条链按各自 cron 定时触发。Ctrl-C 退出。
 *
 * 前置：docker compose up -d（redis + postgres healthy）、npm run migrate、.env 填好凭据。
 * 想立刻验证一次不等到 cron 点，用 `npm run smoke`（直接触发一次 runDailyWorkflow）。
 *
 * 退出：收到 SIGINT/SIGTERM 时优雅关闭全部 worker、queue 与各自连接。
 */
import { Redis } from 'ioredis';
import type { Queue, Worker } from 'bullmq';
import {
  createDailyDigestQueue,
  scheduleDailyDigest,
  buildConnection,
} from './queue.js';
import { createDailyDigestWorker } from './worker.js';
import {
  createAlertScanQueue,
  scheduleAlertScan,
  createAlertScanWorker,
  buildAlertConnection,
} from './alert-queue.js';
import {
  createEventReviewQueue,
  scheduleEventReview,
  createEventReviewWorker,
  buildEventReviewConnection,
} from '../mr/freshness/event-review-queue.js';
import {
  createMrScrapeHttpQueue,
  scheduleMrScrapeHttp,
  createMrScrapeHttpWorker,
  buildScrapeConnection,
} from '../mr/scrape/scrape-queue.js';
import {
  createStalenessQueue,
  scheduleStaleness,
  createStalenessWorker,
  buildStalenessConnection,
} from '../mr/freshness/staleness-queue.js';
import {
  createMrPriceCurationQueue,
  scheduleMrPriceCuration,
  createMrPriceCurationWorker,
  buildCurationConnection,
} from '../mr/curation/curation-queue.js';
import {
  createUrlDriftQueue,
  scheduleUrlDrift,
  createUrlDriftWorker,
  buildUrlDriftConnection,
} from '../mr/curation/url-drift-queue.js';
import type { CurationNotify } from '../mr/curation/propose.js';
import { Bot } from 'grammy';
import {
  env,
  isAlertScanEnabled,
  isMrEventReviewEnabled,
  isMrScrapeEnabled,
  isMrStalenessEnabled,
  isMrPriceCurationEnabled,
  isMrPriceCurationApprovalReady,
  isMrUrlDriftEnabled,
  isMrUrlDriftApprovalReady,
  isFeishuEnabled,
} from '../config/env.js';
import { createFeishuSender } from '../push/feishu.js';
import { buildOpsAlertSink } from './ops-alert-sink.js';
import { withRetry } from '../collectors/types.js';
import { assertProductZhColumns } from './product-digest.js';

/**
 * 装配 curation proposer 的出站发卡回调（design D4）——真实 Telegram/飞书 sender。
 * **worker 镜像只 `api.sendMessage` 发卡，绝不 `bot.start()`**（长轮询单 getUpdates 消费者归 web 镜像；
 * 多消费者会 409 flap）。Telegram 卡挂 inline-keyboard（reply_markup）；飞书**仅通知**（无写按钮、不含 token）。
 * 出站有重试退避 + 错误日志（仓库不变量）。
 */
function buildCurationNotify(): CurationNotify {
  // 仅用 bot.api 出站发送——不 start() 长轮询（web 镜像才收 callback）。
  // 显式 30s 客户端超时：grammY 默认 500s，Telegram 卡顿时 3 次重试会长时间占用 worker（此 bot 无长轮询，短超时安全）。
  const api = new Bot(env.TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 30 } }).api;
  const chatId = env.TELEGRAM_CHAT_ID;
  const feishuSender = isFeishuEnabled() ? createFeishuSender() : undefined;

  const notify: CurationNotify = {
    async telegram(card): Promise<void> {
      await withRetry(
        () =>
          api.sendMessage(chatId, card.text, {
            parse_mode: card.parseMode,
            reply_markup: card.replyMarkup,
          }),
        {
          maxAttempts: 3,
          baseDelayMs: 1000,
          label: 'mr-curation-telegram-card',
          // 镜像接收侧 logRedacted 纪律：只落 err.message，不落含 reply_markup/callback_data 的 error 对象。
          logError: (msg, err) =>
            console.error(
              `[mr-curation] ${msg}: ${err instanceof Error ? err.message : String(err)}`,
            ),
        },
      );
    },
  };
  if (feishuSender) {
    // feishuSender.send 收 dispatcher 契约的 `JSON.stringify({ card })`；parseMode 被飞书忽略。
    notify.feishu = async (card): Promise<void> => {
      await feishuSender.send(JSON.stringify({ card }), 'MarkdownV2');
    };
  }
  return notify;
}

/** 一条调度链的运行时句柄（worker + queue + 其复用的连接），供统一优雅关闭。 */
interface ScheduledLane {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  worker: Worker<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queue: Queue<any>;
  /** 该链 worker/queue 复用的底层 ioredis 连接（shutdown 时 quit）。 */
  connection: unknown;
}

async function main(): Promise<void> {
  // ── 启动期自检（部署防假绿）：日报新品段读 ai_products 中文列，列缺失则 fail-fast，
  //    绝不让漏迁移的生产环境靠 selectProductsForChannelSafe 把「列不存在」静默吞成空新品段。
  //    迁移必先于代码发布（drizzle/0005_*）。在注册任何 worker 之前探针，缺列即拒绝启动。
  await assertProductZhColumns();

  const lanes: ScheduledLane[] = [];

  // ── 链 1：日报 daily-digest（worker 复用同一 connection，shutdown 时一次 quit 即可）。
  {
    const connection = buildConnection();
    const queue = createDailyDigestQueue(connection);
    await scheduleDailyDigest(queue);
    const worker = createDailyDigestWorker({ connection });
    lanes.push({ name: 'daily-digest', worker, queue, connection });
  }

  // ── 链 2：实时告警 alert-scan（高频轮询，独立连接 buildAlertConnection）。
  //    默认禁用（ALERT_SCAN_ENABLED='false'，canonicalUrl + 中文摘要打磨完再启用）；改 env 即启用。
  if (isAlertScanEnabled()) {
    const connection = buildAlertConnection();
    const queue = createAlertScanQueue(connection);
    await scheduleAlertScan(queue);
    const worker = createAlertScanWorker({ connection });
    lanes.push({ name: 'alert-scan', worker, queue, connection });
  }

  // ── 链 4：Model Radar 事件复核 mr-event-review（事件流触发复核，独立连接 buildEventReviewConnection）。
  //    默认禁用（MR_EVENT_REVIEW_ENABLED='false'）；改 env 即启用（design D8/D14）。
  if (isMrEventReviewEnabled()) {
    const connection = buildEventReviewConnection();
    const queue = createEventReviewQueue(connection);
    await scheduleEventReview(queue);
    const worker = createEventReviewWorker({ connection });
    lanes.push({ name: 'mr-event-review', worker, queue, connection });
  }

  // ── 链 5：Model Radar http 档抓取 mr-scrape-http（日级 cron，主镜像可跑、无 Playwright 依赖）。
  //    browser 档为独立 entrypoint（browser-worker-main.ts）+ 独立镜像，**不在此装配**（design D15）。
  //    默认禁用（MR_SCRAPE_ENABLED='false'）；改 env 即启用。
  if (isMrScrapeEnabled()) {
    const connection = buildScrapeConnection();
    const queue = createMrScrapeHttpQueue(connection);
    await scheduleMrScrapeHttp(queue);
    const worker = createMrScrapeHttpWorker({ connection });
    lanes.push({ name: 'mr-scrape-http', worker, queue, connection });
  }

  // ── 链 6：Model Radar 陈旧度排程 mr-staleness（独立连接 buildStalenessConnection）。
  //    默认禁用（MR_STALENESS_ENABLED='false'）；改 env 即启用（design D9/D14）。
  //    **URL drift 零采纳 engagement 信号骑本 lane**（DD3）：注入生产 ops-alert-sink——worker 非 VITEST
  //    → 首次真告警才懒装配真实通道、genuinely 发得出（与离线 eval 的 vitest 守卫死路相反，design D7）。
  //    **耦合**：engagement 监控受 MR_STALENESS_ENABLED 门控——只开 MR_URL_DRIFT_ENABLED 不开它则无此监控。
  if (isMrStalenessEnabled()) {
    const connection = buildStalenessConnection();
    const queue = createStalenessQueue(connection);
    await scheduleStaleness(queue);
    const worker = createStalenessWorker({ connection, alert: buildOpsAlertSink() });
    lanes.push({ name: 'mr-staleness', worker, queue, connection });
  } else if (isMrUrlDriftEnabled()) {
    // 显式化上文「耦合」残余：staleness 关但 url-drift 开 → 零采纳 engagement 监控静默失效（信号骑本 lane 的 sink）。
    console.error(
      '[worker] MR_STALENESS_ENABLED=false 但 MR_URL_DRIFT_ENABLED=true → URL-drift 零采纳 engagement 监控不可用（该信号骑 mr-staleness lane 的 ops-alert-sink，DD3）；要采纳率告警须一并开 MR_STALENESS_ENABLED。',
    );
  }

  // ── 链 7：Model Radar 价格 curation proposer mr-price-curation（日级 cron，http-only 无 Playwright，主镜像可跑）。
  //    **跨镜像 fail-closed**（design D4/D5）：除本侧总开关外，还须 `TELEGRAM_APPROVER_IDS` 就绪才注册——
  //    否则「发卡而无人能批」（proposer 显式确认批准侧白名单存在，各查本侧 env 不足以防此）。
  //    worker 只发卡（buildCurationNotify 的 api.sendMessage），**绝不 bot.start()**；接收长轮询归 web 镜像。
  if (isMrPriceCurationApprovalReady()) {
    const connection = buildCurationConnection();
    const queue = createMrPriceCurationQueue(connection);
    await scheduleMrPriceCuration(queue);
    const worker = createMrPriceCurationWorker({ notify: buildCurationNotify(), connection });
    lanes.push({ name: 'mr-price-curation', worker, queue, connection });
  } else if (isMrPriceCurationEnabled()) {
    console.error(
      '[worker] mr-price-curation 门控开但 TELEGRAM_APPROVER_IDS 为空 → 不注册 lane（不发无人能批的卡）。',
    );
  }

  // ── 链 8：Model Radar browser 档 URL-drift agent mr-url-drift（周级 cron，browser 源 URL 迁移检测，主镜像可跑）。
  //    **跨镜像 fail-closed**（design D4）：与 mr-price-curation 同区、复用 TELEGRAM_APPROVER_IDS + TELEGRAM_CHAT_ID——
  //    推 Telegram 卡、批准侧同一 web 镜像 bot，单查 MR_URL_DRIFT_ENABLED 不足以防"发卡无人能批"。
  //    worker 只发卡（buildCurationNotify 的 api.sendMessage），**绝不 bot.start()**；接收长轮询归 web 镜像。
  if (isMrUrlDriftApprovalReady()) {
    const connection = buildUrlDriftConnection();
    const queue = createUrlDriftQueue(connection);
    await scheduleUrlDrift(queue);
    const worker = createUrlDriftWorker({ notify: buildCurationNotify(), connection });
    lanes.push({ name: 'mr-url-drift', worker, queue, connection });
  } else if (isMrUrlDriftEnabled()) {
    console.error(
      '[worker] mr-url-drift 门控开但 TELEGRAM_APPROVER_IDS 为空或 TELEGRAM_CHAT_ID 非数值 → 不注册 lane（不发无人能批的卡）。',
    );
  }

  console.error(
    `[worker] 已启动 ${lanes.length} 条调度链（${lanes
      .map((l) => l.name)
      .join(', ')}），已注册各自 cron 重复任务，等待触发。Ctrl-C 退出。`,
  );

  for (const lane of lanes) {
    lane.worker.on('completed', (job, result) => {
      console.error(
        `[worker][${lane.name}] job ${job.id} 完成，outcome=${result?.outcome ?? '(无)'}`,
      );
    });
    lane.worker.on('failed', (job, err) => {
      console.error(`[worker][${lane.name}] job ${job?.id} 失败：`, err);
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // 重复信号幂等，避免并发 close/quit。
    shuttingDown = true;
    console.error(`[worker] 收到 ${signal}，优雅关闭 ${lanes.length} 条调度链…`);
    // 先关全部 worker（停止消费），再关 queue，最后 quit 各自底层连接，避免句柄泄漏挂起退出。
    for (const lane of lanes) {
      try {
        await lane.worker.close();
        await lane.queue.close();
        await (lane.connection as Redis).quit();
      } catch (err) {
        console.error(`[worker][${lane.name}] 关闭时出错（继续关闭其余链）：`, err);
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[worker] 启动失败：', err);
  process.exitCode = 1;
});
