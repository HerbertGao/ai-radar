/**
 * Show HN × 产品塌缩 跨源集成测试（source-collectors / product-discovery，**跑真实 Postgres**）。
 *
 * 与既有 product-collapse 集成测试同 DB 装置；**不得用内存桩替代塌缩事务**——
 * `collapseUncollapsedProductRawItems` 依赖 `FOR UPDATE` + jsonb 运算，内存桩会假绿绕开关键断言。
 * 缺 DATABASE_URL 时本套件自动跳过；用唯一前缀隔离，afterAll 清理本套件造的行。
 *
 * 覆盖（tasks 5.3 / design D5 F1 / risk）：
 * ① **回归守护**：source='show_hn' 与 source='product_hunt' 各一 product raw_item 都入 ai_products
 *    （source-agnostic 入口；任何把入口收窄到单 source 的改动即令 show_hn 断言失败）。
 * ② **跨源合并**：PH 行（github_repo=o/r）再塌缩同 github_repo 的 Show HN → 合并为单行（同 product_id）。
 * ③ **github 不误并（验 F1）**：两条产品 url 均为 github.com/<owner>/<name>（经 url 推导 github_repo +
 *    撞出 github.com 域，**不预填 meta**），至少一条 source='product_hunt' → 塌缩后两行、各自
 *    canonical_domain 为 null、不被静默合并/误记 merge_conflict（注释掉 product-keys 的 F1 则本用例转红）。
 * ④ 缺 slug（Show HN 无 product_hunt_slug）不破坏其余键合并。
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

const { collapseUncollapsedProductRawItems } = await import('../product-collapse.js');

const databaseUrl = process.env.DATABASE_URL;
const PREFIX = `shitest-${process.pid}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/** 插入一条 product raw_item（指定 source；source_item_id 唯一隔离），返回 id（bigint）。 */
async function seedProductRawItem(args: {
  source: string;
  sourceItemId: string;
  url: string | null;
  title: string;
  metadata: Record<string, unknown>;
}): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, raw_type, url, title, metadata)
     VALUES ($1, $2, 'product', $3, $4, $5::jsonb) RETURNING id`,
    [
      args.source,
      args.sourceItemId,
      args.url,
      args.title,
      JSON.stringify(args.metadata),
    ],
  );
  return BigInt(rows[0]!.id);
}

async function fetchProduct(productId: string) {
  const { rows } = await pool!.query<{
    product_id: string;
    name: string;
    canonical_domain: string | null;
    github_repo: string | null;
    product_hunt_slug: string | null;
    metadata: { merge_conflict?: { conflict_with?: string[] } } | null;
  }>(`SELECT * FROM ai_products WHERE product_id = $1`, [productId]);
  return rows[0];
}

/** 本套件造的两个 source 的 raw_items 标识前缀（用 source_item_id 前缀隔离，source 复用真实值）。 */
const SHOW_HN_SOURCE = 'show_hn';
const PH_SOURCE = 'product_hunt';

async function cleanup() {
  if (!pool) return;
  // 删本套件造的 raw_items（按 source_item_id 前缀，两 source 都用真实 source 值故只能按前缀删）。
  await pool.query(`DELETE FROM raw_items WHERE source_item_id LIKE $1`, [`${PREFIX}%`]);
  // 删本套件造的 ai_products（按 slug / domain / github_repo 前缀）。
  await pool.query(`DELETE FROM ai_products WHERE product_hunt_slug LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE canonical_domain LIKE $1`, [`%${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE github_repo LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)('Show HN × 产品塌缩（跨源 / F1 不误并）', () => {
  it('① 回归守护：show_hn 与 product_hunt 各一 product raw_item 都经 source-agnostic 入口入库', async () => {
    const phSlug = `${PREFIX}-reg-ph`;
    await seedProductRawItem({
      source: PH_SOURCE,
      sourceItemId: `${PREFIX}-reg-ph-1`,
      url: `https://${PREFIX}-ph.example.com`,
      title: 'Reg PH Product',
      metadata: { product_hunt_slug: phSlug, website: `https://${PREFIX}-ph.example.com` },
    });
    // Show HN 行：无 slug，仅靠 canonical_domain（剥 Show HN 前缀后的产品名作 title）。
    await seedProductRawItem({
      source: SHOW_HN_SOURCE,
      sourceItemId: `${PREFIX}-reg-sh-1`,
      url: `https://${PREFIX}-sh.example.com`,
      title: 'Reg Show HN Product',
      metadata: { points: 42, author: 'someone' },
    });

    const outcomes = await collapseUncollapsedProductRawItems(db!, () => {});
    const ph = outcomes.find((o) => o.keys.productHuntSlug === phSlug);
    const sh = outcomes.find((o) => o.keys.canonicalDomain === `${PREFIX}-sh.example.com`);
    // 两条都被 source-agnostic 入口选中 → INSERT 入 ai_products。
    expect(ph?.status).toBe('inserted');
    expect(sh?.status).toBe('inserted');

    const phRow = await fetchProduct(ph!.productIds[0]!);
    const shRow = await fetchProduct(sh!.productIds[0]!);
    expect(phRow).toBeDefined();
    expect(shRow).toBeDefined();
    expect(phRow!.product_hunt_slug).toBe(phSlug);
    expect(shRow!.canonical_domain).toBe(`${PREFIX}-sh.example.com`);
    // Show HN 行无 slug，不破坏入库。
    expect(shRow!.product_hunt_slug).toBeNull();
  });

  it('② 跨源合并：PH 与 Show HN 同 github_repo → 合并为单行（同 product_id、不新建）', async () => {
    const repo = `${PREFIX}-owner/merge-tool`;
    const repoUrl = `https://github.com/${PREFIX}-owner/merge-tool`;
    // 先 PH 行入库（github_repo 由 url 推导）。
    await seedProductRawItem({
      source: PH_SOURCE,
      sourceItemId: `${PREFIX}-merge-ph-1`,
      url: repoUrl,
      title: 'Merge Tool (PH)',
      metadata: { product_hunt_slug: `${PREFIX}-merge-ph`, website: repoUrl },
    });
    const firstPass = await collapseUncollapsedProductRawItems(db!, () => {});
    const phOut = firstPass.find((o) => o.keys.githubRepo === repo);
    expect(phOut?.status).toBe('inserted');
    const productId = phOut!.productIds[0]!;
    // F1：PH 的 github 产品 canonical_domain 被抑制为 null（按 github_repo 合并）。
    const phRow = await fetchProduct(productId);
    expect(phRow!.github_repo).toBe(repo);
    expect(phRow!.canonical_domain).toBeNull();

    // 其后 Show HN 采到同一 github 仓库（同 github_repo、无 slug）。
    await seedProductRawItem({
      source: SHOW_HN_SOURCE,
      sourceItemId: `${PREFIX}-merge-sh-1`,
      url: repoUrl,
      title: 'Merge Tool (Show HN)',
      metadata: { points: 100, author: 'dev' },
    });
    const secondPass = await collapseUncollapsedProductRawItems(db!, () => {});
    const shOut = secondPass.find((o) => o.keys.githubRepo === repo);
    // 命中既有行 → UPDATE 同 product_id，不新建第二行。
    expect(shOut?.status).toBe('updated');
    expect(shOut!.productIds).toEqual([productId]);

    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ai_products WHERE github_repo = $1`,
      [repo],
    );
    expect(Number(rows[0]!.n)).toBe(1); // 跨源合并为单行。
  });

  it('③ github 不误并（验 F1）：两条 github.com/<o>/<n> 产品按各自 github_repo 独立、canonical_domain 为 null', async () => {
    // 不预填 meta.github_repo / meta.canonical_domain，确保经 url 推导 + 撞出 github.com 域真实发生。
    // 一条 source=product_hunt（背书 F1 对 PH 同样正确），一条 source=show_hn。
    const ownerA = `${PREFIX}-aaa`;
    const ownerB = `${PREFIX}-bbb`;
    const repoA = `${ownerA}/a`;
    const repoB = `${ownerB}/b`;
    await seedProductRawItem({
      source: PH_SOURCE,
      sourceItemId: `${PREFIX}-f1-a`,
      url: `https://github.com/${ownerA}/a`,
      title: 'F1 A (PH)',
      metadata: { product_hunt_slug: `${PREFIX}-f1-a-slug`, website: `https://github.com/${ownerA}/a` },
    });
    await seedProductRawItem({
      source: SHOW_HN_SOURCE,
      sourceItemId: `${PREFIX}-f1-b`,
      url: `https://github.com/${ownerB}/b`,
      title: 'F1 B (Show HN)',
      metadata: { points: 50, author: 'dev' },
    });

    const logged: unknown[] = [];
    const outcomes = await collapseUncollapsedProductRawItems(db!, (m) => logged.push(m));
    const a = outcomes.find((o) => o.keys.githubRepo === repoA);
    const b = outcomes.find((o) => o.keys.githubRepo === repoB);
    // 各成独立行（不被 github.com 域静默合并、不误记 merge_conflict）。
    expect(a?.status).toBe('inserted');
    expect(b?.status).toBe('inserted');
    expect(a!.productIds[0]).not.toBe(b!.productIds[0]);

    const rowA = await fetchProduct(a!.productIds[0]!);
    const rowB = await fetchProduct(b!.productIds[0]!);
    // F1：canonical_domain 均抑制为 null（github.com 不作合并键）。
    expect(rowA!.canonical_domain).toBeNull();
    expect(rowB!.canonical_domain).toBeNull();
    expect(rowA!.github_repo).toBe(repoA);
    expect(rowB!.github_repo).toBe(repoB);
    // 未被误记 merge_conflict。
    expect(rowA!.metadata?.merge_conflict).toBeUndefined();
    expect(rowB!.metadata?.merge_conflict).toBeUndefined();
  });

  it('④ Show HN 缺 slug 不破坏其余键合并（同 canonical_domain 跨源合并）', async () => {
    const domain = `${PREFIX}-slugless.example.com`;
    // PH 行：有 slug + domain。
    await seedProductRawItem({
      source: PH_SOURCE,
      sourceItemId: `${PREFIX}-slugless-ph-1`,
      url: `https://${domain}`,
      title: 'Slugless PH',
      metadata: { product_hunt_slug: `${PREFIX}-slugless`, website: `https://${domain}` },
    });
    const first = await collapseUncollapsedProductRawItems(db!, () => {});
    const phOut = first.find((o) => o.keys.canonicalDomain === domain);
    expect(phOut?.status).toBe('inserted');
    const productId = phOut!.productIds[0]!;

    // Show HN 行：无 slug，同 canonical_domain → 经 domain 命中合并（空 slug 键不放行多行）。
    await seedProductRawItem({
      source: SHOW_HN_SOURCE,
      sourceItemId: `${PREFIX}-slugless-sh-1`,
      url: `https://${domain}`,
      title: 'Slugless Show HN',
      metadata: { points: 33 },
    });
    const second = await collapseUncollapsedProductRawItems(db!, () => {});
    const shOut = second.find((o) => o.keys.canonicalDomain === domain);
    expect(shOut?.status).toBe('updated');
    expect(shOut!.productIds).toEqual([productId]); // 同行、缺 slug 不破坏合并。

    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ai_products WHERE canonical_domain = $1`,
      [domain],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
