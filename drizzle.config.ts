import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 配置 —— 迁移生成与执行。
 *
 * - dialect      ：postgresql
 * - schema       ：本期三表定义所在
 * - out          ：迁移文件目录（journal + SQL）
 * - dbCredentials：直接读 process.env.DATABASE_URL
 *   （drizzle-kit CLI 进程不走 src/config/env 的 Zod 校验，故此处直读 env；
 *    缺失时由 CLI 自身报错。）
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
