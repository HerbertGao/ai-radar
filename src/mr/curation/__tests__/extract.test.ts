/**
 * gate() 分支自检（tasks 3.3）+ extract() fail-closed 抽样（tasks 3.1）。纯函数，不连 DB/Redis。
 * env 仅因 extract.ts 透传 import scrape/http-tier（→ config/env 校验）而预置。
 */
import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { gate, extract } = await import('../extract.js');

const CNY = 'CNY' as const;
const USD = 'USD' as const;

describe('gate() 分支（design D6）', () => {
  it('官方源小改带值预填', () => {
    const r = gate({
      candidate: { value: 46, currency: CNY },
      currentPrice: 42,
      currentCurrency: CNY,
      sourceConfidence: 'official_pricing',
    });
    expect(r.kind).toBe('prefill');
    if (r.kind === 'prefill') {
      expect(r.value).toBe(46);
      expect(r.pctDelta).toBeCloseTo(4 / 42);
    }
  });

  it('pct>20% 无值', () => {
    const r = gate({
      candidate: { value: 50, currency: CNY },
      currentPrice: 40,
      currentCurrency: CNY,
      sourceConfidence: 'official_pricing',
    });
    expect(r).toEqual({ kind: 'escalate', reason: 'pct-over-20' });
  });

  it('¥40→¥4 解析错无值（百分比门挡住，无需 ratio 分支）', () => {
    const r = gate({
      candidate: { value: 4, currency: CNY },
      currentPrice: 40,
      currentCurrency: CNY,
      sourceConfidence: 'official_pricing',
    });
    expect(r).toEqual({ kind: 'escalate', reason: 'pct-over-20' });
  });

  it('NULL 现价 → FIRST_READ', () => {
    const r = gate({
      candidate: { value: 46, currency: CNY },
      currentPrice: null,
      currentCurrency: null,
      sourceConfidence: 'official_pricing',
    });
    expect(r).toEqual({ kind: 'escalate', reason: 'FIRST_READ' });
  });

  it('非官方源无值', () => {
    const r = gate({
      candidate: { value: 46, currency: CNY },
      currentPrice: 42,
      currentCurrency: CNY,
      sourceConfidence: 'official_community',
    });
    expect(r).toEqual({ kind: 'escalate', reason: 'non-official' });
  });

  it('币种变无值', () => {
    const r = gate({
      candidate: { value: 20, currency: USD },
      currentPrice: 40,
      currentCurrency: CNY,
      sourceConfidence: 'official_pricing',
    });
    expect(r).toEqual({ kind: 'escalate', reason: 'currency-changed' });
  });

  it('current=0 不除零抛错 → zero-baseline escalate', () => {
    let r: ReturnType<typeof gate> | undefined;
    expect(() => {
      r = gate({
        candidate: { value: 46, currency: CNY },
        currentPrice: 0,
        currentCurrency: CNY,
        sourceConfidence: 'official_pricing',
      });
    }).not.toThrow();
    expect(r).toEqual({ kind: 'escalate', reason: 'zero-baseline' });
  });
});

describe('extract() fail-closed 抽样（design D6）', () => {
  it('单一带币种+月付金额 → 候选', () => {
    const r = extract({ body: '<div>Pro plan ¥46/月</div>', sourceUrl: 'https://x.com/pricing' });
    expect(r).toEqual({ kind: 'candidate', value: 46, currency: 'CNY' });
  });

  it('多 plan 源一律 escalate', () => {
    const r = extract({ body: '¥46/月', sourceUrl: 'https://x.com', multiPlan: true });
    expect(r).toEqual({ kind: 'escalate', reason: 'multi-plan-source' });
  });

  it('多金额歧义 → escalate', () => {
    const r = extract({ body: '¥46/月 或 ¥88/月', sourceUrl: 'https://x.com' });
    expect(r).toEqual({ kind: 'escalate', reason: 'ambiguous' });
  });

  it('促销折扣形态 → escalate（尽力启发式）', () => {
    const r = extract({ body: '首月 ¥9/月 限时优惠', sourceUrl: 'https://x.com' });
    expect(r).toEqual({ kind: 'escalate', reason: 'promo' });
  });

  it('登录墙 → escalate', () => {
    const r = extract({ body: '请先登录查看价格 ¥46/月', sourceUrl: 'https://x.com' });
    expect(r).toEqual({ kind: 'escalate', reason: 'login-wall' });
  });

  it('价区正文含裸 login/forbidden（非登录墙）→ 不误判 login-wall，正常抽取候选', () => {
    const r = extract({
      body: '<nav><a>login</a></nav> Pro plan ¥46/月 — no forbidden features',
      sourceUrl: 'https://x.com/pricing',
    });
    expect(r).toEqual({ kind: 'candidate', value: 46, currency: 'CNY' });
  });

  it('无月付单位 → escalate', () => {
    const r = extract({ body: '一次性 ¥46', sourceUrl: 'https://x.com' });
    expect(r).toEqual({ kind: 'escalate', reason: 'no-period-unit' });
  });
});
