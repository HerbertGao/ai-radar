/**
 * Show HN 产品发现端到端集成测试（product-discovery / source-collectors，**跑真实 Postgres**）。
 *
 * 以注入的 Product Hunt + Show HN fetch 桩（经 `collectOptions:{productHunt:{...},showHn:{...}}`）驱动
 * `runProductDigest` 的**采集 + 塌缩段**，断言 Show HN 产品经
 *   `collectSources(PRODUCT_SOURCES) → storeCollectedItems → collapseUncollapsedProductRawItems`
 * 全链入 `ai_products`——覆盖 3.4 注入改造正确性与「Show HN 真被产品子集采集入库」（补 5.3 绕过采集层的缺口）。
 *
 * **只验采集+塌缩段、不触发真实推送/redis 锁**（遵 memory test-no-prod-sends）：传 `channels: []` 使推送循环
 * 迭代零通道（不获取锁、不构造 sender、不发任何消息）。注入 fetch 桩不触网。
 * 缺 DATABASE_URL 时本套件自动跳过；唯一前缀隔离，afterAll 清理。
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

const { runProductDigest } = await import('../product-digest.js');

const databaseUrl = process.env.DATABASE_URL;
const PREFIX = `she2e-${process.pid}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const NOW = new Date('2099-04-01T04:00:00Z'); // 远离真实运行日的专属时刻。

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM raw_items WHERE source_item_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE product_hunt_slug LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE canonical_domain LIKE $1`, [`%${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE github_repo LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)('Show HN 端到端经 runProductDigest 采集+塌缩入 ai_products', () => {
  it('注入 PH + Show HN fetch 桩 → Show HN 产品全链入库（不触发推送）', async () => {
    // Show HN fetch 桩：返回一条真实形状的 Algolia hit（github repo + 有 points）。
    const shObjectId = `${PREFIX}-sh-1`;
    const shRepo = `${PREFIX}-showhn/tool`;
    const showHnFetchJson = async () => ({
      hits: [
        {
          objectID: shObjectId,
          title: 'Show HN: My Show HN Tool',
          url: `https://github.com/${PREFIX}-showhn/tool`,
          created_at_i: Math.floor(NOW.getTime() / 1000) - 3600, // 窗内（1 小时前）。
          points: 99,
          num_comments: 5,
          author: 'shdev',
        },
      ],
    });

    // PH fetch 桩：返回一条 PH post（独立产品，验证两源同链采集）。
    const phSlug = `${PREFIX}-ph-1`;
    const phFetchGraphql = async () => ({
      body: {
        data: {
          posts: {
            edges: [
              {
                node: {
                  slug: phSlug,
                  name: 'PH Product',
                  website: `https://${PREFIX}-ph.example.com`,
                  url: `https://www.producthunt.com/posts/${phSlug}`,
                  votesCount: 10,
                },
              },
            ],
          },
        },
      },
      rateLimitRemaining: 5000,
      rateLimitResetSeconds: null,
    });

    const result = await runProductDigest({
      now: NOW,
      dbh: db!,
      // 采集经 collectSources(PRODUCT_SOURCES, collectOptions)：PH 选项落 productHunt、Show HN 落 showHn。
      collectOptions: {
        logError: () => {},
        productHunt: { fetchGraphql: phFetchGraphql },
        showHn: {
          fetchJson: showHnFetchJson,
          logError: () => {},
          now: NOW,
          // 桩 hit 在窗内、points 足够；闸由桩满足，这里不依赖默认 env 值。
          minPoints: 10,
          windowDays: 7,
        },
      },
      // 不触发推送：零通道 → 推送循环不获取锁、不构造 sender、不发消息。
      channels: [],
    });

    // 采集返回 2 条（PH 1 + Show HN 1）、塌缩 2 条。
    expect(result.collectedCount).toBe(2);
    expect(result.collapsedCount).toBeGreaterThanOrEqual(2);
    expect(result.channels).toEqual([]); // 零通道，无推送。

    // Show HN 产品经全链入 ai_products（按 github_repo 键，F1 抑制 github.com 域）。
    const { rows: shRows } = await pool!.query<{
      product_id: string;
      canonical_domain: string | null;
      github_repo: string | null;
    }>(`SELECT product_id, canonical_domain, github_repo FROM ai_products WHERE github_repo = $1`, [
      shRepo,
    ]);
    expect(shRows).toHaveLength(1);
    expect(shRows[0]!.github_repo).toBe(shRepo);
    expect(shRows[0]!.canonical_domain).toBeNull(); // F1：github.com 域被抑制。

    // PH 产品也入库（两源同链采集的对照）。
    const { rows: phRows } = await pool!.query<{ product_id: string }>(
      `SELECT product_id FROM ai_products WHERE product_hunt_slug = $1`,
      [phSlug],
    );
    expect(phRows).toHaveLength(1);

    // raw_items 也确有 source='show_hn' 行落库（采集层确实经产品子集采到 Show HN）。
    const { rows: rawRows } = await pool!.query<{ source: string; raw_type: string }>(
      `SELECT source, raw_type FROM raw_items WHERE source_item_id = $1`,
      [shObjectId],
    );
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0]!.source).toBe('show_hn');
    expect(rawRows[0]!.raw_type).toBe('product');
  });
});
