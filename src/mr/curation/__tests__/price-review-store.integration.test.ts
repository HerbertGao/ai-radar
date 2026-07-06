/**
 * 价格 curation 待批记录 store 集成测试（**需本地 Postgres**，design D2/D3/D5）。
 *
 * 覆盖单测打桩绕过的真 SQL 层（memory follow-up #1：翻门控前机器强锚 CAS/TTL/并发）：
 * ① openReviewOrSupersede：FOR UPDATE 锁既有 pending + DB 单时钟 TTL（`make_interval`）；
 *    opened / noop（未过期同候选）/ superseded-and-opened（不同候选 / 过期同候选）。
 * ② claimReview CAS：`WHERE token=? AND status='pending' AND extracted_at > now()-make_interval(hours=>$ttl)`；
 *    有效认领 / 错 token / 重放（已 approved）/ 过期（backdated extracted_at）→ 0 行 null。
 * ③ markSuperseded / markApplyFailed：独立事务 `WHERE id=? AND status='pending'`；pending→1 行、已决→0 行。
 * ④ 偏唯一索引 `(plan_id) WHERE status='pending'`：两 pending 同 plan 直接插 → 唯一冲突（并发兜底）。
 *
 * 仿 record-price-change.integration.test.ts：PREFIX 隔离 + 缺 DATABASE_URL 自动 skip。
 * store 原语不触 writer / 不发快照失效，无需 mock。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const { openReviewOrSupersede, claimReview, markSuperseded, markApplyFailed } = await import(
  '../price-review-store.js'
);
const { upsertVendor, upsertPlan } = await import('../../ingest/upsert.js');

const PREFIX = 'mr-pricereview-itest-';
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

/** 直接改 extracted_at 模拟过期（DB 单时钟，仿生产 make_interval 语义）。 */
async function backdateReview(reviewId: string, hoursAgo: number): Promise<void> {
  await db!
    .update(schema.mrPriceReview)
    .set({ extractedAt: sql`now() - make_interval(hours => ${hoursAgo})` })
    .where(eq(schema.mrPriceReview.id, reviewId));
}

async function reviewStatus(reviewId: string): Promise<string> {
  const r = await db!
    .select({ status: schema.mrPriceReview.status })
    .from(schema.mrPriceReview)
    .where(eq(schema.mrPriceReview.id, reviewId));
  return r[0]!.status;
}

/** 开记录 + 运行时收窄到 opened（供需 token/reviewId 的用例复用；TS discriminated-union narrowing）。 */
async function openForClaim(
  planId: string,
  candidate: string,
  suffix: string,
): Promise<{ token: string; reviewId: string }> {
  const out = await openReviewOrSupersede(
    {
      planId,
      oldValue: '40.00',
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

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describeIfDb('price-review-store: openReviewOrSupersede 真 SQL', () => {
  it('无既有 pending → opened（新令牌、status=pending）', async () => {
    const planId = await makePlan('open', '40.00', 'CNY');
    const out = await openReviewOrSupersede(
      {
        planId,
        oldValue: '40.00',
        candidateValue: '45.00',
        currency: 'CNY',
        sourceUrl: `${PREFIX}prov-open`,
        sourceConfidence: 'official_pricing',
      },
      db!,
    );
    expect(out.outcome).toBe('opened');
    if (out.outcome !== 'opened') throw new Error('expected opened');
    expect(out.token).toMatch(/^[0-9a-f]{32}$/); // randomBytes(16) hex
    expect(await reviewStatus(out.reviewId)).toBe('pending');
  });

  it('未过期同候选 → noop（不重复发卡）', async () => {
    const planId = await makePlan('noop', '40.00', 'CNY');
    const first = await openReviewOrSupersede(
      {
        planId,
        oldValue: '40.00',
        candidateValue: '45.00',
        currency: 'CNY',
        sourceUrl: `${PREFIX}prov-noop`,
        sourceConfidence: 'official_pricing',
      },
      db!,
    );
    expect(first.outcome).toBe('opened');
    const second = await openReviewOrSupersede(
      {
        planId,
        oldValue: '40.00',
        candidateValue: '45.00',
        currency: 'CNY',
        sourceUrl: `${PREFIX}prov-noop`,
        sourceConfidence: 'official_pricing',
      },
      db!,
    );
    expect(second.outcome).toBe('noop');
  });

  it('不同候选 → superseded-and-opened（旧 superseded、新 pending）', async () => {
    const planId = await makePlan('super', '40.00', 'CNY');
    const first = await openReviewOrSupersede(
      {
        planId,
        oldValue: '40.00',
        candidateValue: '45.00',
        currency: 'CNY',
        sourceUrl: `${PREFIX}prov-super`,
        sourceConfidence: 'official_pricing',
      },
      db!,
    );
    expect(first.outcome).toBe('opened');
    if (first.outcome !== 'opened') throw new Error('expected opened');
    const second = await openReviewOrSupersede(
      {
        planId,
        oldValue: '40.00',
        candidateValue: '46.00', // 不同候选
        currency: 'CNY',
        sourceUrl: `${PREFIX}prov-super`,
        sourceConfidence: 'official_pricing',
      },
      db!,
    );
    expect(second.outcome).toBe('superseded-and-opened');
    if (second.outcome !== 'superseded-and-opened') throw new Error('expected superseded-and-opened');
    expect(await reviewStatus(first.reviewId)).toBe('superseded'); // 旧 → superseded
    expect(await reviewStatus(second.reviewId)).toBe('pending'); // 新 → pending
  });

  it('过期同候选 → superseded-and-opened（DB 单时钟 TTL，不永久卡死）', async () => {
    const planId = await makePlan('expire', '40.00', 'CNY');
    const first = await openReviewOrSupersede(
      {
        planId,
        oldValue: '40.00',
        candidateValue: '45.00',
        currency: 'CNY',
        sourceUrl: `${PREFIX}prov-expire`,
        sourceConfidence: 'official_pricing',
      },
      db!,
    );
    expect(first.outcome).toBe('opened');
    if (first.outcome !== 'opened') throw new Error('expected opened');
    // 回溯 extracted_at 到 73 小时前（TTL=72h → 已过期）。
    await backdateReview(first.reviewId, 73);
    const second = await openReviewOrSupersede(
      {
        planId,
        oldValue: '40.00',
        candidateValue: '45.00', // 同候选，但已过期
        currency: 'CNY',
        sourceUrl: `${PREFIX}prov-expire`,
        sourceConfidence: 'official_pricing',
      },
      db!,
    );
    expect(second.outcome).toBe('superseded-and-opened');
    if (second.outcome !== 'superseded-and-opened') throw new Error('expected superseded-and-opened');
    expect(await reviewStatus(first.reviewId)).toBe('superseded'); // 过期旧行 → superseded
    expect(await reviewStatus(second.reviewId)).toBe('pending'); // 新 pending
  });
});

describeIfDb('price-review-store: claimReview CAS + TTL', () => {
  it('有效 token + pending + 未过期 → 认领成功、status=approved、返回冻结值', async () => {
    const planId = await makePlan('claim-ok', '40.00', 'CNY');
    const opened = await openForClaim(planId, '45.00', 'claim-ok');
    const claimed = await claimReview(opened.token, 'approver-itest', db!);
    expect(claimed).not.toBeNull();
    expect(claimed!.planId).toBe(planId);
    expect(claimed!.candidateValue).toBe('45.00');
    expect(claimed!.currency).toBe('CNY');
    expect(claimed!.sourceConfidence).toBe('official_pricing');
    expect(await reviewStatus(opened.reviewId)).toBe('approved');
  });

  it('错 token → null（不误认领）', async () => {
    const planId = await makePlan('claim-wrong', '40.00', 'CNY');
    await openForClaim(planId, '45.00', 'claim-wrong');
    const claimed = await claimReview('0'.repeat(32), 'approver-itest', db!);
    expect(claimed).toBeNull();
  });

  it('重放（已 approved）→ null（CAS 幂等）', async () => {
    const planId = await makePlan('claim-replay', '40.00', 'CNY');
    const opened = await openForClaim(planId, '45.00', 'claim-replay');
    const first = await claimReview(opened.token, 'approver-itest', db!);
    expect(first).not.toBeNull();
    const second = await claimReview(opened.token, 'approver-itest', db!);
    expect(second).toBeNull(); // 已 approved → 0 行
  });

  it('过期 token → null（TTL 闭合泄漏令牌窗口）', async () => {
    const planId = await makePlan('claim-expired', '40.00', 'CNY');
    const opened = await openForClaim(planId, '45.00', 'claim-expired');
    await backdateReview(opened.reviewId, 73); // TTL=72h → 过期
    const claimed = await claimReview(opened.token, 'approver-itest', db!);
    expect(claimed).toBeNull();
    expect(await reviewStatus(opened.reviewId)).toBe('pending'); // 未被认领
  });
});

describeIfDb('price-review-store: markSuperseded / markApplyFailed 独立事务', () => {
  it('markSuperseded：pending→1 行、再调→0 行（键 id+status=pending 防误标）', async () => {
    const planId = await makePlan('ms', '40.00', 'CNY');
    const opened = await openForClaim(planId, '45.00', 'ms');
    const n1 = await markSuperseded(opened.reviewId, null, db!);
    expect(n1).toBe(1);
    expect(await reviewStatus(opened.reviewId)).toBe('superseded');
    // 已 superseded → WHERE status='pending' 不命中 → 0 行（防并发 proposer 已 supersede 后误标新候选）。
    const n2 = await markSuperseded(opened.reviewId, null, db!);
    expect(n2).toBe(0);
  });

  it('markApplyFailed：pending→1 行、已 apply_failed→0 行', async () => {
    const planId = await makePlan('maf', '40.00', 'CNY');
    const opened = await openForClaim(planId, '45.00', 'maf');
    const n1 = await markApplyFailed(opened.reviewId, 'approver-itest', db!);
    expect(n1).toBe(1);
    expect(await reviewStatus(opened.reviewId)).toBe('apply_failed');
    // apply_failed 非 pending → 0 行（偏索引放行新候选）。
    const n2 = await markApplyFailed(opened.reviewId, 'approver-itest', db!);
    expect(n2).toBe(0);
  });
});

describeIfDb('price-review-store: 偏唯一索引（并发兜底）', () => {
  it('同 plan 直接插第二条 pending → 唯一冲突', async () => {
    const planId = await makePlan('uniq', '40.00', 'CNY');
    await openForClaim(planId, '45.00', 'uniq');
    // 直接插第二条 pending（绕过 openReviewOrSupersede 的 supersede 逻辑）→ 偏唯一索引拒。
    // drizzle 把 pg 错包在 .cause（pg unique_violation = code 23505）。
    let thrown: unknown;
    try {
      await db!.insert(schema.mrPriceReview).values({
        planId,
        oldValue: '40.00',
        candidateValue: '46.00',
        currency: 'CNY',
        sourceUrl: `${PREFIX}prov-uniq-2`,
        sourceConfidence: 'official_pricing',
        token: 'a'.repeat(32),
        status: 'pending',
      });
      throw new Error('should have thrown');
    } catch (e) {
      thrown = e;
    }
    const cause = (thrown as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe('23505'); // unique_violation
  });
});
