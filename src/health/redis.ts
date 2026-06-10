/**
 * Redis 连通探测 —— 供 /health 复用（组 D，任务 4.2）。
 *
 * 设计要点：
 * - 连接串来自 env.REDIS_URL（已在 src/config/env.ts 做启动期校验，缺失即 throw）。
 * - 探测必须有超时与"不无限重连"语义：Redis 不可达时不能让 /health 长时间挂起，
 *   失败即判 down（spec「依赖不可达时如实反映」——禁止静默成功）。
 * - 每次探测用一次性短连接，探测完即 quit，不复用长连接，避免后台无限重连噪声。
 */
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * 执行一次 Redis `PING`。
 * 成功（收到 `PONG`）返回 true；不可达 / 超时 / 任何错误返回 false（不抛出）。
 *
 * @param timeoutMs 探测整体超时（毫秒），默认 2000。
 */
export async function pingRedis(timeoutMs = 2000): Promise<boolean> {
  const client = new Redis(env.REDIS_URL, {
    // 单次连接尝试即放弃，避免不可达时进入无限重连。
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: timeoutMs,
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  try {
    const pong = await Promise.race([
      client.connect().then(() => client.ping()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('redis ping 超时')), timeoutMs),
      ),
    ]);
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    // disconnect() 立即断开，不等待 pending 重连，避免句柄泄漏。
    client.disconnect();
  }
}
