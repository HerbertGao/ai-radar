/**
 * Model Radar 价格 curation proposer（add-model-radar-price-curation-approval，design D4/D6，task 6.1）。
 *
 * **PROPOSE 侧——绝不 import 任何事实 writer**（`recordPriceChange`/`upsert*` 等；eslint `no-restricted-imports`
 * 对 `curation/**` 除 `approve.ts` 外收窄禁 writer）。本文件只：读 pending 源 flag → `safeFetch`（复用 scrape
 * SSRF chokepoint）→ `extract`/`gate`（纯判定）→ `openReviewOrSupersede`（store 原语）→ 发卡。落库只发生在人
 * 一键批准时（approve.ts）。
 *
 * 回路（design D6）：
 * 1. 列 pending 的 `target_type='source'` flag（指纹变/blocked 打的标）。
 * 2. 逐源：仅处理 `fetch_strategy='http'`（本 lane http-only，无 Playwright）。
 * 3. `mr_plan_sources` 解析目标 plan：**恰一个** plan 才继续；0 或多 plan（一页多价）→ escalate（无卡、不猜）。
 * 4. `safeFetch` 重抓（SSRF+裸请求）→ `extract` 抽单一月价候选 → `gate`（官方源+同币种+`0<|Δ|/current≤20%`）。
 * 5. gate=prefill（**候选异于现价、Δ≠0**）→ `openReviewOrSupersede` → opened/superseded 则发 Telegram 一键卡
 *    + 飞书通知卡；noop（同 pending）不重复发卡。gate=escalate（含 Δ=0、大跳、非官方、币种变）→ 无卡，整页
 *    flag 交人经既有 dispose 面处置（未策展事实由 staleness 兜底重浮现）。
 *
 * ponytail: per-source try/catch 隔离失败（仿 `runScrapeTier`）——单源失败只记日志不拖垮整批；批级重试靠
 * curation-queue 的 BullMQ attempts（safeFetch 本身无内建重试，与 scrape 同语义）。
 */
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { mrPlans, mrPlanSources, mrSource } from '../../db/schema.js';
import { listPendingFlags } from '../freshness/dispose.js';
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from '../scrape/http-tier.js';
import { extract, gate, type MrCurrency } from './extract.js';
import { openReviewOrSupersede, markSuperseded } from './price-review-store.js';
import {
  buildPriceReviewFeishuCard,
  buildPriceReviewTelegramCard,
  type PriceReviewCardInput,
  type TelegramReviewCard,
} from './card.js';
import type { FeishuCard } from '../../push/message.js';

type DbLike = typeof defaultDb;

/** 出站发卡回调（注入；真实 Telegram/飞书 sender 由后续接线 group 装配，测试注入 spy）。 */
export interface CurationNotify {
  /** 发 Telegram 一键批准卡（挂 inline-keyboard + reply_markup）。 */
  telegram(card: TelegramReviewCard): Promise<void>;
  /** 发飞书通知卡（可选：飞书未配置则不传，跳过）。 */
  feishu?(card: FeishuCard): Promise<void>;
}

/** 逐源处理的分类结果（可观测计数）。 */
type SourceOutcome = 'carded' | 'noop' | 'escalated' | 'skipped';

export interface RunPriceCurationOptions {
  /** 出站发卡回调（必传——本组不默认构造真实 sender，防测试误发生产 + 强制接线侧显式装配）。 */
  notify: CurationNotify;
  dbh?: DbLike;
  /** 重抓函数（默认 `safeFetch`，走 scrape 同一 SSRF chokepoint）；测试注入桩免触网。 */
  fetchFn?: (url: string) => Promise<SafeFetchResult>;
  /** 透传 safeFetch 的 SSRF/超时选项（测试注入 allowlist/resolveAll）。 */
  safeFetchOptions?: SafeFetchOptions;
}

export interface RunPriceCurationResult {
  /** pending 源 flag 总数。 */
  total: number;
  /** 开记录 + 发新卡的源数。 */
  carded: number;
  /** 同 pending 同候选 → 不重复发卡的源数。 */
  noop: number;
  /** 无候选 / gate escalate（含 Δ=0）/ 多 plan 无法唯一定位 → 无卡的源数。 */
  escalated: number;
  /** 非 http / 无 plan / 抓取失败（truncated/非 2xx/空体）跳过的源数。 */
  skipped: number;
  /** per-source 异常（已记日志、不改事实）。 */
  errors: number;
}

/**
 * 跑一轮价格 curation proposer（design D6）。逐 pending 源 flag 处理，per-source 隔离失败。
 * **不落任何事实**——只开待批记录 + 发卡；落库在人批准时（approve.ts）。
 */
export async function runPriceCuration(
  options: RunPriceCurationOptions,
): Promise<RunPriceCurationResult> {
  const dbh = options.dbh ?? defaultDb;
  const fetchFn =
    options.fetchFn ?? ((url: string) => safeFetch(url, options.safeFetchOptions ?? {}));

  const flags = await listPendingFlags(dbh, { targetType: 'source' });
  const result: RunPriceCurationResult = {
    total: flags.length,
    carded: 0,
    noop: 0,
    escalated: 0,
    skipped: 0,
    errors: 0,
  };

  for (const flag of flags) {
    try {
      const outcome = await proposeForSource(dbh, flag.targetId, fetchFn, options.notify);
      result[outcome] += 1;
    } catch (err) {
      // per-source 隔离：只记通用原因 + source id（不泄拓扑），不改事实。批级重试靠 BullMQ attempts。
      result.errors += 1;
      console.error(
        `[mr-curation] 源处理失败（已跳过，不改事实）source=${flag.targetId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return result;
}

/**
 * 处理单个变更源：定位 plan → 重抓 → 抽取 → gate → 开记录 + 发卡。返回分类 outcome（不抛，异常由上层隔离）。
 */
async function proposeForSource(
  dbh: DbLike,
  sourceId: string,
  fetchFn: (url: string) => Promise<SafeFetchResult>,
  notify: CurationNotify,
): Promise<SourceOutcome> {
  // 载入源行——仅处理 http 档（本 lane http-only）。
  const source = (
    await dbh
      .select({
        id: mrSource.id,
        sourceUrl: mrSource.sourceUrl,
        fetchStrategy: mrSource.fetchStrategy,
      })
      .from(mrSource)
      .where(eq(mrSource.id, sourceId))
  )[0];
  if (!source || source.fetchStrategy !== 'http') return 'skipped';

  // `mr_plan_sources` 解析目标 plan：恰一个才继续；0（无 plan 可定价）或多 plan（一页多价，无法唯一
  // 定位）→ escalate（无卡、不猜 plan_id，design D6）。
  const planRows = await dbh
    .select({ planId: mrPlanSources.planId })
    .from(mrPlanSources)
    .where(eq(mrPlanSources.sourceId, sourceId));
  if (planRows.length !== 1) return 'escalated';
  const planId = planRows[0]!.planId;

  // 载入 plan 事实快照（现价/币种/置信度）。sourceConfidence 取自 plan 行（服务端注册表派生的
  // provenance，**非页面内容**）——gate 用它判官方源，防篡改页抬高置信度。
  const plan = (
    await dbh
      .select({
        name: mrPlans.name,
        currentPrice: mrPlans.currentPrice,
        currency: mrPlans.currency,
        sourceConfidence: mrPlans.sourceConfidence,
      })
      .from(mrPlans)
      .where(eq(mrPlans.id, planId))
  )[0];
  if (!plan) return 'skipped';

  // 重抓（复用 scrape SSRF chokepoint + 裸请求）。truncated/空体/非 2xx → skip（不据坏体抽值）。
  const res = await fetchFn(source.sourceUrl);
  if (res.truncated || res.body == null) return 'skipped';
  if (res.status < 200 || res.status >= 300) return 'skipped';

  // 抽单一月价候选（单价源：multiPlan=false，多 plan 已在上面 escalate）。
  const ext = extract({ body: res.body, sourceUrl: source.sourceUrl });
  if (ext.kind !== 'candidate') return 'escalated';

  // gate：官方源 + 现价非 NULL 且 >0 + 同币种 + `0<|Δ|/current≤20%`；否则 escalate（含 Δ=0 → 不开卡）。
  const currentPrice = plan.currentPrice == null ? null : Number(plan.currentPrice);
  const g = gate({
    candidate: { value: ext.value, currency: ext.currency },
    currentPrice,
    currentCurrency: plan.currency as MrCurrency | null,
    sourceConfidence: plan.sourceConfidence,
  });
  if (g.kind !== 'prefill') return 'escalated';

  // gate=prefill 已保证候选异于现价（Δ≠0）、现价非 NULL——开记录/supersede（候选值冻结在行上）。
  const opened = await openReviewOrSupersede(
    {
      planId,
      oldValue: currentPrice, // 冻结基线快照（批准时校验现价未漂移）。
      candidateValue: g.value,
      currency: g.currency,
      sourceUrl: source.sourceUrl,
      sourceConfidence: plan.sourceConfidence,
    },
    dbh,
  );
  if (opened.outcome === 'noop') return 'noop'; // 同 pending 同候选 → 不重复发卡。

  // opened / superseded-and-opened → 新令牌 → 发新卡。
  const cardInput: PriceReviewCardInput = {
    planName: plan.name,
    oldValue: currentPrice as number, // prefill 保证非 NULL。
    newValue: g.value,
    currency: g.currency,
    sourceUrl: source.sourceUrl,
    pctDelta: g.pctDelta,
  };
  try {
    await notify.telegram(
      buildPriceReviewTelegramCard({ ...cardInput, token: opened.token }),
    );
  } catch (err) {
    // Telegram 发卡失败（重试耗尽）：刚开的未过期 pending 会令下轮 cron「同候选未过期」no-op → 72h 无卡。
    // 置该 review superseded（顶层 db；系统触发无审批人 → decidedBy=null）令下轮重新开卡，再上抛原始
    // Telegram 错误交 per-source 隔离计为 error（非静默 carded）。飞书通知在此路径不发（本源本轮已判失败）。
    // 补偿 supersede 自身失败须单独 catch+log，绝不掩盖原始 Telegram 错误（否则原因丢失 + review 仍 pending）。
    try {
      await markSuperseded(opened.reviewId, null, dbh);
    } catch (supersedeErr) {
      console.error(
        `[mr-curation] 发卡失败后补偿 supersede 也失败（review 仍 pending，待下轮/TTL 兜底）review=${opened.reviewId}`,
        supersedeErr instanceof Error ? supersedeErr.message : String(supersedeErr),
      );
    }
    throw err;
  }
  // 飞书通知-only：其失败绝不改源结果 / 不动 money 路径——本地兜底记日志后仍 carded。
  if (notify.feishu) {
    try {
      await notify.feishu(buildPriceReviewFeishuCard(cardInput));
    } catch (err) {
      console.error(
        `[mr-curation] 飞书通知卡发送失败（通知-only，不改源结果）source=${sourceId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return 'carded';
}
