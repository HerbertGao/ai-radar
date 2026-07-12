/**
 * conversation-store 测试（任务 2.4 / 5.6，design D4）。
 *
 * 两层：
 * 1) 无 DB 快单测（fake db 句柄）—— 确定性覆盖 turn 派生 / UNIQUE 冲突重试 turn+1 / 有界 ≤5 抛 409。
 *    并发在真库下时序不可控（冲突分支不保证被触发），故用注入的 fake 精确摊出这三条分支——始终可跑。
 * 2) 真库集成测（skipIf 无 DATABASE_URL）—— 顺序派生 / WHERE user_id 隔离 / 指针式 hitKbIds 往返 /
 *    并发两写落两条不重复行。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  ConversationConflictError,
  newConversationId,
  readHistory,
  writeTurn,
  type WriteTurnInput,
} from '../conversation-store.js';

/**
 * 最小 fake db 句柄——只实现 writeTurn 用到的两条链：
 * - `select().from().where()` → `[{ maxTurn }]`
 * - `insert().values().onConflictDoNothing().returning()` → 空数组（冲突）或 `[{ turn }]`（成功）
 * `occupied` 集合模拟「该 turn 已被占」→ 空 returning，据此测重试/有界分支。
 */
function makeFakeDb(opts: {
  maxTurn: number | null | string;
  occupied?: Set<number>;
  attempts?: number[];
}): Parameters<typeof writeTurn>[1] {
  const occupied = opts.occupied ?? new Set<number>();
  let pendingTurn = 0;
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    from: () => chain,
    where: () => Promise.resolve([{ maxTurn: opts.maxTurn }]),
    insert: () => chain,
    values: (v: { turn: number }) => {
      pendingTurn = v.turn;
      opts.attempts?.push(v.turn);
      return chain;
    },
    onConflictDoNothing: () => chain,
    returning: () =>
      Promise.resolve(occupied.has(pendingTurn) ? [] : [{ turn: pendingTurn }]),
  });
  return chain as unknown as Parameters<typeof writeTurn>[1];
}

const baseInput = (
  over: Partial<WriteTurnInput> = {},
): WriteTurnInput => ({
  userId: 'local',
  conversationId: 'c1',
  rawQuery: 'q',
  ...over,
});

describe('writeTurn turn 派生 / 冲突重试 / 有界（fake db，无 DB 恒跑）', () => {
  it('空会话 → 派生 turn 1', async () => {
    expect(await writeTurn(baseInput(), makeFakeDb({ maxTurn: null }))).toBe(1);
  });

  it('已有最大 turn 3 → 派生 4', async () => {
    expect(await writeTurn(baseInput(), makeFakeDb({ maxTurn: 3 }))).toBe(4);
  });

  it('max(turn) 回传字符串也不字符串拼接（Number 兜底）', async () => {
    // pg 驱动对 max(integer) 可能回传字符串 "7"；`"7" ?? 0` 后 + 1 会得 "71"，Number 兜底防之。
    expect(await writeTurn(baseInput(), makeFakeDb({ maxTurn: '7' }))).toBe(8);
  });

  it('起始 turn 被占 → 重试 turn+1（不丢轮次）', async () => {
    const attempts: number[] = [];
    // maxTurn 0 → base 1；turn 1 已占 → 重试 turn 2 成功。
    const turn = await writeTurn(
      baseInput(),
      makeFakeDb({ maxTurn: 0, occupied: new Set([1]), attempts }),
    );
    expect(turn).toBe(2);
    expect(attempts).toEqual([1, 2]);
  });

  it('持续冲突 → 有界 ≤5 次后抛 ConversationConflictError(409)', async () => {
    const attempts: number[] = [];
    await expect(
      writeTurn(
        baseInput(),
        makeFakeDb({
          maxTurn: null,
          occupied: new Set([1, 2, 3, 4, 5]),
          attempts,
        }),
      ),
    ).rejects.toBeInstanceOf(ConversationConflictError);
    // 恰好试满 5 个连续 turn（base..base+4），不无界重试。
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
  });

  it('ConversationConflictError 带 status 409（供上层转 HTTP）', () => {
    expect(new ConversationConflictError().status).toBe(409);
  });
});

// ── 真库集成测（skipIf 无 DATABASE_URL） ──────────────────────────────────
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const createdConversationIds: string[] = [];

afterAll(async () => {
  if (pool && createdConversationIds.length > 0) {
    await pool.query(
      `DELETE FROM rag_conversations WHERE conversation_id = ANY($1)`,
      [createdConversationIds],
    );
  }
  await pool?.end();
});

describe.skipIf(!databaseUrl)('conversation-store 真库读写', () => {
  it('顺序 writeTurn 派生 1,2,3 且 readHistory 按 turn 升序读回', async () => {
    const cid = newConversationId();
    createdConversationIds.push(cid);
    const t1 = await writeTurn({ userId: 'local', conversationId: cid, rawQuery: 'a' });
    const t2 = await writeTurn({ userId: 'local', conversationId: cid, rawQuery: 'b' });
    const t3 = await writeTurn({ userId: 'local', conversationId: cid, rawQuery: 'c' });
    expect([t1, t2, t3]).toEqual([1, 2, 3]);

    const hist = await readHistory('local', cid);
    expect(hist.map((h) => h.turn)).toEqual([1, 2, 3]);
    expect(hist.map((h) => h.rawQuery)).toEqual(['a', 'b', 'c']);
  });

  it('WHERE user_id 隔离：不同 user 同 conversation_id 各自独立、互不可见', async () => {
    const cid = newConversationId();
    createdConversationIds.push(cid);
    // 同一 conversation_id 下两个 user 各写一轮——各自从 turn 1 起（max 按 user 过滤）。
    const local1 = await writeTurn({ userId: 'local', conversationId: cid, rawQuery: 'L' });
    const other1 = await writeTurn({ userId: 'other-user', conversationId: cid, rawQuery: 'O' });
    expect(local1).toBe(1);
    expect(other1).toBe(1);

    const localHist = await readHistory('local', cid);
    const otherHist = await readHistory('other-user', cid);
    expect(localHist.map((h) => h.rawQuery)).toEqual(['L']);
    expect(otherHist.map((h) => h.rawQuery)).toEqual(['O']);
  });

  it('指针式 hitKbIds 数组往返（存 kb_id 引用、非 KB 正文拷贝）', async () => {
    const cid = newConversationId();
    createdConversationIds.push(cid);
    await writeTurn({
      userId: 'local',
      conversationId: cid,
      rawQuery: 'q',
      rewrittenQuery: 'rq',
      hitKbIds: ['kb-1', 'kb-2'],
      answer: 'ans',
      evidence: '有据',
      model: 'test/model',
    });
    const [row] = await readHistory('local', cid);
    expect(row?.hitKbIds).toEqual(['kb-1', 'kb-2']);
    expect(row?.rewrittenQuery).toBe('rq');
    expect(row?.evidence).toBe('有据');
  });

  it('并发两写同一 (user,conversation) → 落两条不重复行、turn 各异（UNIQUE 兜底）', async () => {
    const cid = newConversationId();
    createdConversationIds.push(cid);
    const [ta, tb] = await Promise.all([
      writeTurn({ userId: 'local', conversationId: cid, rawQuery: 'x' }),
      writeTurn({ userId: 'local', conversationId: cid, rawQuery: 'y' }),
    ]);
    // 两次派生的 turn 互异（冲突者重试 turn+1），无重复行。
    expect(ta).not.toBe(tb);
    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rag_conversations WHERE conversation_id = $1`,
      [cid],
    );
    expect(rows[0]!.n).toBe('2');
  });
});
