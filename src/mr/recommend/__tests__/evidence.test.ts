/**
 * 证据装配层单测（add-model-radar-recommender-rag-explanation 组 B / task 2.4）。
 *
 * 全经注入 mock dbh/embed——不真连 DB、不真调 embed（沿仓内注入式测试款式）。
 * 覆盖：KB 子源失败仍返回价格变更 / 全失败三空不抛 / 装配超时三空不抛 /
 *       30 天窗口边界（31 天前不入）/ cosine 地板过滤 / old_value NULL ⇒ from=null / 跨候选 docId 去重保最高 cosine。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mrPriceHistory } from '../../../db/schema.js';
import { assembleEvidence, type AssembleEvidenceDeps } from '../evidence.js';
import type { RankedCandidate } from '../schema.js';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  // searchKbCore 的逐查观测走 console.error（stderr）——测试内静默，避免噪声。
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkCandidate(over: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
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
    reasons: [],
    provenance: {
      sourceUrl: 'https://example.com/pricing',
      sourceConfidence: 'official_pricing',
      lastCheckedDate: '2026-06-20',
    },
    ...over,
  };
}

interface KbRow {
  id: string;
  kbTitle: string | null;
  summaryZh: string | null;
  entities: unknown;
  sourceUrls: unknown;
  eventDate: string | null;
  longTermValue: number | null;
  cosineSim: number;
}

function kbRow(over: Partial<KbRow> & { id: string; cosineSim: number }): KbRow {
  return {
    kbTitle: '深度评测',
    summaryZh: null,
    entities: null,
    sourceUrls: ['https://kb.example.com/a'],
    eventDate: null,
    longTermValue: 80,
    ...over,
  };
}

interface PriceRow {
  planId: string;
  oldValue: string | null;
  newValue: string;
  currency: string;
  changedAt: Date;
}

/**
 * 单个 mock dbh，同时喂 searchKbCore（select→from(kbDocuments)→where→orderBy→limit）
 * 与价格查询（select→from(mrPriceHistory)→where）；按 `.from(table)` 的表身份路由。
 * kbRowSets 按 searchKbCore 调用顺序逐次消费（每候选一次）。
 */
function makeDbh(opts: {
  kbRowSets?: KbRow[][];
  priceRows?: PriceRow[];
  priceThrows?: boolean;
}): AssembleEvidenceDeps['dbh'] {
  let kbCall = 0;
  const kbBuilder = {
    from: () => kbBuilder,
    where: () => kbBuilder,
    orderBy: () => kbBuilder,
    limit: () => Promise.resolve(opts.kbRowSets?.[kbCall++] ?? []),
  };
  const priceBuilder = {
    where: () => {
      if (opts.priceThrows) throw new Error('price db down');
      return Promise.resolve(opts.priceRows ?? []);
    },
  };
  return {
    select: () => ({
      from: (table: unknown) => (table === mrPriceHistory ? priceBuilder : kbBuilder),
    }),
  } as unknown as AssembleEvidenceDeps['dbh'];
}

const okEmbed: AssembleEvidenceDeps['embed'] = async () => [[0.1, 0.2, 0.3]];
const throwingEmbed: AssembleEvidenceDeps['embed'] = async () => {
  throw new Error('embed down');
};
const noopLog = () => {};

describe('assembleEvidence', () => {
  it('KB 子源失败仍返回价格变更（子源相互隔离）', async () => {
    const dbh = makeDbh({
      priceRows: [{ planId: 'p1', oldValue: '39', newValue: '49', currency: 'CNY', changedAt: new Date(Date.now() - DAY) }],
    });
    const result = await assembleEvidence([mkCandidate()], { dbh, embed: throwingEmbed, log: noopLog });

    expect(result.kbHits).toEqual([]);
    expect(result.priceChanges).toHaveLength(1);
    expect(result.priceChanges[0]).toMatchObject({ from: '39', to: '49', currency: 'CNY' });
  });

  it('全部子源失败 ⇒ 三空、不抛', async () => {
    const dbh = makeDbh({ priceThrows: true });
    const result = await assembleEvidence(
      [mkCandidate({ reasons: [] })], // 无 pending_review ⇒ pendingReview 亦空
      { dbh, embed: throwingEmbed, log: noopLog },
    );
    expect(result).toEqual({ kbHits: [], priceChanges: [], pendingReview: [] });
  });

  it('装配整体超时 ⇒ 三空、不抛（挂起的 embed 不拖住请求，pendingReview 亦丢弃）', async () => {
    vi.useFakeTimers();
    try {
      const hangingEmbed: AssembleEvidenceDeps['embed'] = () => new Promise(() => {}); // 永不 resolve
      const dbh = makeDbh({ priceRows: [] });
      // 候选带 pending_review：证明超时按全失败三空（连同步可得的 pendingReview 也丢）。
      const candidate = mkCandidate({ reasons: [{ kind: 'pending_review', detail: '待复核' }] });

      const p = assembleEvidence([candidate], { dbh, embed: hangingEmbed, log: noopLog });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await p;

      expect(result).toEqual({ kbHits: [], priceChanges: [], pendingReview: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('30 天窗口边界：29 天前入、31 天前不入', async () => {
    const dbh = makeDbh({
      priceRows: [
        { planId: 'p1', oldValue: '39', newValue: '49', currency: 'CNY', changedAt: new Date(Date.now() - 29 * DAY) },
        { planId: 'p1', oldValue: '49', newValue: '59', currency: 'CNY', changedAt: new Date(Date.now() - 31 * DAY) },
      ],
    });
    const result = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: noopLog });

    expect(result.priceChanges).toHaveLength(1);
    expect(result.priceChanges[0]).toMatchObject({ from: '39', to: '49' });
    expect(result.priceChanges[0]!.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('cosine 地板过滤：全部低于地板 ⇒ kbHits 空', async () => {
    const dbh = makeDbh({
      kbRowSets: [[kbRow({ id: 'd1', cosineSim: 0.3 }), kbRow({ id: 'd2', cosineSim: 0.59 })]],
    });
    const result = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: noopLog });
    expect(result.kbHits).toEqual([]);
  });

  it('old_value NULL 行 ⇒ from=null（首录得价）', async () => {
    const dbh = makeDbh({
      priceRows: [{ planId: 'p1', oldValue: null, newValue: '49', currency: 'CNY', changedAt: new Date(Date.now() - DAY) }],
    });
    const result = await assembleEvidence([mkCandidate()], { dbh, embed: okEmbed, log: noopLog });
    expect(result.priceChanges).toHaveLength(1);
    expect(result.priceChanges[0]!.from).toBeNull();
    expect(result.priceChanges[0]!.to).toBe('49');
  });

  it('跨候选按 docId 去重、保最高 cosine', async () => {
    // 两候选各命中同一 docId d1，cosine 分别 0.7 / 0.9；去重后只留 0.9（与消费顺序无关）。
    const dbh = makeDbh({
      kbRowSets: [[kbRow({ id: 'd1', cosineSim: 0.7 })], [kbRow({ id: 'd1', cosineSim: 0.9 })]],
    });
    const candidates = [
      mkCandidate({ planId: 'p1', name: 'GLM-4.6 Coding Plan' }),
      mkCandidate({ planId: 'p2', name: 'Claude Pro Plan' }),
    ];
    const result = await assembleEvidence(candidates, { dbh, embed: okEmbed, log: noopLog });

    expect(result.kbHits).toHaveLength(1);
    expect(result.kbHits[0]).toMatchObject({ docId: 'd1', cosine: 0.9 });
  });
});
