/**
 * dispatchDailyDigest 单测——失败矩阵（merge-products-into-daily-digest，design D2 方案 A，tasks 7.2）。
 *
 * 用**注入 dbh 桩**（模拟 drizzle 的 select/transaction(insert|update) 链）精确控制各 DB 操作的
 * 成功/抛错时机，验证方案 A 的非对称终态语义与段级失败隔离——这些分支无法用真实 DB 稳定构造：
 * - event 段先在其事务 success；product 终态写抛错时 event 段仍 success 不回滚、product 残 pending、
 *   返回 outcome='sent'（不进 failedChannels）+ **必发错误日志/告警**（可观测性）。
 * - event 终态事务抛错 → **不 swallow、向上传播**（→ run-daily 置 failedChannels 触发整 job 重试），
 *   与 product 终态失败 swallow→sent 非对称。
 * - 发送前 product computePendingSet / INSERT pending 抛错 → productsPending 降级空、只推 event 段 + 告警。
 * - 空 event + 发送前 product 失败 → 两段空 → skip 不发空消息。
 * - 两段皆空（待发集合空）不发；outcome 合并规则；非空抛错不变量。
 *
 * DB 相关「跨天去重 / target_type 不混命名空间 / merge_conflict 排除 / 截断保持 pending」由
 * daily-dispatch.integration.test.ts 连真库覆盖。本套件纯桩、不连库、不真发。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SelectedEvent } from '../../selection/top-n.js';

// 注入占位 env 让 import config/env 通过（dispatcher 间接依赖 push-date → env）。
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/db';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph';

const { dispatchDailyDigest } = await import('../dispatcher.js');
import type { MessageSender } from '../dispatcher.js';

const NOW = new Date('2099-01-01T04:00:00Z'); // 上海 2099-01-01 12:00 → push_date=2099-01-01。

function ev(id: string): SelectedEvent {
  return {
    eventId: id,
    representativeTitle: `事件${id}`,
    summaryZh: '摘要',
    headlineZh: '要点',
    canonicalUrl: null,
    publishedAt: null,
    rankScore: 0,
  };
}
function prod(id: string): SelectedEvent {
  return {
    eventId: id,
    representativeTitle: `产品${id}`,
    summaryZh: null,
    headlineZh: null,
    canonicalUrl: null,
    publishedAt: null,
    rankScore: 0,
  };
}

function okSender(): MessageSender & { calls: number } {
  const s = { calls: 0, async send() { s.calls += 1; } };
  return s;
}
function failSender(message = 'sender boom'): MessageSender & { calls: number } {
  const s = {
    calls: 0,
    async send(): Promise<void> {
      s.calls += 1;
      throw new Error(message);
    },
  };
  return s;
}

/** 记录一次 DB 写操作（用于断言哪些 target_type 被写了什么终态/pending）。 */
interface DbOp {
  kind: 'insert-pending' | 'update';
  targetType: string;
  status?: string; // update 时的目标 status；insert 时为 'pending'。
}

/**
 * 注入 dbh 桩配置（按 targetType 维度声明，由桩据 dispatch 的确定性调用流派给具体操作）：
 * - successByType：computePendingSet 的 select 对该 targetType 返回的已 success target_id（→ 排除出待发）。
 * - throwSelectForType：computePendingSet（select）对该 targetType 抛错（模拟发送前 product computePendingSet 失败）。
 * - throwInsertForType：transaction 内 insert pending 对该 targetType 抛错（模拟发送前 product INSERT 失败）。
 * - throwUpdate：transaction 内 update 对该 (targetType,status) 抛错（模拟终态写失败）。
 *
 * 桩须知道**输入段是否非空**才能给 select 正确派 targetType（computePendingSet 仅在输入段非空时
 * 才发 select），故 makeDbStub 第二参显式传入 `inputs`（各段输入条数 > 0 否）。
 */
interface StubConfig {
  successByType?: Partial<Record<string, string[]>>;
  throwSelectForType?: string;
  throwInsertForType?: string;
  throwUpdate?: { targetType: string; status: 'success' | 'failed' };
}

/** 各段输入是否非空（决定 computePendingSet 是否对该段发 select；insert/update 的 targetType 桩另有可靠信号）。 */
interface StubInputs {
  eventsNonEmpty: boolean;
  productsNonEmpty: boolean;
}

/**
 * 构造一个模拟 drizzle 句柄的 dbh 桩，记录所有写操作到 ops，按 StubConfig 注入抛错。
 *
 * 支持的链：
 * - `select({...}).from(table).where(cond)`（await）→ computePendingSet 用，返回 successByType 行。
 * - `transaction(cb)` → cb(tx)；tx 支持 `insert(table).values(rows).onConflictDoNothing()`（await）
 *   与 `update(table).set(patch).where(cond)`（await）。
 *
 * **targetType 派发（不内省 drizzle 的 where SQL 对象，全靠 dispatch 的确定性调用流）**：
 * - select：`dispatchDailyDigest` 先对 event 段（输入非空时）、后对 product 段（输入非空时）各调一次
 *   computePendingSet；computePendingSet 仅在输入段非空时才发 select。故据 `inputs` 预排 selectPlan
 *   （非空段按 event→product 顺序入列），第 k 次 select 即 selectPlan[k]。
 * - insert pending：values 首行显式带 targetType（dispatch 写入），直接读，最可靠。
 * - update（终态写）：`dispatchDailyDigest` 始终先 event 段、后 product 段更新，且只更新此前 INSERT 过
 *   pending 的段，顺序与 insert 一致。故记 insertedOrder（实际 insert 的 targetType 序列），update 按
 *   「同状态第几次」走 insertedOrder（第一次→insertedOrder[0]、第二次→insertedOrder[1]）。
 *   sender 失败时 event/product 各置一次 failed（顺序同 insertedOrder）；成功时各置一次 success。
 */
function makeDbStub(
  config: StubConfig = {},
  inputs: StubInputs = { eventsNonEmpty: true, productsNonEmpty: true },
): { dbh: unknown; ops: DbOp[] } {
  const ops: DbOp[] = [];

  // computePendingSet 仅对非空输入段发 select，顺序固定 event→product。
  const selectPlan: string[] = [];
  if (inputs.eventsNonEmpty) selectPlan.push('event');
  if (inputs.productsNonEmpty) selectPlan.push('product');
  let selectIdx = 0;

  const insertedOrder: string[] = []; // 实际 INSERT pending 的 targetType 序列（供 update 派发）。
  const updateCountByStatus: Record<string, number> = {};

  function makeSelect() {
    const targetType = selectPlan[selectIdx] ?? 'unknown';
    selectIdx += 1;
    const rows = (config.successByType?.[targetType] ?? []).map((id) => ({
      targetId: id,
    }));
    const thenable = {
      from() {
        return this;
      },
      where() {
        return this;
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        if (config.throwSelectForType === targetType) {
          reject(new Error(`select boom for ${targetType}`));
          return;
        }
        resolve(rows);
      },
    };
    return thenable;
  }

  function makeTx() {
    return {
      insert() {
        return {
          values(rows: Array<{ targetType: string }>) {
            const targetType = rows[0]?.targetType ?? 'unknown';
            return {
              onConflictDoNothing() {
                return {
                  then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
                    if (config.throwInsertForType === targetType) {
                      reject(new Error(`insert boom for ${targetType}`));
                      return;
                    }
                    insertedOrder.push(targetType);
                    ops.push({ kind: 'insert-pending', targetType, status: 'pending' });
                    resolve(undefined);
                  },
                };
              },
            };
          },
        };
      },
      update() {
        return {
          set(patch: { status: string }) {
            const status = patch.status;
            return {
              where() {
                return {
                  then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
                    // 同 status 的第 n 次 update → insertedOrder[n-1]（终态写顺序与 insert 一致）。
                    updateCountByStatus[status] = (updateCountByStatus[status] ?? 0) + 1;
                    const nth = updateCountByStatus[status]!;
                    const targetType = insertedOrder[nth - 1] ?? 'unknown';
                    if (
                      config.throwUpdate &&
                      config.throwUpdate.targetType === targetType &&
                      config.throwUpdate.status === status
                    ) {
                      reject(new Error(`update boom for ${targetType}/${status}`));
                      return;
                    }
                    ops.push({ kind: 'update', targetType, status });
                    resolve(undefined);
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  const dbh = {
    select() {
      return makeSelect();
    },
    async transaction(cb: (tx: unknown) => Promise<unknown>) {
      return cb(makeTx());
    },
  };
  return { dbh, ops };
}

describe('dispatchDailyDigest 方案 A 终态与段级失败隔离（7.2 失败矩阵，桩）', () => {
  it('两段皆有待发、发送成功 → event/product 各自 INSERT pending + 各自终态 success（不混命名空间）', async () => {
    const { dbh, ops } = makeDbStub(); // 无 success 历史 → 两段都待发。
    const sender = okSender();
    const r = await dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never);

    expect(r.outcome).toBe('sent');
    expect(r.eventIncludedIds).toEqual(['e1']);
    expect(r.productIncludedIds).toEqual(['p1']);
    expect(sender.calls).toBe(1); // 一次发送。

    // event 行写 event 命名空间、product 行写 product 命名空间，互不混。
    expect(ops).toEqual([
      { kind: 'insert-pending', targetType: 'event', status: 'pending' },
      { kind: 'insert-pending', targetType: 'product', status: 'pending' },
      { kind: 'update', targetType: 'event', status: 'success' }, // 先固化要闻段。
      { kind: 'update', targetType: 'product', status: 'success' }, // 再固化新品段。
    ]);
  });

  it('product 终态写抛错 → event 段仍 success 不回滚、product 残 pending、outcome=sent、必发告警', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { dbh, ops } = makeDbStub({
        throwUpdate: { targetType: 'product', status: 'success' },
      });
      const sender = okSender();
      const r = await dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never);

      // 关键：消息已送达 → outcome=sent（不进 failedChannels），product 终态失败被 swallow。
      expect(r.outcome).toBe('sent');
      expect(r.eventIncludedIds).toEqual(['e1']);
      expect(r.productIncludedIds).toEqual(['p1']);
      expect(sender.calls).toBe(1);

      // event 段已 success（在自己的事务里固化），不被 product 段事务抛错回滚。
      expect(ops).toContainEqual({ kind: 'update', targetType: 'event', status: 'success' });
      // product 段终态写抛错 → 未记 product success op（残 pending，下次补发）。
      expect(ops).not.toContainEqual({ kind: 'update', targetType: 'product', status: 'success' });
      // 可观测性：product 终态写失败必发错误日志/告警。
      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('新品段终态写 success 失败');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('event 终态事务抛错 → 不 swallow、向上传播（与 product 终态失败 swallow→sent 非对称）', async () => {
    const { dbh } = makeDbStub({
      throwUpdate: { targetType: 'event', status: 'success' },
    });
    const sender = okSender();
    // event 段是优先段：其终态写失败应抛错传出 dispatchDailyDigest（→ run-daily 置 failedChannels 触发重试）。
    await expect(
      dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never),
    ).rejects.toThrow(/update boom for event\/success/);
    expect(sender.calls).toBe(1); // 消息已发（终态写在发送之后）。
  });

  it('发送前 product computePendingSet 抛错 → productsPending 降级空、只推 event 段 + 告警', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { dbh, ops } = makeDbStub({ throwSelectForType: 'product' });
      const sender = okSender();
      const r = await dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never);

      // product 段降级空 → 只推 event 段。
      expect(r.outcome).toBe('sent');
      expect(r.eventIncludedIds).toEqual(['e1']);
      expect(r.productIncludedIds).toEqual([]); // 降级空。
      expect(sender.calls).toBe(1);
      // 只有 event 段被 INSERT pending + 终态 success；product 段无任何写。
      expect(ops).toContainEqual({ kind: 'insert-pending', targetType: 'event', status: 'pending' });
      expect(ops).toContainEqual({ kind: 'update', targetType: 'event', status: 'success' });
      expect(ops.some((o) => o.targetType === 'product')).toBe(false);
      // 必发告警。
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('新品段 computePendingSet 失败');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('发送前 product INSERT pending 抛错 → productsPending 降级空、只推 event 段 + 告警', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { dbh, ops } = makeDbStub({ throwInsertForType: 'product' });
      const sender = okSender();
      const r = await dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never);

      expect(r.outcome).toBe('sent');
      expect(r.eventIncludedIds).toEqual(['e1']);
      expect(r.productIncludedIds).toEqual([]); // INSERT 抛错降级空。
      expect(sender.calls).toBe(1);
      // event 段照常 INSERT + success；product 段无终态写（已降级）。
      expect(ops).toContainEqual({ kind: 'update', targetType: 'event', status: 'success' });
      expect(ops.some((o) => o.kind === 'update' && o.targetType === 'product')).toBe(false);
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('新品段 INSERT pending 失败');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('空 event + 发送前 product 失败 → 两段空 → skip 不发空消息', async () => {
    // 输入：events 空（不发 event select）、products 非空（发 product select 并抛错）。
    const { dbh, ops } = makeDbStub(
      { throwSelectForType: 'product' },
      { eventsNonEmpty: false, productsNonEmpty: true },
    );
    const sender = okSender();
    // events 入参空 → eventsPending 空；product computePendingSet 抛错 → productsPending 降级空 → 两段空 → skip。
    const r = await dispatchDailyDigest([], [prod('p1')], { now: NOW, sender }, dbh as never);
    expect(r.outcome).toBe('skipped');
    expect(r.eventIncludedIds).toEqual([]);
    expect(r.productIncludedIds).toEqual([]);
    expect(sender.calls).toBe(0); // 不发空消息。
    expect(ops).toEqual([]); // 无任何 INSERT/UPDATE。
  });

  it('event computePendingSet 空 + product INSERT pending 抛错降级空 → 两段空 → skip（不抛非空不变量错）', async () => {
    // event 输入非空但已全 success → eventsPending 空；product 输入非空、computePendingSet 非空，
    // 但 INSERT pending 抛错 → productsPending 降级空。此后两段皆空须走第二次早退 skip，
    // 而非落到渲染→非空抛错不变量误抛。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { dbh, ops } = makeDbStub({
        successByType: { event: ['e1'] }, // eventsPending 空。
        throwInsertForType: 'product', // product INSERT pending 抛错 → 降级空。
      });
      const sender = okSender();
      const r = await dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never);
      expect(r.outcome).toBe('skipped');
      expect(r.eventIncludedIds).toEqual([]);
      expect(r.productIncludedIds).toEqual([]);
      expect(sender.calls).toBe(0); // 不发空消息。
      // event 段无 INSERT（pending 空）；product 段 INSERT 抛错未记成功 op。
      expect(ops.some((o) => o.kind === 'insert-pending' && o.targetType === 'event')).toBe(false);
      expect(ops.some((o) => o.kind === 'update')).toBe(false);
      // 降级告警仍发（INSERT 失败），但不抛错。
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('新品段 INSERT pending 失败');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('两段待发皆空（皆已 success）→ skip，不发', async () => {
    const { dbh, ops } = makeDbStub({
      successByType: { event: ['e1'], product: ['p1'] },
    });
    const sender = okSender();
    const r = await dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never);
    expect(r.outcome).toBe('skipped');
    expect(sender.calls).toBe(0);
    expect(ops).toEqual([]);
  });

  it('仅 event 段待发（product 已全 success）→ 只推 event 段', async () => {
    const { dbh, ops } = makeDbStub({ successByType: { product: ['p1'] } });
    const sender = okSender();
    const r = await dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never);
    expect(r.outcome).toBe('sent');
    expect(r.eventIncludedIds).toEqual(['e1']);
    expect(r.productIncludedIds).toEqual([]); // product 已 success → 不在待发集合。
    expect(sender.calls).toBe(1);
    expect(ops.some((o) => o.targetType === 'product')).toBe(false);
  });

  it('仅 product 段待发（event 已全 success）→ 只推 product 段', async () => {
    const { dbh, ops } = makeDbStub({ successByType: { event: ['e1'] } });
    const sender = okSender();
    const r = await dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never);
    expect(r.outcome).toBe('sent');
    expect(r.eventIncludedIds).toEqual([]); // event 已 success。
    expect(r.productIncludedIds).toEqual(['p1']);
    expect(sender.calls).toBe(1);
    expect(ops).toContainEqual({ kind: 'update', targetType: 'product', status: 'success' });
    expect(ops.some((o) => o.targetType === 'event')).toBe(false);
  });

  it('sender 抛异常 → outcome=failed，两段各自独立事务置 failed', async () => {
    const { dbh, ops } = makeDbStub();
    const sender = failSender('telegram down');
    const r = await dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never);
    expect(r.outcome).toBe('failed');
    expect(sender.calls).toBe(1);
    // 两段实发 includedIds 各置 failed（独立事务）。
    expect(ops).toContainEqual({ kind: 'update', targetType: 'event', status: 'failed' });
    expect(ops).toContainEqual({ kind: 'update', targetType: 'product', status: 'failed' });
  });

  it('sender 失败 + product 置 failed 写库也抛错 → 不拖累 event 段 failed（仍 outcome=failed）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { dbh, ops } = makeDbStub({
        throwUpdate: { targetType: 'product', status: 'failed' },
      });
      const sender = failSender('boom');
      const r = await dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never);
      expect(r.outcome).toBe('failed');
      // event 段 failed 仍被写（product 置 failed 抛错被 swallow，不拖累 event）。
      expect(ops).toContainEqual({ kind: 'update', targetType: 'event', status: 'failed' });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('dispatchDailyDigest 非空抛错不变量（7.2，桩）', () => {
  it('两段 pending 并集非空但 includedIds 并集空 → 抛错（防静默漏推）', async () => {
    // 构造「renderDailyDigest 渲染出 0 条」：用空标题 + 空产品名……但单块恒可装、首块总能渲染。
    // 真实渲染器对非空入参恒回 ≥1 includedId（首块有界恒可装），故此不变量在正常路径不会触发。
    // 用 spy 把 renderDailyDigest 替换为返回空 includedIds 的桩，验证 dispatch 在该破坏态下抛错。
    const dispatcherModule = await import('../dispatcher.js');
    const messageModule = await import('../message.js');
    const renderSpy = vi
      .spyOn(messageModule, 'renderDailyDigest')
      .mockReturnValue({
        text: 'x',
        parseMode: 'MarkdownV2',
        eventIncludedIds: [],
        productIncludedIds: [],
      });
    try {
      const { dbh } = makeDbStub();
      const sender = okSender();
      await expect(
        dispatcherModule.dispatchDailyDigest([ev('e1')], [prod('p1')], { now: NOW, sender }, dbh as never),
      ).rejects.toThrow(/渲染出 0 条可发/);
      expect(sender.calls).toBe(0); // 抛在发送之前。
    } finally {
      renderSpy.mockRestore();
    }
  });
});
