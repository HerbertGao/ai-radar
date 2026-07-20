/**
 * URL drift 零采纳 engagement 规则集成测试（task 10.4，design D7 信号 1 / DD3）——**需本地 Postgres**。
 *
 * 覆盖 `runStaleness` 新增的 engagement 规则：读 `mr_url_drift_metric` 最近
 * `MR_URL_DRIFT_ADOPTION_ROUNDS`（默认 3）个「已决且有产出」轮次（`total_candidates>0 AND adopted IS NOT NULL`），
 * 连续全 `adopted=0` → 经**注入的 mock `AlertSink`** 发 ops 告警（dedupKey `zero-adoption:url-drift`）。
 *
 * **注入 mock AlertSink**（守 test-no-prod-sends 不变量——绝不真发生产 Telegram）。断言：
 * ① 连续 N 轮 tc>0&adopted=0 → mock alert 收 dedupKey；② tc=0 轮不计窗口；③ adopted IS NULL 未决轮跳过；
 * ④ <N 合格轮 → 不告警；⑤ 窗口内任一轮有采纳（adopted>0）→ 不告警。
 *
 * mr_url_drift_metric 是监控表、生产 feature 门控关闭无真数据——测试内 `DELETE FROM` 清空隔离，安全。
 * 缺 DATABASE_URL 时自动跳过；不触网 / 不触 LLM（mock alert）。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
// engagement 窗口 N=3（与默认一致，显式钉住使断言稳定）。
process.env.MR_URL_DRIFT_ADOPTION_ROUNDS ||= '3';

const { runStaleness } = await import('../staleness.js');
const schema = await import('../../../db/schema.js');
import type { AlertSink, AlertDetail } from '../../../pipeline/ops-alert-sink.js';

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

const PREFIX = 'mr-udrift-eng-itest-';
let seq = 0;

/** 插一行 metric（ran_at 递增，控制 ORDER BY ran_at DESC 顺序；run_id 加前缀便清理）。 */
async function insertMetric(totalCandidates: number, adopted: number | null): Promise<void> {
  await db!.insert(schema.mrUrlDriftMetric).values({
    runId: `${PREFIX}${seq}`,
    totalCandidates,
    adopted,
    ranAt: new Date(Date.now() + seq * 1000),
  });
  seq += 1;
}

function makeMockAlert(): { alert: AlertSink; calls: Array<{ message: string; detail: AlertDetail }> } {
  const calls: Array<{ message: string; detail: AlertDetail }> = [];
  const alert: AlertSink = (message, detail) => {
    calls.push({ message, detail });
  };
  return { alert, calls };
}

/** runStaleness 用未来 now + 长阈值，避免扫其它事实表命中陈旧行、把测试聚焦到 engagement。 */
async function runWithAlert(alert: AlertSink) {
  return runStaleness(db as never, { alert, thresholdDays: 3650, now: new Date('2000-01-01T00:00:00Z') });
}

beforeEach(async () => {
  if (!db) return;
  await db.execute(sql`DELETE FROM mr_url_drift_metric WHERE run_id LIKE ${PREFIX + '%'}`);
  // 清掉全部残留 metric 行——engagement 查询是全局 ORDER BY ran_at DESC LIMIT N，防他源行污染窗口。
  await db.execute(sql`DELETE FROM mr_url_drift_metric`);
  seq = 0;
});

afterAll(async () => {
  if (db) await db.execute(sql`DELETE FROM mr_url_drift_metric WHERE run_id LIKE ${PREFIX + '%'}`);
  if (pool) await pool.end();
});

describeIfDb('runStaleness — URL drift 零采纳 engagement 规则（注入 mock AlertSink）', () => {
  it('① 连续 3 轮 tc>0 & adopted=0 → mock alert 收 dedupKey zero-adoption:url-drift', async () => {
    await insertMetric(2, 0);
    await insertMetric(1, 0);
    await insertMetric(3, 0);
    const { alert, calls } = makeMockAlert();
    await runWithAlert(alert);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.detail.dedupKey).toBe('zero-adoption:url-drift');
    // 正文含具体数值（轮次 / 累计候选 / 采纳）。
    expect(calls[0]!.detail.rounds).toBe(3);
    expect(calls[0]!.detail.totalCandidates).toBe(6);
    expect(calls[0]!.message).toContain('3');
  });

  it('② tc=0 轮不计窗口（仅 2 个 tc>0&0 + 1 个 tc=0&0 → 合格轮不足 N → 不告警）', async () => {
    await insertMetric(2, 0);
    await insertMetric(1, 0);
    await insertMetric(0, 0); // tc=0：被 WHERE total_candidates>0 排除、不进窗口。
    const { alert, calls } = makeMockAlert();
    await runWithAlert(alert);
    expect(calls).toHaveLength(0);
  });

  it('③ adopted IS NULL 未决轮跳过（2 个 tc>0&0 + 1 个 tc>0&NULL → 合格轮不足 N → 不告警）', async () => {
    await insertMetric(2, 0);
    await insertMetric(1, 0);
    await insertMetric(3, null); // 未决：被 WHERE adopted IS NOT NULL 排除。
    const { alert, calls } = makeMockAlert();
    await runWithAlert(alert);
    expect(calls).toHaveLength(0);
  });

  it('④ <N 合格轮 → 不告警（仅 2 个 tc>0&adopted=0）', async () => {
    await insertMetric(2, 0);
    await insertMetric(1, 0);
    const { alert, calls } = makeMockAlert();
    await runWithAlert(alert);
    expect(calls).toHaveLength(0);
  });

  it('⑤ 窗口内任一轮有采纳（adopted>0）→ 不告警（人仍在处理）', async () => {
    await insertMetric(2, 0);
    await insertMetric(1, 1); // 最近 N 窗口内有一轮被采纳。
    await insertMetric(3, 0);
    const { alert, calls } = makeMockAlert();
    await runWithAlert(alert);
    expect(calls).toHaveLength(0);
  });
});
