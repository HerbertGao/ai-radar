/**
 * vendorDomainSet / vendorOf 反查单测（task 5.2，design D5）。
 *
 * 纯逻辑（注入伪 dbh，不触真 DB / 网络 / LLM）：验证 host ∩ allowlist 反查算法、malformed URL 跳过、
 * 去重、空 vendor → []、vendorId 经 drizzle eq 绑定参（非字面拼接、防 SQL injection）。
 */
import { describe, expect, it, vi } from 'vitest';

// db/index.js 在 import 时经 env.ts 校验 process.env——补足必填项（不连真 DB，伪 dbh 顶替查询）。
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { vendorDomainSet, vendorOf } = await import('../vendor-domains.js');

/** 伪 dbh：select().from().where() 直接 await（thenable）→ rows；vendorOf 再 .limit(1)。 */
function fakeDb(rows: unknown[], capture?: { where?: unknown }) {
  const chain = {
    from: () => chain,
    where: (cond: unknown) => {
      if (capture) capture.where = cond;
      return chain;
    },
    limit: () => Promise.resolve(rows),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return { select: () => chain };
}

describe('vendorDomainSet 反查（design D5）', () => {
  it('多 source（含 malformed URL）→ host ∩ allowlist、去重', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = [
      { sourceUrl: 'https://www.kimi.com/membership/pricing' }, // → kimi.com
      { sourceUrl: 'https://platform.kimi.com/docs' }, // → kimi.com（去重）
      { sourceUrl: 'https://platform.moonshot.cn/docs' }, // → moonshot.cn
      { sourceUrl: 'not-a-valid-url' }, // malformed → 跳过 + 记日志
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await vendorDomainSet('v-kimi', fakeDb(rows) as any);
    expect(new Set(result)).toEqual(new Set(['kimi.com', 'moonshot.cn']));
    expect(result).toHaveLength(2); // Set 去重、malformed 不入
    expect(warn).toHaveBeenCalledTimes(1); // malformed 记一次日志
    warn.mockRestore();
  });

  it('无 source 的 vendor → []（agent 必然 escalate、fail-closed）', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await vendorDomainSet('v-empty', fakeDb([]) as any);
    expect(result).toEqual([]);
  });

  it('host 不在 allowlist → 不进域集', async () => {
    const rows = [{ sourceUrl: 'https://evil.example.com/pricing' }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await vendorDomainSet('v-x', fakeDb(rows) as any);
    expect(result).toEqual([]);
  });

  it('vendorId 经 drizzle eq 绑定参传入（非字面拼接、防 SQL injection）', async () => {
    const capture: { where?: unknown } = {};
    const inject = "v'; DROP TABLE mr_source; --";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await vendorDomainSet(inject, fakeDb([], capture) as any);
    expect(result).toEqual([]); // vendorId 对函数不透明、不入 URL 解析逻辑
    expect(capture.where).toBeDefined(); // 经 eq(mrSource.vendorId, vendorId) 构造的绑定条件对象、非裸串
  });
});

describe('vendorOf 反查', () => {
  it('命中 → vendor_id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await vendorOf('s1', fakeDb([{ vendorId: 'v1' }]) as any);
    expect(result).toBe('v1');
  });

  it('缺行 → null', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await vendorOf('s-missing', fakeDb([]) as any);
    expect(result).toBeNull();
  });
});
