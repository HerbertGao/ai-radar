/**
 * 批准核心 `applyReview` 单测（task 5.3）——**mock 依赖，无真实 DB / Redis / 不触网**（遵守测试守卫）。
 *
 * mock 边界：`claimReview`/`markApplyFailed`/`markSuperseded`（store）、`_recordPriceChangeTx`（事实 writer）、
 * `publishSnapshotInvalidation`（快照失效）。注入的 db 桩只提供 `transaction` + plan 锁 `select().for('update')`。
 *
 * 覆盖 money-path 分支（design D5）：
 * - 双击/重投 → CAS 仅一次认领落库一次（其余 null → noop、不再调 writer）；
 * - 基线漂移（现价≠冻结 old）→ 不写 + 独立事务 superseded；
 * - writer 返回 history-conflict → apply_failed（非 appended = 失败）；
 * - writer 抛错 → apply_failed；
 * - 成功（appended）→ 提交后触发快照失效；快照失效抛错不使批准转失败；
 * - 并发已 supersede（mark* 0 行）→ 按 id 不误标、结果仍归位；
 * - money 值/币种/provenance 只从冻结行读。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const mocks = vi.hoisted(() => ({
  claimReview: vi.fn(),
  markApplyFailed: vi.fn(),
  markSuperseded: vi.fn(),
  recordPriceChangeTx: vi.fn(),
  publishSnapshotInvalidation: vi.fn(),
}));

vi.mock('../price-review-store.js', () => ({
  claimReview: mocks.claimReview,
  markApplyFailed: mocks.markApplyFailed,
  markSuperseded: mocks.markSuperseded,
}));
vi.mock('../../ingest/record-price-change.js', () => ({
  _recordPriceChangeTx: mocks.recordPriceChangeTx,
}));
vi.mock('../../snapshot/invalidation.js', () => ({
  publishSnapshotInvalidation: mocks.publishSnapshotInvalidation,
}));

const { applyReview } = await import('../approve.js');

/** 冻结行（claimReview 返回；money 值/币种/provenance 唯一来源）。 */
const FROZEN = {
  id: 'r-1',
  planId: 'plan-1',
  oldValue: '40.00',
  candidateValue: '45.00',
  currency: 'CNY',
  sourceUrl: 'https://example.com/pricing',
  sourceConfidence: 'official_pricing',
};

/** db 桩：transaction 传 tx 桩给回调（回调抛出即 reject，仿真回滚+上抛）；tx 只需支持 plan 锁 select。 */
function makeDb(planLockRows: unknown[]) {
  const tx = {
    select(_c?: unknown) {
      return {
        from(_t: unknown) {
          return {
            where(_w: unknown) {
              return { for: async (_m: string) => planLockRows };
            },
          };
        },
      };
    },
  };
  return {
    async transaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
      return cb(tx);
    },
  };
}

const PLAN_AT_BASELINE = [{ currentPrice: '40.00', currency: 'CNY' }];

beforeEach(() => {
  vi.clearAllMocks();
  // 默认：writer 真追加成功、mark* 命中 1 行、快照失效成功。
  mocks.recordPriceChangeTx.mockResolvedValue({
    outcome: 'appended',
    oldValue: '40.00',
    newValue: '45.00',
  });
  mocks.markApplyFailed.mockResolvedValue(1);
  mocks.markSuperseded.mockResolvedValue(1);
  mocks.publishSnapshotInvalidation.mockResolvedValue(undefined);
});

describe('applyReview 成功路径', () => {
  it('appended → applied，money 值/provenance 只从冻结行读，提交后触发快照失效', async () => {
    mocks.claimReview.mockResolvedValue(FROZEN);
    const db = makeDb(PLAN_AT_BASELINE);

    const out = await applyReview('tok-live', 'approver-1', db as never);

    expect(out).toEqual({
      kind: 'applied',
      reviewId: 'r-1',
      planId: 'plan-1',
      oldValue: '40.00',
      newValue: '45.00',
    });
    // writer 收到的是**冻结**候选/币种/provenance（applyReview 入参只有 token+decidedBy，无入站金额）。
    expect(mocks.recordPriceChangeTx).toHaveBeenCalledTimes(1);
    const writerInput = mocks.recordPriceChangeTx.mock.calls[0]![1];
    expect(writerInput).toEqual({
      planId: 'plan-1',
      newValue: '45.00',
      currency: 'CNY',
      provenance: {
        sourceUrl: 'https://example.com/pricing',
        sourceConfidence: 'official_pricing',
      },
    });
    // 提交后触发快照失效；成功路径不碰 flag（结构上 approve 不 import resolveFlag/markChecked）。
    expect(mocks.publishSnapshotInvalidation).toHaveBeenCalledTimes(1);
    expect(mocks.markApplyFailed).not.toHaveBeenCalled();
    expect(mocks.markSuperseded).not.toHaveBeenCalled();
  });

  it('快照失效抛错（如 Redis 不可达）→ 批准仍成功、不回退', async () => {
    mocks.claimReview.mockResolvedValue(FROZEN);
    mocks.publishSnapshotInvalidation.mockRejectedValue(new Error('redis down'));
    const db = makeDb(PLAN_AT_BASELINE);

    const out = await applyReview('tok-live', 'approver-1', db as never);

    expect(out.kind).toBe('applied');
    expect(mocks.markApplyFailed).not.toHaveBeenCalled();
  });
});

describe('applyReview 幂等（CAS）', () => {
  it('双击/重投 → 仅第一次认领落库一次，重投 claim null → noop、不再调 writer', async () => {
    mocks.claimReview.mockResolvedValueOnce(FROZEN).mockResolvedValueOnce(null);
    const db = makeDb(PLAN_AT_BASELINE);

    const first = await applyReview('tok-live', 'approver-1', db as never);
    const second = await applyReview('tok-live', 'approver-1', db as never);

    expect(first.kind).toBe('applied');
    expect(second).toEqual({ kind: 'noop' });
    // 只落库一次：writer 恰调一次，快照失效恰一次。
    expect(mocks.recordPriceChangeTx).toHaveBeenCalledTimes(1);
    expect(mocks.publishSnapshotInvalidation).toHaveBeenCalledTimes(1);
  });

  it('claim null（过期/已决/superseded）→ noop、不写、不触发快照失效', async () => {
    mocks.claimReview.mockResolvedValue(null);
    const db = makeDb(PLAN_AT_BASELINE);

    const out = await applyReview('dead-tok', 'approver-1', db as never);

    expect(out).toEqual({ kind: 'noop' });
    expect(mocks.recordPriceChangeTx).not.toHaveBeenCalled();
    expect(mocks.publishSnapshotInvalidation).not.toHaveBeenCalled();
  });
});

describe('applyReview 基线漂移', () => {
  it('现价≠冻结 old → 不写 + 独立事务置 superseded', async () => {
    mocks.claimReview.mockResolvedValue(FROZEN);
    const db = makeDb([{ currentPrice: '50.00', currency: 'CNY' }]); // 现价已漂移到 50

    const out = await applyReview('tok-live', 'approver-1', db as never);

    expect(out).toEqual({ kind: 'baseline-drift', reviewId: 'r-1' });
    expect(mocks.recordPriceChangeTx).not.toHaveBeenCalled(); // 不落库
    expect(mocks.markSuperseded).toHaveBeenCalledWith('r-1', 'approver-1', db);
    expect(mocks.markApplyFailed).not.toHaveBeenCalled();
    expect(mocks.publishSnapshotInvalidation).not.toHaveBeenCalled();
  });

  it('币种漂移（同额异币种）→ 基线漂移 superseded', async () => {
    mocks.claimReview.mockResolvedValue(FROZEN);
    const db = makeDb([{ currentPrice: '40.00', currency: 'USD' }]);

    const out = await applyReview('tok-live', 'approver-1', db as never);

    expect(out.kind).toBe('baseline-drift');
    expect(mocks.recordPriceChangeTx).not.toHaveBeenCalled();
    expect(mocks.markSuperseded).toHaveBeenCalledWith('r-1', 'approver-1', db);
  });

  it('并发已处置：markSuperseded 0 行 → 仍报 baseline-drift、不误标', async () => {
    mocks.claimReview.mockResolvedValue(FROZEN);
    mocks.markSuperseded.mockResolvedValue(0);
    const db = makeDb([{ currentPrice: '50.00', currency: 'CNY' }]);

    const out = await applyReview('tok-live', 'approver-1', db as never);

    expect(out).toEqual({ kind: 'baseline-drift', reviewId: 'r-1' });
    expect(mocks.markSuperseded).toHaveBeenCalledWith('r-1', 'approver-1', db);
    expect(mocks.markApplyFailed).not.toHaveBeenCalled();
  });
});

describe('applyReview 落库失败', () => {
  it('writer 返回 history-conflict（非 appended）→ apply_failed，未 resolve flag', async () => {
    mocks.claimReview.mockResolvedValue(FROZEN);
    mocks.recordPriceChangeTx.mockResolvedValue({ outcome: 'history-conflict' });
    const db = makeDb(PLAN_AT_BASELINE);

    const out = await applyReview('tok-live', 'approver-1', db as never);

    expect(out.kind).toBe('failed');
    expect((out as { reviewId: string }).reviewId).toBe('r-1');
    // writer 被调（确认代码未跳过 writer 直接返回 failed）
    expect(mocks.recordPriceChangeTx).toHaveBeenCalledTimes(1);
    expect(mocks.markApplyFailed).toHaveBeenCalledWith('r-1', 'approver-1', db);
    expect(mocks.markSuperseded).not.toHaveBeenCalled();
    // flag 不 resolve：approve.ts 结构上不 import resolveFlag/markChecked，无从塌缩整页 flag。
    expect(mocks.publishSnapshotInvalidation).not.toHaveBeenCalled();
  });

  it('writer 抛错 → apply_failed', async () => {
    mocks.claimReview.mockResolvedValue(FROZEN);
    mocks.recordPriceChangeTx.mockRejectedValue(new Error('boom'));
    const db = makeDb(PLAN_AT_BASELINE);

    const out = await applyReview('tok-live', 'approver-1', db as never);

    expect(out.kind).toBe('failed');
    expect(mocks.markApplyFailed).toHaveBeenCalledWith('r-1', 'approver-1', db);
    expect(mocks.markSuperseded).not.toHaveBeenCalled();
  });

  it('并发已处置：markApplyFailed 0 行 → 仍报 failed、按 id 不误标', async () => {
    mocks.claimReview.mockResolvedValue(FROZEN);
    mocks.recordPriceChangeTx.mockResolvedValue({ outcome: 'history-conflict' });
    mocks.markApplyFailed.mockResolvedValue(0);
    const db = makeDb(PLAN_AT_BASELINE);

    const out = await applyReview('tok-live', 'approver-1', db as never);

    expect(out.kind).toBe('failed');
    expect((out as { reviewId: string }).reviewId).toBe('r-1');
    expect(mocks.markApplyFailed).toHaveBeenCalledWith('r-1', 'approver-1', db);
  });

  it('plan 不存在 → apply_failed（非漂移）', async () => {
    mocks.claimReview.mockResolvedValue(FROZEN);
    const db = makeDb([]); // 锁 plan 返回空

    const out = await applyReview('tok-live', 'approver-1', db as never);

    expect(out.kind).toBe('failed');
    expect(mocks.markApplyFailed).toHaveBeenCalledWith('r-1', 'approver-1', db);
    expect(mocks.markSuperseded).not.toHaveBeenCalled();
  });

  it('冻结行 candidateValue 为 null → apply_failed，未调 writer', async () => {
    // gate=prefill 保证非 null，此 guard 是显式运行时兜底（移除 `as string` 谎言）。
    mocks.claimReview.mockResolvedValue({ ...FROZEN, candidateValue: null });
    const db = makeDb(PLAN_AT_BASELINE); // 基线匹配（currency 非 null）→ 过漂移校验 → 命中 null guard
    const out = await applyReview('tok-live', 'approver-1', db as never);
    expect(out.kind).toBe('failed');
    expect(mocks.recordPriceChangeTx).not.toHaveBeenCalled(); // guard 在 writer 前抛出
    expect(mocks.markApplyFailed).toHaveBeenCalledWith('r-1', 'approver-1', db);
  });
});
