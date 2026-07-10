/**
 * 按源陈旧度检测集成测试（add-per-source-staleness-alert，任务 4.3）——需本地 Postgres（compose 起的库）。
 *
 * 种入不同 `fetched_at` 的 `raw_items`，断言真实聚合查询 + 判定：
 * - 陈旧源（max(fetched_at) 超阈值）被识别，且 max 取最新一行（种两行验证聚合取 max）；
 * - 新鲜源（阈值内有入库）不被识别；
 * - 从未产出的已注册源（结果集缺席、NULL）判陈旧（lastFetched=null / staleDays=null）；
 * - 按源覆盖阈值放宽后，原陈旧源转新鲜（覆盖参与真实判定）。
 *
 * 用唯一 source 前缀隔离、afterAll 清理；缺 DATABASE_URL 时本套件自动跳过。判定纯 DB + 程序、无 LLM。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { detectStaleSources } = await import('../source-staleness.js');

const databaseUrl = process.env.DATABASE_URL;
const PREFIX = 'staleness-itest-';
const FRESH = `${PREFIX}fresh`;
const STALE = `${PREFIX}stale`;
const NEVER = `${PREFIX}never`;
const DAY_MS = 86_400_000;

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

async function seed(source: string, sourceItemId: string, fetchedAt: Date): Promise<void> {
  await pool!.query(
    `INSERT INTO raw_items (source, source_item_id, title, fetched_at)
     VALUES ($1, $2, $3, $4)`,
    [source, sourceItemId, `title ${sourceItemId}`, fetchedAt.toISOString()],
  );
}

const now = new Date();
const daysAgo = (n: number): Date => new Date(now.getTime() - n * DAY_MS);

beforeAll(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM raw_items WHERE source LIKE $1`, [`${PREFIX}%`]);
  // FRESH：阈值内（1 天前）。
  await seed(FRESH, 'f1', daysAgo(1));
  // STALE：两行验证聚合取 max（最新 = 10 天前，仍超 3 天阈值）。
  await seed(STALE, 's1', daysAgo(20));
  await seed(STALE, 's2', daysAgo(10));
  // NEVER：不种任何行（已注册但从未产出 → 结果集缺席 → NULL → 陈旧）。
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM raw_items WHERE source LIKE $1`, [`${PREFIX}%`]);
    await pool.end();
  }
});

describe.skipIf(!databaseUrl)('按源陈旧度检测（真实 pg 聚合 + 判定）', () => {
  it('陈旧源被识别、新鲜源不被识别、从未产出的源判陈旧（max 取最新行）', async () => {
    const stale = await detectStaleSources(
      { now, sources: [FRESH, STALE, NEVER], thresholds: new Map(), defaultDays: 3 },
      db!,
    );
    const bySource = new Map(stale.map((s) => [s.source, s]));

    // FRESH 不在陈旧集。
    expect(bySource.has(FRESH)).toBe(false);

    // STALE 被识别：lastFetched = max = 10 天前（非 20 天前），staleDays≈10。
    const staleRow = bySource.get(STALE);
    expect(staleRow).toBeDefined();
    expect(staleRow!.lastFetched?.getTime()).toBeCloseTo(daysAgo(10).getTime(), -4);
    expect(staleRow!.staleDays).toBe(10);

    // NEVER 判陈旧：从未产出 → lastFetched=null / staleDays=null。
    expect(bySource.get(NEVER)).toEqual({
      source: NEVER,
      lastFetched: null,
      staleDays: null,
    });

    // 只识别 STALE + NEVER，共两源。
    expect(stale.map((s) => s.source).sort()).toEqual([NEVER, STALE].sort());
  });

  it('按源覆盖放宽阈值后，原陈旧源转新鲜（覆盖参与真实判定）', async () => {
    const stale = await detectStaleSources(
      {
        now,
        sources: [STALE],
        thresholds: new Map([[STALE, 30]]), // 30 天阈值 → 10 天前不再陈旧
        defaultDays: 3,
      },
      db!,
    );
    expect(stale).toEqual([]);
  });
});
