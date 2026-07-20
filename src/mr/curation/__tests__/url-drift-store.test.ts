/**
 * URL drift 待批记录 store 单测（task 3.2）——**注入 db/tx 桩，无真实 DB / 不触网**（遵守测试守卫）。
 * 与 price-review-store.test.ts 逐字节对称。
 *
 * 覆盖 money-path 分支契约：
 * - 无既有 pending → opened（插新、token 定长 hex、flag_opened_at 开卡冻结写入）；
 * - 未过期同候选（candidate_url 字面相同）→ no-op（不重复发卡、不 supersede、不 insert）；
 * - 不同候选 / 过期同候选 → 置旧 superseded + 插新 pending；
 * - 过期/未知令牌 claim CAS 0 行 → null（幂等 no-op）；claim 非空 → 返回行上冻结值（含 flag_opened_at）；
 * - markUrlDriftSuperseded / markUrlDriftApplyFailed 命中 / 0 行；
 * - 非法 confidence 枚举 → Zod 闸在发 SQL 前拒（不进事务）。
 *
 * 真实 SQL（now() 有效期谓词、偏唯一索引、FOR UPDATE 并发）由集成测在真实 DB 验。
 */
import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const {
  openUrlDriftReviewOrSupersede,
  claimUrlDriftReview,
  markUrlDriftSuperseded,
  markUrlDriftApplyFailed,
} = await import('../url-drift-store.js');

interface Op {
  op: 'select' | 'update' | 'insert';
  set?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

interface StubConfig {
  /** SELECT ... FOR UPDATE 返回的既有 pending 行（[] = 无既有 pending）。 */
  existing?: unknown[];
  /** INSERT ... RETURNING 返回行。 */
  inserted?: unknown[];
  /** UPDATE ... RETURNING 返回行（claim / mark* 用）。 */
  updateReturning?: unknown[];
}

/** 附带 `.returning()` 的 thenable（供 `await update().set().where()` 与 `.returning()` 两种收尾）。 */
function thenableWithReturning(rows: unknown[]): Promise<unknown[]> & {
  returning: (c?: unknown) => Promise<unknown[]>;
} {
  const p = Promise.resolve(rows) as Promise<unknown[]> & {
    returning: (c?: unknown) => Promise<unknown[]>;
  };
  p.returning = async () => rows;
  return p;
}

function makeTx(cfg: StubConfig, ops: Op[]) {
  return {
    select(_cols?: unknown) {
      return {
        from(_t: unknown) {
          return {
            where(_c: unknown) {
              return { for: async (_mode: string) => cfg.existing ?? [] };
            },
          };
        },
      };
    },
    update(_t: unknown) {
      return {
        set(v: Record<string, unknown>) {
          return {
            where(_c: unknown) {
              ops.push({ op: 'update', set: v });
              return thenableWithReturning(cfg.updateReturning ?? []);
            },
          };
        },
      };
    },
    insert(_t: unknown) {
      return {
        values(v: Record<string, unknown>) {
          ops.push({ op: 'insert', values: v });
          return { returning: async (_c?: unknown) => cfg.inserted ?? [] };
        },
      };
    },
  };
}

/** db 桩：transaction 把 tx 桩传给回调；裸 update 供 claim/mark* 用。 */
function makeDb(cfg: StubConfig, ops: Op[]) {
  const tx = makeTx(cfg, ops);
  return { ...tx, async transaction<T>(cb: (t: unknown) => Promise<T>) { return cb(tx); } };
}

const baseInput = {
  sourceId: 'src-1',
  runId: 'run-1',
  oldUrl: 'https://kimi.com/old/pricing',
  confidence: 'high',
  reason: 'agent 推断 path 重构',
  flagOpenedAt: '2026-07-20 09:17:00.123456+00',
};

describe('openUrlDriftReviewOrSupersede', () => {
  it('无既有 pending → opened（插新，不 supersede；flag_opened_at 开卡冻结写入）', async () => {
    const ops: Op[] = [];
    const db = makeDb({ existing: [], inserted: [{ id: 'r-new', token: 'tok-new' }] }, ops);
    const out = await openUrlDriftReviewOrSupersede(
      { ...baseInput, candidateUrl: 'https://kimi.com/new/pricing' },
      db as never,
    );
    expect(out).toEqual({ outcome: 'opened', reviewId: 'r-new', token: 'tok-new' });
    expect(ops.filter((o) => o.op === 'update')).toHaveLength(0);
    expect(ops.filter((o) => o.op === 'insert')).toHaveLength(1);
    const ins = ops.find((o) => o.op === 'insert')!.values!;
    // 令牌由 randomBytes(16) → 32 hex；extracted_at 不由 app 写（列 defaultNow）。
    expect(ins.token).toMatch(/^[0-9a-f]{32}$/);
    expect(ins).not.toHaveProperty('extractedAt');
    expect(ins.status).toBe('pending');
    // flag_opened_at 开卡冻结：调用方传入值原样写入行（generation token，design D-M4）。
    expect(ins.flagOpenedAt).toBe(baseInput.flagOpenedAt);
    expect(ins.runId).toBe('run-1');
  });

  it('未过期同候选（candidate_url 字面相同）→ no-op（不 supersede、不 insert、不重复发卡）', async () => {
    const ops: Op[] = [];
    const db = makeDb(
      {
        existing: [{ id: 'r-old', candidateUrl: 'https://kimi.com/new/pricing', expired: false }],
        inserted: [{ id: 'x', token: 'x' }],
      },
      ops,
    );
    const out = await openUrlDriftReviewOrSupersede(
      { ...baseInput, candidateUrl: 'https://kimi.com/new/pricing' },
      db as never,
    );
    expect(out).toEqual({ outcome: 'noop' });
    expect(ops.filter((o) => o.op !== 'select')).toHaveLength(0);
  });

  it('不同候选 → 置旧 superseded + 插新 pending', async () => {
    const ops: Op[] = [];
    const db = makeDb(
      {
        existing: [{ id: 'r-old', candidateUrl: 'https://kimi.com/new/pricing', expired: false }],
        inserted: [{ id: 'r-new', token: 'tok-new' }],
      },
      ops,
    );
    const out = await openUrlDriftReviewOrSupersede(
      { ...baseInput, candidateUrl: 'https://kimi.com/newer/pricing' }, // 不同候选
      db as never,
    );
    expect(out).toEqual({
      outcome: 'superseded-and-opened',
      reviewId: 'r-new',
      token: 'tok-new',
      supersededId: 'r-old',
    });
    expect(ops.find((o) => o.op === 'update')?.set?.status).toBe('superseded');
    expect(ops.filter((o) => o.op === 'insert')).toHaveLength(1);
  });

  it('过期同候选 → supersede + 重发（防卡死，不因同候选 no-op）', async () => {
    const ops: Op[] = [];
    const db = makeDb(
      {
        existing: [{ id: 'r-old', candidateUrl: 'https://kimi.com/new/pricing', expired: true }],
        inserted: [{ id: 'r-new', token: 'tok-new' }],
      },
      ops,
    );
    const out = await openUrlDriftReviewOrSupersede(
      { ...baseInput, candidateUrl: 'https://kimi.com/new/pricing' }, // 同候选、但过期
      db as never,
    );
    expect(out).toEqual({
      outcome: 'superseded-and-opened',
      reviewId: 'r-new',
      token: 'tok-new',
      supersededId: 'r-old',
    });
    expect(ops.find((o) => o.op === 'update')?.set?.status).toBe('superseded');
    expect(ops.filter((o) => o.op === 'insert')).toHaveLength(1);
  });

  it('非法 confidence 被 Zod 闸在发 SQL 前拒（不进事务）', async () => {
    const ops: Op[] = [];
    const db = makeDb({ existing: [] }, ops);
    await expect(
      openUrlDriftReviewOrSupersede(
        { ...baseInput, confidence: 'urgent', candidateUrl: 'https://kimi.com/new/pricing' },
        db as never,
      ),
    ).rejects.toThrow();
    expect(ops).toHaveLength(0);
  });
});

describe('claimUrlDriftReview CAS', () => {
  it('过期/未知令牌 → CAS 0 行 → null（幂等 no-op）', async () => {
    const ops: Op[] = [];
    const db = makeDb({ updateReturning: [] }, ops);
    const out = await claimUrlDriftReview('dead-token', 'approver-1', db as never);
    expect(out).toBeNull();
  });

  it('命中 → 置 approved 并返回行上冻结值（含 flag_opened_at）', async () => {
    const ops: Op[] = [];
    const frozen = {
      id: 'r-1',
      sourceId: 'src-1',
      oldUrl: 'https://kimi.com/old/pricing',
      candidateUrl: 'https://kimi.com/new/pricing',
      flagOpenedAt: '2026-07-20 09:17:00.123456+00',
    };
    const db = makeDb({ updateReturning: [frozen] }, ops);
    const out = await claimUrlDriftReview('tok-live', 'approver-1', db as never);
    expect(out).toEqual(frozen);
    const upd = ops.find((o) => o.op === 'update');
    expect(upd?.set?.status).toBe('approved');
    expect(upd?.set?.decidedBy).toBe('approver-1');
  });
});

describe('markUrlDriftSuperseded / markUrlDriftApplyFailed（键 id AND status=pending）', () => {
  it('markUrlDriftSuperseded 命中 1 行 → 1（decidedBy 可为 null）', async () => {
    const ops: Op[] = [];
    const db = makeDb({ updateReturning: [{ id: 'r-1' }] }, ops);
    expect(await markUrlDriftSuperseded('r-1', null, db as never)).toBe(1);
    const upd = ops.find((o) => o.op === 'update');
    expect(upd?.set?.status).toBe('superseded');
    expect(upd?.set?.decidedBy).toBeNull();
  });

  it('markUrlDriftApplyFailed 0 行（已被并发 supersede）→ 0，不误标（写 decided_by 审计）', async () => {
    const ops: Op[] = [];
    const db = makeDb({ updateReturning: [] }, ops);
    expect(await markUrlDriftApplyFailed('r-1', 'approver-1', db as never)).toBe(0);
    const upd = ops.find((o) => o.op === 'update');
    expect(upd?.set?.status).toBe('apply_failed');
    expect(upd?.set?.decidedBy).toBe('approver-1');
  });
});
