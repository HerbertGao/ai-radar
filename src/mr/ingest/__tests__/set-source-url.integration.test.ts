/**
 * setSourceUrl 授权写入口集成测试（task 2.2，**需本地 Postgres**，design D2/D-B1/D-M4）。
 *
 * 覆盖：① happy path（CAS 命中 → source_url 改 + last_checked 刷新 + 关联 plan 对齐迁移 + flag resolve、void 返回）；
 * ② mr_plans 对齐只动 source_url=oldUrl 的关联 plan、聚合关联（≠oldUrl）不动；
 * ③ old-URL CAS 0 行 → 抛 StaleUrlError + 整事务回滚（source/plan 均不改、flag 仍 pending）；
 * ④ generation mismatch（expectedOpenedAt 不符、CAS 仍命中）→ URL 照常提交（不抛）、新一代 flag 留 pending；
 * ⑤ 跨域 URL → assertUrlAllowed 抛 SsrfBlockedError + 回滚 source 不改。
 *
 * 不触网 / 不触 LLM；缺 DATABASE_URL 时自动跳过。唯一 PREFIX 隔离 + beforeEach 重置 + afterAll 清理。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray, like, sql } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { setSourceUrl, StaleUrlError } = await import('../set-source-url.js');
const { SsrfBlockedError } = await import('../../scrape/ssrf-guard.js');

const PREFIX = 'mr-set-url-itest-';
const V_ID = `${PREFIX}vendor`;
const S_ID = `${PREFIX}source`;
const PA_ID = `${PREFIX}planA`; // canonical：source_url = OLD_URL → 应被对齐迁移
const PB_ID = `${PREFIX}planB`; // 聚合关联：source_url ≠ OLD_URL → 不应被动

const OLD_URL = 'https://www.kimi.com/membership/pricing';
const NEW_URL = 'https://kimi.com/membership';
const OTHER_URL = 'https://platform.kimi.com/docs'; // planB 的聚合关联 URL（allowlist 内、≠OLD_URL）
const CROSS_DOMAIN_URL = 'https://evil.example.com/pricing'; // 非 allowlist → SsrfBlockedError

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

async function cleanup(): Promise<void> {
  if (!db) return;
  await db.delete(schema.mrReviewFlag).where(eq(schema.mrReviewFlag.targetId, S_ID));
  await db.delete(schema.mrPlanSources).where(eq(schema.mrPlanSources.sourceId, S_ID));
  await db.delete(schema.mrPlans).where(inArray(schema.mrPlans.id, [PA_ID, PB_ID]));
  await db.delete(schema.mrSource).where(eq(schema.mrSource.id, S_ID));
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
    {
      id: PA_ID,
      vendorId: V_ID,
      name: `${PREFIX}A`,
      category: 'ide_membership',
      sourceUrl: OLD_URL,
      lastChecked: new Date(),
      sourceConfidence: 'official',
    },
    {
      id: PB_ID,
      vendorId: V_ID,
      name: `${PREFIX}B`,
      category: 'ide_membership',
      sourceUrl: OTHER_URL,
      lastChecked: new Date(),
      sourceConfidence: 'official',
    },
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

/** 读当前 source flag 的 opened_at::text（frozen generation token 口径，与 flag.ts 精确文本比一致）。 */
async function flagOpenedAtText(): Promise<string> {
  const res = await pool!.query(
    `SELECT opened_at::text AS t FROM mr_review_flag WHERE target_type='source' AND target_id=$1`,
    [S_ID],
  );
  return res.rows[0]!.t as string;
}

async function sourceUrlOf(): Promise<string> {
  const [row] = await db!
    .select({ sourceUrl: schema.mrSource.sourceUrl })
    .from(schema.mrSource)
    .where(eq(schema.mrSource.id, S_ID));
  return row!.sourceUrl;
}

async function planUrlOf(id: string): Promise<string> {
  const [row] = await db!
    .select({ sourceUrl: schema.mrPlans.sourceUrl })
    .from(schema.mrPlans)
    .where(eq(schema.mrPlans.id, id));
  return row!.sourceUrl;
}

async function flagStatusOf(): Promise<string> {
  const [row] = await db!
    .select({ status: schema.mrReviewFlag.status })
    .from(schema.mrReviewFlag)
    .where(eq(schema.mrReviewFlag.targetId, S_ID));
  return row!.status;
}

async function lastCheckedOf(): Promise<Date | null> {
  const [row] = await db!
    .select({ lastChecked: schema.mrSource.lastChecked })
    .from(schema.mrSource)
    .where(eq(schema.mrSource.id, S_ID));
  return row!.lastChecked;
}

beforeAll(seed);
beforeEach(seed);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describeIfDb('setSourceUrl 集成（design D2/D-B1/D-M4）', () => {
  it('happy path：CAS 命中 → source_url 改 + last_checked 刷新 + 关联 plan 对齐 + flag resolve、void', async () => {
    const expectedOpenedAt = await flagOpenedAtText();
    expect(await lastCheckedOf()).toBeNull(); // seed 未设 last_checked（nullable 无 default）

    const ret = await db!.transaction((tx) =>
      setSourceUrl(S_ID, NEW_URL, OLD_URL, 'tester', tx, expectedOpenedAt),
    );

    expect(ret).toBeUndefined(); // void 返回
    expect(await sourceUrlOf()).toBe(NEW_URL);
    // last_checked 由 CAS 的 SET last_checked=now() 刷新：null → 非 null 即证已写入。
    expect(await lastCheckedOf()).not.toBeNull();
    expect(await planUrlOf(PA_ID)).toBe(NEW_URL); // canonical plan 对齐迁移
    expect(await planUrlOf(PB_ID)).toBe(OTHER_URL); // 聚合关联（≠oldUrl）不动
    expect(await flagStatusOf()).toBe('resolved'); // generation 匹配 → flag resolve
  });

  it('old-URL CAS 0 行（oldUrl 不符）→ 抛 StaleUrlError + 整事务回滚', async () => {
    const expectedOpenedAt = await flagOpenedAtText();
    const WRONG_OLD = 'https://kimi.com/stale-wrong';

    await expect(
      db!.transaction((tx) =>
        setSourceUrl(S_ID, NEW_URL, WRONG_OLD, 'tester', tx, expectedOpenedAt),
      ),
    ).rejects.toBeInstanceOf(StaleUrlError);

    expect(await sourceUrlOf()).toBe(OLD_URL); // 未改
    expect(await planUrlOf(PA_ID)).toBe(OLD_URL); // 回滚：plan 未迁
    expect(await flagStatusOf()).toBe('pending'); // 回滚：flag 仍 pending
  });

  it('generation mismatch（expectedOpenedAt 不符、CAS 命中）→ URL 照常提交、flag 留 pending', async () => {
    const ret = await db!.transaction((tx) =>
      setSourceUrl(S_ID, NEW_URL, OLD_URL, 'tester', tx, '1999-01-01 00:00:00+00'),
    );

    expect(ret).toBeUndefined();
    expect(await sourceUrlOf()).toBe(NEW_URL); // URL 提交
    expect(await planUrlOf(PA_ID)).toBe(NEW_URL); // plan 也对齐
    expect(await flagStatusOf()).toBe('pending'); // generation 不匹配 → flag 不被 resolve、留下轮
  });

  it('跨域 URL → assertUrlAllowed 抛 SsrfBlockedError + 回滚 source 不改', async () => {
    const expectedOpenedAt = await flagOpenedAtText();

    await expect(
      db!.transaction((tx) =>
        setSourceUrl(S_ID, CROSS_DOMAIN_URL, OLD_URL, 'tester', tx, expectedOpenedAt),
      ),
    ).rejects.toBeInstanceOf(SsrfBlockedError);

    expect(await sourceUrlOf()).toBe(OLD_URL); // assertUrlAllowed 在 CAS 前抛、source 未改
    expect(await planUrlOf(PA_ID)).toBe(OLD_URL);
    expect(await flagStatusOf()).toBe('pending');
  });
});
