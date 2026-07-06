/**
 * 价格 curation 批准核心 `applyReview` 集成测试（**需本地 Postgres**，design D5）。
 *
 * 端到端真 DB 链路：CAS 认领（claimReview）→ FOR UPDATE 锁 plan + 基线校验（sameMoney）→
 * `_recordPriceChangeTx`（真 writer、真 history append、真 current 刷新）→ 提交后 publishSnapshotInvalidation（mock）。
 * 覆盖单测打桩绕过的真 SQL 组合：
 * ① happy path：open → applyReview → applied（真价写 mr_plans + mr_price_history，review=approved）。
 * ② 重放：同 token 再 applyReview → noop（CAS 0 行）。
 * ③ 过期：backdated extracted_at → noop（TTL 闭合）。
 * ④ 基线漂移：open 后改 plan 现价 → baseline-drift（主事务回滚、独立事务 superseded、未落库）。
 * ⑤ 错 token → noop。
 *
 * 仿 record-price-change.integration.test.ts：PREFIX 隔离 + mock 快照失效（守「测试绝不连真 Redis」）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, like, sql } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
process.env.MR_PRICE_REVIEW_TTL_HOURS ||= '72';

// applyReview 提交后调 publishSnapshotInvalidation（连真 Redis）→ mock 成 no-op，守「测试绝不连真 Redis」。
vi.mock('../../snapshot/invalidation.js', () => ({
  publishSnapshotInvalidation: vi.fn(async () => {}),
  createSnapshotInvalidationSubscriber: vi.fn(() => ({ quit: vi.fn(async () => {}) })),
  SNAPSHOT_INVALIDATION_CHANNEL: 'mr:snapshot:invalidate',
}));

const { applyReview } = await import('../approve.js');
const { openReviewOrSupersede } = await import('../price-review-store.js');
const { upsertVendor, upsertPlan } = await import('../../ingest/upsert.js');

const PREFIX = 'mr-apply-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

async function makePlan(suffix: string, currentPrice: string, currency: string): Promise<string> {
  const v = await upsertVendor(db!, {
    normalizedName: `${PREFIX}v-${suffix}`,
    name: `V ${suffix}`,
  });
  const plan = await upsertPlan(db!, {
    vendorId: v.id,
    name: `${PREFIX}plan-${suffix}`,
    category: 'coding_plan',
    currentPrice,
    currency,
    sourceUrl: `${PREFIX}src-${suffix}`,
    sourceConfidence: 'official_pricing',
  });
  return (plan as { id: string }).id;
}

async function cleanup() {
  if (!db) return;
  await db.delete(schema.mrPriceReview).where(like(schema.mrPriceReview.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPriceHistory).where(like(schema.mrPriceHistory.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlans).where(like(schema.mrPlans.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrVendors).where(like(schema.mrVendors.normalizedName, `${PREFIX}%`));
}

async function backdateReview(reviewId: string, hoursAgo: number): Promise<void> {
  await db!
    .update(schema.mrPriceReview)
    .set({ extractedAt: sql`now() - make_interval(hours => ${hoursAgo})` })
    .where(eq(schema.mrPriceReview.id, reviewId));
}

async function openReview(
  planId: string,
  oldValue: string,
  candidate: string,
  suffix: string,
): Promise<{ token: string; reviewId: string }> {
  const out = await openReviewOrSupersede(
    {
      planId,
      oldValue,
      candidateValue: candidate,
      currency: 'CNY',
      sourceUrl: `${PREFIX}prov-${suffix}`,
      sourceConfidence: 'official_pricing',
    },
    db!,
  );
  if (out.outcome !== 'opened') throw new Error(`expected opened, got ${out.outcome}`);
  return { token: out.token, reviewId: out.reviewId };
}

async function reviewRow(reviewId: string) {
  const r = await db!
    .select()
    .from(schema.mrPriceReview)
    .where(eq(schema.mrPriceReview.id, reviewId));
  return r[0]!;
}

async function planRow(planId: string) {
  const r = await db!.select().from(schema.mrPlans).where(eq(schema.mrPlans.id, planId));
  return r[0]!;
}

async function historyRows(planId: string) {
  return db!
    .select()
    .from(schema.mrPriceHistory)
    .where(eq(schema.mrPriceHistory.planId, planId))
    .orderBy(sql`${schema.mrPriceHistory.changedAt} asc`);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describeIfDb('applyReview 端到端真 DB', () => {
  it('happy path：open → applied（真写 mr_plans + mr_price_history，review=approved）', async () => {
    const planId = await makePlan('happy', '40.00', 'CNY');
    const { token, reviewId } = await openReview(planId, '40.00', '45.00', 'happy');

    const out = await applyReview(token, 'approver-itest', db!);
    expect(out.kind).toBe('applied');
    if (out.kind !== 'applied') throw new Error('expected applied');
    expect(out.planId).toBe(planId);
    expect(out.oldValue).toBe('40.00');
    expect(out.newValue).toBe('45.00');

    // review 已 approved（CAS 已认领）。
    expect((await reviewRow(reviewId)).status).toBe('approved');
    // plan.currentPrice 刷成 45。
    expect(Number((await planRow(planId)).currentPrice)).toBe(45);
    // mr_price_history 真追加一行（old=40 → new=45）。
    const h = await historyRows(planId);
    expect(h).toHaveLength(1);
    expect(Number(h[0]!.newValue)).toBe(45);
    expect(Number(h[0]!.oldValue)).toBe(40);
  });

  it('重放：同 token 再 applyReview → noop（CAS 0 行、不二次落库）', async () => {
    const planId = await makePlan('replay', '40.00', 'CNY');
    const { token } = await openReview(planId, '40.00', '45.00', 'replay');

    const first = await applyReview(token, 'approver-itest', db!);
    expect(first.kind).toBe('applied');
    const second = await applyReview(token, 'approver-itest', db!);
    expect(second.kind).toBe('noop'); // 已 approved → CAS 0 行

    // history 仍只 1 行（未二次落库）。
    expect((await historyRows(planId))).toHaveLength(1);
  });

  it('过期：backdated extracted_at → noop（TTL 闭合、未认领）', async () => {
    const planId = await makePlan('expired', '40.00', 'CNY');
    const { token, reviewId } = await openReview(planId, '40.00', '45.00', 'expired');
    await backdateReview(reviewId, 73); // TTL=72h → 过期

    const out = await applyReview(token, 'approver-itest', db!);
    expect(out.kind).toBe('noop'); // CAS WHERE extracted_at > now()-72h → 0 行
    expect((await reviewRow(reviewId)).status).toBe('pending'); // 未被认领
    // 未落库。
    expect((await historyRows(planId))).toHaveLength(0);
    expect(Number((await planRow(planId)).currentPrice)).toBe(40);
  });

  it('基线漂移：open 后改 plan 现价 → baseline-drift（主事务回滚、独立事务 superseded、未落库）', async () => {
    const planId = await makePlan('drift', '40.00', 'CNY');
    const { token, reviewId } = await openReview(planId, '40.00', '45.00', 'drift');

    // 模拟开记录后、人批准前 plan 现价被改（基线漂移）。
    await db!
      .update(schema.mrPlans)
      .set({ currentPrice: '50.00' })
      .where(eq(schema.mrPlans.id, planId));

    const out = await applyReview(token, 'approver-itest', db!);
    expect(out.kind).toBe('baseline-drift');
    if (out.kind !== 'baseline-drift') throw new Error('expected baseline-drift');
    expect(out.reviewId).toBe(reviewId);

    // 主事务回滚（CAS 未提交 approved）→ 独立事务 markSuperseded → superseded。
    expect((await reviewRow(reviewId)).status).toBe('superseded');
    // 未落库（current 仍 50——漂移后的值，非候选 45）。
    expect(Number((await planRow(planId)).currentPrice)).toBe(50);
    expect((await historyRows(planId))).toHaveLength(0);
  });

  it('错 token → noop', async () => {
    const planId = await makePlan('wrongtok', '40.00', 'CNY');
    await openReview(planId, '40.00', '45.00', 'wrongtok');

    const out = await applyReview('0'.repeat(32), 'approver-itest', db!);
    expect(out.kind).toBe('noop');
    expect((await historyRows(planId))).toHaveLength(0);
  });
});
