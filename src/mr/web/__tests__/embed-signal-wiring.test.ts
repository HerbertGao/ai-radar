/**
 * 组 D（add-model-radar-assembly-deadline-cancel / task 4.2 web 侧）：默认解释层工厂注入的 embed lambda
 * 的 signal 转发验收。
 *
 * 默认工厂（`MR_RECOMMEND_EXPLAIN==='llm'`）把 `(texts, signal) => embedTexts(texts, { signal })` 作 embed
 * 注入 buildExplainer。此处 mock buildExplainer（捕获注入的 embed）+ mock embedTexts（监视转发形状）：
 * - 缺省路径（searchKbCore 不传 signal）⇒ lambda 收 undefined ⇒ 条件展开省去 signal 键 ⇒ embedTexts 收 `{}`
 *   ⇒ 底层 abortSignal 不出现（组 A 已证）⇒ 逐字节等价现状。
 * - 真取消路径（传入 signal）⇒ 原样转发（装配超时 ac.abort() 经此中止 web embed）。
 *
 * 页面静态导入链 cache→db→env 在 import 时校验 env——先设占位（含 MR_RECOMMEND_EXPLAIN=llm 使默认工厂构造）、
 * 再动态 import 页面（镜像 explain-wiring.test.ts）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { known, provider, snap } from './fixtures.js';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_BASE_URL ||= 'https://ex.com/v1';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.EMBEDDING_MODEL ||= 'text-embedding-3-small';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
// 默认解释层工厂仅在 MR_RECOMMEND_EXPLAIN==='llm' 时构造 explainer（并注入 embed lambda）——本测须开。
process.env.MR_RECOMMEND_EXPLAIN = 'llm';

// mock buildExplainer：捕获默认工厂注入的 embed lambda（返回 stub explainer，页面照常 200、不触真装配）。
vi.mock('../../recommend/explain-llm.js', () => ({
  buildExplainer: vi.fn(() => async () => 'MOCK_NARRATIVE'),
}));
import { buildExplainer } from '../../recommend/explain-llm.js';
const mockedBuildExplainer = vi.mocked(buildExplainer);

// mock embedTexts：监视 web 装配 embed lambda 的 signal 转发形状（真实 embedding 从不被调用）。
vi.mock('../../../dedup/embedding.js', () => ({
  embedTexts: vi.fn(async () => [[1]]),
}));
import { embedTexts } from '../../../dedup/embedding.js';
const mockedEmbedTexts = vi.mocked(embedTexts);

const { createModelRadarWebApp } = await import('../model-radar-page.js');

afterEach(() => {
  vi.clearAllMocks();
});

describe('4.2 web 默认工厂注入的 embed lambda：signal 转发（缺省 undefined ⇒ 无 abortSignal 逐字节不变、传入 ⇒ 转发 { signal }）', () => {
  it('请求 /model-radar（默认工厂、llm 模式）⇒ 捕获注入 buildExplainer 的 embed lambda 并验转发', async () => {
    // 不传第二参 ⇒ 用默认工厂（defaultExplainerFactory）；getCached=miss 保 hermetic（不触真 Redis）。
    const app = createModelRadarWebApp(provider(snap(known('Alpha', '30', 'CNY'))), undefined, {
      getCached: async () => null,
    });
    const res = await app.request('/model-radar');
    expect(res.status).toBe(200);
    expect(mockedBuildExplainer).toHaveBeenCalledTimes(1);

    const embed = mockedBuildExplainer.mock.calls[0]![0].embed;

    // 缺省路径：signal=undefined ⇒ 条件展开省去 signal 键 ⇒ embedTexts 收 {}（同原 `embedTexts(texts)` 的默认
    // options={}）⇒ abortSignal 不出现（组 A 已证）⇒ 逐字节等价现状。
    await embed(['t'], undefined);
    expect(mockedEmbedTexts).toHaveBeenCalledWith(['t'], {});

    // 真取消路径：传入 signal ⇒ 原样转发（装配超时 ac.abort() 经此中止 web embed）。
    const ac = new AbortController();
    await embed(['t2'], ac.signal);
    expect(mockedEmbedTexts).toHaveBeenLastCalledWith(['t2'], { signal: ac.signal });
  });
});
