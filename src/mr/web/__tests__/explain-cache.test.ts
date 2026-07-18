/**
 * explain-cache 单测（add-model-radar-explain-public-cost-bound task 3.3 / design D1·D4·D5）——
 * 全部 no-network：computeSetupHash 纯函数；缓存读写注入内存/抛错 Redis 桩；单飞进程内。
 *
 * 覆盖：
 * - computeSetupHash：等价输入同 hash；`maxMonthlyPrice` / currency / **model / tool / protocol / usageProfile
 *   各自改动 ⇒ 不同 hash**（防漏字段回归）；`{}` 与显式缺省 `{CNY,medium}` 同 hash（先套缺省再哈希）。
 * - get/setCachedExplanation：写后读命中；不同 version / setupHash 不命中；Redis 抛错 ⇒ get null / set 不抛（fail-open）。
 * - withSingleFlight：并发 N 个同键 ⇒ produce 至多 1 次、其余 await 同一 promise 得同结果；produce 抛错 ⇒ 清键、
 *   下次可重试。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RecommendInput } from '../../recommend/recommend.js';

let computeSetupHash: typeof import('../explain-cache.js').computeSetupHash;
let getCachedExplanation: typeof import('../explain-cache.js').getCachedExplanation;
let setCachedExplanation: typeof import('../explain-cache.js').setCachedExplanation;
let withSingleFlight: typeof import('../explain-cache.js').withSingleFlight;
let EXPLAIN_CACHE_TTL_MS: number;

beforeAll(async () => {
  // explain-cache.ts import env（dotenv/config 校验）；无 .env 的 CI 兜底最小 env，有 .env 时 ||= 不覆盖。
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  ({ computeSetupHash, getCachedExplanation, setCachedExplanation, withSingleFlight, EXPLAIN_CACHE_TTL_MS } =
    await import('../explain-cache.js'));
});

/** 内存 Redis 桩（get/set PX；暴露 store + 记录 TTL）。 */
function memRedis(store: Record<string, string> = {}) {
  return {
    get: async (k: string) => store[k] ?? null,
    set: vi.fn(async (k: string, v: string, _px: 'PX', _ttl: number) => {
      store[k] = v;
      return 'OK';
    }),
    store,
  };
}

/** 读写恒抛的 Redis 桩（验 fail-open）。 */
const throwingRedis = {
  get: async () => {
    throw new Error('redis down');
  },
  set: async () => {
    throw new Error('redis down');
  },
};

describe('computeSetupHash：稳定 + 全字段覆盖', () => {
  it('等价输入同 hash（同对象字面量两次）', () => {
    const input: RecommendInput = { model: 'gpt', tool: 'cline', maxMonthlyPrice: 30, currency: 'CNY', usageProfile: 'heavy' };
    expect(computeSetupHash(input)).toBe(computeSetupHash({ ...input }));
  });

  it('字段书写顺序不影响 hash（固定字段序序列化）', () => {
    const a: RecommendInput = { model: 'gpt', maxMonthlyPrice: 30 };
    const b: RecommendInput = { maxMonthlyPrice: 30, model: 'gpt' };
    expect(computeSetupHash(a)).toBe(computeSetupHash(b));
  });

  it('`{}` 与显式缺省 `{currency:CNY, usageProfile:medium}` 同 hash（先套缺省再哈希）', () => {
    expect(computeSetupHash({})).toBe(computeSetupHash({ currency: 'CNY', usageProfile: 'medium' }));
  });

  it('maxMonthlyPrice 不同 ⇒ 不同 hash（连续数值不离散化）', () => {
    expect(computeSetupHash({ maxMonthlyPrice: 30 })).not.toBe(computeSetupHash({ maxMonthlyPrice: 31 }));
  });

  it('maxMonthlyPrice undefined ≠ 任一数值（无预算约束语义 ≠ 数值）', () => {
    expect(computeSetupHash({})).not.toBe(computeSetupHash({ maxMonthlyPrice: 0 }));
    expect(computeSetupHash({})).not.toBe(computeSetupHash({ maxMonthlyPrice: 30 }));
  });

  it('maxMonthlyPrice 数值归一（30 与 30.0 同 hash）', () => {
    expect(computeSetupHash({ maxMonthlyPrice: 30 })).toBe(computeSetupHash({ maxMonthlyPrice: 30.0 }));
  });

  // 显式逐字段覆盖：漏任一字段会让异档请求撞缓存返错误解释（防漏字段回归）。
  it('model 改动 ⇒ 不同 hash', () => {
    expect(computeSetupHash({ model: 'gpt' })).not.toBe(computeSetupHash({ model: 'claude' }));
  });
  it('tool 改动 ⇒ 不同 hash', () => {
    expect(computeSetupHash({ tool: 'cline' })).not.toBe(computeSetupHash({ tool: 'cursor' }));
  });
  it('protocol 改动 ⇒ 不同 hash', () => {
    expect(computeSetupHash({ protocol: 'mcp' })).not.toBe(computeSetupHash({ protocol: 'a2a' }));
  });
  it('currency 改动 ⇒ 不同 hash', () => {
    expect(computeSetupHash({ currency: 'CNY' })).not.toBe(computeSetupHash({ currency: 'USD' }));
  });
  it('usageProfile 改动 ⇒ 不同 hash（漏它会让异档请求撞缓存）', () => {
    expect(computeSetupHash({ usageProfile: 'light' })).not.toBe(computeSetupHash({ usageProfile: 'heavy' }));
  });
});

describe('get/setCachedExplanation：命中 / 不命中 / fail-open', () => {
  it('写后读命中（同 version + setupHash）', async () => {
    const redis = memRedis();
    await setCachedExplanation('v1', 'h1', '叙述串 A', { redis });
    expect(await getCachedExplanation('v1', 'h1', { redis })).toBe('叙述串 A');
  });

  it('set 带 EXPLAIN_CACHE_TTL_MS（PX）', async () => {
    const redis = memRedis();
    await setCachedExplanation('v1', 'h1', 'x', { redis });
    expect(redis.set).toHaveBeenCalledWith('mr:explain:v1:h1', 'x', 'PX', EXPLAIN_CACHE_TTL_MS);
  });

  it('不同 version 不命中', async () => {
    const redis = memRedis();
    await setCachedExplanation('v1', 'h1', 'x', { redis });
    expect(await getCachedExplanation('v2', 'h1', { redis })).toBeNull();
  });

  it('不同 setupHash 不命中', async () => {
    const redis = memRedis();
    await setCachedExplanation('v1', 'h1', 'x', { redis });
    expect(await getCachedExplanation('v1', 'h2', { redis })).toBeNull();
  });

  it('未写过 ⇒ 未命中返 null', async () => {
    expect(await getCachedExplanation('v1', 'h1', { redis: memRedis() })).toBeNull();
  });

  it('fail-open：get 抛错 ⇒ 返 null（当作未命中）', async () => {
    expect(await getCachedExplanation('v1', 'h1', { redis: throwingRedis })).toBeNull();
  });

  it('fail-open：set 抛错 ⇒ 静默不抛', async () => {
    await expect(setCachedExplanation('v1', 'h1', 'x', { redis: throwingRedis })).resolves.toBeUndefined();
  });
});

describe('withSingleFlight：进程内单飞 + settle 清键可重试', () => {
  it('并发 N 个同键 ⇒ produce 至多 1 次、其余 await 同一 promise 得同结果', async () => {
    let calls = 0;
    const produce = () => {
      calls += 1;
      return new Promise<string>((resolve) => setTimeout(() => resolve('result'), 5));
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => withSingleFlight('k', produce)));
    expect(calls).toBe(1);
    expect(results).toEqual(Array(8).fill('result'));
  });

  it('settle 后清键 ⇒ 同键再调重新 produce', async () => {
    let calls = 0;
    const produce = async () => {
      calls += 1;
      return 'v';
    };
    await withSingleFlight('k2', produce);
    await withSingleFlight('k2', produce); // 上一个已 settle+清键 ⇒ 再 produce
    expect(calls).toBe(2);
  });

  it('不同键并发各自 produce（不互相收敛）', async () => {
    let calls = 0;
    const produce = () => {
      calls += 1;
      return Promise.resolve('v');
    };
    await Promise.all([withSingleFlight('a', produce), withSingleFlight('b', produce)]);
    expect(calls).toBe(2);
  });

  it('produce 抛错 ⇒ 拒绝传播 + 清键、下次可重试', async () => {
    let calls = 0;
    const boom = async () => {
      calls += 1;
      throw new Error('produce boom');
    };
    await expect(withSingleFlight('k3', boom)).rejects.toThrow('produce boom');
    // 键已清 ⇒ 下次可重试（此次成功）。
    const ok = await withSingleFlight('k3', async () => {
      calls += 1;
      return 'recovered';
    });
    expect(ok).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('produce 抛错 ⇒ 全部并发 awaiter 同拒绝', async () => {
    const boom = () => Promise.reject(new Error('boom'));
    const settled = await Promise.allSettled([withSingleFlight('k4', boom), withSingleFlight('k4', boom)]);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
  });
});
