/**
 * 三档抓取编排单测（task 7.5，design D7）。注入 fetch/compare 桩，不触网/不连 DB。
 * 覆盖：manual 不发请求 + http 走 fetch + 真变才打标（compare 收到的指纹随内容变）+ robots 禁则不抓。
 */
import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { detectSourceChange, fingerprint } = await import('../fingerprint.js');

const fakeDb = {} as never;

describe('detectSourceChange 编排', () => {
  it('manual 档不发请求、不打标（skipped）', async () => {
    const fetchHttp = vi.fn();
    const compareFn = vi.fn();
    const out = await detectSourceChange(
      fakeDb,
      { id: 's1', sourceUrl: 'https://openai.com/x', fetchStrategy: 'manual' },
      { fetchHttp, compareFn, writeSnapshotFile: false },
    );
    expect(out).toEqual({ outcome: 'skipped' });
    expect(fetchHttp).not.toHaveBeenCalled();
    expect(compareFn).not.toHaveBeenCalled();
  });

  it('http 档走 fetch + compare 收到内容指纹', async () => {
    const fetchHttp = vi.fn(async () => '<html>Price $20/mo</html>');
    const compareFn = vi.fn(async () => ({ outcome: 'changed', flaggedPlans: 2 }) as const);
    const out = await detectSourceChange(
      fakeDb,
      { id: 's2', sourceUrl: 'https://openai.com/pricing', fetchStrategy: 'http' },
      { fetchHttp, compareFn, writeSnapshotFile: false },
    );
    expect(out).toEqual({ outcome: 'changed', flaggedPlans: 2 });
    expect(fetchHttp).toHaveBeenCalledOnce();
    // compare 收到的指纹 = sha256(归一价格区域文本)。
    const region = 'price $20/mo';
    expect(compareFn).toHaveBeenCalledWith(fakeDb, 's2', fingerprint(region), expect.any(String));
  });

  it('内容变 → 指纹随之变（真变才会被 compare 判打标）', async () => {
    const compareFn = vi.fn(async () => ({ outcome: 'unchanged' }) as const);
    await detectSourceChange(
      fakeDb,
      { id: 's3', sourceUrl: 'https://openai.com/p', fetchStrategy: 'http' },
      { fetchHttp: async () => '<b>$10</b>', compareFn, writeSnapshotFile: false },
    );
    await detectSourceChange(
      fakeDb,
      { id: 's3', sourceUrl: 'https://openai.com/p', fetchStrategy: 'http' },
      { fetchHttp: async () => '<b>$11</b>', compareFn, writeSnapshotFile: false },
    );
    const calls = compareFn.mock.calls as unknown as unknown[][];
    const fp1 = calls[0]![2];
    const fp2 = calls[1]![2];
    expect(fp1).not.toBe(fp2); // 内容不同 → 指纹不同（compare 据此判真变打标）。
  });

  it('robots 桩禁则不抓（skipped）', async () => {
    const fetchHttp = vi.fn();
    const out = await detectSourceChange(
      fakeDb,
      { id: 's4', sourceUrl: 'https://openai.com/secret', fetchStrategy: 'http' },
      {
        fetchHttp,
        robotsCheck: async () => false, // robots 禁。
        compareFn: vi.fn(),
        writeSnapshotFile: false,
      },
    );
    expect(out).toEqual({ outcome: 'skipped' });
    expect(fetchHttp).not.toHaveBeenCalled();
  });

  it('截断 fetch 返回 null body → skipped，不更新 fingerprint', async () => {
    const fetchHttp = vi.fn(async () => null);
    const compareFn = vi.fn();
    const out = await detectSourceChange(
      fakeDb,
      { id: 's-truncated', sourceUrl: 'https://openai.com/pricing', fetchStrategy: 'http' },
      {
        fetchHttp,
        compareFn,
        writeSnapshotFile: false,
      },
    );

    expect(out).toEqual({ outcome: 'skipped' });
    expect(fetchHttp).toHaveBeenCalledOnce();
    expect(compareFn).not.toHaveBeenCalled();
  });

  it('200 登录墙/验证码页 → 不更新指纹 + 给 source 打标（blocked，不误报「变了」）', async () => {
    const compareFn = vi.fn();
    const flagSourceFn = vi.fn(async () => {});
    const out = await detectSourceChange(
      fakeDb,
      { id: 's-blocked', sourceUrl: 'https://openai.com/pricing', fetchStrategy: 'http' },
      {
        fetchHttp: async () =>
          '<html><body>请完成安全验证：拖动滑块完成人机验证</body></html>',
        compareFn,
        flagSourceFn,
        writeSnapshotFile: false,
      },
    );
    expect(out).toEqual({ outcome: 'blocked' });
    expect(compareFn).not.toHaveBeenCalled(); // 指纹链不跑 → content_fingerprint 不更新。
    expect(flagSourceFn).toHaveBeenCalledWith(
      fakeDb,
      { targetType: 'source', targetId: 's-blocked' },
      expect.any(String),
    );
  });

  it('blocked 页下轮抓到真内容 → 正常比对（compare 被调）', async () => {
    const compareFn = vi.fn(async () => ({ outcome: 'changed', flaggedPlans: 1 }) as const);
    const flagSourceFn = vi.fn(async () => {});
    // 上一轮：登录墙 → blocked，不比对。
    await detectSourceChange(
      fakeDb,
      { id: 's6', sourceUrl: 'https://openai.com/p', fetchStrategy: 'http' },
      {
        fetchHttp: async () => 'captcha: verify you are human',
        compareFn,
        flagSourceFn,
        writeSnapshotFile: false,
      },
    );
    expect(compareFn).not.toHaveBeenCalled();
    // 下一轮：真内容 → 正常比对。
    const out = await detectSourceChange(
      fakeDb,
      { id: 's6', sourceUrl: 'https://openai.com/p', fetchStrategy: 'http' },
      {
        fetchHttp: async () => '<html>Price $20/mo</html>',
        compareFn,
        flagSourceFn,
        writeSnapshotFile: false,
      },
    );
    expect(out).toEqual({ outcome: 'changed', flaggedPlans: 1 });
    expect(compareFn).toHaveBeenCalledOnce();
  });

  it('普通价页含导航「登录」链接 → 不误判 blocked（calibration：短语级标记）', async () => {
    const compareFn = vi.fn(async () => ({ outcome: 'unchanged' }) as const);
    const flagSourceFn = vi.fn();
    const out = await detectSourceChange(
      fakeDb,
      { id: 's7', sourceUrl: 'https://openai.com/pricing', fetchStrategy: 'http' },
      {
        fetchHttp: async () =>
          '<nav><a>登录</a><a>注册</a></nav><h1>Pricing</h1> $20/mo',
        compareFn,
        flagSourceFn,
        writeSnapshotFile: false,
      },
    );
    expect(out).toEqual({ outcome: 'unchanged' });
    expect(compareFn).toHaveBeenCalledOnce();
    expect(flagSourceFn).not.toHaveBeenCalled();
  });

  it('未知 fetchStrategy → fail-closed skipped，不发请求（纵深防御，非落 http）', async () => {
    const fetchHttp = vi.fn();
    const fetchBrowser = vi.fn();
    const compareFn = vi.fn();
    const out = await detectSourceChange(
      fakeDb,
      { id: 's-unknown', sourceUrl: 'https://openai.com/p', fetchStrategy: 'graphql' },
      { fetchHttp, fetchBrowser, compareFn, writeSnapshotFile: false },
    );
    expect(out).toEqual({ outcome: 'skipped' });
    expect(fetchHttp).not.toHaveBeenCalled();
    expect(fetchBrowser).not.toHaveBeenCalled();
    expect(compareFn).not.toHaveBeenCalled();
  });

  it('browser 档无注入 fetchBrowser → skipped（隔离 playwright）', async () => {
    const out = await detectSourceChange(
      fakeDb,
      { id: 's5', sourceUrl: 'https://openai.com/p', fetchStrategy: 'browser' },
      { writeSnapshotFile: false },
    );
    expect(out).toEqual({ outcome: 'skipped' });
  });
});
