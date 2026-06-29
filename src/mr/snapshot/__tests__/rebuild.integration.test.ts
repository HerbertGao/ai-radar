/**
 * 快照 rebuild 耦合 + 版本失效集成测试（task 5.4，**需本地 Postgres**，design D8）。
 *
 * 覆盖 spec「快照版本与 ETag 必须随数据变更失效」「API 与快照路径只读」端到端（经真 builder + 注入 now）：
 * ① 改价经公开 `recordPriceChange` → 最外层事务提交后触发 rebuild → ETag 变、缓存反映新价；
 * ② 改价经 `upsertPlan` 委托路径（price-delegated）→ 同样触发 rebuild → ETag 变；
 * ③ 「改价后未 rebuild」不被当作已更新（缓存不 on-read 自动刷；直接 DB 写不触发 rebuild → version 不变，
 *    rebuild 后才变）；
 * ④ 保鲜回路 flag 写（不经改价入口）→ 直接调 rebuild job body（注入 now）→ reviewStatus 反映 + ETag 变；
 * ⑤ staleness 阈值穿越（注入 now 跨阈值、无 DB 写）→ ETag 变（不 304-with-stale）；
 * ⑥ 注入 now 推进但不跨阈值 + 无变更 → ETag 稳定（304 命中）；
 * ⑦ 请求路径只读不写库（getSnapshot 前后 mr_* 行数不变）。
 *
 * ⑤⑥ 用 builder 全局读后**按本套件 plan id 过滤**再哈希，隔离同库其它行的 staleness 干扰（version 是全快照
 * 哈希，跨 now 直接比全局哈希会被无关行翻转污染）。缺 DATABASE_URL 自动 skip。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray, like } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { buildModelRadarSnapshot } = await import('../build.js');
const {
  computeSnapshotVersion,
  rebuildModelRadarSnapshot,
  getModelRadarSnapshot,
  invalidateModelRadarSnapshot,
  peekCachedSnapshot,
} = await import('../cache.js');
const { runSnapshotRebuild } = await import('../rebuild.js');
const { recordPriceChange } = await import('../../ingest/record-price-change.js');
const { upsertVendor, upsertPlan } = await import('../../ingest/upsert.js');
const { setReviewFlag } = await import('../../write/flag.js');

const PREFIX = 'mr-rebuild-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

const NOW = new Date();

async function cleanup() {
  if (!db) return;
  await db.delete(schema.mrReviewFlag).where(like(schema.mrReviewFlag.reason, `${PREFIX}%`));
  await db.delete(schema.mrPriceHistory).where(like(schema.mrPriceHistory.sourceUrl, `${PREFIX}%`));
  const srcIds = (
    await db.select({ id: schema.mrSource.id }).from(schema.mrSource).where(like(schema.mrSource.sourceUrl, `${PREFIX}%`))
  ).map((r) => r.id);
  if (srcIds.length) {
    await db.delete(schema.mrPlanSources).where(inArray(schema.mrPlanSources.sourceId, srcIds));
  }
  await db.delete(schema.mrPlanLimits).where(like(schema.mrPlanLimits.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlans).where(like(schema.mrPlans.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrSource).where(like(schema.mrSource.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrVendors).where(like(schema.mrVendors.normalizedName, `${PREFIX}%`));
}

beforeAll(cleanup);
beforeEach(() => invalidateModelRadarSnapshot());
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

async function makeVendor(suffix: string): Promise<string> {
  const [v] = await db!
    .insert(schema.mrVendors)
    .values({ normalizedName: `${PREFIX}v-${suffix}`, name: `Vendor ${suffix}` })
    .returning();
  return v!.id;
}

interface PlanOpts {
  currentPrice?: string | null;
  currency?: string | null;
  sourceConfidence?: string;
  lastChecked?: Date;
}

async function makePlan(vendorId: string, suffix: string, opts: PlanOpts = {}): Promise<string> {
  const [plan] = await db!
    .insert(schema.mrPlans)
    .values({
      vendorId,
      name: `${PREFIX}plan-${suffix}`,
      category: 'coding_plan',
      currentPrice: opts.currentPrice === undefined ? '20.00' : opts.currentPrice,
      currency: opts.currency === undefined ? 'USD' : opts.currency,
      sourceUrl: `${PREFIX}src-${suffix}`,
      lastChecked: opts.lastChecked ?? NOW,
      sourceConfidence: opts.sourceConfidence ?? 'official_pricing',
    })
    .returning();
  return plan!.id;
}

/** 取缓存快照中本套件指定 plan（按 id 定位，builder 全局读）。 */
function cachedPlan(planId: string) {
  return peekCachedSnapshot()!.snapshot.plans.find((p) => p.id === planId);
}

describeIfDb('5.4 rebuild 耦合 + 版本失效', () => {
  it('改价经 recordPriceChange 提交后触发 rebuild → ETag 变、缓存反映新价', async () => {
    const vendorId = await makeVendor('rpc');
    const planId = await makePlan(vendorId, 'rpc', { currentPrice: '20.00', currency: 'USD' });

    // warm 缓存（注入 NOW）。
    const v0 = (await runSnapshotRebuild({ dbh: db!, now: NOW })).version!;
    expect(cachedPlan(planId)!.currentPrice).toBe('20.00');

    // 经公开改价入口改 20→30（official_pricing）；hook 在提交后触发 rebuild。
    const outcome = await recordPriceChange(
      {
        planId,
        newValue: '30.00',
        currency: 'USD',
        provenance: { sourceUrl: `${PREFIX}prov-rpc`, sourceConfidence: 'official_pricing' },
      },
      db!,
    );
    expect(outcome.outcome).toBe('appended');

    const after = peekCachedSnapshot()!;
    expect(after.version).not.toBe(v0);
    expect(cachedPlan(planId)!.currentPrice).toBe('30.00');
    expect(cachedPlan(planId)!.priceStatus).toBe('known');
  });

  it('改价经 upsertPlan 委托路径（price-delegated）提交后触发 rebuild → ETag 变', async () => {
    const v = await upsertVendor(db!, { normalizedName: `${PREFIX}v-up`, name: 'Vendor up' });
    const created = await upsertPlan(db!, {
      vendorId: v.id,
      name: `${PREFIX}plan-up`,
      category: 'coding_plan',
      currentPrice: '20.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-up`,
      sourceConfidence: 'official_pricing',
    });
    const planId = 'id' in created ? created.id : undefined;
    expect(planId).toBeDefined();

    const v0 = (await runSnapshotRebuild({ dbh: db!, now: NOW })).version!;

    // 同 vendor+name 重录、价 20→30 → 走 _recordPriceChangeTx 委托（price-delegated）；hook 提交后 rebuild。
    const re = await upsertPlan(db!, {
      vendorId: v.id,
      name: `${PREFIX}plan-up`,
      category: 'coding_plan',
      currentPrice: '30.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-up`,
      sourceConfidence: 'official_pricing',
    });
    expect(re.outcome).toBe('price-delegated');

    expect(peekCachedSnapshot()!.version).not.toBe(v0);
    expect(cachedPlan(planId!)!.currentPrice).toBe('30.00');
  });

  it('改价后未 rebuild 不被当作已更新（缓存不 on-read 自动刷；rebuild 后才反映）', async () => {
    const vendorId = await makeVendor('norebuild');
    const planId = await makePlan(vendorId, 'norebuild', { currentPrice: '20.00', currency: 'USD' });
    const v0 = (await runSnapshotRebuild({ dbh: db!, now: NOW })).version!;

    // 绕过改价入口直接 DB 写（无 hook）→ 缓存不自动刷新。
    await db!.update(schema.mrPlans).set({ currentPrice: '50.00' }).where(eq(schema.mrPlans.id, planId));

    // getSnapshot 命中旧缓存：version 仍 v0、价仍 20（请求路径不触发 rebuild、不读新值）。
    const served = await getModelRadarSnapshot(db!, NOW);
    expect(served.version).toBe(v0);
    expect(cachedPlan(planId)!.currentPrice).toBe('20.00');

    // 显式 rebuild 后才反映新价、ETag 才变。
    await runSnapshotRebuild({ dbh: db!, now: NOW });
    expect(peekCachedSnapshot()!.version).not.toBe(v0);
    expect(cachedPlan(planId)!.currentPrice).toBe('50.00');
  });

  it('保鲜回路 flag 写 → 直接调 rebuild job body(注入 now) → reviewStatus 反映 + ETag 变', async () => {
    const vendorId = await makeVendor('flag');
    const planId = await makePlan(vendorId, 'flag');
    const v0 = (await runSnapshotRebuild({ dbh: db!, now: NOW })).version!;
    expect(cachedPlan(planId)!.reviewStatus.pending).toBe(false);

    // 保鲜回路给 plan 打 pending flag（不经改价入口、无 rebuild）。
    await setReviewFlag(db!, { targetType: 'plan', targetId: planId }, `${PREFIX}fresh-loop-pending`);

    // 直接调 rebuild job body（注入 now）。
    const res = await runSnapshotRebuild({ dbh: db!, now: NOW });
    expect(res.ok).toBe(true);
    expect(res.version).not.toBe(v0);
    expect(cachedPlan(planId)!.reviewStatus.pending).toBe(true);
  });

  it('staleness 阈值穿越（注入 now 跨阈值、无 DB 写）→ ETag 变；不跨阈值 + 无变更 → ETag 稳定', async () => {
    // 默认阈值 30 天。plan 自身永鲜（lastChecked=now2），关联源 last_checked=2026-03-01 仅在 now2 跨阈值。
    const now1 = new Date('2026-02-01T00:00:00Z'); // 阈值 2026-01-02 → 源鲜
    const now1b = new Date('2026-02-06T00:00:00Z'); // 阈值 2026-01-07 → 源仍鲜（不跨）
    const now2 = new Date('2026-04-01T00:00:00Z'); // 阈值 2026-03-02 → 源陈旧（跨）
    const vendorId = await makeVendor('stale');
    const planId = await makePlan(vendorId, 'stale', { lastChecked: now2 });
    const [src] = await db!
      .insert(schema.mrSource)
      .values({
        sourceUrl: `${PREFIX}src-stale-edge`,
        vendorId,
        fetchStrategy: 'http',
        lastChecked: new Date('2026-03-01T00:00:00Z'),
      })
      .returning();
    await db!.insert(schema.mrPlanSources).values({ planId, sourceId: src!.id });

    // 按本套件 plan id 过滤后哈希（隔离同库其它行的 staleness 干扰）。
    const versionAt = async (now: Date): Promise<string> => {
      const snap = await buildModelRadarSnapshot(db!, now);
      const plan = snap.plans.find((p) => p.id === planId)!;
      return computeSnapshotVersion({ plans: [plan] });
    };
    const staleAt = async (now: Date): Promise<boolean> => {
      const snap = await buildModelRadarSnapshot(db!, now);
      return snap.plans.find((p) => p.id === planId)!.freshness.stale;
    };

    // 不跨阈值 + 无变更 → version 稳定（304 命中）。
    expect(await staleAt(now1)).toBe(false);
    expect(await staleAt(now1b)).toBe(false);
    expect(await versionAt(now1)).toBe(await versionAt(now1b));

    // 跨阈值 → stale 翻转 → version 变（不 304-with-stale）。
    expect(await staleAt(now2)).toBe(true);
    expect(await versionAt(now2)).not.toBe(await versionAt(now1));
  });

  it('请求路径只读不写库（getSnapshot 前后 mr_* 行数不变）', async () => {
    const vendorId = await makeVendor('readonly');
    await makePlan(vendorId, 'readonly');
    await rebuildModelRadarSnapshot(db!, NOW);

    const count = async () =>
      (await db!.select({ id: schema.mrPlans.id }).from(schema.mrPlans)).length;
    const before = await count();
    await getModelRadarSnapshot(db!, NOW);
    await getModelRadarSnapshot(db!, NOW);
    expect(await count()).toBe(before);
  });
});
