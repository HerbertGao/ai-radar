/**
 * 组 D（add-model-radar-explain-public-cost-bound / task 4.2）：web `llm` 解释路径**成本边界接线**集成测。
 *
 * 经 `createModelRadarWebApp` 的第三参 `deps` 注入内存缓存桩 / canned daily-cap 结果 / reject 桩（不触真
 * Redis），配合真 `buildExplainer`（`generateObjectFn`/`assembleEvidence` mock、hooks 由页面接线透传）驱动：
 * 缓存命中/未命中、cap 触顶两态、空证据不计配额、单飞收敛、顶层兜底 fail-open 页恒 200、默认 template 零边界。
 *
 * 静态导入链 cache→db→env 在 import 时校验 env → 先设占位、再动态 import 页面（镜像 explain-wiring.test.ts）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExplainer, type BuildExplainerOptions } from '../../recommend/explain-llm.js';
import type { RecommendEvidence } from '../../recommend/schema.js';
import type { DailyCapResult } from '../../../rag/daily-cap.js';
import type { ExplainerFactory, SnapshotProvider } from '../model-radar-page.js';
import { known, provider, snap } from './fixtures.js';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

// 桩控 assembleEvidence（同 explain-wiring.test.ts）：驱动「证据空/非空」分支而不触真 KB/价格 SQL。
vi.mock('../../recommend/evidence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../recommend/evidence.js')>()),
  assembleEvidence: vi.fn(),
}));
const { assembleEvidence } = await import('../../recommend/evidence.js');
const mockedAssemble = vi.mocked(assembleEvidence);

const { createModelRadarWebApp } = await import('../model-radar-page.js');

afterEach(() => {
  vi.clearAllMocks();
});

/** 守卫可过的叙述（数字 25/30 均在 priceEvidence 白名单、无结论词、无 URL、无 [n]）。 */
const NARRATIVE = '最近价格从 25 调整到 30 供你参考。';

/** 非空证据（priceChanges 单行）⇒ explainer 走 LLM 路径、触发 beforeLlmCall gate。 */
const priceEvidence: RecommendEvidence = {
  kbHits: [],
  priceChanges: [
    { planId: 'Alpha', vendorName: 'Vendor 1', planName: 'Alpha', from: '25', to: '30', currency: 'CNY', changedAt: '2026-07-01' },
  ],
  pendingReview: [],
};
const emptyEvidence: RecommendEvidence = { kbHits: [], priceChanges: [], pendingReview: [] };

/** llm explainerFactory：真 buildExplainer + mock LLM，**透传页面接线的 hooks**（onRender/beforeLlmCall）。 */
function llmFactory(narrative: string, onLlm?: () => void): ExplainerFactory {
  return (hooks) =>
    buildExplainer({
      credentials: { apiKey: 'k', baseUrl: 'https://ex.com/v1', model: 'chat-m' },
      dbh: {} as BuildExplainerOptions['dbh'],
      embed: async () => [[1]],
      log: () => {},
      generateObjectFn: async () => {
        onLlm?.();
        return { object: { narrative } };
      },
      ...hooks,
    });
}

/** 内存缓存桩（Map 背书，spy 计数）。 */
function memCache() {
  const store = new Map<string, string>();
  const getCached = vi.fn(async (v: string, h: string) => store.get(`${v}:${h}`) ?? null);
  const setCached = vi.fn(async (v: string, h: string, e: string) => {
    store.set(`${v}:${h}`, e);
  });
  return { store, getCached, setCached };
}

/** canned daily-cap 结果桩（计调用次数）。 */
function cannedCap(result: DailyCapResult) {
  return vi.fn(async () => result);
}

/** 从页面 HTML 抽出引擎完整说明串（`<div class="explanation-body">…</div>`，render_now-free）。 */
function explanationOf(html: string): string {
  const m = html.match(/<div class="explanation-body">([\s\S]*?)<\/div>/);
  if (!m) throw new Error('explanation-body 未找到');
  return m[1]!;
}

/** 同一 snapshot/request 下的 template 基线 explanation（explainerFactory 恒返 undefined ⇒ 纯模板、无 llm 解释）。 */
async function templateExplanationOf(getSnapshot: SnapshotProvider): Promise<string> {
  const app = createModelRadarWebApp(getSnapshot, () => undefined);
  return explanationOf(await (await app.request('/model-radar')).text());
}

describe('4.2 缓存命中：同 setup 二次请求命中缓存、零 LLM、零装配、不计 cap', () => {
  it('首次 miss 装配+LLM+写缓存；二次 hit 注入 ()=>cached、不调 LLM/不装配/不 gate', async () => {
    mockedAssemble.mockResolvedValue(priceEvidence);
    const cache = memCache();
    let llmCalls = 0;
    const checkCap = cannedCap({ allowed: true, count: 1 });
    const app = createModelRadarWebApp(
      provider(snap(known('Alpha', '30', 'CNY'))),
      llmFactory(NARRATIVE, () => (llmCalls += 1)),
      { getCached: cache.getCached, setCached: cache.setCached, checkCap },
    );

    const r1 = await app.request('/model-radar');
    expect(r1.status).toBe(200);
    expect(llmCalls).toBe(1);
    expect(mockedAssemble).toHaveBeenCalledTimes(1);
    expect(cache.setCached).toHaveBeenCalledTimes(1); // renderedBy==='llm' ⇒ 写缓存
    expect(checkCap).toHaveBeenCalledTimes(1); // 证据非空 ⇒ gate 一次

    const r2 = await app.request('/model-radar');
    expect(r2.status).toBe(200);
    expect(llmCalls).toBe(1); // 命中 ⇒ 无新 LLM
    expect(mockedAssemble).toHaveBeenCalledTimes(1); // 命中 ⇒ 无新装配
    expect(checkCap).toHaveBeenCalledTimes(1); // 命中经平凡 explainer ⇒ 不触 gate、不计 cap
    expect(cache.setCached).toHaveBeenCalledTimes(1); // 不双写
  });
});

describe('4.2 guidance 非空场景：命中路径 explanation 与首次 miss 逐字节相等（缓存串不含 guidance、不双写）', () => {
  it('他币种 guidance：被缓存串仅 explainer 返回（无 guidance）、命中重拼 guidance 一次', async () => {
    mockedAssemble.mockResolvedValue(priceEvidence);
    const cache = memCache();
    const app = createModelRadarWebApp(
      provider(snap(known('Alpha', '30', 'USD'))), // USD plan + 默认 CNY 查询 ⇒ 无 primary、他币种 guidance 非空
      llmFactory(NARRATIVE),
      { getCached: cache.getCached, setCached: cache.setCached, checkCap: cannedCap({ allowed: true, count: 1 }) },
    );

    const exp1 = explanationOf(await (await app.request('/model-radar?currency=CNY')).text());
    const exp2 = explanationOf(await (await app.request('/model-radar?currency=CNY')).text());

    expect(exp2).toBe(exp1); // 逐字节相等（缓存串不含 guidance ⇒ 命中不双写）
    expect(exp1).toContain('他币种'); // guidance 确在渲染串
    expect((exp2.match(/他币种/g) ?? []).length).toBe(1); // guidance 恰一次（若误缓存 result.explanation 则为 2）

    const cached = [...cache.store.values()][0]!;
    expect(cached).not.toContain('他币种'); // 被缓存串 = explainer 返回、不含 guidance
    expect(cached).not.toContain('未找到 CNY 币种候选');
  });
});

describe('4.2 空证据不占配额：三源全空 ⇒ beforeLlmCall 未触发、不 INCR mr 配额', () => {
  it('assembleEvidence 空 ⇒ explainer 早返 template、checkCap 零调用、零 LLM、不写缓存', async () => {
    mockedAssemble.mockResolvedValue(emptyEvidence);
    const cache = memCache();
    let llmCalls = 0;
    const checkCap = cannedCap({ allowed: true, count: 1 });
    const app = createModelRadarWebApp(
      provider(snap(known('Alpha', '30', 'CNY'))),
      llmFactory(NARRATIVE, () => (llmCalls += 1)),
      { getCached: cache.getCached, setCached: cache.setCached, checkCap },
    );

    const res = await app.request('/model-radar');
    expect(res.status).toBe(200);
    expect(checkCap).not.toHaveBeenCalled(); // gate 在三源全空早返之后 ⇒ 不触发、不占配额
    expect(llmCalls).toBe(0);
    expect(cache.setCached).not.toHaveBeenCalled(); // renderedBy='template' ⇒ 不写
  });
});

describe('4.2 cap 触顶 / 两态 reason：fail-open 回落模板、页 200、两态分别记日志', () => {
  it('quota-exceeded ⇒ 跳过 LLM、页 200、warn 记 quota-exceeded', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedAssemble.mockResolvedValue(priceEvidence);
    const cache = memCache();
    let llmCalls = 0;
    const app = createModelRadarWebApp(
      provider(snap(known('Alpha', '30', 'CNY'))),
      llmFactory(NARRATIVE, () => (llmCalls += 1)),
      {
        getCached: cache.getCached,
        setCached: cache.setCached,
        checkCap: cannedCap({ allowed: false, count: 201, reason: 'quota-exceeded' }),
      },
    );

    const res = await app.request('/model-radar');
    expect(res.status).toBe(200); // fail-open：恒可用、不拒服务
    expect(llmCalls).toBe(0); // gate 拒 ⇒ 跳过 LLM
    expect(cache.setCached).not.toHaveBeenCalled(); // llm-fallback-template ⇒ 不写
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('quota-exceeded'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('infra-error（Redis 不可用）⇒ 跳过 LLM、页 200、warn 记 infra-error（可用性降级、非成本放大）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedAssemble.mockResolvedValue(priceEvidence);
    const cache = memCache();
    let llmCalls = 0;
    const app = createModelRadarWebApp(
      provider(snap(known('Alpha', '30', 'CNY'))),
      llmFactory(NARRATIVE, () => (llmCalls += 1)),
      {
        getCached: cache.getCached,
        setCached: cache.setCached,
        checkCap: cannedCap({ allowed: false, count: null, reason: 'infra-error' }),
      },
    );

    const res = await app.request('/model-radar');
    expect(res.status).toBe(200);
    expect(llmCalls).toBe(0);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('infra-error'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('4.2 Redis 不可用整体 fail-open：缓存未命中 + gate infra-error ⇒ 模板、页 200', () => {
  it('getCached 恒 null（fail-open 语义）+ checkCap infra-error ⇒ 页 200、模板答案卡', async () => {
    mockedAssemble.mockResolvedValue(priceEvidence);
    const app = createModelRadarWebApp(provider(snap(known('Alpha', '30', 'CNY'))), llmFactory(NARRATIVE), {
      getCached: async () => null,
      setCached: async () => {},
      checkCap: cannedCap({ allowed: false, count: null, reason: 'infra-error' }),
    });
    const res = await app.request('/model-radar');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('class="answer-card"');
  });
});

describe('4.2 顶层兜底 fail-open：缓存读/produce/注入 explainer 任一 reject ⇒ 页 200 + 模板（非 500）', () => {
  it('缓存读 reject ⇒ 兜底回落模板、页 200、记错', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedAssemble.mockResolvedValue(priceEvidence);
    const app = createModelRadarWebApp(provider(snap(known('Alpha', '30', 'CNY'))), llmFactory(NARRATIVE), {
      getCached: async () => {
        throw new Error('redis read boom');
      },
      checkCap: cannedCap({ allowed: true, count: 1 }),
    });
    const res = await app.request('/model-radar');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="answer-card"');
    // 兜底回落必须逐字节等于纯 template 基线（`answer-card` 与解释内容无关；此断言落实「回落默认模板」契约）。
    expect(explanationOf(html)).toBe(await templateExplanationOf(provider(snap(known('Alpha', '30', 'CNY')))));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('注入 explainer / produce reject ⇒ 兜底回落模板、页 200、记错', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwingFactory: ExplainerFactory = () => async () => {
      throw new Error('explainer boom');
    };
    const app = createModelRadarWebApp(provider(snap(known('Alpha', '30', 'CNY'))), throwingFactory, {
      getCached: async () => null,
      setCached: async () => {},
      checkCap: cannedCap({ allowed: true, count: 1 }),
    });
    const res = await app.request('/model-radar');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="answer-card"');
    // 兜底回落必须逐字节等于纯 template 基线（`answer-card` 与解释内容无关；此断言落实「回落默认模板」契约）。
    expect(explanationOf(html)).toBe(await templateExplanationOf(provider(snap(known('Alpha', '30', 'CNY')))));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('4.2 单飞：并发同 setup 首请求经进程内单飞、至多 1 次 LLM', () => {
  it('N 个并发首请求（同 version+setupHash）⇒ 至多 1 次 generateObject、1 次装配', async () => {
    mockedAssemble.mockResolvedValue(priceEvidence);
    const cache = memCache(); // getCached 恒 miss（并发首批未写入）
    let llmCalls = 0;
    const app = createModelRadarWebApp(
      provider(snap(known('Alpha', '30', 'CNY'))),
      llmFactory(NARRATIVE, () => (llmCalls += 1)),
      { getCached: cache.getCached, setCached: cache.setCached, checkCap: cannedCap({ allowed: true, count: 1 }) },
    );

    const results = await Promise.all([0, 1, 2, 3].map(() => app.request('/model-radar')));
    for (const r of results) expect(r.status).toBe(200);
    expect(llmCalls).toBe(1); // 单飞收敛：至多 1 次真 LLM
    expect(mockedAssemble).toHaveBeenCalledTimes(1); // 至多 1 次装配
  });
});

describe('4.2 默认 template：工厂 undefined ⇒ 零缓存 / 零 cap / 零装配', () => {
  it('工厂返回 undefined ⇒ getCached/setCached/checkCap 均零调用、assembleEvidence 未触发、页 200', async () => {
    const cache = memCache();
    const checkCap = cannedCap({ allowed: true, count: 1 });
    const app = createModelRadarWebApp(provider(snap(known('Alpha', '30', 'CNY'))), () => undefined, {
      getCached: cache.getCached,
      setCached: cache.setCached,
      checkCap,
    });
    const res = await app.request('/model-radar');
    expect(res.status).toBe(200);
    expect(cache.getCached).not.toHaveBeenCalled();
    expect(cache.setCached).not.toHaveBeenCalled();
    expect(checkCap).not.toHaveBeenCalled();
    expect(mockedAssemble).not.toHaveBeenCalled();
  });
});
