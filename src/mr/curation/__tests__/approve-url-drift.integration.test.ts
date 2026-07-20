/**
 * `applyUrlDriftReview` 集成测试（task 9.3，**需本地 Postgres**，design D2/D-M5）。
 *
 * 端到端真 DB 链路：CAS 认领（claimUrlDriftReview）→ vendor-scope 再校验（vendorOf + vendorDomainSet）→
 * setSourceUrl（真 old-URL CAS + mr_plans 对齐 + generation-aware resolveFlag）→ 提交后 publishSnapshotInvalidation（mock）。
 * 覆盖单测打桩绕过的真 SQL 组合：
 * ① happy：open → applyUrlDriftReview → applied（真改 mr_source.source_url + 关联 plan 对齐 + flag resolve、review=approved）。
 * ② 重放：同 token 再 applyUrlDriftReview → noop（CAS 0 行）。
 * ③ cross-domain：候选 host 不在该 vendor 域集内（vendor-scope step ②）→ cross-domain-drift（source 不改、review=apply_failed）。
 * ④ url-conflict：候选 = 同 vendor 另一 source 的 URL → 真撞 UNIQUE(vendor_id, source_url) → failed{url-conflict}。
 * ⑤ stale-url：open 后源 URL 被并发替换 → old-URL CAS 0 行 → failed{stale-url}。
 * ⑥ 错 token → noop。
 *
 * 仿 approve.integration.test.ts / set-source-url.integration.test.ts：PREFIX 隔离 + mock 快照失效（守「测试绝不连真 Redis」）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray, like, sql } from 'drizzle-orm';
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

// applyUrlDriftReview 提交后调 publishSnapshotInvalidation（连真 Redis）→ mock 成 no-op，守「测试绝不连真 Redis」。
vi.mock('../../snapshot/invalidation.js', () => ({
  publishSnapshotInvalidation: vi.fn(async () => {}),
  createSnapshotInvalidationSubscriber: vi.fn(() => ({ quit: vi.fn(async () => {}) })),
  SNAPSHOT_INVALIDATION_CHANNEL: 'mr:snapshot:invalidate',
}));

const { applyUrlDriftReview } = await import('../approve.js');
const { openUrlDriftReviewOrSupersede } = await import('../url-drift-store.js');

const PREFIX = 'mr-apply-ud-itest-';
const V_ID = `${PREFIX}vendor`;
const S_ID = `${PREFIX}source`;
const SIB_ID = `${PREFIX}sibling`;
const PA_ID = `${PREFIX}planA`; // canonical：source_url = OLD_URL → 应被对齐迁移
const PB_ID = `${PREFIX}planB`; // 聚合关联：source_url ≠ OLD_URL → 不应被动

const OLD_URL = 'https://www.kimi.com/membership/pricing';
const NEW_URL = 'https://kimi.com/membership';
const OTHER_URL = 'https://platform.kimi.com/docs'; // planB 聚合关联（allowlist 内、≠OLD_URL）
const CROSS_DOMAIN_URL = 'https://bigmodel.cn/glm-coding'; // allowlist 内、但不在 Kimi vendor 域集 → cross-domain

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

async function cleanup(): Promise<void> {
  if (!db) return;
  await db.delete(schema.mrUrlDriftReview).where(like(schema.mrUrlDriftReview.sourceId, `${PREFIX}%`));
  await db.delete(schema.mrReviewFlag).where(eq(schema.mrReviewFlag.targetId, S_ID));
  await db.delete(schema.mrPlanSources).where(eq(schema.mrPlanSources.sourceId, S_ID));
  await db.delete(schema.mrPlans).where(inArray(schema.mrPlans.id, [PA_ID, PB_ID]));
  await db.delete(schema.mrSource).where(inArray(schema.mrSource.id, [S_ID, SIB_ID]));
  await db.delete(schema.mrVendors).where(like(schema.mrVendors.id, `${PREFIX}%`));
}

async function seed(): Promise<void> {
  if (!db) return;
  await cleanup();
  await db.insert(schema.mrVendors).values({ id: V_ID, normalizedName: `${PREFIX}v`, name: `${PREFIX}Vendor` });
  await db.insert(schema.mrSource).values({
    id: S_ID,
    sourceUrl: OLD_URL,
    vendorId: V_ID,
    fetchStrategy: 'browser',
  });
  await db.insert(schema.mrPlans).values([
    { id: PA_ID, vendorId: V_ID, name: `${PREFIX}A`, category: 'ide_membership', sourceUrl: OLD_URL, lastChecked: new Date(), sourceConfidence: 'official' },
    { id: PB_ID, vendorId: V_ID, name: `${PREFIX}B`, category: 'ide_membership', sourceUrl: OTHER_URL, lastChecked: new Date(), sourceConfidence: 'official' },
  ]);
  await db.insert(schema.mrPlanSources).values([
    { id: `${PREFIX}psA`, sourceId: S_ID, planId: PA_ID },
    { id: `${PREFIX}psB`, sourceId: S_ID, planId: PB_ID },
  ]);
  await db.insert(schema.mrReviewFlag).values({
    targetType: 'source',
    targetId: S_ID,
    reason: 'test drift',
    status: 'pending',
    openedAt: sql`now()`,
    resolvedAt: null,
  });
}

/** 读当前 source flag 的 opened_at::text（frozen generation token 口径）。 */
async function flagOpenedAtText(): Promise<string> {
  const res = await pool!.query(
    `SELECT opened_at::text AS t FROM mr_review_flag WHERE target_type='source' AND target_id=$1`,
    [S_ID],
  );
  return res.rows[0]!.t as string;
}

async function openDriftReview(candidateUrl: string): Promise<{ token: string; reviewId: string }> {
  const out = await openUrlDriftReviewOrSupersede(
    {
      sourceId: S_ID,
      runId: `${PREFIX}run`,
      oldUrl: OLD_URL,
      candidateUrl,
      confidence: 'high',
      reason: 'test drift reason',
      flagOpenedAt: await flagOpenedAtText(),
    },
    db!,
  );
  if (out.outcome !== 'opened') throw new Error(`expected opened, got ${out.outcome}`);
  return { token: out.token, reviewId: out.reviewId };
}

async function sourceUrlOf(id: string): Promise<string> {
  const [row] = await db!.select({ sourceUrl: schema.mrSource.sourceUrl }).from(schema.mrSource).where(eq(schema.mrSource.id, id));
  return row!.sourceUrl;
}
async function planUrlOf(id: string): Promise<string> {
  const [row] = await db!.select({ sourceUrl: schema.mrPlans.sourceUrl }).from(schema.mrPlans).where(eq(schema.mrPlans.id, id));
  return row!.sourceUrl;
}
async function flagStatusOf(): Promise<string> {
  const [row] = await db!.select({ status: schema.mrReviewFlag.status }).from(schema.mrReviewFlag).where(eq(schema.mrReviewFlag.targetId, S_ID));
  return row!.status;
}
async function reviewStatusOf(reviewId: string): Promise<string> {
  const [row] = await db!.select({ status: schema.mrUrlDriftReview.status }).from(schema.mrUrlDriftReview).where(eq(schema.mrUrlDriftReview.id, reviewId));
  return row!.status;
}

beforeAll(seed);
beforeEach(seed);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describeIfDb('applyUrlDriftReview 端到端真 DB（design D2/D-M5）', () => {
  it('happy：open → applied（真改 source_url + 关联 plan 对齐 + flag resolve、review=approved）', async () => {
    const { token, reviewId } = await openDriftReview(NEW_URL);

    const out = await applyUrlDriftReview(token, 'approver-itest', db!);
    expect(out.kind).toBe('applied');
    if (out.kind !== 'applied') throw new Error('expected applied');
    expect(out.sourceId).toBe(S_ID);
    expect(out.oldUrl).toBe(OLD_URL);
    expect(out.newUrl).toBe(NEW_URL);

    expect(await sourceUrlOf(S_ID)).toBe(NEW_URL); // source_url 已改
    expect(await planUrlOf(PA_ID)).toBe(NEW_URL); // canonical plan 对齐迁移
    expect(await planUrlOf(PB_ID)).toBe(OTHER_URL); // 聚合关联不动
    expect(await flagStatusOf()).toBe('resolved'); // generation 匹配 → flag resolve
    expect(await reviewStatusOf(reviewId)).toBe('approved'); // CAS 已认领
  });

  it('重放：同 token 再 applyUrlDriftReview → noop（CAS 0 行、不二次落库）', async () => {
    const { token } = await openDriftReview(NEW_URL);

    const first = await applyUrlDriftReview(token, 'approver-itest', db!);
    expect(first.kind).toBe('applied');
    const second = await applyUrlDriftReview(token, 'approver-itest', db!);
    expect(second.kind).toBe('noop'); // 已 approved → CAS 0 行
    expect(await sourceUrlOf(S_ID)).toBe(NEW_URL);
  });

  it('cross-domain：候选 host 不在 vendor 域集 → cross-domain-drift（source 不改、review=apply_failed）', async () => {
    const { token, reviewId } = await openDriftReview(CROSS_DOMAIN_URL);

    const out = await applyUrlDriftReview(token, 'approver-itest', db!);
    expect(out).toEqual({ kind: 'cross-domain-drift', reviewId });
    expect(await sourceUrlOf(S_ID)).toBe(OLD_URL); // 主事务回滚、source 未改
    expect(await flagStatusOf()).toBe('pending'); // 未 resolve
    expect(await reviewStatusOf(reviewId)).toBe('apply_failed'); // 独立事务已标
  });

  it('url-conflict：候选 = 同 vendor 另一 source 的 URL → 撞 UNIQUE → failed{url-conflict}', async () => {
    // 同 vendor 另一 source 已占 NEW_URL：CAS 把 S_ID 迁到 NEW_URL 时撞 UNIQUE(vendor_id, source_url)。
    await db!.insert(schema.mrSource).values({ id: SIB_ID, sourceUrl: NEW_URL, vendorId: V_ID, fetchStrategy: 'http' });
    const { token, reviewId } = await openDriftReview(NEW_URL);

    const out = await applyUrlDriftReview(token, 'approver-itest', db!);
    expect(out).toEqual({ kind: 'failed', reviewId, reason: 'url-conflict' });
    expect(await sourceUrlOf(S_ID)).toBe(OLD_URL); // 回滚、source 未改
    expect(await reviewStatusOf(reviewId)).toBe('apply_failed');
  });

  it('stale-url：open 后源 URL 被并发替换 → old-URL CAS 0 行 → failed{stale-url}', async () => {
    const { token, reviewId } = await openDriftReview(NEW_URL);
    // 模拟并发信号已替换源 URL（CAS WHERE source_url=OLD_URL 将命中 0 行）。
    await db!.update(schema.mrSource).set({ sourceUrl: 'https://kimi.com/drifted' }).where(eq(schema.mrSource.id, S_ID));

    const out = await applyUrlDriftReview(token, 'approver-itest', db!);
    expect(out).toEqual({ kind: 'failed', reviewId, reason: 'stale-url' });
    expect(await sourceUrlOf(S_ID)).toBe('https://kimi.com/drifted'); // 未被 stale token 覆盖
    expect(await reviewStatusOf(reviewId)).toBe('apply_failed');
  });

  it('错 token → noop', async () => {
    await openDriftReview(NEW_URL);

    const out = await applyUrlDriftReview('0'.repeat(32), 'approver-itest', db!);
    expect(out.kind).toBe('noop');
    expect(await sourceUrlOf(S_ID)).toBe(OLD_URL);
  });
});
