/**
 * acquireDigestLock 看门狗丢锁感知单测（Codex C3）：续租 Lua 返 0（令牌不匹配/键已不存在）
 * 时，锁句柄须把 isHeld() 从 true 翻成 false，让调用方在 dispatch 前据此中止，避免双发。
 * 用注入的内存 RedisLike 桩 + fake timers 驱动看门狗，无需真实 Redis。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDigestLock, type RedisLike } from '../lock.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 可控返回值的 RedisLike 桩：set 永远成功获锁，eval 返回 evalResult。 */
function makeRedis(evalResult: number): RedisLike {
  return {
    set: () => Promise.resolve('OK'),
    eval: () => Promise.resolve(evalResult),
  };
}

describe('acquireDigestLock 丢锁感知', () => {
  it('续租 Lua 返 0（锁被抢占/过期）→ isHeld() 由 true 变 false 并停续租', async () => {
    const redis = makeRedis(0);
    const lock = await acquireDigestLock('2099-01-09', {
      redis,
      ttlMs: 30_000,
      renewIntervalMs: 100,
    });
    expect(lock).not.toBeNull();
    expect(lock!.isHeld()).toBe(true);

    // 推进到首次续租并让其 promise 落地。
    await vi.advanceTimersByTimeAsync(100);

    expect(lock!.isHeld()).toBe(false);
    await lock!.release();
  });

  it('续租 Lua 返 1（成功）→ isHeld() 保持 true', async () => {
    const redis = makeRedis(1);
    const lock = await acquireDigestLock('2099-01-10', {
      redis,
      ttlMs: 30_000,
      renewIntervalMs: 100,
    });
    expect(lock).not.toBeNull();

    await vi.advanceTimersByTimeAsync(100);

    expect(lock!.isHeld()).toBe(true);
    await lock!.release();
  });

  it('release 后 isHeld() 为 false', async () => {
    const redis = makeRedis(1);
    const lock = await acquireDigestLock('2099-01-11', {
      redis,
      ttlMs: 30_000,
      renewIntervalMs: 0,
    });
    expect(lock!.isHeld()).toBe(true);
    await lock!.release();
    expect(lock!.isHeld()).toBe(false);
  });
});
