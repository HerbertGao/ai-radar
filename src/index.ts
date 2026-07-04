/**
 * 应用启动入口（组 D，任务 4.1）—— `npm run dev` / `npm start` 执行本文件。
 *
 * import app（已在 src/config/env.ts 启动期校验 env），用 @hono/node-server 监听端口。
 * 端口取 PORT，默认 3000。
 *
 * 优雅关闭：收到 SIGINT/SIGTERM 时 close server（停止接收新连接、drain 在途请求）再退出，
 * 与 worker-main.ts 同口径。容器内由 compose 的 init:true（tini）把 docker stop 的 SIGTERM
 * 可靠转发到本进程。
 */
import { serve } from '@hono/node-server';
import { app } from './app.js';
import { startSnapshotBackgroundRefresh } from './mr/snapshot/background.js';
import {
  env,
  isMrPriceCurationEnabled,
  isMrPriceCurationApprovalReady,
} from './config/env.js';
import {
  startApprovalBot,
  type ApprovalBotHandle,
} from './mr/curation/telegram-callback.js';

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ai-radar 已启动，监听 http://localhost:${info.port}（健康检查：/health）`);
});

// Model Radar 快照后台刷新（5d）：subscriber 收跨进程失效 + 周期 rebuild 驱动 stale 翻转/漏消息自愈。
const snapshotBg = startSnapshotBackgroundRefresh();

// Model Radar 价格 curation 批准接收 bot（design D4）：**仅 web 镜像**跑 grammY 长轮询——web 是常驻 bot host，
// 且 Telegram 单 getUpdates 消费者、web 单副本约束（多副本/多消费者会 409 flap）。worker 镜像只 api.sendMessage
// 发卡、绝不 bot.start()。跨镜像 fail-closed：门控关或 TELEGRAM_APPROVER_IDS 为空 → 不 start bot。
// // ponytail: 长轮询单副本，web 横扩再切 webhook（+ secret_token 常量时间校验）。
let approvalBot: ApprovalBotHandle | undefined;
if (isMrPriceCurationApprovalReady()) {
  approvalBot = startApprovalBot();
} else {
  console.error(
    `[web] Model Radar 价格批准 bot 未启动（enabled=${isMrPriceCurationEnabled()} approvers=${env.TELEGRAM_APPROVER_IDS.length}）。`,
  );
}

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return; // 重复信号幂等。
  shuttingDown = true;
  // best-effort fire（不 await）：clearInterval 同步即时、quit 异步 best-effort，不阻塞下方 server.close/exit。
  void snapshotBg.stop();
  // 批准 bot 随快照 bg 一并优雅停轮询（best-effort，不阻塞退出）。
  if (approvalBot) void approvalBot.stop();
  console.error(`[web] 收到 ${signal}，关闭 HTTP server…`);
  // close() 停止接收新连接、在途请求处理完后回调退出。但 http.Server.close() **不会**
  // 主动断开空闲 keep-alive 连接（监控/反代常驻探活会保活），否则回调永不触发 → 卡到
  // SIGKILL。故显式断空闲连接（Node 18.2+），并加超时兜底确保最终退出（8s < 容器 grace：web 15s）。
  server.close(() => process.exit(0));
  if ('closeIdleConnections' in server) {
    server.closeIdleConnections();
  }
  setTimeout(() => process.exit(0), 8_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
