/**
 * daily-cap namespace + reason 扩展单测（add-model-radar-explain-public-cost-bound task 1.4 / design D3）——
 * 全部 no-network：注入内存/抛错 Redis 桩，不触真 Redis。
 *
 * 覆盖：
 * - dailyCapKey：无参默认 namespace='rag'（`rag:llmcalls:<date>`，advisor 逐字节不变）、显式 'mr' 键。
 * - checkAndBumpDailyCap：`mr` 与 `rag` 独立计数、独立 cap（mr cap=3 触顶不影响 rag）。
 * - reason 两态：超限 ⇒ 'quota-exceeded'；Redis 抛错 ⇒ 'infra-error'（count=null）；放行时 undefined。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

let dailyCapKey: typeof import('../daily-cap.js').dailyCapKey;
let checkAndBumpDailyCap: typeof import('../daily-cap.js').checkAndBumpDailyCap;

beforeAll(async () => {
  // daily-cap.ts import env（dotenv/config 校验）；无 .env 的 CI 兜底最小 env，有 .env 时 ||= 不覆盖。
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  ({ dailyCapKey, checkAndBumpDailyCap } = await import('../daily-cap.js'));
});

/** 每 namespace 独立计数的内存 Redis 桩（键含 namespace ⇒ 天然隔离；暴露 store 供键隔离断言）。 */
function memRedis(store: Record<string, number> = {}) {
  return {
    incr: async (k: string) => (store[k] = (store[k] ?? 0) + 1),
    expire: vi.fn(async () => 1),
    store,
  };
}

const FIXED = () => new Date('2026-07-17T00:00:00Z');

describe('dailyCapKey namespace', () => {
  it('无参默认 rag（advisor 逐字节不变）', () => {
    expect(dailyCapKey(FIXED())).toBe('rag:llmcalls:2026-07-17');
  });
  it('显式 mr namespace', () => {
    expect(dailyCapKey(FIXED(), 'mr')).toBe('mr:llmcalls:2026-07-17');
  });
});

describe('checkAndBumpDailyCap：mr / rag 独立计数、独立 cap', () => {
  it('mr cap=3 触顶时 rag 不受影响（独立键、独立 cap 值）', async () => {
    const redis = memRedis();
    const mr = { namespace: 'mr', cap: 3, redis, now: FIXED } as const;
    // mr 打满 cap=3：前 3 次放行、第 4 次越限。
    expect((await checkAndBumpDailyCap(mr)).allowed).toBe(true); // 1
    expect((await checkAndBumpDailyCap(mr)).allowed).toBe(true); // 2
    expect((await checkAndBumpDailyCap(mr)).allowed).toBe(true); // 3
    const mr4 = await checkAndBumpDailyCap(mr);
    expect(mr4.allowed).toBe(false);
    expect(mr4.reason).toBe('quota-exceeded');

    // 同一内存 Redis，rag namespace 独立键、独立 cap=5，不受 mr 触顶影响。
    const rag = await checkAndBumpDailyCap({ namespace: 'rag', cap: 5, redis, now: FIXED });
    expect(rag.allowed).toBe(true);
    expect(rag.count).toBe(1); // rag 键从 0 起计，未被 mr 的 4 次污染

    // 键隔离核对。
    expect(redis.store['mr:llmcalls:2026-07-17']).toBe(4);
    expect(redis.store['rag:llmcalls:2026-07-17']).toBe(1);
  });
});

describe('reason 两态', () => {
  it('超限 ⇒ reason=quota-exceeded（count 仍带回）', async () => {
    const deps = { namespace: 'mr', cap: 1, redis: memRedis(), now: FIXED } as const;
    expect((await checkAndBumpDailyCap(deps)).allowed).toBe(true); // 1 <= 1
    const over = await checkAndBumpDailyCap(deps); // 2 > 1
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe('quota-exceeded');
    expect(over.count).toBe(2);
  });

  it('Redis 抛错 ⇒ {allowed:false, reason:infra-error, count:null}', async () => {
    const redis = {
      incr: async () => {
        throw new Error('redis down');
      },
      expire: async () => 1,
    };
    const r = await checkAndBumpDailyCap({ namespace: 'mr', cap: 100, redis });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('infra-error');
    expect(r.count).toBeNull();
  });

  it('放行时无 reason（allowed=true ⇒ reason undefined）', async () => {
    const r = await checkAndBumpDailyCap({ namespace: 'mr', cap: 100, redis: memRedis(), now: FIXED });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});
