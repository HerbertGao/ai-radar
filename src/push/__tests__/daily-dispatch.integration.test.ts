/**
 * dispatchDailyDigest 集成测试（merge-products-into-daily-digest，design D2，tasks 7.2 DB 部分）。
 * 需本地 Postgres（compose 起的库）。mock 发送器断言状态机，不依赖真实 Telegram/飞书（防误发生产）。
 *
 * 覆盖（连真库才能稳定验证 push_records 写入）：
 * - event 行写 target_type='event'、product 行写 target_type='product'（不混命名空间）。
 * - 两段各自 computePendingSet 跨天去重（按 channel）：某段已 success 跨天/同天不重发。
 * - 产品跨天「一产品一生一次」+ merge_conflict 排除（经真实 selectProductCandidates）。
 * - 被截断未发的产品保持 pending、不误标 success（分段 includedIds）。
 *
 * 缺 DATABASE_URL 时本套件自动跳过；唯一前缀 + 专属 push_date 隔离，afterAll 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { SelectedEvent } from '../../selection/top-n.js';
import type { MessageSender } from '../dispatcher.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph';

const { dispatchDailyDigest } = await import('../dispatcher.js');
const { selectProductCandidates } = await import('../../pipeline/product-digest.js');

const databaseUrl = process.env.DATABASE_URL;
const canRun = Boolean(databaseUrl);

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const PREFIX = `dd-itest-${process.pid}-`;
const NOW_D1 = new Date('2099-05-01T04:00:00Z'); // 上海 2099-05-01 12:00 → push_date=2099-05-01。
const PUSH_DATE_1 = '2099-05-01';
const NOW_D2 = new Date('2099-05-02T04:00:00Z'); // push_date=2099-05-02。
const PUSH_DATE_2 = '2099-05-02';

function ev(suffix: string): SelectedEvent {
  return {
    eventId: `${PREFIX}e-${suffix}`,
    representativeTitle: `事件${suffix}`,
    summaryZh: '摘要',
    headlineZh: '要点',
    canonicalUrl: null,
    publishedAt: null,
    rankScore: 0,
  };
}
/** 用真实 product_id（候选产物）作 dispatch 输入；eventId=product_id。 */
function prodInput(productId: string): SelectedEvent {
  return {
    eventId: productId,
    representativeTitle: `产品${productId}`,
    summaryZh: null,
    headlineZh: null,
    canonicalUrl: null,
    publishedAt: null,
    rankScore: 0,
  };
}

function okSender(): MessageSender & { calls: number } {
  const s = { calls: 0, async send() { s.calls += 1; } };
  return s;
}

/** 插一条 ai_products，返回 product_id。 */
async function seedProduct(args: {
  suffix: string;
  canonicalDomain?: string | null;
  metadata?: Record<string, unknown> | null;
  isAiRelated?: boolean | null;
}): Promise<string> {
  const productId = `${PREFIX}p-${args.suffix}`;
  await pool!.query(
    `INSERT INTO ai_products (product_id, name, canonical_domain, last_seen_at, metadata, is_ai_related)
     VALUES ($1, $2, $3, now(), $4::jsonb, $5)`,
    [
      productId,
      `${PREFIX}${args.suffix}-name`,
      args.canonicalDomain ?? null,
      args.metadata ? JSON.stringify(args.metadata) : null,
      // is_ai_related 闸门（selectProductCandidates 新增 eq(is_ai_related,true)）：默认 true 保既有候选口径。
      args.isAiRelated ?? true,
    ],
  );
  return productId;
}

async function fetchRows(targetType: string, channel: string, pushDate: string) {
  const { rows } = await pool!.query<{
    target_id: string;
    status: string;
    pushed_at: Date | null;
  }>(
    `SELECT target_id, status, pushed_at FROM push_records
      WHERE target_type=$1 AND channel=$2 AND push_date=$3 AND target_id LIKE $4
      ORDER BY target_id`,
    [targetType, channel, pushDate, `${PREFIX}%`],
  );
  return rows;
}

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE product_id LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool?.end();
});

describe.skipIf(!canRun)('dispatchDailyDigest 双段 push_records 幂等（7.2 DB）', () => {
  it('event 行写 target_type=event、product 行写 target_type=product（不混命名空间）', async () => {
    const pid = await seedProduct({ suffix: 'ns1' });
    const sender = okSender();
    const r = await dispatchDailyDigest(
      [ev('ns1')],
      [prodInput(pid)],
      { now: NOW_D1, sender, channel: 'telegram' },
      db!,
    );
    expect(r.outcome).toBe('sent');
    expect(r.eventIncludedIds).toEqual([`${PREFIX}e-ns1`]);
    expect(r.productIncludedIds).toEqual([pid]);
    expect(sender.calls).toBe(1); // 一次发送一条双段消息。

    // event 命名空间一行 success；product 命名空间一行 success；互不混。
    const eventRows = await fetchRows('event', 'telegram', PUSH_DATE_1);
    const productRows = await fetchRows('product', 'telegram', PUSH_DATE_1);
    expect(eventRows.map((r) => r.target_id)).toEqual([`${PREFIX}e-ns1`]);
    expect(eventRows[0]!.status).toBe('success');
    expect(productRows.map((r) => r.target_id)).toEqual([pid]);
    expect(productRows[0]!.status).toBe('success');
  });

  it('两段各自 computePendingSet 跨天去重（按 channel）：同天重跑两段皆已 success → skip 不重发', async () => {
    const pid = await seedProduct({ suffix: 'dedup1' });
    const events = [ev('dedup1')];
    const products = [prodInput(pid)];

    const r1 = await dispatchDailyDigest(
      events, products, { now: NOW_D1, sender: okSender(), channel: 'telegram' }, db!,
    );
    expect(r1.outcome).toBe('sent');

    // 同天重跑：event 段（今日 success 排除）+ product 段（任一 push_date success 排除）皆空 → skip。
    const s2 = okSender();
    const r2 = await dispatchDailyDigest(
      events, products, { now: NOW_D1, sender: s2, channel: 'telegram' }, db!,
    );
    expect(r2.outcome).toBe('skipped');
    expect(s2.calls).toBe(0);

    // 跨天重跑（次日 push_date）：两段仍已 success（任一 push_date / 跨天）→ skip。
    const s3 = okSender();
    const r3 = await dispatchDailyDigest(
      events, products, { now: NOW_D2, sender: s3, channel: 'telegram' }, db!,
    );
    expect(r3.outcome).toBe('skipped');
    expect(s3.calls).toBe(0);
    // 次日 push_date 无新增行（未天天重推）。
    expect(await fetchRows('event', 'telegram', PUSH_DATE_2)).toHaveLength(0);
    expect(await fetchRows('product', 'telegram', PUSH_DATE_2)).toHaveLength(0);
  });

  it('按 channel 分判：telegram 已 success 不抑制 feishu 段待发（各 channel 独立幂等）', async () => {
    const pid = await seedProduct({ suffix: 'chan1' });
    const events = [ev('chan1')];
    const products = [prodInput(pid)];

    // telegram 先 success。
    const rTg = await dispatchDailyDigest(
      events, products, { now: NOW_D1, sender: okSender(), channel: 'telegram' }, db!,
    );
    expect(rTg.outcome).toBe('sent');

    // feishu 段不被 telegram 的 success 抑制：candidates 与 dispatch 仍把该 product 视为待发。
    const fsCandidates = await selectProductCandidates('feishu', db!);
    expect(fsCandidates.map((c) => c.eventId)).toContain(pid);

    const sFs = okSender();
    const rFs = await dispatchDailyDigest(
      events, products, { now: NOW_D1, sender: sFs, channel: 'feishu' }, db!,
    );
    expect(rFs.outcome).toBe('sent');
    expect(sFs.calls).toBe(1);
    // feishu 命名空间各自一行 success（与 telegram 行不互相覆盖）。
    expect((await fetchRows('event', 'feishu', PUSH_DATE_1))[0]!.status).toBe('success');
    expect((await fetchRows('product', 'feishu', PUSH_DATE_1))[0]!.status).toBe('success');
  });

  it('产品跨天一产品一生一次：Day1 success 后 Day2 候选窗口排除（不天天重推）', async () => {
    const pid = await seedProduct({ suffix: 'lifetime1' });
    // Day1：候选含该产品、推 success。
    const day1 = await selectProductCandidates('telegram', db!);
    expect(day1.map((c) => c.eventId)).toContain(pid);
    const r1 = await dispatchDailyDigest(
      [], [prodInput(pid)], { now: NOW_D1, sender: okSender(), channel: 'telegram' }, db!,
    );
    expect(r1.outcome).toBe('sent');
    expect(r1.productIncludedIds).toContain(pid);

    // 模拟 last_seen 天天刷新。
    await pool!.query(`UPDATE ai_products SET last_seen_at = now() WHERE product_id = $1`, [pid]);
    // Day2 候选窗口：该产品曾 success（任一 push_date）→ 不再进候选。
    const day2 = await selectProductCandidates('telegram', db!);
    expect(day2.map((c) => c.eventId)).not.toContain(pid);
  });

  it('merge_conflict 产品排除出候选（不进新品段）', async () => {
    const pidX = await seedProduct({
      suffix: 'conf-x',
      metadata: { merge_conflict: { conflict_with: [`${PREFIX}p-conf-y`] } },
    });
    const pidClean = await seedProduct({ suffix: 'conf-clean' });
    const candidates = await selectProductCandidates('telegram', db!);
    const ids = candidates.map((c) => c.eventId);
    expect(ids).not.toContain(pidX); // 冲突排除。
    expect(ids).toContain(pidClean); // 干净产品入候选。
  });

  it('被截断未发的产品保持 pending、不误标 success（分段 includedIds）', async () => {
    // 要闻段占去大半预算（堆足够多块、每块 title 近 TITLE_MAX、headline 近 HEADLINE_MAX，均不被截、
    // 块内有界但累加逼近 MAX_MESSAGE_LENGTH），新品段产品块自身较大（带 ~1900 字合法 URL，≤ MAX_URL_LENGTH
    // 故被渲染、块约 2000 字）→ 剩余预算装不下产品块 → 产品被顺延。验证：product 仍 INSERT pending 但
    // 不在 productIncludedIds、状态保持 pending（不误标 success）。
    const pid = await seedProduct({ suffix: 'trunc1' });
    const nearTitle = '甲'.repeat(115); // < TITLE_MAX(120)，不被截。
    const nearHeadline = '乙'.repeat(78); // < HEADLINE_MAX(80)，不被截。
    const longEvents = Array.from({ length: 30 }, (_, i) => ({
      ...ev(`trunc-ev${i}`),
      representativeTitle: nearTitle,
      headlineZh: nearHeadline,
    }));
    // 产品块较大：合法长 URL（≤ MAX_URL_LENGTH=2000，故被渲染进块）。
    const bigProduct = {
      ...prodInput(pid),
      canonicalUrl: 'https://prod.example.com/' + 'a'.repeat(1900),
    };
    const sender = okSender();
    const r = await dispatchDailyDigest(
      longEvents, [bigProduct], { now: NOW_D1, sender, channel: 'telegram' }, db!,
    );
    expect(r.outcome).toBe('sent');
    expect(sender.calls).toBe(1);
    // 要闻段被截断（实发 < 8）。
    expect(r.eventIncludedIds.length).toBeGreaterThan(0);
    expect(r.eventIncludedIds.length).toBeLessThan(longEvents.length);
    // 产品被顺延、不在实发集合。
    expect(r.productIncludedIds).not.toContain(pid);

    // product 行已 INSERT pending（待发集合非空必先插），但状态保持 pending（未误标 success）。
    const productRows = await fetchRows('product', 'telegram', PUSH_DATE_1);
    const row = productRows.find((x) => x.target_id === pid)!;
    expect(row.status).toBe('pending');
    expect(row.pushed_at).toBeNull();

    // 下次仍属待发集合（候选窗口仍判未 success）。
    const stillCandidate = await selectProductCandidates('telegram', db!);
    expect(stillCandidate.map((c) => c.eventId)).toContain(pid);
  });
});
