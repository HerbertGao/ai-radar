/**
 * proposer 单测（task 6.1）——注入 db/tx 桩 + fetchFn 桩 + notify spy，**无真实 DB / 不触网 / 不发送**。
 *
 * money-path 分支契约：
 * - gate=prefill（候选异于现价、Δ≠0、官方源、同币种、≤20%）→ 开记录 + 发 Telegram 一键卡（callback_data
 *   mrpr:<token>:approve）+ 飞书通知卡；
 * - **Δ=0（候选==现价）→ 无卡、不开记录**（gate no-change）；
 * - **多 plan 源无法唯一定位 → escalate 无卡**（不猜 plan_id、不重抓）；
 * - 同 pending 同候选 → noop（不重复发卡）；
 * - 非 http 源 → skipped。
 *
 * 真实 SQL（偏索引、now() 有效期、FOR UPDATE）由集成测在真实 DB 验（收尾）。
 */
import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { runPriceCuration } = await import('../propose.js');
const { mrReviewFlag, mrSource, mrPlanSources, mrPlans, mrPriceReview } =
  await import('../../../db/schema.js');

interface StubConfig {
  flags?: unknown[];
  source?: unknown[];
  planSources?: unknown[];
  plan?: unknown[];
  existingPending?: unknown[];
  inserted?: unknown[];
}

function tableRows(cfg: StubConfig, t: unknown): unknown[] {
  if (t === mrReviewFlag) return cfg.flags ?? [];
  if (t === mrSource) return cfg.source ?? [];
  if (t === mrPlanSources) return cfg.planSources ?? [];
  if (t === mrPlans) return cfg.plan ?? [];
  if (t === mrPriceReview) return cfg.existingPending ?? [];
  return [];
}

/** await 得数组，并挂 orderBy/for（listPendingFlags 用 orderBy、store 用 for('update')）。 */
function makeThenable(rows: unknown[]): Promise<unknown[]> & {
  orderBy: (c?: unknown) => Promise<unknown[]>;
  for: (m?: string) => Promise<unknown[]>;
} {
  const p = Promise.resolve(rows) as Promise<unknown[]> & {
    orderBy: (c?: unknown) => Promise<unknown[]>;
    for: (m?: string) => Promise<unknown[]>;
  };
  p.orderBy = async () => rows;
  p.for = async () => rows;
  return p;
}

function thenableWithReturning(rows: unknown[]): Promise<unknown[]> & {
  returning: (c?: unknown) => Promise<unknown[]>;
} {
  const p = Promise.resolve(rows) as Promise<unknown[]> & {
    returning: (c?: unknown) => Promise<unknown[]>;
  };
  p.returning = async () => rows;
  return p;
}

/** 表感知 db/tx 桩（同一实例既作 db 又作 tx，transaction 直接回调 self）。 */
function makeDb(cfg: StubConfig) {
  const self: Record<string, unknown> = {
    select(_c?: unknown) {
      return {
        from(t: unknown) {
          return { where: (_w?: unknown) => makeThenable(tableRows(cfg, t)) };
        },
      };
    },
    update(_t: unknown) {
      return {
        set(_v: Record<string, unknown>) {
          return { where: (_w?: unknown) => thenableWithReturning([]) };
        },
      };
    },
    insert(_t: unknown) {
      return {
        values(_v: Record<string, unknown>) {
          return { returning: async (_c?: unknown) => cfg.inserted ?? [] };
        },
      };
    },
    async transaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
      return cb(self);
    },
  };
  return self;
}

function makeNotify() {
  return {
    telegram: vi.fn((_card: unknown) => Promise.resolve()),
    feishu: vi.fn((_card: unknown) => Promise.resolve()),
  };
}

const oneFlag = [
  { targetType: 'source', targetId: 'src-1', reason: null, openedAtText: 'x' },
];
const httpSource = [
  { id: 'src-1', sourceUrl: 'https://example.com/pricing', fetchStrategy: 'http' },
];
const officialPlan = (currentPrice: string) => [
  {
    name: 'Coding Plan Pro',
    currentPrice,
    currency: 'CNY',
    sourceConfidence: 'official_pricing',
  },
];

describe('runPriceCuration', () => {
  it('gate=prefill → 开记录 + 发 Telegram 一键卡 + 飞书通知卡', async () => {
    const db = makeDb({
      flags: oneFlag,
      source: httpSource,
      planSources: [{ planId: 'plan-1' }],
      plan: officialPlan('40.00'),
      existingPending: [],
      inserted: [{ id: 'r-1', token: 'tok-1' }],
    });
    const notify = makeNotify();
    const fetchFn = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://example.com/pricing',
      body: '价格 ¥44/月',
      truncated: false,
    }));

    const res = await runPriceCuration({ notify, dbh: db as never, fetchFn });

    expect(res.carded).toBe(1);
    expect(notify.telegram).toHaveBeenCalledTimes(1);
    expect(notify.feishu).toHaveBeenCalledTimes(1);
    const card = notify.telegram.mock.calls[0]![0] as {
      replyMarkup: { inline_keyboard: { callback_data: string }[][] };
    };
    expect(card.replyMarkup.inline_keyboard[0]![0]!.callback_data).toBe(
      'mrpr:tok-1:approve',
    );
  });

  it('Telegram 发卡失败 → 置刚开的 review superseded（重开）+ 计为 error（非静默 carded）', async () => {
    const db = makeDb({
      flags: oneFlag,
      source: httpSource,
      planSources: [{ planId: 'plan-1' }],
      plan: officialPlan('40.00'),
      existingPending: [],
      inserted: [{ id: 'r-1', token: 'tok-1' }],
    });
    // 监视 update：openReviewOrSupersede 此例 existing=[] 不 update，故 update 命中 = markSuperseded 重开。
    const updateSpy = vi.spyOn(db as unknown as { update: () => unknown }, 'update');
    const notify = makeNotify();
    notify.telegram.mockRejectedValue(new Error('telegram down'));
    const fetchFn = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://example.com/pricing',
      body: '价格 ¥44/月',
      truncated: false,
    }));

    const res = await runPriceCuration({ notify, dbh: db as never, fetchFn });

    expect(res.carded).toBe(0);
    expect(res.errors).toBe(1);
    expect(updateSpy).toHaveBeenCalledTimes(1); // markSuperseded 置刚开的 review superseded → 下轮重开卡
    expect(notify.feishu).not.toHaveBeenCalled(); // 失败路径不发飞书通知
  });

  it('飞书通知失败 → 仍 carded（通知-only，不改源结果 / 不影响 money 路径）', async () => {
    const db = makeDb({
      flags: oneFlag,
      source: httpSource,
      planSources: [{ planId: 'plan-1' }],
      plan: officialPlan('40.00'),
      existingPending: [],
      inserted: [{ id: 'r-1', token: 'tok-1' }],
    });
    const notify = makeNotify();
    notify.feishu.mockRejectedValue(new Error('feishu down'));
    const fetchFn = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://example.com/pricing',
      body: '价格 ¥44/月',
      truncated: false,
    }));

    const res = await runPriceCuration({ notify, dbh: db as never, fetchFn });

    expect(res.carded).toBe(1);
    expect(res.errors).toBe(0);
    expect(notify.telegram).toHaveBeenCalledTimes(1);
  });

  it('Δ=0（候选==现价）→ 无卡、不开记录（gate no-change）', async () => {
    const db = makeDb({
      flags: oneFlag,
      source: httpSource,
      planSources: [{ planId: 'plan-1' }],
      plan: officialPlan('40.00'),
      inserted: [{ id: 'x', token: 'x' }],
    });
    const notify = makeNotify();
    const fetchFn = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://example.com/pricing',
      body: '价格 ¥40/月',
      truncated: false,
    }));

    const res = await runPriceCuration({ notify, dbh: db as never, fetchFn });

    expect(res.escalated).toBe(1);
    expect(res.carded).toBe(0);
    expect(notify.telegram).not.toHaveBeenCalled();
  });

  it('多 plan 源无法唯一定位 → escalate 无卡（不重抓、不猜 plan_id）', async () => {
    const db = makeDb({
      flags: oneFlag,
      source: httpSource,
      planSources: [{ planId: 'p1' }, { planId: 'p2' }],
    });
    const notify = makeNotify();
    const fetchFn = vi.fn(async () => {
      throw new Error('不该重抓多 plan 源');
    });

    const res = await runPriceCuration({ notify, dbh: db as never, fetchFn });

    expect(res.escalated).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(notify.telegram).not.toHaveBeenCalled();
  });

  it('同 pending 同候选 → noop（不重复发卡）', async () => {
    const db = makeDb({
      flags: oneFlag,
      source: httpSource,
      planSources: [{ planId: 'plan-1' }],
      plan: officialPlan('40.00'),
      existingPending: [
        { id: 'r-old', candidateValue: '44.00', currency: 'CNY', expired: false },
      ],
      inserted: [{ id: 'x', token: 'x' }],
    });
    const notify = makeNotify();
    const fetchFn = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://example.com/pricing',
      body: '价格 ¥44/月',
      truncated: false,
    }));

    const res = await runPriceCuration({ notify, dbh: db as never, fetchFn });

    expect(res.noop).toBe(1);
    expect(notify.telegram).not.toHaveBeenCalled();
  });

  it('非 http 源 → skipped（本 lane http-only）', async () => {
    const db = makeDb({
      flags: oneFlag,
      source: [
        { id: 'src-1', sourceUrl: 'https://example.com/pricing', fetchStrategy: 'browser' },
      ],
    });
    const notify = makeNotify();
    const fetchFn = vi.fn(async () => {
      throw new Error('不该抓 browser 源');
    });

    const res = await runPriceCuration({ notify, dbh: db as never, fetchFn });

    expect(res.skipped).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
