/**
 * searchKbCore signal 转发 + DB 侧真取消（deadlineAtMs → 单连事务 + set_config）单测
 * （add-model-radar-assembly-deadline-cancel，组 B / task 2.2 / 见 D3/D4）。
 *
 * 全程注入 mock dbh/embed——不真连 DB、不真调 embed（沿仓内注入式测试款式）。env-clean 模块，直接静态 import。
 * 覆盖：signal 转发 embed / deadlineAtMs ⇒ 走 tx + set_config 且 timeout 值是绑定参（非 `SET …=$1` 语法错）/
 *       statement_timeout fire ⇒ 事务 ROLLBACK 完成 + 同连接可立即再查 / 连接获取等待跨 deadline ⇒ 回调内
 *       重算 remainingMs≤0 不发业务查询不 set_config / remainingMs≤0 跳过返 [] / 缺省裸查询路径逐字节不动。
 */
import { describe, expect, it } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { searchKbCore, type KbEmbed, type SearchKbCoreParams } from '../retrieval-core.js';

type DbLike = SearchKbCoreParams['dbh'];

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

function row(over: Partial<KbRow> & { id: string; cosineSim: number }): KbRow {
  return {
    kbTitle: 'T',
    summaryZh: null,
    entities: null,
    sourceUrls: ['https://kb.example.com/a'],
    eventDate: null,
    longTermValue: 80,
    ...over,
  };
}

/** 一次 select→from→where→orderBy→limit 链，limit 处 resolve/reject 业务查询结果；onSelect 计一次业务查询。 */
function mkExecutor(queryResult: () => Promise<KbRow[]>, onSelect: () => void): { select: (...a: unknown[]) => unknown } {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => queryResult(),
  };
  return {
    select: () => {
      onSelect();
      return chain;
    },
  };
}

interface DbhState {
  executeSqls: SQL[];
  businessQueries: number;
  rolledBack: boolean;
  txInvoked: number;
}

/**
 * mock dbh：裸路径经 dbh.select()，事务路径经 dbh.transaction(cb) → tx（含 execute + select）。
 * transaction 桩仿 Drizzle 语义：回调抛 ⇒ 记 rolledBack 并 rethrow（自动 ROLLBACK）；txDelayMs 仿满池连接获取等待。
 */
function mkDbh(opts: {
  bareQueryResult?: () => Promise<KbRow[]>;
  txQueryResult?: () => Promise<KbRow[]>;
  txDelayMs?: number;
}): { dbh: DbLike; state: DbhState } {
  const state: DbhState = { executeSqls: [], businessQueries: 0, rolledBack: false, txInvoked: 0 };
  const bare = mkExecutor(opts.bareQueryResult ?? (async () => []), () => (state.businessQueries += 1));
  const tx = {
    execute: async (s: SQL) => {
      state.executeSqls.push(s);
    },
    ...mkExecutor(opts.txQueryResult ?? (async () => []), () => (state.businessQueries += 1)),
  };
  const dbh = {
    ...bare,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      state.txInvoked += 1;
      if (opts.txDelayMs) await new Promise((r) => setTimeout(r, opts.txDelayMs));
      try {
        return await cb(tx);
      } catch (e) {
        state.rolledBack = true; // Drizzle 异常自动 ROLLBACK 的建模
        throw e;
      }
    },
  };
  return { dbh: dbh as unknown as DbLike, state };
}

const noopLog = () => {};

function baseParams(dbh: DbLike, embed: KbEmbed): SearchKbCoreParams {
  return { query: '查询', topK: 5, dbh, embed, logError: noopLog };
}

describe('searchKbCore signal 转发（D3）', () => {
  it('传 signal ⇒ embed 收到该 aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    let got: { signal: AbortSignal | undefined } | null = null;
    const embed: KbEmbed = async (_t, signal) => {
      got = { signal };
      return [[0.1, 0.2]];
    };
    const { dbh } = mkDbh({ bareQueryResult: async () => [] });
    await searchKbCore({ ...baseParams(dbh, embed), signal: ac.signal });
    expect(got!.signal).toBe(ac.signal);
    expect(got!.signal!.aborted).toBe(true);
  });

  it('缺省不传 signal ⇒ embed 第二参为 undefined（逐字节等价现状）', async () => {
    let got: { signal: AbortSignal | undefined } | null = null;
    const embed: KbEmbed = async (_t, signal) => {
      got = { signal };
      return [[0.1, 0.2]];
    };
    const { dbh, state } = mkDbh({ bareQueryResult: async () => [row({ id: '1', cosineSim: 0.9 })] });
    const out = await searchKbCore(baseParams(dbh, embed));
    expect(got!.signal).toBeUndefined();
    expect(state.txInvoked).toBe(0); // 缺省 ⇒ 不开事务，走裸 dbh.select()
    expect(state.businessQueries).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('1');
  });
});

describe('searchKbCore deadlineAtMs → 单连事务 + set_config（D4）', () => {
  const okEmbed: KbEmbed = async () => [[0.1, 0.2]];

  it('deadlineAtMs 非空 ⇒ 走 tx；set_config 语句 timeout 值是绑定参、非 `SET …=$1` 语法错', async () => {
    const { dbh, state } = mkDbh({ txQueryResult: async () => [row({ id: 'd1', cosineSim: 0.8 })] });
    const out = await searchKbCore({ ...baseParams(dbh, okEmbed), deadlineAtMs: Date.now() + 60_000 });

    expect(state.txInvoked).toBe(1);
    expect(state.businessQueries).toBe(1);
    expect(state.executeSqls).toHaveLength(1);

    const compiled = new PgDialect().sqlToQuery(state.executeSqls[0]!);
    // set_config 函数调用形态：值走绑定参 $1（PG SET 命令不吃绑定参，`SET …=$1` 会运行期语法错）。
    expect(compiled.sql).toBe("select set_config('statement_timeout', $1, true)");
    expect(compiled.sql).not.toMatch(/\bset\s+(local\s+)?statement_timeout\s*=/i);
    expect(compiled.params).toHaveLength(1);
    expect(typeof compiled.params[0]).toBe('string'); // ms 文本（String(remainingMs)）
    expect(Number(compiled.params[0])).toBeGreaterThan(0);

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('d1');
  });

  // 注：此处 mock 只证「查询错误冒泡出 dbh.transaction（未被回调内吞）⇒ Drizzle 得以自动 ROLLBACK」这一**代码**属性；
  // 真 PG 的 57014 / 自动 ROLLBACK / is_local 不泄漏由 retrieval-core.integration.test.ts 真连库证（mock 无连接可污染）。
  it('statement_timeout（业务查询抛 57014）冒泡出 dbh.transaction（建模自动 ROLLBACK）、同一 dbh 可立即再查', async () => {
    // 生产真形态：Drizzle 包外层 Error（message="Failed query: …"、顶层无 code），真 SQLSTATE 57014 在 .cause（对真 PG 实测）。
    const canceled = Object.assign(new Error('Failed query: …\nparams: '), {
      cause: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    });
    let fire = true;
    const { dbh, state } = mkDbh({
      txQueryResult: async () => {
        if (fire) throw canceled;
        return [row({ id: 'later', cosineSim: 0.7 })];
      },
      bareQueryResult: async () => [row({ id: 'after', cosineSim: 0.6 })],
    });

    await expect(
      searchKbCore({ ...baseParams(dbh, okEmbed), deadlineAtMs: Date.now() + 60_000 }),
    ).rejects.toMatchObject({ cause: { code: '57014' } }); // 真 SQLSTATE 在 .cause（searchKbCore 只透传、由 evidence 层 isExpectedCancel 沿链判定）
    expect(state.rolledBack).toBe(true); // 建模：错误冒泡出事务 ⇒ Drizzle 自动 ROLLBACK（真 PG 归还干净连接见 integration 测）

    // 同一 dbh 立即跑后续查询（裸路径，无 deadline）——mock 无连接状态，仅证代码可再次调用。
    fire = false;
    const out = await searchKbCore(baseParams(dbh, okEmbed));
    expect(out.map((r) => r.id)).toEqual(['after']);
  });

  it('remainingMs≤0（deadline 已过）⇒ 回调内不启动业务查询、不 set_config、返 []', async () => {
    const { dbh, state } = mkDbh({ txQueryResult: async () => [row({ id: 'x', cosineSim: 0.9 })] });
    const out = await searchKbCore({ ...baseParams(dbh, okEmbed), deadlineAtMs: Date.now() - 1000 });
    expect(out).toEqual([]);
    expect(state.txInvoked).toBe(1); // 进了事务（拿连接后才知已过期）
    expect(state.executeSqls).toHaveLength(0); // 不 set_config
    expect(state.businessQueries).toBe(0); // 不发业务查询
  });

  it('连接获取等待跨过 deadline（慢 transaction 桩）⇒ 回调内重算 remainingMs≤0（验回调内算、非事务前算）', async () => {
    // deadline 仅 10ms 后：若在 transaction() 之前算，remaining≈+10 会照跑；桩延 50ms 才进回调 ⇒ 回调内重算已过期。
    const { dbh, state } = mkDbh({
      txQueryResult: async () => [row({ id: 'x', cosineSim: 0.9 })],
      txDelayMs: 50,
    });
    const out = await searchKbCore({ ...baseParams(dbh, okEmbed), deadlineAtMs: Date.now() + 10 });
    expect(out).toEqual([]);
    expect(state.txInvoked).toBe(1);
    expect(state.executeSqls).toHaveLength(0); // 回调内算得 ≤0 ⇒ 未 set_config
    expect(state.businessQueries).toBe(0); // 未发业务查询
  });
});
