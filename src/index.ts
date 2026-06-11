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

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ai-radar 已启动，监听 http://localhost:${info.port}（健康检查：/health）`);
});

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return; // 重复信号幂等。
  shuttingDown = true;
  console.error(`[web] 收到 ${signal}，关闭 HTTP server…`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
