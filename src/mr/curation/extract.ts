/**
 * Model Radar 价格 curation 候选抽取器（design D6）。
 *
 * **money-path 红线**：本文件是**纯函数**——只产出「候选值 / escalate」判别联合，**绝不**写任何 `mr_*` 事实
 * （不 import `recordPriceChange` 等 writer；eslint `no-restricted-imports` 对 `curation/**` 除 `approve.ts`
 * 外收窄禁 writer）。最坏后果只是「让人白看一次」。
 *
 * fail-closed：仅当窗内是**单一金额、带币种标记、带月付单位、在物理边界内、无促销词、非登录墙、单价源**时才产候选值；
 * 任一不满足 → escalate（无值、强制人手输）。是否预填一键值由 `gate()` 按百分比门决定。
 *
 * 归一化**复用** scrape 的 `defaultPriceRegionExtractor`（design D7）——**不复制**归一逻辑。
 */
import { z } from 'zod';
import {
  defaultPriceRegionExtractor,
  type PriceRegionExtractor,
} from '../scrape/http-tier.js';
import { isOfficialConfidence, mrCurrencySchema } from '../../db/mr-schema.zod.js';

export type MrCurrency = z.infer<typeof mrCurrencySchema>;

/** 单月价物理上界（design D6「物理边界」）：超此值近乎必是解析错/年费/序号，fail-closed。 */
const MAX_MONTHLY_PRICE = 100_000;

/** 促销/折扣词（尽力启发式，design D6：**不声称对促销 fail-closed**，命中即 escalate、人手输兜底）。 */
const PROMO_MARKERS = [
  '折', '优惠', '限时', '立减', '首月', '券后', '秒杀', '特惠',
  'discount', 'sale', 'promo', 'coupon', '% off', 'save ', 'off)', 'off ', 'deal',
];

/** 登录墙/验证码/封禁标记（抓到即无候选，design D6 场景「登录墙不给数」）。 */
const BLOCKED_MARKERS = [
  '登录', '登陆', '验证码', '滑块', '人机验证', '请先登录',
  'sign in', 'log in', 'login', 'captcha', 'are you a robot', 'forbidden', 'access denied',
];

/** 月付单位标记（无月付单位 = 非月价页，不预填）。 */
const MONTHLY_MARKERS = ['/mo', '/month', 'per month', 'a month', 'monthly', '月付', '/月', '每月', '/ 月'];

/** 币种标记 → 归一币种。归一文本已 lowercase，`¥ ￥ $ €` 符号不被剥。 */
const CURRENCY_TOKENS: { token: string; currency: MrCurrency; side: 'prefix' | 'suffix' }[] = [
  { token: '¥', currency: 'CNY', side: 'prefix' },
  { token: '￥', currency: 'CNY', side: 'prefix' },
  { token: 'cny', currency: 'CNY', side: 'prefix' },
  { token: 'rmb', currency: 'CNY', side: 'prefix' },
  { token: '元', currency: 'CNY', side: 'suffix' },
  { token: '$', currency: 'USD', side: 'prefix' },
  { token: 'usd', currency: 'USD', side: 'prefix' },
  { token: '€', currency: 'EUR', side: 'prefix' },
  { token: 'eur', currency: 'EUR', side: 'prefix' },
];

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;

/** 抽取产出：候选值 或 escalate（无值）。 */
export type ExtractResult =
  | { kind: 'candidate'; value: number; currency: MrCurrency }
  | { kind: 'escalate'; reason: ExtractEscalateReason };

export type ExtractEscalateReason =
  | 'multi-plan-source' // 一页多价、无法唯一定位单 plan（本期一键仅覆盖单价源）
  | 'login-wall' // 登录墙/验证码/封禁页
  | 'promo' // 命中促销/折扣词（尽力启发式）
  | 'no-period-unit' // 无月付单位（非月价页）
  | 'no-amount' // 窗内无可解析金额
  | 'ambiguous' // 多个不同金额（含币种混杂 / ¥ 块数漂移）
  | 'out-of-bounds'; // 金额越物理边界

export interface ExtractInput {
  /** 原始抓取响应体（HTML/文本）。 */
  body: string;
  sourceUrl: string;
  /**
   * 该源是否映射到多个 plan（一页多价）。**多 plan 源本期一律 escalate**——一键仅覆盖单价源
   * （design D6；`plan_id` 由 proposer 经 `mr_plan_sources` 解析，无法唯一定位时置此）。
   */
  multiPlan?: boolean;
  /**
   * per-source 归一函数（默认 scrape 的 `defaultPriceRegionExtractor`，复用不复制）。
   */
  regionExtractor?: PriceRegionExtractor;
  /**
   * per-source 锚定窗：命中后只在其后 `anchorWindow` 字符内找价，缩小噪声。
   * 不配 = 全价区文本。ponytail: 朴素「首个 anchor 命中后切窗」，要更精细 per-source 切片再配 extractor。
   */
  anchor?: RegExp;
  /** 锚定窗长度（默认 400 字符）。 */
  anchorWindow?: number;
}

/**
 * 纯函数：从抓取体抽单一月价候选，fail-closed。产 `{value,currency}` 或 escalate（无值）。
 */
export function extract(input: ExtractInput): ExtractResult {
  if (input.multiPlan) return { kind: 'escalate', reason: 'multi-plan-source' };

  const normalizer = input.regionExtractor ?? defaultPriceRegionExtractor;
  let text = normalizer(input.body, input.sourceUrl);

  // per-source 锚定窗（可选）。
  if (input.anchor) {
    const m = input.anchor.exec(text);
    if (m) {
      const win = input.anchorWindow ?? 400;
      text = text.slice(m.index, m.index + win);
    }
  }

  if (BLOCKED_MARKERS.some((k) => text.includes(k))) {
    return { kind: 'escalate', reason: 'login-wall' };
  }
  // 促销尽力启发式：命中即 escalate（人手输兜底，design D6 禁称对促销 fail-closed）。
  if (PROMO_MARKERS.some((k) => text.includes(k))) {
    return { kind: 'escalate', reason: 'promo' };
  }
  // 月价页须带月付单位，否则不预填（可能是年费/一次性/无周期）。
  if (!MONTHLY_MARKERS.some((k) => text.includes(k))) {
    return { kind: 'escalate', reason: 'no-period-unit' };
  }

  const amounts = collectAmounts(text);
  if (amounts.length === 0) return { kind: 'escalate', reason: 'no-amount' };

  // 去重（同币种同值）后须恰一个不同金额；否则歧义（多金额 / 币种混杂 / ¥ 块数漂移）。
  const distinct = dedupe(amounts);
  if (distinct.length !== 1) return { kind: 'escalate', reason: 'ambiguous' };

  const { value, currency } = distinct[0]!;
  if (!(value > 0 && value <= MAX_MONTHLY_PRICE)) {
    return { kind: 'escalate', reason: 'out-of-bounds' };
  }
  return { kind: 'candidate', value, currency };
}

/** 扫币种前缀/后缀相邻金额，产 {currency,value} 列表。无币种标记的裸数字不收（只收币种标记相邻的金额）。 */
function collectAmounts(text: string): { currency: MrCurrency; value: number }[] {
  const out: { currency: MrCurrency; value: number }[] = [];
  for (const { token, currency, side } of CURRENCY_TOKENS) {
    const tk = escapeRegex(token);
    const pattern =
      side === 'prefix'
        ? new RegExp(`${tk}\\s*(${NUM})`, 'gi')
        : new RegExp(`(${NUM})\\s*${tk}`, 'gi');
    for (const m of text.matchAll(pattern)) {
      const raw = m[1]!;
      const value = Number.parseFloat(raw.replace(/,/g, ''));
      if (Number.isFinite(value)) out.push({ currency, value });
    }
  }
  return out;
}

function dedupe(
  amounts: { currency: MrCurrency; value: number }[],
): { currency: MrCurrency; value: number }[] {
  const seen = new Map<string, { currency: MrCurrency; value: number }>();
  for (const a of amounts) seen.set(`${a.currency}:${a.value}`, a);
  return [...seen.values()];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// gate(): 是否预填一键值的纯判定（design D6）。
// ---------------------------------------------------------------------------

/** gate 输入。`sourceConfidence` **必须由 source 注册表按源信任派生、禁取自页面内容**（防篡改页抬高置信度）。 */
export interface GateInput {
  candidate: { value: number; currency: MrCurrency };
  /** 现价快照（NULL = 未定基线/登录墙 seed；0 = 免费档基线）。 */
  currentPrice: number | null;
  currentCurrency: MrCurrency | null;
  /** 源信任派生的置信度（**非页面**）——仅 `official_pricing`/`official_doc` 允许预填。 */
  sourceConfidence: string;
}

/** 预填一键值 或 escalate（无值、强制人手输）。 */
export type GateResult =
  | { kind: 'prefill'; value: number; currency: MrCurrency; pctDelta: number }
  | { kind: 'escalate'; reason: GateEscalateReason };

export type GateEscalateReason =
  | 'FIRST_READ' // 现价 NULL：未定基线的占位/登录墙 seed
  | 'zero-baseline' // 现价 0：免费档基线，|Δ|/0 无意义（绝不除零）
  | 'non-official' // 非官方源（否则批准必因 confidence↔price 绑定 apply_failed）
  | 'currency-changed' // 币种变
  | 'pct-over-20' // |Δ|/current > 20%（含 ¥40→¥4=90% 解析错）
  | 'no-change'; // Δ=0：非价内容变动，不预填（proposer 侧亦不开卡）

/**
 * 纯函数：预填须**同时**满足 ①官方源（注册表派生）②现价非 NULL 且 >0 ③同币种 ④`0<|Δ|/current≤20%`；
 * 其余一律 escalate 无值。百分比门即挡住解析错（¥40→¥4=90%>20%），故**无**另设 ratio 分支。
 */
export function gate(input: GateInput): GateResult {
  const { candidate, currentPrice, currentCurrency, sourceConfidence } = input;

  // ② 现价 NULL / 0 先判（在任何除法之前，绝不 |Δ|/NULL 或 |Δ|/0）。
  if (currentPrice == null) return { kind: 'escalate', reason: 'FIRST_READ' };
  if (currentPrice <= 0) return { kind: 'escalate', reason: 'zero-baseline' };
  // ① 官方源（source 注册表派生，非页面）。
  if (!isOfficialConfidence(sourceConfidence)) {
    return { kind: 'escalate', reason: 'non-official' };
  }
  // ③ 同币种。
  if (currentCurrency !== candidate.currency) {
    return { kind: 'escalate', reason: 'currency-changed' };
  }
  // ④ 百分比门。
  const pctDelta = Math.abs(candidate.value - currentPrice) / currentPrice;
  if (pctDelta === 0) return { kind: 'escalate', reason: 'no-change' };
  if (pctDelta > 0.2) return { kind: 'escalate', reason: 'pct-over-20' };

  return { kind: 'prefill', value: candidate.value, currency: candidate.currency, pctDelta };
}
