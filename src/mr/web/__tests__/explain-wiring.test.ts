/**
 * 组 D（add-model-radar-recommender-rag-explanation / task 4.4 web 侧）：解释层装配的 Web 集成测。
 *
 * 经 `createModelRadarWebApp` 的第二参 `explainerFactory` 注入驱动三条路径（全合成、不触 DB/Redis）：
 * - **llm 成功**：注入「真 `buildExplainer` + mock `generateObjectFn` + mock `assembleEvidence`」的 explainer →
 *   页面 explanation = 模板段 + 叙述段 + 参考清单，且**断言装配确实发生**（`assembleEvidence` 被调用、其 kbHits
 *   经参考清单流入叙述子渲染）。
 * - **构造抛错 fail-open**：工厂 throw ⇒ 页仍 200、走模板层、记错（不 500、不使公开页失败）。
 * - **模板模式（工厂返回 undefined）**：`recommend()` 无第三参、零证据装配、零 LLM。
 *
 * `assembleEvidence` 经 `vi.mock` 桩控其返回（免去 mock drizzle db/embed 的复杂度，直接验「装配结果 → 渲染」通道）。
 * 页面静态导入链 cache→db→env 在 import 时校验 env——先设占位、再动态 import 页面（镜像 page.test.ts）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExplainer, type BuildExplainerOptions } from '../../recommend/explain-llm.js';
import type { Explainer, RecommendEvidence } from '../../recommend/schema.js';
import { known, provider, snap } from './fixtures.js';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

// 桩控 assembleEvidence（explain-llm.js 从 ./evidence.js 值 import 它）：验「装配结果 → 叙述子渲染」通道，
// 不触真 KB 检索 / 价格 SQL。template 模式测试恒不触发装配 → 桩对其惰性。
// 经 importOriginal 保留 evidence.js 其余真实导出（explain-llm 亦从此 import safeLog / PRICE_CHANGE_WINDOW_DAYS），
// 仅替换 assembleEvidence。
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

describe('4.4 web llm 路径：模板段 + 叙述段 + 参考清单，且装配确实发生', () => {
  it('注入 explainer（真 buildExplainer + mock LLM + mock 装配）⇒ 页 explanation 含叙述段与参考清单标题', async () => {
    const evidence: RecommendEvidence = {
      kbHits: [{ docId: 'd1', planId: 'Alpha', title: 'Alpha 更新说明', url: 'https://ex.com/a', cosine: 0.9 }],
      priceChanges: [
        { planId: 'Alpha', vendorName: 'Vendor 1', planName: 'Alpha', from: '25', to: '30', currency: 'CNY', changedAt: '2026-07-01' },
      ],
      pendingReview: [],
    };
    mockedAssemble.mockResolvedValue(evidence);

    const opts: BuildExplainerOptions = {
      credentials: { apiKey: 'k', baseUrl: 'https://ex.com/v1', model: 'chat-m' },
      dbh: {} as BuildExplainerOptions['dbh'], // 不触——assembleEvidence 被桩替换
      embed: async () => [[1]], // 不触——同上
      log: () => {},
      // 叙述段数字（25/30）均在白名单（价格变更 from/to）、无结论词、无 URL、[1] 合法引用 → 守卫全过。
      generateObjectFn: async () => ({ object: { narrative: '最近该方案价格从 25 调整到 30，供你参考背景。[1]' } }),
    };
    const explainer: Explainer = buildExplainer(opts);

    const app = createModelRadarWebApp(provider(snap(known('Alpha', '30', 'CNY'))), () => explainer);
    const res = await app.request('/model-radar');
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(mockedAssemble).toHaveBeenCalled(); // 装配确实发生（叙述子渲染前）
    expect(html).toContain('最近该方案价格从 25 调整到 30'); // 叙述段
    expect(html).toContain('Alpha 更新说明'); // 参考清单标题（kbHits → 装配结果流入渲染）
  });
});

describe('4.4 web 调用方构造抛错 ⇒ fail-open 模板层', () => {
  it('工厂 throw ⇒ 页仍 200、渲模板答案卡、记错、零装配（不 500、不使公开页失败）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createModelRadarWebApp(provider(snap(known('Alpha', '30', 'CNY'))), () => {
      throw new Error('construct boom');
    });
    const res = await app.request('/model-radar');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="answer-card"'); // 模板层正常渲染答案卡
    expect(errSpy).toHaveBeenCalled(); // fail-open 记错
    expect(mockedAssemble).not.toHaveBeenCalled(); // 无 explainer ⇒ 无装配
    errSpy.mockRestore();
  });
});

describe('4.4 web 默认模板（工厂返回 undefined）⇒ 零 LLM、零证据装配', () => {
  it('工厂 undefined ⇒ recommend 无第三参、assembleEvidence 不被调用、页 200', async () => {
    const app = createModelRadarWebApp(provider(snap(known('Alpha', '30', 'CNY'))), () => undefined);
    const res = await app.request('/model-radar');
    expect(res.status).toBe(200);
    expect(mockedAssemble).not.toHaveBeenCalled();
  });
});
