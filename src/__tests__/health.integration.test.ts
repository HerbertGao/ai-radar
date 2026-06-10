/**
 * /health integration 测试（组 D，任务 4.4 可达分支）。
 *
 * 用真实 db + redis 探测断言 `/health` 返回两者 ok。
 * 依赖真实 pg + redis（compose 起的即可），通过 DATABASE_URL + REDIS_URL 注入。
 * 缺任一连接串时自动跳过——避免 CI 无服务时假阴性（与组 C integration 同约定）。
 *
 * 不 mock 任何模块：走真实 env 校验 + 真实 pingDb / pingRedis。
 */
import { afterAll, describe, expect, it } from 'vitest';

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

describe.skipIf(!hasInfra)('/health integration（真实依赖）', () => {
  afterAll(async () => {
    // 关闭 db Pool，避免句柄泄漏导致 vitest 不退出。
    const { pool } = await import('../db/index.js');
    await pool.end();
  });

  it('真实 pg + redis 可达时返回 200 且皆 ok', async () => {
    const { app } = await import('../app.js');
    const res = await app.request('/health');
    const body = (await res.json()) as { db: string; redis: string };
    expect(body).toEqual({ db: 'ok', redis: 'ok' });
    expect(res.status).toBe(200);
  });
});
