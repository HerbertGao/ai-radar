/**
 * 模板解释层 v1 回归钉（add-model-radar-recommender-rag-explanation 5e / task 1.3）。
 *
 * 不变量：`renderTemplate` **忽略 `evidence`**——带 `evidence` 与不带时，逐字节输出相同。
 * 守住「模板层 = v1 兜底、v2 定型 evidence 不改模板行为」的降级链前提（design D5：回落恒返回 renderTemplate 原值）。
 * 纯函数、无 DB/LLM。
 */
import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../explain.js';
import type { ExplanationInput, RankedCandidate, RecommendEvidence } from '../schema.js';

const candidate: RankedCandidate = {
  planId: 'p1',
  vendorName: 'Vendor A',
  name: 'GLM-4.6 Coding Plan',
  monthlyCost: 49,
  currency: 'CNY',
  priceStatus: 'known',
  availability: 'on_sale',
  stale: false,
  fitsWindow: 'unknown',
  verdict: 'primary',
  reasons: [
    { kind: 'primary_cheapest', detail: '同币种 eligible 中最低月价' },
    { kind: 'pending_review', detail: '有一条待复核事实' },
  ],
  provenance: {
    sourceUrl: 'https://example.com/pricing',
    sourceConfidence: 'official_pricing',
    lastCheckedDate: '2026-06-20',
  },
};

const base: ExplanationInput = {
  query: { currency: 'CNY', usageProfile: 'medium' },
  candidates: [candidate],
};

const evidence: RecommendEvidence = {
  kbHits: [{ docId: 'd1', planId: 'p1', title: '深度评测', url: 'https://kb.example.com/a', cosine: 0.71 }],
  priceChanges: [
    { planId: 'p1', vendorName: 'Vendor A', planName: 'GLM-4.6 Coding Plan', from: '39', to: '49', currency: 'CNY', changedAt: '2026-07-01' },
  ],
  pendingReview: ['GLM-4.6 Coding Plan'],
};

describe('renderTemplate 忽略 evidence（v1 兜底不变）', () => {
  it('带 evidence 与不带 evidence 输出逐字节相同', async () => {
    const withoutEvidence = await renderTemplate(base);
    const withEvidence = await renderTemplate({ ...base, evidence });
    expect(withEvidence).toBe(withoutEvidence);
  });

  it('三空数组 evidence 亦与不带相同（装配过但无证据的路径）', async () => {
    const empty: RecommendEvidence = { kbHits: [], priceChanges: [], pendingReview: [] };
    const withoutEvidence = await renderTemplate(base);
    const withEmpty = await renderTemplate({ ...base, evidence: empty });
    expect(withEmpty).toBe(withoutEvidence);
  });
});
