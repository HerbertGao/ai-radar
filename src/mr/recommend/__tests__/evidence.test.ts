/**
 * 证据装配层单测（add-model-radar-recommender-rag-explanation 组 B / task 2.4；
 * add-model-radar-assembly-deadline-cancel 组 C / task 3.2 补充：恒 deadlineAt + AbortController 真取消）。
 *
 * 全经注入 mock dbh/embed——不真连 DB、不真调 embed（沿仓内注入式测试款式）。
 * 覆盖（既有）：KB 子源失败仍返回价格变更 / 全失败三空不抛 / 30 天窗口边界 / cosine 地板 /
 *              old_value NULL ⇒ from=null / 跨候选 docId 去重保最高 cosine。
 * 覆盖（组 C 新增）：装配超时 ⇒ 三空 + signal abort + embed 桩收到 aborted signal、不记子源 failed /
 *              某子源早失败致 assembly 早于 deadline resolve ⇒ 返回前仍 abort（覆盖非超时早结束路径）/
 *              KB 与价格查询各制造 statement_timeout（57014）⇒ 错误冒泡出事务（建模自动 ROLLBACK）、取消降级不记 failed
 *              （真 PG 的 57014/ROLLBACK/is_local 不泄漏由 kb/__tests__/retrieval-core.integration.test.ts 证）/
 *              价格查询走单连事务 + set_config 绑定参（非 `SET …=$1`）/
 *              价格连接获取等待跨 deadline ⇒ 回调内重算 remainingMs≤0 ⇒ 不发业务查询、不 set_config /
 *              未超时 ⇒ signal 未 abort、正常三源返回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { mrPriceHistory } from '../../../db/schema.js';
import { assembleEvidence, type AssembleEvidenceDeps } from '../evidence.js';
import type { RankedCandidate } from '../schema.js';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  // searchKbCore 的逐查观测走 console.error（stderr）——测试内静默，避免噪声。
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkCandidate(over: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    planId: 'p1',
    vendorName: 'Vendor A',
    name: 'GLM-4.6 Coding Plan',
    monthlyCost: 49,
    currency: 'CNY',
    priceStatus: 'known',
    availability: 'on_sale',
    stale: false,
    fitsWindow: 'unknown',
    verdict: 'primary',
    reasons: [],
    provenance: {
      sourceUrl: 'https://example.com/pricing',
      sourceConfidence: 'official_pricing',
      lastCheckedDate: '2026-06-20',
    },
    ...over,
  };
}

interface KbRow {
  id: string;
  kbTitle: string | null;
  summaryZh: string | null;
  entities: unknown;
  sourceUrls: unknown;
  eventDate: string | null;
  longTermValue: number | null;
  cosineSim: number;
}

function kbRow(over: Partial<KbRow> & { id: string; cosineSim: number }): KbRow {
  return {
    kbTitle: '深度评测',
    summaryZh: null,
    entities: null,
    sourceUrls: ['https://kb.example.com/a'],
    eventDate: null,
    longTermValue: 80,
    ...over,
  };
}

interface PriceRow {
  planId: string;
  oldValue: string | null;
  newValue: string;
  currency: string;
  changedAt: Date;
}

interface DbhState {
  kbBusinessQueries: number;
  priceBusinessQueries: number;
  /** 事务内 tx.execute 收到的 set_config 语句（含 KB 与价格两路）。 */
  setConfigSqls: SQL[];
  /** 事务回调抛错触发的自动 ROLLBACK 次数（Drizzle 语义建模）。 */
  rolledBack: number;
  txInvoked: number;
}

/**
 * 单个 mock dbh：deadlineAtMs 恒非空 ⇒ KB（searchKbCore）与价格查询**均走 `dbh.transaction`**。
 * tx 暴露 `execute`（记 set_config）+ `select`（按 `.from(table)` 身份路由 KB / 价格业务查询）。
 * transaction 桩仿 Drizzle：回调抛 ⇒ 记 rolledBack 并 rethrow（自动 ROLLBACK）；txDelayMs 仿满池连接获取等待。
 * kbRowSets 按 searchKbCore 调用顺序逐次消费（每候选一次）；kbQuery/priceQuery 覆盖默认（供抛错场景）。
 */
function makeDbh(opts: {
  kbRowSets?: KbRow[][];
  priceRows?: PriceRow[];
  kbQuery?: () => Promise<KbRow[]>;
  priceQuery?: () => Promise<PriceRow[]>;
  txDelayMs?: number;
}): { dbh: AssembleEvidenceDeps['dbh']; state: DbhState } {
  let kbCall = 0;
  const state: DbhState = {
    kbBusinessQueries: 0,
    priceBusinessQueries: 0,
    setConfigSqls: [],
    rolledBack: 0,
    txInvoked: 0,
  };
  const kbHandler = opts.kbQuery ?? (async () => opts.kbRowSets?.[kbCall++] ?? []);
  const priceHandler = opts.priceQuery ?? (async () => opts.priceRows ?? []);
  const selectRouter = () => ({
    from: (table: unknown) => {
      if (table === mrPriceHistory) {
        return {
          where: () => {
            state.priceBusinessQueries += 1;
            return priceHandler();
          },
        };
      }
      const kb = {
        where: () => kb,
        orderBy: () => kb,
        limit: () => {
          state.kbBusinessQueries += 1;
          return kbHandler();
        },
      };
      return kb;
    },
  });
  const dbh = {
    select: selectRouter,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      state.txInvoked += 1;
      if (opts.txDelayMs) await new Promise((r) => setTimeout(r, opts.txDelayMs));
      const tx = {
        execute: async (s: SQL) => {
          state.setConfigSqls.push(s);
        },
        select: selectRouter,
      };
      try {
        return await cb(tx);
      } catch (e) {
        state.rolledBack += 1; // Drizzle 异常自动 ROLLBACK 的建模
        throw e;
      }
    },
  };
  return { dbh: dbh as unknown as AssembleEvidenceDeps['dbh'], state };
}

const okEmbed: AssembleEvidenceDeps['embed'] = async () => [[0.1, 0.2, 0.3]];
const throwingEmbed: AssembleEvidenceDeps['embed'] = async () => {
  throw new Error('embed down');
};
const noopLog = () => {};

/**
 * PG query_canceled（statement_timeout fire）的**生产真形态**：Drizzle 把真 pg 错误包成外层 `Error`，
 * 外层 message = `Failed query: …`、外层无 `code`；真 SQLSTATE 57014 与取消文案住在 `.cause`（已对真 PG 实测）。
 * 用此形态才检得住 isExpectedCancel 的 `.cause` 链遍历（旧的顶层 `{code:'57014'}` 桩是生产从不产生的假绿）。
 */
function statementTimeoutError(): Error {
  const pgErr = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  return Object.assign(new Error('Failed query: select …\nparams: '), { cause: pgErr });
}

describe('assembleEvidence（既有行为）', () => {
  it('KB 子源失败仍返回价格变更（子源相互隔离）', async () => {
    const { dbh } = makeDbh({
      priceRows: [{ planId: 'p1', oldValue: '39', newValue: '49', currency: 'CNY', changedAt: new Date(Date.now() - DAY) }],
    });
    const result = await assembleEvidence([mkCandidate()], { dbh, embed: throwingEmbed, log: noopLog });

    expect(result.kbHits).toEqual([]);
    expect(result.priceChanges).toHaveLength(1);
    expect(result.priceChanges[0]).toMatchObject({ from: '39', to: '49', currency: 'CNY' });
  });

  it('全部子源失败（非取消）⇒ 三空、不抛', async () => {
    const { dbh } = makeDbh({
      priceQuery: async () => {
        throw new Error('price db down');
      },
    });
    const result = await assembleEvidence(
      [mkCandidate({ reasons: [] })], // 无 pending_review ⇒ pendingReview 亦空
      { dbh, embed: throwingEmbed, log: noopLog },
    );
    expect(result).toEqual({ kbHits: [], priceChanges: [], pendingReview: [] });
  });

  it('30 天窗口边界：29 天前入、31 天前不入', async () => {
    const { dbh } = makeDbh({
      priceRows: [
        { planId: 'p1', oldValue: '39', newValue: '49', currency: 'CNY', changedAt: new Date(Date.now() - 29 * DAY) },
        { planId: 'p1', oldValue: '49', newValue: '59', currency: 'CNY', changedAt: new Date(Date.now() - 31 * DAY) },
      ],
    });
    const result = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: noopLog });

    expect(result.priceChanges).toHaveLength(1);
    expect(result.priceChanges[0]).toMatchObject({ from: '39', to: '49' });
    expect(result.priceChanges[0]!.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('cosine 地板过滤：全部低于地板 ⇒ kbHits 空', async () => {
    const { dbh } = makeDbh({
      kbRowSets: [[kbRow({ id: 'd1', cosineSim: 0.3 }), kbRow({ id: 'd2', cosineSim: 0.59 })]],
    });
    const result = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: noopLog });
    expect(result.kbHits).toEqual([]);
  });

  it('old_value NULL 行 ⇒ from=null（首录得价）', async () => {
    const { dbh } = makeDbh({
      priceRows: [{ planId: 'p1', oldValue: null, newValue: '49', currency: 'CNY', changedAt: new Date(Date.now() - DAY) }],
    });
    const result = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: noopLog });
    expect(result.priceChanges).toHaveLength(1);
    expect(result.priceChanges[0]!.from).toBeNull();
    expect(result.priceChanges[0]!.to).toBe('49');
  });

  it('跨候选按 docId 去重、保最高 cosine', async () => {
    // 两候选各命中同一 docId d1，cosine 分别 0.7 / 0.9；去重后只留 0.9（与消费顺序无关）。
    const { dbh } = makeDbh({
      kbRowSets: [[kbRow({ id: 'd1', cosineSim: 0.7 })], [kbRow({ id: 'd1', cosineSim: 0.9 })]],
    });
    const candidates = [
      mkCandidate({ planId: 'p1', name: 'GLM-4.6 Coding Plan' }),
      mkCandidate({ planId: 'p2', name: 'Claude Pro Plan' }),
    ];
    const result = await assembleEvidence(candidates, { dbh, embed: okEmbed, log: noopLog });

    expect(result.kbHits).toHaveLength(1);
    expect(result.kbHits[0]).toMatchObject({ docId: 'd1', cosine: 0.9 });
  });
});

describe('assembleEvidence 真取消（组 C / D1/D4）', () => {
  it('装配整体超时 ⇒ 三空 + signal abort + embed 桩收到 aborted signal，不记子源 failed（取消降级）', async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      // embed 尊重 signal：abort ⇒ 抛 AbortError（模拟底层 embedMany abortSignal 真取消）。
      const abortAwareEmbed: AssembleEvidenceDeps['embed'] = (_texts, signal) =>
        new Promise((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
          );
        });
      const { dbh } = makeDbh({ priceRows: [] });
      const logs: string[] = [];
      // 候选带 pending_review：证明超时按全失败三空（连同步可得的 pendingReview 也丢）。
      const candidate = mkCandidate({ reasons: [{ kind: 'pending_review', detail: '待复核' }] });

      const p = assembleEvidence([candidate], { dbh, embed: abortAwareEmbed, log: (m) => logs.push(m) });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await p;

      expect(result).toEqual({ kbHits: [], priceChanges: [], pendingReview: [] });
      expect(capturedSignal!.aborted).toBe(true); // deadline 触发 ac.abort()
      // 预期取消降级为 canceled、绝不记为「子源 failed」错误日志（design D1，防增噪）。
      expect(logs).toContain('evidence.kbHits canceled');
      expect(logs).not.toContain('evidence.kbHits failed');
      expect(logs).not.toContain('evidence.priceChanges failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('2 候选：一个 embed 早失败、另一个 embed 仍在飞 ⇒ assembly 早于 deadline resolve、返回前 abort 令在飞的兄弟 embed 被取消', async () => {
    // 候选1 embed 立即真失败（非取消错、signal 未 abort）⇒ Promise.all 早拒 ⇒ assembleKbHits 早返 []；价格空 ⇒ assembly
    // 远早于 5s deadline resolve。候选2 embed 仍挂起——abort 若只在 deadline 触发，此在飞的兄弟不被取消；abort 恒在 finally
    // 发即取消它。共用同一 ac.signal，故验「在飞的兄弟」确观测到 abort（非仅早失败候选自身 signal 置位）。
    let siblingAbortedResolve!: (v: boolean) => void;
    const siblingAborted = new Promise<boolean>((r) => {
      siblingAbortedResolve = r;
    });
    let call = 0;
    const embed: AssembleEvidenceDeps['embed'] = (_texts, signal) => {
      call += 1;
      if (call === 1) throw new Error('embed hard fail'); // 候选1：立即真失败（非取消错）
      return new Promise<number[][]>((_res, reject) => {
        // 候选2：挂起直到 signal abort（模拟在飞的兄弟 embed 被 ac.abort() 取消）
        signal?.addEventListener('abort', () => {
          siblingAbortedResolve(true);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    };
    const { dbh } = makeDbh({ priceRows: [] });
    const candidates = [mkCandidate({ planId: 'p1' }), mkCandidate({ planId: 'p2', name: 'Other Plan' })];
    const result = await assembleEvidence(candidates, { dbh, embed, log: noopLog });

    expect(result).toEqual({ kbHits: [], priceChanges: [], pendingReview: [] });
    expect(await siblingAborted).toBe(true); // 在飞的兄弟 embed 确被 finally 的 ac.abort() 取消（非仅超时分支）
  });

  it('KB 查询 statement_timeout（57014）冒泡出事务（建模自动 ROLLBACK）、同一 dbh 可立即再查、不记 failed', async () => {
    let fire = true;
    const logs: string[] = [];
    const { dbh, state } = makeDbh({
      kbQuery: async () => {
        if (fire) throw statementTimeoutError();
        return [kbRow({ id: 'later', cosineSim: 0.9 })];
      },
      priceRows: [],
    });

    const first = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: (m) => logs.push(m) });
    expect(first.kbHits).toEqual([]); // 取消降级、fail-open 三空
    expect(state.rolledBack).toBeGreaterThanOrEqual(1); // 建模：错误冒泡出事务 ⇒ Drizzle 自动 ROLLBACK（真 PG 见 integration 测）
    expect(logs).toContain('evidence.kbHits canceled'); // 57014 ⇒ 标预期取消
    expect(logs).not.toContain('evidence.kbHits failed'); // 绝不记为失败

    // 同一 dbh 立即再查——mock 无连接状态，仅证代码可再次调用（连接干净复用见 integration 测）。
    fire = false;
    const second = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: noopLog });
    expect(second.kbHits).toHaveLength(1);
    expect(second.kbHits[0]!.docId).toBe('later');
  });

  it('价格查询 statement_timeout（57014）冒泡出事务（建模自动 ROLLBACK）、同一 dbh 可立即再查、不记 failed', async () => {
    let fire = true;
    const logs: string[] = [];
    const { dbh, state } = makeDbh({
      priceQuery: async () => {
        if (fire) throw statementTimeoutError();
        return [{ planId: 'p1', oldValue: '39', newValue: '49', currency: 'CNY', changedAt: new Date(Date.now() - DAY) }];
      },
    });

    const first = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: (m) => logs.push(m) });
    expect(first.priceChanges).toEqual([]); // 取消降级、fail-open 三空
    expect(state.rolledBack).toBeGreaterThanOrEqual(1);
    expect(logs).toContain('evidence.priceChanges canceled');
    expect(logs).not.toContain('evidence.priceChanges failed');

    fire = false;
    const second = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: noopLog });
    expect(second.priceChanges).toHaveLength(1);
    expect(second.priceChanges[0]).toMatchObject({ from: '39', to: '49' });
  });

  it('价格查询走单连事务 + set_config，timeout 值是绑定参（非 `SET …=$1` 语法错）', async () => {
    const { dbh, state } = makeDbh({
      priceRows: [{ planId: 'p1', oldValue: '39', newValue: '49', currency: 'CNY', changedAt: new Date(Date.now() - DAY) }],
    });
    const result = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: noopLog });
    expect(result.priceChanges).toHaveLength(1);

    // KB 与价格两路各 set_config 一次；两路均须绑定参形态（价格是 KB 之外的独立事务实现，须单独核不写歪）。
    const compiled = state.setConfigSqls.map((s) => new PgDialect().sqlToQuery(s));
    expect(compiled.length).toBeGreaterThanOrEqual(1);
    for (const c of compiled) {
      expect(c.sql).toBe("select set_config('statement_timeout', $1, true)");
      expect(c.sql).not.toMatch(/\bset\s+(local\s+)?statement_timeout\s*=/i);
      expect(typeof c.params[0]).toBe('string'); // ms 文本（String(remainingMs)）
      expect(Number(c.params[0])).toBeGreaterThan(0);
    }
  });

  it('价格连接获取等待跨 deadline（慢 transaction 桩）⇒ 回调内重算 remainingMs≤0 ⇒ 不发价格业务查询、不 set_config', async () => {
    vi.useFakeTimers();
    try {
      // 装配 deadline = now + 5000；transaction 拿连接耗 6000ms 才进回调 ⇒ 回调内 remainingMs≤0（验回调内算、非事务前算）。
      const { dbh, state } = makeDbh({
        priceRows: [{ planId: 'p1', oldValue: '39', newValue: '49', currency: 'CNY', changedAt: new Date(Date.now() - DAY) }],
        txDelayMs: 6000,
      });
      const p = assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: noopLog });
      await vi.advanceTimersByTimeAsync(6000); // 越过 5000 deadline（先触发装配超时）再让慢事务进回调
      const result = await p;

      expect(result.priceChanges).toEqual([]);
      expect(state.txInvoked).toBeGreaterThanOrEqual(1); // 事务被进入（拿到连接后才算 remaining）
      expect(state.priceBusinessQueries).toBe(0); // 回调内 remainingMs≤0 ⇒ 未发业务查询
      expect(state.setConfigSqls).toHaveLength(0); // 未 set_config
    } finally {
      vi.useRealTimers();
    }
  });

  it('未超时 ⇒ 正常三源返回（embed 执行期间未被 abort；finally 恒 abort 对已完成调用是 no-op、不影响结果）', async () => {
    const { dbh } = makeDbh({
      kbRowSets: [[kbRow({ id: 'd1', cosineSim: 0.8 })]],
      priceRows: [{ planId: 'p1', oldValue: '39', newValue: '49', currency: 'CNY', changedAt: new Date(Date.now() - DAY) }],
    });
    // 执行期快照：未超时路径 embed 跑时不应已被 abort（证 finally 的恒 abort 不干扰在飞的底层调用）。
    let abortedDuringEmbed: boolean | undefined;
    const embed: AssembleEvidenceDeps['embed'] = async (_texts, signal) => {
      abortedDuringEmbed = signal?.aborted;
      return [[0.1, 0.2, 0.3]];
    };
    const candidate = mkCandidate({ reasons: [{ kind: 'pending_review', detail: '待复核' }] });
    const result = await assembleEvidence([candidate], { dbh, embed, log: noopLog });

    expect(result.kbHits).toHaveLength(1);
    expect(result.kbHits[0]!.docId).toBe('d1');
    expect(result.priceChanges).toHaveLength(1);
    expect(result.pendingReview).toEqual([candidate.name]);
    expect(abortedDuringEmbed).toBe(false); // 执行期间未被取消 ⇒ 未超时路径底层调用照常完成、结果完整
  });
});
