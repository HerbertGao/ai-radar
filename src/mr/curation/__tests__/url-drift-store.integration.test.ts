/**
 * URL drift 待批记录 store 集成测试（**需本地 Postgres**，task 3.2，design D2/D5）。
 * 仿 price-review-store.integration.test.ts：PREFIX 隔离（source_id 前缀）+ 缺 DATABASE_URL 自动 skip。
 *
 * 覆盖单测打桩绕过的真 SQL 层：
 * ① openUrlDriftReviewOrSupersede：FOR UPDATE 锁既有 pending + DB 单时钟 TTL（make_interval）；
 *    opened / noop（未过期同候选）/ superseded-and-opened（不同候选 / 过期同候选）；flag_opened_at 冻结写入。
 * ② claimUrlDriftReview CAS：`WHERE token=? AND status='pending' AND extracted_at > now()-make_interval(hours=>$ttl)`
 *    RETURNING 含 flag_opened_at；有效认领 / 错 token / 重放（已 approved）/ 过期（backdated）→ 0 行 null。
 * ③ markUrlDriftSuperseded / markUrlDriftApplyFailed：独立事务 `WHERE id=? AND status='pending'`；pending→1、已决→0。
 * ④ 偏唯一索引 `(source_id) WHERE status='pending'`：两 pending 同 source 直接插 → 唯一冲突（并发双开兜底）。
 *
 * store 原语不触 writer / 不发快照失效、无 FK（source_id/run_id 仅标识），无需真实 mr_source 行。
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
process.env.MR_URL_DRIFT_TTL_HOURS ||= '72';

const {
  openUrlDriftReviewOrSupersede,
  claimUrlDriftReview,
  markUrlDriftSuperseded,
  markUrlDriftApplyFailed,
} = await import('../url-drift-store.js');

const PREFIX = 'mr-urldrift-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

const FLAG_OPENED_AT = '2026-07-20 09:17:00.123456+00';

function baseInput(sourceId: string, candidateUrl: string) {
  return {
    sourceId,
    runId: `${PREFIX}run`,
    oldUrl: 'https://kimi.com/old/pricing',
    candidateUrl,
    confidence: 'high',
    reason: 'agent 推断 path 重构',
    flagOpenedAt: FLAG_OPENED_AT,
  };
}

async function cleanup() {
  if (!db) return;
  await db.delete(schema.mrUrlDriftReview).where(like(schema.mrUrlDriftReview.sourceId, `${PREFIX}%`));
}

/** 直接改 extracted_at 模拟过期（DB 单时钟，仿生产 make_interval 语义）。 */
async function backdate(reviewId: string, hoursAgo: number): Promise<void> {
  await db!
    .update(schema.mrUrlDriftReview)
    .set({ extractedAt: sql`now() - make_interval(hours => ${hoursAgo})` })
    .where(eq(schema.mrUrlDriftReview.id, reviewId));
}

async function reviewStatus(reviewId: string): Promise<string> {
  const r = await db!
    .select({ status: schema.mrUrlDriftReview.status })
    .from(schema.mrUrlDriftReview)
    .where(eq(schema.mrUrlDriftReview.id, reviewId));
  return r[0]!.status;
}

/** 开记录 + 收窄到 opened（供需 token/reviewId 的用例复用）。 */
async function openForClaim(
  sourceId: string,
  candidateUrl: string,
): Promise<{ token: string; reviewId: string }> {
  const out = await openUrlDriftReviewOrSupersede(baseInput(sourceId, candidateUrl), db!);
  if (out.outcome !== 'opened') throw new Error(`expected opened, got ${out.outcome}`);
  return { token: out.token, reviewId: out.reviewId };
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describeIfDb('url-drift-store: openUrlDriftReviewOrSupersede 真 SQL', () => {
  it('无既有 pending → opened（新令牌、status=pending、flag_opened_at 冻结）', async () => {
    const out = await openUrlDriftReviewOrSupersede(
      baseInput(`${PREFIX}open`, 'https://kimi.com/new/pricing'),
      db!,
    );
    expect(out.outcome).toBe('opened');
    if (out.outcome !== 'opened') throw new Error('expected opened');
    expect(out.token).toMatch(/^[0-9a-f]{32}$/); // randomBytes(16) hex
    expect(await reviewStatus(out.reviewId)).toBe('pending');
    const row = await db!
      .select({ flagOpenedAt: schema.mrUrlDriftReview.flagOpenedAt })
      .from(schema.mrUrlDriftReview)
      .where(eq(schema.mrUrlDriftReview.id, out.reviewId));
    expect(row[0]!.flagOpenedAt).toBe(FLAG_OPENED_AT); // 开卡冻结、原样落库
  });

  it('未过期同候选 → noop（不重复发卡）', async () => {
    const first = await openUrlDriftReviewOrSupersede(
      baseInput(`${PREFIX}noop`, 'https://kimi.com/new/pricing'),
      db!,
    );
    expect(first.outcome).toBe('opened');
    const second = await openUrlDriftReviewOrSupersede(
      baseInput(`${PREFIX}noop`, 'https://kimi.com/new/pricing'),
      db!,
    );
    expect(second.outcome).toBe('noop');
  });

  it('不同候选 → superseded-and-opened（旧 superseded、新 pending）', async () => {
    const first = await openUrlDriftReviewOrSupersede(
      baseInput(`${PREFIX}super`, 'https://kimi.com/new/pricing'),
      db!,
    );
    if (first.outcome !== 'opened') throw new Error('expected opened');
    const second = await openUrlDriftReviewOrSupersede(
      baseInput(`${PREFIX}super`, 'https://kimi.com/newer/pricing'), // 不同候选
      db!,
    );
    expect(second.outcome).toBe('superseded-and-opened');
    if (second.outcome !== 'superseded-and-opened') throw new Error('expected superseded-and-opened');
    expect(await reviewStatus(first.reviewId)).toBe('superseded');
    expect(await reviewStatus(second.reviewId)).toBe('pending');
  });

  it('过期同候选 → superseded-and-opened（DB 单时钟 TTL，不永久卡死）', async () => {
    const first = await openUrlDriftReviewOrSupersede(
      baseInput(`${PREFIX}expire`, 'https://kimi.com/new/pricing'),
      db!,
    );
    if (first.outcome !== 'opened') throw new Error('expected opened');
    await backdate(first.reviewId, 73); // TTL=72h → 已过期
    const second = await openUrlDriftReviewOrSupersede(
      baseInput(`${PREFIX}expire`, 'https://kimi.com/new/pricing'), // 同候选、但已过期
      db!,
    );
    expect(second.outcome).toBe('superseded-and-opened');
    if (second.outcome !== 'superseded-and-opened') throw new Error('expected superseded-and-opened');
    expect(await reviewStatus(first.reviewId)).toBe('superseded');
    expect(await reviewStatus(second.reviewId)).toBe('pending');
  });
});

describeIfDb('url-drift-store: claimUrlDriftReview CAS + TTL', () => {
  it('有效 token + pending + 未过期 → 认领成功、status=approved、返回冻结值（含 flag_opened_at）', async () => {
    const opened = await openForClaim(`${PREFIX}claim-ok`, 'https://kimi.com/new/pricing');
    const claimed = await claimUrlDriftReview(opened.token, 'approver-itest', db!);
    expect(claimed).not.toBeNull();
    expect(claimed!.sourceId).toBe(`${PREFIX}claim-ok`);
    expect(claimed!.oldUrl).toBe('https://kimi.com/old/pricing');
    expect(claimed!.candidateUrl).toBe('https://kimi.com/new/pricing');
    expect(claimed!.flagOpenedAt).toBe(FLAG_OPENED_AT); // RETURNING MUST 含 flag_opened_at（design D-M4）
    expect(await reviewStatus(opened.reviewId)).toBe('approved');
  });

  it('错 token → null（不误认领）', async () => {
    await openForClaim(`${PREFIX}claim-wrong`, 'https://kimi.com/new/pricing');
    const claimed = await claimUrlDriftReview('0'.repeat(32), 'approver-itest', db!);
    expect(claimed).toBeNull();
  });

  it('重放（已 approved）→ null（CAS 幂等）', async () => {
    const opened = await openForClaim(`${PREFIX}claim-replay`, 'https://kimi.com/new/pricing');
    const first = await claimUrlDriftReview(opened.token, 'approver-itest', db!);
    expect(first).not.toBeNull();
    const second = await claimUrlDriftReview(opened.token, 'approver-itest', db!);
    expect(second).toBeNull();
  });

  it('过期 token → null（TTL 闭合泄漏令牌窗口）', async () => {
    const opened = await openForClaim(`${PREFIX}claim-expired`, 'https://kimi.com/new/pricing');
    await backdate(opened.reviewId, 73); // TTL=72h → 过期
    const claimed = await claimUrlDriftReview(opened.token, 'approver-itest', db!);
    expect(claimed).toBeNull();
    expect(await reviewStatus(opened.reviewId)).toBe('pending'); // 未被认领
  });
});

describeIfDb('url-drift-store: markUrlDriftSuperseded / markUrlDriftApplyFailed 独立事务', () => {
  it('markUrlDriftSuperseded：pending→1 行、再调→0 行（键 id+status=pending 防误标）', async () => {
    const opened = await openForClaim(`${PREFIX}ms`, 'https://kimi.com/new/pricing');
    expect(await markUrlDriftSuperseded(opened.reviewId, null, db!)).toBe(1);
    expect(await reviewStatus(opened.reviewId)).toBe('superseded');
    expect(await markUrlDriftSuperseded(opened.reviewId, null, db!)).toBe(0);
  });

  it('markUrlDriftApplyFailed：pending→1 行、已 apply_failed→0 行', async () => {
    const opened = await openForClaim(`${PREFIX}maf`, 'https://kimi.com/new/pricing');
    expect(await markUrlDriftApplyFailed(opened.reviewId, 'approver-itest', db!)).toBe(1);
    expect(await reviewStatus(opened.reviewId)).toBe('apply_failed');
    expect(await markUrlDriftApplyFailed(opened.reviewId, 'approver-itest', db!)).toBe(0);
  });
});

describeIfDb('url-drift-store: 偏唯一索引（并发双开兜底）', () => {
  it('同 source 直接插第二条 pending → 唯一冲突', async () => {
    await openForClaim(`${PREFIX}uniq`, 'https://kimi.com/new/pricing');
    // 直接插第二条 pending（绕过 openUrlDriftReviewOrSupersede 的 supersede 逻辑）→ 偏唯一索引拒。
    let thrown: unknown;
    try {
      await db!.insert(schema.mrUrlDriftReview).values({
        sourceId: `${PREFIX}uniq`,
        runId: `${PREFIX}run`,
        oldUrl: 'https://kimi.com/old/pricing',
        candidateUrl: 'https://kimi.com/newer/pricing',
        confidence: 'high',
        reason: 'r',
        token: 'a'.repeat(32),
        status: 'pending',
        flagOpenedAt: FLAG_OPENED_AT,
      });
      throw new Error('should have thrown');
    } catch (e) {
      thrown = e;
    }
    const cause = (thrown as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe('23505'); // unique_violation
  });
});
