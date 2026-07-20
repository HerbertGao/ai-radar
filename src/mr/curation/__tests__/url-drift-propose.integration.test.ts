/**
 * url-drift proposer 集成测试（**需本地 Postgres**，task 6.2/10.2）——覆盖单测打桩绕过的真 SQL 层：
 * ① 端到端 propose：seed browser 源 + pending flag → detectFn 候选桩 → 真开 `mr_url_drift_review` 行（run_id
 *    冻结、status=pending）+ 真 upsert `mr_url_drift_metric` 行（total_candidates 从持久候选行 count(*) 重算、adopted null）；
 * ② metric upsert 幂等：同 run_id 再跑 → 单行、total_candidates 重算（`ON CONFLICT(run_id) DO UPDATE`）；
 * ③ metric 回填（DD2）：run1 review 批准后、后续 run 入口一条 UPDATE 回填 run1 的 `adopted`（该 run 已全部 decided）。
 *
 * 注入 detectFn 桩（不触 LLM）+ notify spy（不发 Telegram）；PREFIX 隔离（source/vendor/run_id 前缀）+ 缺
 * DATABASE_URL 自动 skip。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, like } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';
import type { UrlDriftAgentOutput } from '../../scrape/url-drift-agent.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
process.env.MR_URL_DRIFT_TTL_HOURS ||= '72';

const { runUrlDriftCuration } = await import('../url-drift-propose.js');

const PREFIX = 'mr-urldrift-prop-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

const candidateOut: UrlDriftAgentOutput = {
  kind: 'candidate',
  candidate_url: 'https://kimi.com/membership',
  confidence: 'high',
  reason: 'www.kimi.com 会员页路径重构',
};
const detectFn = vi.fn(async () => candidateOut);
const notify = { telegram: vi.fn(async () => {}) };

/** seed 一个 browser 源（host www.kimi.com → 反查匹配 allowlist kimi.com）+ 一条 pending source flag。 */
async function seed(suffix: string): Promise<string> {
  const sourceId = `${PREFIX}${suffix}`;
  await db!.insert(schema.mrSource).values({
    id: sourceId,
    sourceUrl: 'https://www.kimi.com/membership/pricing',
    // 每 seed 独立 vendorId（避免复用 sourceUrl 撞 UNIQUE(vendor_id, source_url)；vendorDomainSet 逐 vendor 隔离）。
    vendorId: `${PREFIX}vendor-${suffix}`,
    fetchStrategy: 'browser',
  });
  await db!.insert(schema.mrReviewFlag).values({
    targetType: 'source',
    targetId: sourceId,
    reason: '来源页面长期未核对',
    status: 'pending',
  });
  return sourceId;
}

async function metricRow(runId: string): Promise<{ total: number; adopted: number | null } | undefined> {
  const r = await db!
    .select({ total: schema.mrUrlDriftMetric.totalCandidates, adopted: schema.mrUrlDriftMetric.adopted })
    .from(schema.mrUrlDriftMetric)
    .where(eq(schema.mrUrlDriftMetric.runId, runId));
  return r[0];
}

async function cleanup() {
  if (!db) return;
  await db.delete(schema.mrUrlDriftReview).where(like(schema.mrUrlDriftReview.sourceId, `${PREFIX}%`));
  await db.delete(schema.mrUrlDriftMetric).where(like(schema.mrUrlDriftMetric.runId, `${PREFIX}%`));
  await db.delete(schema.mrReviewFlag).where(like(schema.mrReviewFlag.targetId, `${PREFIX}%`));
  await db.delete(schema.mrSource).where(like(schema.mrSource.id, `${PREFIX}%`));
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describeIfDb('runUrlDriftCuration 真 SQL（propose → review 行 + metric 行）', () => {
  it('端到端：candidate 达阈 → 真开 review 行（run_id 冻结）+ upsert metric（total=1、adopted null）', async () => {
    await seed('e2e');
    const runId = `${PREFIX}run-e2e`;

    const res = await runUrlDriftCuration({ notify, runId, dbh: db!, detectFn });

    expect(res.carded).toBe(1);
    expect(notify.telegram).toHaveBeenCalled();
    // review 行：run_id 冻结、status pending。
    const reviews = await db!
      .select({ status: schema.mrUrlDriftReview.status, candidateUrl: schema.mrUrlDriftReview.candidateUrl })
      .from(schema.mrUrlDriftReview)
      .where(eq(schema.mrUrlDriftReview.runId, runId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe('pending');
    expect(reviews[0]!.candidateUrl).toBe('https://kimi.com/membership');
    // metric 行：total_candidates 从持久候选行重算、adopted 当轮 null。
    const m = await metricRow(runId);
    expect(m).toEqual({ total: 1, adopted: null });
  });

  it('metric upsert 幂等：同 run_id 再跑 → 单行、total_candidates 重算（ON CONFLICT DO UPDATE）', async () => {
    await seed('idem');
    const runId = `${PREFIX}run-idem`;

    await runUrlDriftCuration({ notify, runId, dbh: db!, detectFn });
    // 第二次同 run_id（review 已 pending → openReviewOrSupersede noop）——metric 不重复插行。
    await runUrlDriftCuration({ notify, runId, dbh: db!, detectFn });

    const rows = await db!
      .select({ id: schema.mrUrlDriftMetric.id })
      .from(schema.mrUrlDriftMetric)
      .where(eq(schema.mrUrlDriftMetric.runId, runId));
    expect(rows).toHaveLength(1); // 单行（run_id UNIQUE + upsert）
    const m = await metricRow(runId);
    expect(m).toEqual({ total: 1, adopted: null }); // total 从持久行重算仍 1、adopted 未被覆盖
  });

  it('metric 回填（DD2）：run1 review 批准后、后续 run 入口回填 run1 的 adopted=1', async () => {
    await seed('bf');
    const run1 = `${PREFIX}run-bf-1`;
    await runUrlDriftCuration({ notify, runId: run1, dbh: db!, detectFn });
    expect((await metricRow(run1))!.adopted).toBeNull(); // 当轮未决 → null

    // 模拟人一键批准 run1 的候选（review → approved），令该 run 全部 decided。
    await db!
      .update(schema.mrUrlDriftReview)
      .set({ status: 'approved' })
      .where(and(eq(schema.mrUrlDriftReview.runId, run1), eq(schema.mrUrlDriftReview.status, 'pending')));
    // flag 仍 pending（approve 侧 setSourceUrl 才 resolve，本测未走 approve）——但 openReviewOrSupersede 见无 pending review → run2 可重开。

    const run2 = `${PREFIX}run-bf-2`;
    await runUrlDriftCuration({ notify, runId: run2, dbh: db!, detectFn }); // 入口 backfill 回填 run1

    expect((await metricRow(run1))!.adopted).toBe(1); // run1 全部 decided → 回填 approved 计数 1
  });
});
