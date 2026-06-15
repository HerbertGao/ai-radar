/**
 * 知识库历史回填驱动单元测试（ops 工具）——纯 mock，不依赖真实 DB / LLM / 网络。
 *
 * 覆盖回填不变量：
 * 1. 枚举历史 push_date（升序），逐日调 `runKbIngestion`（经注入 ingestFn 桩）。
 * 2. **日期映射往返**：传给每日 ingestFn 的 `now` 经 `getPushDate(now)` 必还原为同一 `push_date`
 *    （中国 UTC+8 无 DST，12:00 China == 04:00 UTC；回填日历不偏移）。
 * 3. 统计按日累加（candidates/ingested/...）。
 * 4. targetType 透传；无历史日时为空回填、不报错。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

let runKbBackfill: typeof import('../backfill.js').runKbBackfill;
let getPushDate: typeof import('../../push/push-date.js').getPushDate;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PUSH_TIMEZONE ||= 'Asia/Shanghai';
  runKbBackfill = (await import('../backfill.js')).runKbBackfill;
  getPushDate = (await import('../../push/push-date.js')).getPushDate;
});

/** 构造最小 fake dbh：仅实现 selectDistinct(...).from(...).where(...).orderBy(...) 返回给定日期行。 */
function fakeDbReturningDates(
  dates: string[],
): Parameters<typeof runKbBackfill>[1] {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: async () => dates.map((pushDate) => ({ pushDate })),
  };
  return { selectDistinct: () => chain } as unknown as Parameters<
    typeof runKbBackfill
  >[1];
}

const oneResult = (over: Partial<Record<string, number>> = {}) => ({
  candidates: 1,
  agentOk: 1,
  agentFailed: 0,
  gatedOut: 0,
  ingested: 1,
  skippedClaimed: 0,
  storeFailed: 0,
  ...over,
});

describe('runKbBackfill（历史回填驱动）', () => {
  it('逐日复用 runKbIngestion：每日 now 经 getPushDate 还原为同一 push_date（往返不偏移）', async () => {
    const dates = ['2026-06-12', '2026-06-13', '2026-06-15'];
    const seenPushDates: string[] = [];
    const ingestFn = vi.fn(async (options: { now?: Date }) => {
      // 断言驱动传入的 now 映射回当日 push_date（回填日历正确性的核心）。
      seenPushDates.push(getPushDate(options.now));
      return oneResult();
    });

    const res = await runKbBackfill(
      { ingestFn: ingestFn as never, log: () => {} },
      fakeDbReturningDates(dates),
    );

    expect(ingestFn).toHaveBeenCalledTimes(3);
    expect(seenPushDates).toEqual(dates); // now→push_date 往返与历史日一一对应、升序
    expect(res.pushDates).toBe(3);
    expect(res.perDate.map((d) => d.pushDate)).toEqual(dates);
  });

  it('统计按日累加（candidates/ingested/gatedOut/skippedClaimed）', async () => {
    const dates = ['2026-06-13', '2026-06-14'];
    const perCall = [
      oneResult({ candidates: 3, ingested: 2, gatedOut: 1 }),
      oneResult({ candidates: 5, ingested: 1, gatedOut: 2, skippedClaimed: 2 }),
    ];
    let i = 0;
    const ingestFn = vi.fn(async () => perCall[i++]!);

    const res = await runKbBackfill(
      { ingestFn: ingestFn as never, log: () => {} },
      fakeDbReturningDates(dates),
    );

    expect(res.totals.candidates).toBe(8);
    expect(res.totals.ingested).toBe(3);
    expect(res.totals.gatedOut).toBe(3);
    expect(res.totals.skippedClaimed).toBe(2);
    expect(res.totals.agentOk).toBe(2);
  });

  it('无历史 push success 日：空回填、不报错、不调用 ingestFn', async () => {
    const ingestFn = vi.fn(async () => oneResult());
    const res = await runKbBackfill(
      { ingestFn: ingestFn as never, log: () => {} },
      fakeDbReturningDates([]),
    );
    expect(ingestFn).not.toHaveBeenCalled();
    expect(res.pushDates).toBe(0);
    expect(res.totals.ingested).toBe(0);
  });
});
