/**
 * env-clean `embedTextsClean` 单测（add-model-radar-assembly-deadline-cancel，组 A / task 1.3 / 见 D2）。
 *
 * 覆盖 signal 透传 + abort 不重试 + 缺省逐字节等价 + 空数组短路。全程注入 embedManyFn 桩、不触网。
 * embed-clean.ts 是 env-clean 侧（无 config/env 值 import），故可直接静态 import、无需 env 预置。
 */
import { describe, expect, it, vi } from 'vitest';
import { embedTextsClean, type EmbedCleanCredentials } from '../embed-clean.js';

const creds: EmbedCleanCredentials = {
  apiKey: 'test-key',
  baseURL: 'https://example.invalid/v1',
  model: 'text-embedding-3-small',
};

describe('embedTextsClean（signal 透传 + abort 不重试，见 D2）', () => {
  it('传 signal ⇒ 桩 args 含 abortSignal；abort 后抛且不重试（run 计数=1，maxAttempts=3）', async () => {
    const ac = new AbortController();
    ac.abort();
    const embedManyFn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(
      embedTextsClean(['a'], creds, {
        embedManyFn,
        signal: ac.signal,
        maxAttempts: 3,
        logError: () => {},
      }),
    ).rejects.toBeTruthy();
    expect(embedManyFn).toHaveBeenCalledTimes(1); // abort 不进下一 attempt
    expect(embedManyFn.mock.calls[0]![0].abortSignal).toBe(ac.signal);
  });

  it('缺省不传 signal ⇒ 桩 args 无 abortSignal 键（逐字节等价现状）', async () => {
    const embedManyFn = vi.fn().mockResolvedValue({ embeddings: [[1, 2]] });
    const out = await embedTextsClean(['a'], creds, { embedManyFn, logError: () => {} });
    expect(out).toEqual([[1, 2]]);
    expect(embedManyFn).toHaveBeenCalledTimes(1);
    expect('abortSignal' in embedManyFn.mock.calls[0]![0]).toBe(false);
  });

  it('空数组仍直接返 []（即便传 signal 也不发起调用）', async () => {
    const embedManyFn = vi.fn();
    const out = await embedTextsClean([], creds, {
      embedManyFn,
      signal: new AbortController().signal,
    });
    expect(out).toEqual([]);
    expect(embedManyFn).not.toHaveBeenCalled();
  });
});
