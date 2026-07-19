/**
 * LLM 渲染器与机械守卫单测（add-model-radar-recommender-rag-explanation 组 C / tasks 3.4–3.6）。
 *
 * 全经注入（generateObjectFn 桩 + mock dbh/embed），不触网、不连 DB。覆盖：
 * - 3.4 逐字节：回落/跳过路径最终 explanation 与 v1 逐字节相等（普通/空召回/全待核/他币种）+ 权威前缀恒在 LLM 段前；
 * - 3.5 观测：renderedBy 三值 + KB/价格/待核统计 + 弃用原因；
 * - 3.6 守卫对抗样例（白名单/结论词/引用形态/canonical/URL/空叙述/内部抛错/log sink 抛错/maxRetries:0）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { mrPriceHistory } from '../../../db/schema.js';
import { recommend, type RecommendInput } from '../recommend.js';
import { renderTemplate } from '../explain.js';
import { buildExplainer, type BuildExplainerOptions, type GenerateObjectFn, type RenderedBy } from '../explain-llm.js';
import type {
  ExplanationInput,
  MrCurrency,
  RankedCandidate,
  RecommendEvidence,
  RecommendQuery,
} from '../schema.js';
import type { ModelRadarSnapshot, SnapshotPlan } from '../../snapshot/dto.js';

const CREDS = { apiKey: 'k', baseUrl: 'https://llm.example', model: 'test-model' };

beforeEach(() => {
  // searchKbCore 逐查观测走 console.error（stderr）——静默避免噪声。
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ── 直接渲染（注入 evidence，绕过装配）：守卫/观测样例用 ────────────────────────

const PROV = {
  sourceUrl: 'https://example.com/pricing',
  sourceConfidence: 'official_pricing' as const,
  lastCheckedDate: '2026-06-20',
};

function mkCandidate(over: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    planId: 'p1',
    vendorName: 'Vendor A',
    name: 'GLM-4.6',
    monthlyCost: 49,
    currency: 'CNY',
    priceStatus: 'known',
    availability: 'on_sale',
    stale: false,
    fitsWindow: 'unknown',
    verdict: 'primary',
    reasons: [],
    provenance: PROV,
    ...over,
  };
}

function mkEvidence(over: Partial<RecommendEvidence> = {}): RecommendEvidence {
  return { kbHits: [], priceChanges: [], pendingReview: [], ...over };
}

function kbHit(over: Partial<RecommendEvidence['kbHits'][number]> = {}): RecommendEvidence['kbHits'][number] {
  return { docId: 'd1', planId: 'p1', title: '深度评测', url: null, cosine: 0.7, ...over };
}

function priceChange(
  over: Partial<RecommendEvidence['priceChanges'][number]> = {},
): RecommendEvidence['priceChanges'][number] {
  return { planId: 'p1', vendorName: 'Vendor A', planName: 'GLM-4.6', from: '39', to: '49', currency: 'CNY', changedAt: '2026-07-10', ...over };
}

const QUERY: RecommendQuery = { currency: 'CNY', usageProfile: 'medium' };

function mockLlm(narrative: string): GenerateObjectFn {
  return vi.fn(async () => ({ object: { narrative } }));
}

interface RenderOut {
  out: string;
  templateSeg: string;
  logs: Array<{ message: string; detail: unknown }>;
  gen: GenerateObjectFn;
}

/** 注入 evidence 直渲：返回 out / 模板段 / 日志 / gen 桩。 */
async function render(
  narrative: string,
  opts: {
    candidates?: RankedCandidate[];
    evidence?: RecommendEvidence;
    log?: (m: string, d?: unknown) => void;
    gen?: GenerateObjectFn;
    onRender?: (renderedBy: RenderedBy) => void;
    beforeLlmCall?: () => Promise<boolean>;
  } = {},
): Promise<RenderOut> {
  const candidates = opts.candidates ?? [mkCandidate()];
  const evidence = opts.evidence ?? mkEvidence({ priceChanges: [priceChange()] });
  const logs: Array<{ message: string; detail: unknown }> = [];
  const log = opts.log ?? ((message: string, detail?: unknown) => logs.push({ message, detail }));
  const gen = opts.gen ?? mockLlm(narrative);
  const options: BuildExplainerOptions = {
    credentials: CREDS,
    dbh: {} as BuildExplainerOptions['dbh'],
    embed: (async () => [[0.1]]) as BuildExplainerOptions['embed'],
    log,
    generateObjectFn: gen,
    ...(opts.onRender ? { onRender: opts.onRender } : {}),
    ...(opts.beforeLlmCall ? { beforeLlmCall: opts.beforeLlmCall } : {}),
  };
  const explainer = buildExplainer(options);
  const input: ExplanationInput = { query: QUERY, candidates, evidence };
  const out = await explainer(input);
  const templateSeg = await renderTemplate(input);
  return { out, templateSeg, logs, gen };
}

/** 取渲染观测行（mr.recommend.explain）的 detail。 */
function renderLog(logs: Array<{ message: string; detail: unknown }>): Record<string, unknown> | undefined {
  const entry = logs.find((l) => l.message === 'mr.recommend.explain');
  return entry?.detail as Record<string, unknown> | undefined;
}

// ── 3.6 守卫对抗样例 ──────────────────────────────────────────────────────────

describe('3.6 守卫①：数字白名单', () => {
  it('白名单外杜撰价格 ⇒ 弃用回落', async () => {
    const { out, templateSeg, logs } = await render('新套餐只要 12345 元');
    expect(out).toBe(templateSeg);
    expect(renderLog(logs)!.renderedBy).toBe('llm-fallback-template');
    expect(String(renderLog(logs)!.discardReason)).toContain('guard1');
  });

  it('独立「-25」与「跌到-25」均弃用（白名单只有 25）', async () => {
    const ev = mkEvidence({ priceChanges: [priceChange({ from: '50', to: '25.00' })] });
    for (const narrative of ['本月降幅 -25 元', '价格跌到-25 了']) {
      const { out, templateSeg } = await render(narrative, { evidence: ev });
      expect(out).toBe(templateSeg);
    }
  });

  it('证据行 "25.00" vs 叙述「25」⇒ 通过（数值相等不误杀）', async () => {
    const ev = mkEvidence({ priceChanges: [priceChange({ from: '50', to: '25.00' })] });
    const { out, templateSeg, logs } = await render('近期降到 25 元左右', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n近期降到 25 元左右`);
    expect(renderLog(logs)!.renderedBy).toBe('llm');
  });

  it('候选名 GLM-4.6 与叙述裸写 4.6 / GLM 4.6 / GLM-4.6 均通过（符号上下文）', async () => {
    for (const narrative of ['4.6 版本近期更新', 'GLM 4.6 有更新', 'GLM-4.6 有更新']) {
      const { out, templateSeg } = await render(narrative);
      expect(out).toBe(`${templateSeg}\n\n${narrative}`);
    }
  });

  it('「2/5」零宽拼接 ⇒ canonical 剔 Cf 后按 25 走守卫①（不在白名单）⇒ 弃用', async () => {
    // 白名单 = {39,49,...}，不含 25。零宽拼接的 2+ZWSP+5 canonical 后为 25。
    const { out, templateSeg } = await render('价格 2\u200B5 元');
    expect(out).toBe(templateSeg);
  });

  it('﹣25(FE63)/⁻25(207B) 经 NFKC + 负号映射 ⇒ -25 ⇒ 弃用', async () => {
    for (const narrative of ['降 ﹣25', '降 ⁻25']) {
      const { out, templateSeg } = await render(narrative);
      expect(out).toBe(templateSeg);
    }
  });

  it('「20, 25」不并成 2025（20 与 25 均在白名单则通过）', async () => {
    const ev = mkEvidence({ priceChanges: [priceChange({ from: '20', to: '25' })] });
    const { out, templateSeg } = await render('价格区间 20, 25', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n价格区间 20, 25`);
  });

  it('千分位「1,000」归一为 1000（在白名单则通过）', async () => {
    const ev = mkEvidence({ priceChanges: [priceChange({ from: '900', to: '1000' })] });
    const { out, templateSeg } = await render('涨到 1,000 元', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n涨到 1,000 元`);
  });

  it('全角数字 ４９ 归一为 49（在白名单则通过）', async () => {
    const { out, templateSeg } = await render('调整到 ４９ 元');
    // canonical NFKC 折半角后叙述段发射为 "49"。
    expect(out).toBe(`${templateSeg}\n\n调整到 49 元`);
  });

  it('changedAt=2026-07-01 vs 叙述「7 月 1 日」⇒ 通过（日期成分入白名单）', async () => {
    const ev = mkEvidence({ priceChanges: [priceChange({ changedAt: '2026-07-01' })] });
    const { out, templateSeg } = await render('调整发生在 7 月 1 日', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n调整发生在 7 月 1 日`);
  });
});

describe('3.6 守卫②：结论词禁令', () => {
  it('中文「首选」与拉丁「Primary」均弃用', async () => {
    for (const narrative of ['这是首选方案', 'this is Primary now']) {
      const { out, templateSeg } = await render(narrative);
      expect(out).toBe(templateSeg);
    }
  });

  it('「推[1]荐」/「recom[1]mended」弃用（守卫②消费剥离 [n] 后文本）', async () => {
    const ev = mkEvidence({ kbHits: [kbHit()] });
    for (const narrative of ['推[1]荐 使用', 'recom[1]mended plan']) {
      const { out, templateSeg } = await render(narrative, { evidence: ev });
      expect(out).toBe(templateSeg);
    }
  });

  it('「推\u200B荐」canonical 剔零宽后词表命中 ⇒ 弃用', async () => {
    const { out, templateSeg } = await render('推\u200B荐 使用');
    expect(out).toBe(templateSeg);
  });

  it('KB 标题含「首选」但只在参考清单 ⇒ 不弃用（守卫仅消费叙述段）', async () => {
    const ev = mkEvidence({ kbHits: [kbHit({ title: '首选评测 GLM-4.6' })] });
    const { out, templateSeg, logs } = await render('最近有更新', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n最近有更新\n\n[1] 首选评测 GLM-4.6`);
    expect(renderLog(logs)!.renderedBy).toBe('llm');
  });
});

describe('3.6 守卫③：引用形态', () => {
  it('含 [1][2] 合法引用（kbHits=2）⇒ 不弃用', async () => {
    const ev = mkEvidence({ kbHits: [kbHit({ docId: 'd1' }), kbHit({ docId: 'd2', cosine: 0.65 })] });
    const { out, templateSeg } = await render('详见 [1] 与 [2]', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n详见 [1] 与 [2]\n\n[1] 深度评测\n[2] 深度评测`);
  });

  it('kbHits>0 且零引用 ⇒ 合法（引用可选）', async () => {
    const ev = mkEvidence({ kbHits: [kbHit(), kbHit({ docId: 'd2' })] });
    const { out, templateSeg, logs } = await render('最近有更新可参考资料', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n最近有更新可参考资料\n\n[1] 深度评测\n[2] 深度评测`);
    expect(renderLog(logs)!.renderedBy).toBe('llm');
  });

  it('越界引用 [9]（kbHits=2）⇒ 弃用', async () => {
    const ev = mkEvidence({ kbHits: [kbHit(), kbHit({ docId: 'd2' })] });
    const { out, templateSeg } = await render('见 [9]', { evidence: ev });
    expect(out).toBe(templateSeg);
  });

  it('「[2]5」邻接数字 ⇒ 弃用（防视觉合成白名单外数字）', async () => {
    const ev = mkEvidence({ kbHits: [kbHit(), kbHit({ docId: 'd2' })] });
    const { out, templateSeg } = await render('见 [2]5', { evidence: ev });
    expect(out).toBe(templateSeg);
  });

  it('全角 ［１］ 引用归一后按 [1] 处理（kbHits=1）⇒ 不弃用', async () => {
    const ev = mkEvidence({ kbHits: [kbHit()] });
    const { out, templateSeg } = await render('见 ［１］', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n见 [1]\n\n[1] 深度评测`);
  });

  it('叙述含 http:// / HTTP:// ⇒ 弃用（URL 大小写不敏感）', async () => {
    for (const narrative of ['详见 http://x.com/a', '详见 HTTP://X.COM']) {
      const { out, templateSeg } = await render(narrative);
      expect(out).toBe(templateSeg);
    }
  });
});

describe('3.6 canonical / URL 渲染 / bidi', () => {
  it('纯零宽/RLO 返回值 canonical 后为空 ⇒ 回落、不标 llm、不产空段', async () => {
    const { out, templateSeg, logs } = await render(String.fromCharCode(0x200B, 0x202E, 0x200C));
    expect(out).toBe(templateSeg); // 无尾随空段
    expect(renderLog(logs)!.renderedBy).toBe('llm-fallback-template');
    expect(renderLog(logs)!.discardReason).toBe('empty-narrative');
  });

  it('空叙述 ⇒ fallback', async () => {
    const { out, templateSeg, logs } = await render('   ');
    expect(out).toBe(templateSeg);
    expect(renderLog(logs)!.renderedBy).toBe('llm-fallback-template');
  });

  it('RLO bidi：发射文本 = canonical（无 Cf）⇒ 视觉序 = 逻辑序', async () => {
    const { out } = await render('从 39 到 49\u202E');
    expect(out).toContain('从 39 到 49');
    expect(out.includes(String.fromCharCode(0x202E))).toBe(false); // 发射段已剔 Cf
  });

  it('URL 含 CR/LF/tab ⇒ 参考清单只渲染 parsed.href、恒单行', async () => {
    const href = new URL('https://ex.com/a\r\nb\tc').href; // 装配层 firstValidHttpUrl 同口径产物
    expect(href.includes('\n')).toBe(false);
    const ev = mkEvidence({ kbHits: [kbHit({ url: href })] });
    const { out, templateSeg } = await render('最近有更新', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n最近有更新\n\n[1] 深度评测 ${href}`);
    // 参考清单该 hit 恰一物理行。
    const refLines = out.split('\n').filter((l) => l.startsWith('[1] '));
    expect(refLines).toHaveLength(1);
  });

  it('KB 标题含 \\n\\n【首选】… ⇒ 参考清单单行渲染、不产生新段落', async () => {
    const ev = mkEvidence({ kbHits: [kbHit({ title: '评测\n\n【首选】GLM-4.6' })] });
    const { out, templateSeg } = await render('最近有更新', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n最近有更新\n\n[1] 评测 【首选】GLM-4.6`);
    expect(out.includes('评测\n\n【首选】')).toBe(false); // 折叠、无新段落
  });
});

describe('3.6 LLM 调用契约 / 失败隔离', () => {
  it('mock 断言 generateObject 收到 maxRetries: 0', async () => {
    const { gen } = await render('最近有更新');
    const args = (gen as unknown as { mock: { calls: Array<[{ maxRetries: number }]> } }).mock.calls[0]![0];
    expect(args.maxRetries).toBe(0);
  });

  it('LLM 调用抛错 ⇒ fallback、不上抛', async () => {
    const gen: GenerateObjectFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const { out, templateSeg, logs } = await render('x', { gen });
    expect(out).toBe(templateSeg);
    expect(renderLog(logs)!.renderedBy).toBe('llm-fallback-template');
  });

  it('渲染器内部拼装抛错（非法 title 类型注入）⇒ fallback、不上抛', async () => {
    // title 非字符串 ⇒ 素材 canonical 时 .replace 抛错，被主体 try/catch 兜住。
    const ev = mkEvidence({ kbHits: [kbHit({ title: 123 as unknown as string })] });
    const { out, templateSeg, logs } = await render('最近有更新', { evidence: ev });
    expect(out).toBe(templateSeg);
    expect(renderLog(logs)!.discardReason).toBe('render-error');
  });

  it('log sink 抛错（成功路径）⇒ 返回值不受影响、不上抛', async () => {
    const throwingLog = () => {
      throw new Error('log down');
    };
    const { out, templateSeg } = await render('最近有更新', { log: throwingLog });
    expect(out).toBe(`${templateSeg}\n\n最近有更新`);
  });

  it('log sink 抛错（回落路径）⇒ 返回值不受影响、不上抛', async () => {
    const throwingLog = () => {
      throw new Error('log down');
    };
    const { out, templateSeg } = await render('这是首选', { log: throwingLog }); // 词表命中回落
    expect(out).toBe(templateSeg);
  });
});

// ── T1–T5/T9 对抗样例（本轮 finding 修复）───────────────────────────────────────

describe('T1 canonical 剔 C1 控制符（U+0080–009F）', () => {
  it('C1 拆开的结论词「首<C1>选」canonical 后命中词表 ⇒ 弃用', async () => {
    const { out, templateSeg } = await render('这是首\u0085选方案');
    expect(out).toBe(templateSeg); // 修前 C1 存活 ⇒ includes(\'首选\')=false 误放行
  });
  it('C1 拼接的白名单外数字「2<C1>5」⇒ 弃用（默认白名单无 25）', async () => {
    const { out, templateSeg } = await render('价格 2\u00855 元');
    expect(out).toBe(templateSeg);
  });
  it('C1 拆开的 URL「ht<C1>tp://…」canonical 后触 URL 闸 ⇒ 弃用', async () => {
    const { out, templateSeg } = await render('详见 ht\u0085tp://x.com/a');
    expect(out).toBe(templateSeg);
  });
});

describe('T2 参考清单 foldTitle 经 canonical 剔不可信 KB 标题的不可见字符', () => {
  it('KB 标题含 RLO/零宽 ⇒ 参考清单折叠后不含不可见字符', async () => {
    const ev = mkEvidence({ kbHits: [kbHit({ title: '评\u200b测\u202e报告' })] });
    const { out, templateSeg } = await render('最近有更新', { evidence: ev });
    expect(out).toBe(`${templateSeg}\n\n最近有更新\n\n[1] 评测报告`);
    expect(out.includes('\u200b')).toBe(false);
    expect(out.includes('\u202e')).toBe(false);
  });
});

describe('T3 dash 类完整覆盖（\\p{Dash_Punctuation} 含 U+058A）', () => {
  it('「降至\u058a25」U+058A 经 dash 映射为 -25 ⇒ 弃用（白名单有 25、无 -25）', async () => {
    // 修前 U+058A 未映射 ⇒ 提取为 +25（在白名单）误放行；修后映射为 -25 ⇒ 不在白名单弃用。
    const ev = mkEvidence({ priceChanges: [priceChange({ from: '50', to: '25' })] });
    const { out, templateSeg } = await render('降至\u058a25', { evidence: ev });
    expect(out).toBe(templateSeg);
  });
});

describe('T4 守卫① fail-closed 于不可验证数字', () => {
  it('400 位数（parseFloat→Infinity）⇒ guard1-unverifiable-number 弃用', async () => {
    const { out, templateSeg, logs } = await render('新价 ' + '9'.repeat(400) + ' 元');
    expect(out).toBe(templateSeg);
    expect(renderLog(logs)!.discardReason).toBe('guard1-unverifiable-number');
  });
  it('超 MAX_SAFE_INTEGER（9007199254740993≡…992 浮点折叠）⇒ 弃用', async () => {
    const { out, templateSeg, logs } = await render('编号 9007199254740993');
    expect(out).toBe(templateSeg);
    expect(renderLog(logs)!.discardReason).toBe('guard1-unverifiable-number');
  });
  it('科学计数法 4.6e1（拆成 {4.6,1} 显示为 46）⇒ fail-closed 弃用', async () => {
    const { out, templateSeg, logs } = await render('降到 4.6e1 元');
    expect(out).toBe(templateSeg);
    expect(renderLog(logs)!.discardReason).toBe('guard1-unverifiable-number');
  });
});

describe('T5 日期正则数字边界', () => {
  it('「12025-07-17」不被拆出内层日期、残 12025 白名单外 ⇒ 弃用', async () => {
    // 白名单含 2025/07/17（来自 changedAt 素材）；修前内层 2025-07-17 被消费、残 1 放行 12025，修后整体不匹配、12025 被提取弃用。
    const ev = mkEvidence({ priceChanges: [priceChange({ changedAt: '2025-07-17' })] });
    const { out, templateSeg } = await render('生效日 12025-07-17', { evidence: ev });
    expect(out).toBe(templateSeg);
  });
});

describe('T9 发射段无首尾空白', () => {
  it('叙述含首尾空白/全角空格 ⇒ canonical.trim 后发射无首尾空白', async () => {
    const { out, templateSeg } = await render('\u3000  最近有更新  \n');
    expect(out).toBe(`${templateSeg}\n\n最近有更新`);
    expect(out.endsWith('最近有更新')).toBe(true);
  });
});

// ── T10 重试路径（注入桩驱动 isTransient / isAbortOrTimeout 分支）──────────────────

describe('T10 重试路径', () => {
  it('瞬态 APICallError(503) 首调抛、次调成功 ⇒ 重试 1 次并成功（共 2 次）', async () => {
    let n = 0;
    const gen: GenerateObjectFn = vi.fn(async () => {
      n++;
      if (n === 1) {
        throw new APICallError({
          message: '503',
          url: 'https://llm.example',
          requestBodyValues: {},
          statusCode: 503,
        });
      }
      return { object: { narrative: '最近有更新' } };
    });
    const { out, templateSeg } = await render('unused', { gen });
    expect(out).toBe(`${templateSeg}\n\n最近有更新`);
    expect((gen as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it('4xx 业务错 APICallError(408/409/400) ⇒ 不重试、只调 1 次并回落（isRetryable 对 408/409 置 true 亦不重试）', async () => {
    for (const statusCode of [408, 409, 400]) {
      const gen: GenerateObjectFn = vi.fn(async () => {
        throw new APICallError({ message: String(statusCode), url: 'https://llm.example', requestBodyValues: {}, statusCode });
      });
      const { out, templateSeg } = await render('unused', { gen });
      expect(out).toBe(templateSeg);
      expect((gen as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    }
  });

  it('AbortError ⇒ 不重试、只调 1 次并回落', async () => {
    const gen: GenerateObjectFn = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const { out, templateSeg } = await render('unused', { gen });
    expect(out).toBe(templateSeg);
    expect((gen as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('返回不满足 {narrative} schema 的 object ⇒ 不重试、回落（schema 错非瞬态）', async () => {
    const gen: GenerateObjectFn = vi.fn(async () => ({ object: { notNarrative: 1 } }));
    const { out, templateSeg } = await render('unused', { gen });
    expect(out).toBe(templateSeg);
    expect((gen as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});

describe('3.5 观测：renderedBy 三值 + 命中统计', () => {
  it('llm 成功记 renderedBy=llm + KB/价格/待核统计 + top cosine', async () => {
    const ev = mkEvidence({
      kbHits: [kbHit({ cosine: 0.7 }), kbHit({ docId: 'd2', cosine: 0.9 })],
      priceChanges: [priceChange()],
      pendingReview: ['GLM-4.6'],
    });
    const { logs } = await render('最近有更新', { evidence: ev });
    const d = renderLog(logs)!;
    expect(d.renderedBy).toBe('llm');
    expect(d.kbHits).toBe(2);
    expect(d.topCosine).toBe(0.9);
    expect(d.priceChanges).toBe(1);
    expect(d.pendingReview).toBe(1);
  });

  it('三源全空 ⇒ 跳过 LLM、标记 template、零 LLM 调用', async () => {
    const gen = mockLlm('never');
    const { out, templateSeg, logs } = await render('never', { evidence: mkEvidence(), gen });
    expect(out).toBe(templateSeg);
    expect(renderLog(logs)!.renderedBy).toBe('template');
    expect((gen as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});

// ── 2.4 buildExplainer 注入回调（onRender + beforeLlmCall；缺省逐字节不变）─────────

describe('2.4 buildExplainer 注入回调 onRender / beforeLlmCall', () => {
  it('beforeLlmCall=()=>false ⇒ 跳过 LLM、renderedBy=llm-fallback-template(cap-declined)、onRender 收该值', async () => {
    const rendered: RenderedBy[] = [];
    const beforeLlmCall = vi.fn(async () => false);
    const gen = mockLlm('最近有更新');
    const { out, templateSeg, logs } = await render('最近有更新', {
      gen,
      beforeLlmCall,
      onRender: (rb) => rendered.push(rb),
    });
    expect(out).toBe(templateSeg); // 跳过 LLM ⇒ 逐字节 = 模板段
    expect((gen as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0); // LLM 未被调
    expect(beforeLlmCall).toHaveBeenCalledTimes(1); // gate 只调一次（不进重试循环）
    expect(renderLog(logs)!.renderedBy).toBe('llm-fallback-template');
    expect(renderLog(logs)!.discardReason).toBe('cap-declined');
    expect(rendered).toEqual(['llm-fallback-template']);
  });

  it('beforeLlmCall=()=>true ⇒ 正常调 LLM、onRender 收 llm', async () => {
    const rendered: RenderedBy[] = [];
    const beforeLlmCall = vi.fn(async () => true);
    const gen = mockLlm('最近有更新');
    const { out, templateSeg } = await render('最近有更新', {
      gen,
      beforeLlmCall,
      onRender: (rb) => rendered.push(rb),
    });
    expect(out).toBe(`${templateSeg}\n\n最近有更新`); // 正常 LLM 段
    expect((gen as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    expect(beforeLlmCall).toHaveBeenCalledTimes(1);
    expect(rendered).toEqual(['llm']);
  });

  it('证据三源全空 ⇒ beforeLlmCall 不被调（gate 前早返）、onRender 收 template、零 LLM', async () => {
    const rendered: RenderedBy[] = [];
    const beforeLlmCall = vi.fn(async () => true);
    const gen = mockLlm('never');
    const { out, templateSeg } = await render('never', {
      evidence: mkEvidence(), // 三源全空
      gen,
      beforeLlmCall,
      onRender: (rb) => rendered.push(rb),
    });
    expect(out).toBe(templateSeg);
    expect(beforeLlmCall).not.toHaveBeenCalled(); // 空证据不占配额（三源全空早返在 gate 前）
    expect((gen as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    expect(rendered).toEqual(['template']);
  });

  it('缺省不注入回调 ⇒ 行为与 5e v2 逐字节不变（有回调=true 时同结果）', async () => {
    // 缺省（MCP 路径）与显式 beforeLlmCall=()=>true 应产出逐字节相同的 explanation。
    const bare = await render('最近有更新'); // 不注入任何回调
    const gated = await render('最近有更新', { beforeLlmCall: async () => true });
    expect(bare.out).toBe(`${bare.templateSeg}\n\n最近有更新`);
    expect(gated.out).toBe(bare.out);
  });
});

// ── 3.4 逐字节 = v1（经 recommend() 拼装）+ 权威前缀在前 ─────────────────────────

const PLAN_PROV = PROV;
const PLAN_PROV_UNVETTED = { ...PROV, sourceConfidence: 'needs_login_recheck' as const };

interface PlanOpts {
  price?: string | null;
  currency?: MrCurrency | null;
  priceStatus?: 'known' | 'unknown';
  pending?: boolean;
  tool?: string;
}

function mkPlan(id: string, opts: PlanOpts = {}): SnapshotPlan {
  const known = (opts.priceStatus ?? 'known') === 'known';
  const tool = opts.tool ?? 'claude-code';
  return {
    id,
    vendorId: `vendor-${id}`,
    vendorName: `Vendor ${id}`,
    name: id,
    category: 'coding_plan',
    availability: 'unknown',
    currentPrice: known ? (opts.price ?? '49') : (opts.price ?? null),
    currency: known ? (opts.currency ?? 'CNY') : (opts.currency ?? null),
    priceStatus: known ? 'known' : 'unknown',
    provenance: known ? PLAN_PROV : PLAN_PROV_UNVETTED,
    freshness: { stale: false },
    reviewStatus: { pending: opts.pending ?? false },
    periodPrices: [],
    models: [{ modelId: `m-${id}`, family: 'glm', version: '4.6', provenance: PLAN_PROV }],
    clients: [{ clientType: 'tool', clientId: tool, provenance: PLAN_PROV }],
    limits: [],
    sources: [],
  };
}

function snap(...plans: SnapshotPlan[]): ModelRadarSnapshot {
  return { plans };
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

interface PriceRow {
  planId: string;
  oldValue: string | null;
  newValue: string;
  currency: string;
  changedAt: Date;
}

/** mock dbh：按 .from(table) 路由 KB 查询与价格查询（仿 evidence.test.ts）。 */
function makeDbh(opts: { kbRowSets?: KbRow[][]; priceRows?: PriceRow[] }): BuildExplainerOptions['dbh'] {
  let kbCall = 0;
  const kbBuilder = {
    from: () => kbBuilder,
    where: () => kbBuilder,
    orderBy: () => kbBuilder,
    limit: () => Promise.resolve(opts.kbRowSets?.[kbCall++] ?? []),
  };
  const priceBuilder = { where: () => Promise.resolve(opts.priceRows ?? []) };
  // assembleEvidence 现恒经 dbh.transaction 跑 KB/价格查询（design D1/D4 统一 deadlineAt）——tx 桩提供 execute(no-op set_config)
  // + 同一 select 路由；本文件不断言 rollback/set_config，故 tx 桩无需记状态。
  const selectRouter = () => ({ from: (table: unknown) => (table === mrPriceHistory ? priceBuilder : kbBuilder) });
  return {
    select: selectRouter,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({ execute: async () => {}, select: selectRouter }),
  } as unknown as BuildExplainerOptions['dbh'];
}

const okEmbed: BuildExplainerOptions['embed'] = async () => [[0.1, 0.2, 0.3]];

/** 装配 evidence 全空（无 KB / 无价格）：LLM 被跳过。 */
function emptyDeps(gen?: GenerateObjectFn): Partial<BuildExplainerOptions> {
  return {
    dbh: makeDbh({ kbRowSets: [], priceRows: [] }),
    embed: okEmbed,
    ...(gen ? { generateObjectFn: gen } : {}),
  };
}

function explainerWith(over: Partial<BuildExplainerOptions>): BuildExplainerOptions {
  return {
    credentials: CREDS,
    dbh: makeDbh({}),
    embed: okEmbed,
    log: () => {},
    ...over,
  };
}

describe('3.4 回落/跳过路径最终 explanation 逐字节 = v1', () => {
  it('普通路径（证据装配全空 ⇒ 跳过 LLM）', async () => {
    const s = snap(mkPlan('elig', { price: '49' }));
    const input: RecommendInput = { tool: 'claude-code', currency: 'CNY' };
    const v1 = await recommend(s, input);
    const v2 = await recommend(s, input, buildExplainer(explainerWith(emptyDeps(mockLlm('unused')))));
    expect(v2.explanation).toBe(v1.explanation);
  });

  it('空召回路径（candidates=[]）', async () => {
    const s = snap(mkPlan('p', { tool: 'cursor' }));
    const input: RecommendInput = { tool: 'claude-code', currency: 'CNY' };
    const v1 = await recommend(s, input);
    const v2 = await recommend(s, input, buildExplainer(explainerWith(emptyDeps())));
    expect(v2.explanation).toBe(v1.explanation);
  });

  it('全待核路径（pendingReview 非空 ⇒ LLM 被调用但叙述被守卫弃用回落）', async () => {
    const s = snap(mkPlan('pend', { price: '30', pending: true }));
    const input: RecommendInput = { tool: 'claude-code', currency: 'CNY' };
    const v1 = await recommend(s, input);
    // 无 KB / 无价格但有待核 ⇒ 三源非全空 ⇒ 调 LLM；叙述含结论词 ⇒ 弃用回落模板。
    const gen = mockLlm('这是首选方案');
    const v2 = await recommend(
      s,
      input,
      buildExplainer(explainerWith({ dbh: makeDbh({ kbRowSets: [], priceRows: [] }), embed: okEmbed, generateObjectFn: gen })),
    );
    expect(v2.explanation).toBe(v1.explanation);
    expect((gen as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
  });

  it('他币种路径（guidance 非空 ⇒ 装配全空跳过 LLM）', async () => {
    const s = snap(mkPlan('cny', { price: '49', currency: 'CNY' }), mkPlan('usd', { price: '5', currency: 'USD' }));
    const input: RecommendInput = { tool: 'claude-code', currency: 'CNY' };
    const v1 = await recommend(s, input);
    const v2 = await recommend(s, input, buildExplainer(explainerWith(emptyDeps())));
    expect(v2.explanation).toBe(v1.explanation);
    expect(v1.explanation).toContain('他币种'); // 前置确认 guidance 非空
  });

  it('结构断言：guidance 非空且 LLM 成功 ⇒ 最终 = v1 + \\n\\n + 叙述段（权威前缀恒在 LLM 段前）', async () => {
    const s = snap(mkPlan('cny', { price: '49', currency: 'CNY' }), mkPlan('usd', { price: '5', currency: 'USD' }));
    const input: RecommendInput = { tool: 'claude-code', currency: 'CNY' };
    const v1 = await recommend(s, input); // = guidance + '\n\n' + 模板段
    const narrative = '价格从 39 调整到 49。';
    const dbh = makeDbh({ priceRows: [{ planId: 'cny', oldValue: '39', newValue: '49', currency: 'CNY', changedAt: new Date() }] });
    const v2 = await recommend(
      s,
      input,
      buildExplainer(explainerWith({ dbh, embed: okEmbed, generateObjectFn: mockLlm(narrative) })),
    );
    // 无 KB 命中 ⇒ 无参考清单；LLM 段恒在权威前缀（v1）之后。
    expect(v2.explanation).toBe(`${v1.explanation}\n\n${narrative}`);
    expect(v2.explanation.startsWith(v1.explanation)).toBe(true);
  });
});
