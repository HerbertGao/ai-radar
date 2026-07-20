/**
 * url-drift proposer 单测（task 6.2）——注入 db/tx 桩 + detectFn 桩 + notify spy，**无真实 DB / 不触网 /
 * 不发送 / 不真实 LLM**。
 *
 * 分支契约（design D6/m2/m4）：
 * - flag reason ∈ blocked/stale + agent candidate 达阈 → 开记录 + 发 Telegram 一键卡（callback_data
 *   `mrud:<token>:approve`）；
 * - **flag reason=changed（未匹配）→ 不调 agent**（reason-gate fail-closed）；
 * - agent escalate → 不写候选行 + **log-only**（不推卡、不额外计 metric）；
 * - agent candidate 低置信 → 跳过；
 * - agent candidate host 越界（理论不应发生）→ `assertUrlAllowed` 拒 + 不写候选行；
 * - http/manual 源 → skipped；per-source 错误隔离。
 *
 * 真实 SQL（偏索引、now() 有效期、metric upsert/回填）由集成测在真实 DB 验（DATABASE_URL-gated）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { UrlDriftAgentOutput } from '../../scrape/url-drift-agent.js';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { runUrlDriftCuration } = await import('../url-drift-propose.js');
const { mrReviewFlag, mrSource, mrUrlDriftReview } = await import('../../../db/schema.js');

interface StubConfig {
  flags?: unknown[];
  source?: unknown[];
  existingPending?: unknown[];
  inserted?: unknown[];
}

function tableRows(cfg: StubConfig, t: unknown): unknown[] {
  if (t === mrReviewFlag) return cfg.flags ?? [];
  if (t === mrSource) return cfg.source ?? [];
  if (t === mrUrlDriftReview) return cfg.existingPending ?? [];
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

/** 表感知 db/tx 桩（同一实例既作 db 又作 tx，transaction 直接回调 self；execute no-op 供 metric 回填/upsert）。 */
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
          return { where: (_w?: unknown) => ({ returning: async () => [] }) };
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
    execute: vi.fn(async () => ({ rows: [] })),
    async transaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
      return cb(self);
    },
  };
  return self;
}

function makeNotify() {
  return { telegram: vi.fn((_card: unknown) => Promise.resolve()) };
}

/** browser 源（sourceUrl host `www.kimi.com` → 反查匹配 allowlist `kimi.com`；同行既作 source-load 又作 vendorDomainSet）。 */
const kimiBrowserSource = [
  {
    id: 'src-1',
    sourceUrl: 'https://www.kimi.com/membership/pricing',
    vendorId: 'v-kimi',
    fetchStrategy: 'browser',
  },
];
const blockedFlag = [
  {
    targetType: 'source',
    targetId: 'src-1',
    reason: '抓取到疑似登录墙/验证码/人机校验拦截页（源 src-1），未更新指纹，请检查源是否被墙',
    openedAtText: '2026-07-20 09:00:00.123456+00',
  },
];
const staleFlag = [
  { targetType: 'source', targetId: 'src-1', reason: '来源页面长期未核对', openedAtText: 'x' },
];

const candidateOut: UrlDriftAgentOutput = {
  kind: 'candidate',
  candidate_url: 'https://kimi.com/membership',
  confidence: 'high',
  reason: 'www.kimi.com 会员页路径重构到 kimi.com/membership',
};
const candidate = (): Promise<UrlDriftAgentOutput> => Promise.resolve(candidateOut);

describe('runUrlDriftCuration', () => {
  it('blocked flag + agent candidate 达阈 → 开记录 + 发 Telegram 一键卡（mrud:<token>:approve）', async () => {
    const db = makeDb({
      flags: blockedFlag,
      source: kimiBrowserSource,
      existingPending: [],
      inserted: [{ id: 'r-1', token: 'tok-1' }],
    });
    const notify = makeNotify();
    const detectFn = vi.fn(candidate);

    const res = await runUrlDriftCuration({ notify, runId: 'run-1', dbh: db as never, detectFn });

    expect(res.carded).toBe(1);
    expect(detectFn).toHaveBeenCalledTimes(1);
    expect(notify.telegram).toHaveBeenCalledTimes(1);
    const card = notify.telegram.mock.calls[0]![0] as {
      replyMarkup: { inline_keyboard: { callback_data: string }[][] };
    };
    expect(card.replyMarkup.inline_keyboard[0]![0]!.callback_data).toBe('mrud:tok-1:approve');
    // metric 回填（入口）+ upsert（尾部）各 execute 一次。
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('stale flag + agent candidate 达阈 → 开记录 + 发卡', async () => {
    const db = makeDb({
      flags: staleFlag,
      source: kimiBrowserSource,
      existingPending: [],
      inserted: [{ id: 'r-2', token: 'tok-2' }],
    });
    const notify = makeNotify();
    const detectFn = vi.fn(candidate);

    const res = await runUrlDriftCuration({ notify, runId: 'run-1', dbh: db as never, detectFn });

    expect(res.carded).toBe(1);
    expect(detectFn).toHaveBeenCalledTimes(1);
    expect(notify.telegram).toHaveBeenCalledTimes(1);
  });

  it('flag reason=changed（未匹配）→ 不调 agent（reason-gate fail-closed）', async () => {
    const db = makeDb({
      flags: [
        {
          targetType: 'source',
          targetId: 'src-1',
          reason: '抓取检测到页面内容变动（源 src-1），请复核价格/额度/兼容事实',
          openedAtText: 'x',
        },
      ],
      source: kimiBrowserSource,
    });
    const notify = makeNotify();
    const detectFn = vi.fn(candidate);

    const res = await runUrlDriftCuration({ notify, runId: 'run-1', dbh: db as never, detectFn });

    expect(res.skipped).toBe(1);
    expect(detectFn).not.toHaveBeenCalled();
    expect(notify.telegram).not.toHaveBeenCalled();
  });

  it('agent escalate → 不写候选行 + log-only（不推卡、不额外计 metric）', async () => {
    const db = makeDb({ flags: blockedFlag, source: kimiBrowserSource });
    const insertSpy = vi.spyOn(db as unknown as { insert: () => unknown }, 'insert');
    const notify = makeNotify();
    const detectFn = vi.fn(
      (): Promise<UrlDriftAgentOutput> =>
        Promise.resolve({ kind: 'escalate', escalate_reason: 'no-drift-detected' }),
    );

    const res = await runUrlDriftCuration({ notify, runId: 'run-1', dbh: db as never, detectFn });

    expect(res.escalated).toBe(1);
    expect(res.carded).toBe(0);
    expect(insertSpy).not.toHaveBeenCalled(); // 无候选行写入
    expect(notify.telegram).not.toHaveBeenCalled();
  });

  it('agent candidate 低置信（low < medium 阈值）→ 跳过（不发卡、不写行）', async () => {
    const db = makeDb({ flags: blockedFlag, source: kimiBrowserSource });
    const insertSpy = vi.spyOn(db as unknown as { insert: () => unknown }, 'insert');
    const notify = makeNotify();
    const detectFn = vi.fn(
      (): Promise<UrlDriftAgentOutput> =>
        Promise.resolve({
          kind: 'candidate',
          candidate_url: 'https://kimi.com/membership',
          confidence: 'low',
          reason: '低置信候选',
        }),
    );

    const res = await runUrlDriftCuration({ notify, runId: 'run-1', dbh: db as never, detectFn });

    expect(res.skipped).toBe(1);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(notify.telegram).not.toHaveBeenCalled();
  });

  it('agent candidate host 越界（理论不应发生）→ assertUrlAllowed 拒 + 不写候选行', async () => {
    const db = makeDb({ flags: blockedFlag, source: kimiBrowserSource });
    const insertSpy = vi.spyOn(db as unknown as { insert: () => unknown }, 'insert');
    const notify = makeNotify();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const detectFn = vi.fn(
      (): Promise<UrlDriftAgentOutput> =>
        Promise.resolve({
          kind: 'candidate',
          candidate_url: 'https://evil.example.org/pricing',
          confidence: 'high',
          reason: '越界候选',
        }),
    );

    const res = await runUrlDriftCuration({ notify, runId: 'run-1', dbh: db as never, detectFn });

    expect(res.errors).toBe(1); // assertUrlAllowed 抛 → per-source 隔离
    expect(res.carded).toBe(0);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(notify.telegram).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('http/manual 源 → skipped（本 lane browser-only、不调 agent）', async () => {
    const db = makeDb({
      flags: blockedFlag,
      source: [
        { id: 'src-1', sourceUrl: 'https://example.com/pricing', vendorId: 'v-x', fetchStrategy: 'http' },
      ],
    });
    const notify = makeNotify();
    const detectFn = vi.fn(candidate);

    const res = await runUrlDriftCuration({ notify, runId: 'run-1', dbh: db as never, detectFn });

    expect(res.skipped).toBe(1);
    expect(detectFn).not.toHaveBeenCalled();
  });

  it('per-source 错误隔离（detectFn 抛 → error 计数、不改事实、不推卡）', async () => {
    const db = makeDb({ flags: blockedFlag, source: kimiBrowserSource });
    const notify = makeNotify();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const detectFn = vi.fn(
      (): Promise<UrlDriftAgentOutput> => Promise.reject(new Error('rate limit')),
    );

    const res = await runUrlDriftCuration({ notify, runId: 'run-1', dbh: db as never, detectFn });

    expect(res.errors).toBe(1);
    expect(res.carded).toBe(0);
    expect(notify.telegram).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('Telegram 发卡失败 → 置刚开的 review superseded（重开）+ 计为 error（非静默 carded）', async () => {
    const db = makeDb({
      flags: blockedFlag,
      source: kimiBrowserSource,
      existingPending: [],
      inserted: [{ id: 'r-1', token: 'tok-1' }],
    });
    // existing=[] 时 openReviewOrSupersede 不 update；故 update 命中 = markUrlDriftSuperseded 重开。
    const updateSpy = vi.spyOn(db as unknown as { update: () => unknown }, 'update');
    const notify = makeNotify();
    notify.telegram.mockRejectedValue(new Error('telegram down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const detectFn = vi.fn(candidate);

    const res = await runUrlDriftCuration({ notify, runId: 'run-1', dbh: db as never, detectFn });

    expect(res.carded).toBe(0);
    expect(res.errors).toBe(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('源处理失败'),
    );
    expect(logged?.[1]).toBe('telegram down');
    errSpy.mockRestore();
  });
});
