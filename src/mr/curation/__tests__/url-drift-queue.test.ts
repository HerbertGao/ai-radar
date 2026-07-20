/**
 * url-drift BullMQ lane 单测（task 7.4）——无真实 Redis / 无真实 DB。
 * - cron 注册幂等：`scheduleUrlDrift` 用稳定 jobId（`upsertJobScheduler` 重复调同一 jobId）；
 * - 门控 fail-closed：`MR_URL_DRIFT_ENABLED` 缺省 'false' → `isMrUrlDriftApprovalReady` false（不注册 lane）；
 *   开关开但无 approver / chat 非数值 → 仍 false；
 * - `confidenceRank` low < medium < high 三序数。
 */
import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { scheduleUrlDrift, MR_URL_DRIFT_JOB } = await import('../url-drift-queue.js');
const { isMrUrlDriftEnabled, isMrUrlDriftApprovalReady } = await import('../../../config/env.js');
const { confidenceRank } = await import('../../scrape/url-drift-agent.js');
type Env = Parameters<typeof isMrUrlDriftEnabled>[0];

/** 最小 Env 桩（只填门控 helper 读取的三字段）。 */
function makeEnv(overrides: Partial<Env>): Env {
  return {
    MR_URL_DRIFT_ENABLED: 'false',
    TELEGRAM_APPROVER_IDS: [],
    TELEGRAM_CHAT_ID: 'test-chat',
    ...overrides,
  } as Env;
}

describe('7.4 url-drift lane', () => {
  it('cron 注册幂等：scheduleUrlDrift 用稳定 jobId（重复调同一 jobId）', async () => {
    const upsert = vi.fn(
      (_jobId: string, _repeat: unknown, _tmpl: { name: string }) => Promise.resolve({} as never),
    );
    const queue = { upsertJobScheduler: upsert } as never;

    await scheduleUrlDrift(queue);
    await scheduleUrlDrift(queue);

    expect(upsert).toHaveBeenCalledTimes(2);
    const jobId1 = upsert.mock.calls[0]![0];
    const jobId2 = upsert.mock.calls[1]![0];
    expect(jobId1).toBe('mr-url-drift-cron');
    expect(jobId2).toBe(jobId1); // 稳定 jobId → upsert 幂等收敛单条 scheduler
    expect(upsert.mock.calls[0]![2].name).toBe(MR_URL_DRIFT_JOB);
  });

  it('MR_URL_DRIFT_ENABLED 缺省 false → 不 enabled、不 ready（不注册 lane）', () => {
    const e = makeEnv({});
    expect(isMrUrlDriftEnabled(e)).toBe(false);
    expect(isMrUrlDriftApprovalReady(e)).toBe(false);
  });

  it('开关开但 approver 白名单为空 → ready false（跨镜像 fail-closed）', () => {
    const e = makeEnv({ MR_URL_DRIFT_ENABLED: 'true', TELEGRAM_APPROVER_IDS: [] });
    expect(isMrUrlDriftEnabled(e)).toBe(true);
    expect(isMrUrlDriftApprovalReady(e)).toBe(false);
  });

  it('开关开 + approver 非空 + chat 非数值 → ready false', () => {
    const e = makeEnv({
      MR_URL_DRIFT_ENABLED: 'true',
      TELEGRAM_APPROVER_IDS: [123],
      TELEGRAM_CHAT_ID: 'not-a-number',
    });
    expect(isMrUrlDriftApprovalReady(e)).toBe(false);
  });

  it('开关开 + approver 非空 + chat 数值化 → ready true', () => {
    const e = makeEnv({
      MR_URL_DRIFT_ENABLED: 'true',
      TELEGRAM_APPROVER_IDS: [123],
      TELEGRAM_CHAT_ID: '-1001234567890',
    });
    expect(isMrUrlDriftApprovalReady(e)).toBe(true);
  });

  it('confidenceRank low < medium < high', () => {
    expect(confidenceRank('low')).toBe(0);
    expect(confidenceRank('medium')).toBe(1);
    expect(confidenceRank('high')).toBe(2);
    expect(confidenceRank('low')).toBeLessThan(confidenceRank('medium'));
    expect(confidenceRank('medium')).toBeLessThan(confidenceRank('high'));
  });
});
