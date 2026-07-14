/**
 * 纯顺序每日工作流编排（daily-intel-pipeline 10.1 / 10.3，design D7/D8）。
 *
 * runDailyWorkflow 是一个**纯顺序 async 函数**，把 G1–G6 的能力汇成一条链路：
 *   collect（Promise.allSettled 三源，G1）
 *   → 去重塌缩（G2）
 *   → Value Judge 逐条（G3）
 *   → Top N 选择（G4）
 *   → 中文摘要（G5）
 *   → 多通道推送（向所有已配置通道并发分发：Telegram 必配 + 飞书可选，G6）
 *
 * BullMQ 只在外层当「定时触发器 + 整 job 重试外壳」（见 ./queue.ts / ./worker.ts），
 * **本函数内不拆阶段队列、不投递消息**——阶段间靠普通 await 顺序衔接。
 *
 * 关键不变量（绝不可违背，design D7/D8）：
 * - 整个日报任务用 acquireDigestLock 包住（finally 释放），保证某 push_date 全局单例。
 * - 降级率**按阶段分别计算、各自独立熔断**：judge 分母 = 送判（未评分）事件数；
 *   摘要分母 = Top N。任一阶段分母 > 0 且其降级率严格 > DEGRADE_ABORT_RATIO → 中止 + 告警，
 *   **不推残缺日报**。分母 = 0 不是错误、不中止：judge 分母 = 0 直接进 Top N（已评分常青
 *   事件仍可推），摘要分母 = 0 正常不推。禁止把「judge 分母 = 0」误判为「今日无候选」中止。
 * - 系统级故障告警以**采集/规范化层**为准：①采集返回条数 = 0 或 ②采集 > 0 但可处理条目数 = 0
 *   → 告警；可处理数含塌缩进既有事件者，故全命中既有事件的正常无新闻日不告警。
 * - 日报 digest 阶段降级用 headlineOnlyEvent（轻量路径，只产 headline_zh；回退 representative_title
 *   → canonical_url → 剔除）；绝不推半截。summary_zh 改由 KB 入库阶段产出回写（design D1/D2）。
 *
 * 边界：本模块只编排，调用各组已导出函数，不重写其内部逻辑、不改 schema。
 */
import { and, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, aiProducts, rawItems } from '../db/schema.js';
import { UNNAMED_PRODUCT_NAME } from '../collectors/product-collapse.js';
import { env } from '../config/env.js';
import {
  collectAndStore,
  type CollectAllOptions,
} from '../collectors/index.js';
import { createLookbackArxivCursorStore } from '../collectors/arxiv-cursor.js';
import { collapseUncollapsedRawItems } from '../dedup/collapse.js';
import { buildOpsAlertSink, consoleAlertSink, type AlertSink } from './ops-alert-sink.js';
import {
  semanticMergeEvents,
  type SemanticMergeOptions,
  type SemanticMergeResult,
} from '../dedup/semantic-merge.js';
import {
  enrichCandidateContent,
  type EnrichContentOptions,
  type EnrichContentResult,
} from './content-enrichment.js';
import {
  runKbIngestion,
  type RunKbIngestionOptions,
  type KbIngestionResult,
} from '../kb/index.js';
import {
  scoreUnscoredEvents,
  type ScoreEventsOptions,
} from '../agents/value-judge/score-events.js';
import { selectTopN, type SelectedEvent } from '../selection/top-n.js';
import {
  suppressEventsInProducts,
  PLATFORM_HOSTS,
  type EventWithKeys,
} from '../selection/cross-segment-dedup.js';
// extractProductMergeKeys 来自 collectors/product-keys（零 db/env 纯 leaf）。run-daily 已 import
// collectAndStore（collectors/index）→ pipeline→collectors 依赖边已存在，import 此纯 leaf 是同向良性边。
import { extractProductMergeKeys } from '../collectors/product-keys.js';
import { backfillPublishedAt } from '../agents/published-at-inference/backfill.js';
import type { InferPublishedAtOptions } from '../agents/published-at-inference/index.js';
import type { AcquireAlertLockOptions } from './alert-lock.js';
import {
  headlineOnlyEvent,
  type EventForDigest,
} from '../agents/digest/persistence.js';
import type { SummarizeOptions } from '../agents/digest/index.js';
import {
  dispatchDailyDigest,
  dispatchDigest,
  type DailyDispatchResult,
  type DispatchResult,
  type MessageSender,
} from '../push/dispatcher.js';
import {
  collapseProductsOnce,
  digestPendingProducts,
  selectProductsForChannelSafe,
} from './product-digest.js';
import {
  runExperienceMiningOnce,
  runExperienceKbIngestion,
  selectExperiencesForChannel,
  type RunExperienceMiningOptions,
  type RunExperienceKbIngestionOptions,
  type SelectExperiencesOptions,
  type ExperienceMiningResult,
  type ExperienceKbIngestionResult,
} from './experience-chain.js';
import { createTelegramSender } from '../push/telegram.js';
import { createFeishuSender } from '../push/feishu.js';
import { CHANNEL, TARGET_TYPE, type Channel } from '../push/targets.js';
import { isFeishuEnabled } from '../config/env.js';
import {
  acquireDigestLock,
  type AcquireLockOptions,
} from '../push/lock.js';
import { getPushDate, startOfDayInTimeZone } from '../push/push-date.js';
import {
  classifySystemFailure,
  stageDegradeRate,
  stageShouldAbort,
  type StageDegrade,
} from './circuit-breaker.js';
import {
  detectStaleSources,
  type DetectStaleSourcesParams,
  type StaleSource,
} from './source-staleness.js';
import type { BackfillPublishedAtResult } from '../agents/published-at-inference/backfill.js';
import type { RunContext } from './run-context.js';

type DbLike = typeof defaultDb;

/**
 * 日报单例锁默认 TTL（毫秒）：30 分钟。覆盖含**多通道并发分发**的最坏 runDailyWorkflow 时长
 * （采集多源 + 数百条逐条 LLM 判断 + 逐条摘要 + Telegram/飞书并发分发，feishu-push 5.4）。
 * 相比 lock.ts 的 15min 默认上调一倍，给 P2 多通道留足余量；配合看门狗按 TTL/3 续租，
 * 长任务不会中途失锁致第二实例双发。崩溃时该 TTL 是「同日重新获取锁」的恢复上界。
 */
const DEFAULT_DIGEST_LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * 告警 sink：把「系统级故障」与「降级率熔断」以可观测方式上报。
 * 默认 console.error（非静默）。生产可注入 Telegram/PagerDuty 等。
 */
// AlertSink / AlertDetail 的权威定义在 ops-alert-sink（detail.dedupKey 必填，是当日限频键）。
// 此处 re-export 保持既有 import 路径可用。
export { type AlertDetail, type AlertSink } from './ops-alert-sink.js';

// 未注入真 sink 时回落 stderr。生产装配路径（run()）注入 buildOpsAlertSink()。
const defaultAlert: AlertSink = consoleAlertSink;

/** 工作流被熔断中止时抛出的信号（编排层据此让 BullMQ job 失败/重试）。 */
export class WorkflowAbortError extends Error {
  /** 触发熔断的阶段。 */
  readonly stage: 'value-judge' | 'digest';
  /** 该阶段降级率。 */
  readonly rate: number;
  constructor(stage: 'value-judge' | 'digest', rate: number) {
    super(
      `日报流水线在「${stage}」阶段降级率 ${(rate * 100).toFixed(1)}% 超阈值，已中止，不推残缺日报。`,
    );
    this.name = 'WorkflowAbortError';
    this.stage = stage;
    this.rate = rate;
  }
}

export interface RunDailyWorkflowOptions {
  /** 参考时刻，决定 push_date 与候选窗口「今天」（默认当前时刻）。 */
  now?: Date;
  /** 注入 db 或事务句柄（默认全局 db）。 */
  dbh?: DbLike;
  /** 采集层选项（注入 mock collector / RSS 源等）。 */
  collect?: CollectAllOptions;
  /**
   * 正文补全阶段选项（source-content-enrichment，组 G 2.4）。注入 `fetchImpl`/`resolve` 桩使
   * 集成测在补全阶段**不触网**（对空 content + 可抓 URL 的候选，默认真实 fetch 会外发请求）。
   */
  enrich?: EnrichContentOptions;
  /** Value Judge 阶段选项（注入 mock generateObject 等）。 */
  judge?: ScoreEventsOptions;
  /** 中文摘要阶段选项（注入 mock generateObject 等）。 */
  digest?: SummarizeOptions;
  /**
   * Telegram 推送发送器（默认 grammY 真实发送；测试注入 mock）。
   * 向后兼容字段：等价于 `senders.telegram`。同时传 `senders.telegram` 时以 `senders` 为准。
   */
  sender?: MessageSender;
  /**
   * 各通道发送器显式注入（多通道分发）。键为 channel；提供则覆盖该通道默认 sender。
   * 未提供某已配置通道的 sender 时按 env 构造真实 sender（telegram→grammY、feishu→webhook）。
   * 测试可注入飞书 mock sender 在不配真实 FEISHU env 时验证多通道分发 / 单通道失败隔离。
   */
  senders?: Partial<Record<Channel, MessageSender>>;
  /**
   * 覆盖「已配置通道集」（测试用：无需真实 FEISHU env 即可让 feishu 参与分发）。
   * 默认按 env 计算：恒含 telegram；isFeishuEnabled() 为真时加 feishu。
   */
  channels?: readonly Channel[];
  /** 单例锁选项（注入 mock Redis / TTL 等）。 */
  lock?: AcquireLockOptions;
  /** 告警 sink（默认 console.error）。 */
  alert?: AlertSink;
  /**
   * 按源陈旧度检测注入（add-per-source-staleness-alert，组 B）。默认真实 detectStaleSources。
   * best-effort 阶段的唯一测试缝：注入桩确定性控制返回陈旧源 / 抛错（验证隔离），或返回空
   * 以在既有用例里静默本阶段（避免部分源无产出误触发陈旧告警干扰无关断言）。
   */
  staleness?: (
    params: DetectStaleSourcesParams,
    dbh: DbLike,
  ) => Promise<StaleSource[]>;
  /** 熔断阈值（默认 env.DEGRADE_ABORT_RATIO）。 */
  abortRatio?: number;
  /**
   * 发布时间回填阶段的推断选项（透传给 backfillPublishedAt 的 `infer`）。
   * 注入 mock generateObjectFn / maxAttempts 等，使测试控制推断结果、不依赖真实 LLM。
   */
  publishedAtInfer?: Omit<InferPublishedAtOptions, 'now'>;
  /**
   * 发布时间回填阶段的 Redis 锁选项（透传给 backfillPublishedAt 的 `lock`）。
   * 注入 mock Redis / TTL；不传则用真实 Redis（集成测有真实 Redis 可用）。
   */
  publishedAtLock?: AcquireAlertLockOptions;
  /**
   * 语义去重阶段选项（透传给 semanticMergeEvents 的 embedding / search / judge 桩；P3 语义层，6.1）。
   * 注入 mock embedManyFn / generateObjectFn / 阈值等，使测试不触真实 embedding/LLM。
   * `thisRoundEventIds` 由本编排在 collapse 之后注入（调用方无需自带）。
   */
  semantic?: Omit<SemanticMergeOptions, 'now' | 'thisRoundEventIds'>;
  /**
   * 知识库入库阶段选项（透传给 runKbIngestion 的 agent / embed / store 桩；P3 KB 层，6.2）。
   * 注入 mock generateObjectFn / embedManyFn 等，使测试不触真实 LLM/embedding。
   * `now` 由本编排注入（候选 push_date 与 push 阶段同源）。
   */
  kb?: Omit<RunKbIngestionOptions, 'now'>;
  /**
   * 实践锦囊段提炼选项（透传给 runExperienceMiningOnce；add-ai-blogger-experience-mining 组 E 5.2）。
   * 注入 mock mineExperienceFn / mineOptions 等，使测试不真调经验提炼 LLM。channel-blind 每批只跑一次。
   */
  experienceMining?: RunExperienceMiningOptions;
  /**
   * 实践锦囊 KB 沉淀选项（透传给 runExperienceKbIngestion；channel-blind、早退之前执行，防 KB stranding）。
   * 注入 store 桩 / logError 等；`now` 由本编排注入（eventDate NULL 回退当日 pushDate，与 push 同源）。
   */
  experienceKb?: Omit<RunExperienceKbIngestionOptions, 'now'>;
  /**
   * 实践锦囊推送候选选项（透传给 selectExperiencesForChannel；limit / windowDays）。
   * `now` 由本编排注入（recency 窗口与 push_date 同源）。
   */
  experienceSelect?: Omit<SelectExperiencesOptions, 'now'>;
  /**
   * run-event 发射钩子（Phase A0，design D3/D4）：阶段进入 / 结局时经它发一条粗粒度事件；
   * **缺省 no-op**。由薄 run(ctx) 包装注入 ctx.emit；直调核心的测试 / smoke 不传则静默。
   * DI/测试 seam 仍留 options 核心、不进 ctx（design D2）。
   */
  emit?: RunContext['emit'];
}

/** 工作流结束状态（供 worker / 可观测 / 测试断言）。 */
export type WorkflowOutcome =
  | 'pushed' // 正常推送（dispatch outcome=sent）
  | 'skipped-locked' // 未抢到单例锁，本实例放弃
  | 'skipped-no-candidates' // 无待推事件（Top N 空 / 全已 success）
  | 'aborted-degrade'; // 某阶段降级率超阈值中止（不推残缺日报）

export interface RunDailyWorkflowResult {
  outcome: WorkflowOutcome;
  pushDate: string;
  /** 采集返回条数（registry 全部源汇总，非新插入行数）。 */
  collectedCount: number;
  /**
   * **新闻类**可处理条目数（含塌缩进既有新闻事件者；排除 product/paper）。
   * 系统级「新闻真空」告警的分母（feishu-push 5.7）；与 store.processableCount 的全量口径不同。
   */
  newsProcessableCount: number;
  /** Value Judge 阶段降级统计。 */
  judge: StageDegrade;
  /** 中文摘要阶段降级统计。 */
  digest: StageDegrade;
  /** 今日 Top N 条数。 */
  topNCount: number;
  /** 是否触发了系统级故障告警。 */
  alerted: boolean;
  /**
   * 发布时间回填阶段统计（**仅可观测**，绝不影响 outcome / 熔断）。
   * 回填的「判不出/失败」绝不计入 DEGRADE_ABORT_RATIO 分母（只含 judge + digest 两阶段）。
   * 未执行回填（如未抢到锁提前返回）时为 undefined。
   */
  publishedAtBackfill?: BackfillPublishedAtResult;
  /**
   * 正文补全阶段统计（**仅可观测**，绝不影响 outcome / 熔断；组 G 2.4）。
   * `hit`=成功抓 og:description 并原子写回数，`fail`=失败数（含被 SSRF 守卫拒绝数）。
   * 整阶段 try/catch、永不向上抛、不进熔断分母。未执行（如未抢到锁提前返回）时为 undefined。
   */
  enrichment?: EnrichContentResult;
  /**
   * 语义去重阶段统计（**仅可观测**，绝不影响 outcome / 熔断；P3 语义层，6.1）。
   * 语义降级（embedding/检索/LLM judge/合并冲突）一律「不合并」、不抛断、不计入 judge/digest
   * 熔断分母（语义层独立）。`SEMANTIC_DEDUP_ENABLED=off` 或阶段未执行（如未抢到锁提前返回）时为 undefined。
   */
  semantic?: SemanticMergeResult;
  /**
   * 知识库入库阶段统计（**仅可观测**，绝不影响 outcome / 熔断；P3 KB 层，6.2）。
   * KB 阶段在 push 成功之后运行、永不向上抛、降级不计入 judge/digest 熔断分母。
   * 未执行（如早退 / 未抢到锁）时为 undefined。
   */
  kb?: KbIngestionResult;
  /**
   * 实践锦囊段提炼统计（**仅可观测**，绝不影响 outcome / 熔断；组 E 5.2）。
   * 提炼 channel-blind 每批只跑一次、失败隔离永不向上抛、不计入 judge/digest 熔断分母。
   * 未执行（如未抢到锁提前返回）时为 undefined。
   */
  experienceMining?: ExperienceMiningResult;
  /**
   * 实践锦囊 KB 沉淀统计（**仅可观测**；channel-blind、在早退之前执行防 KB stranding）。
   * 失败隔离永不向上抛、不计入熔断。未执行时为 undefined。
   */
  experienceKb?: ExperienceKbIngestionResult;
}

/** 代表 raw_item 的摘要相关字段：canonical_url（摘要降级回退）+ 补全后 content/source（摘要 grounding）。 */
interface RepresentativeFields {
  canonicalUrl: string | null;
  content: string | null;
  source: string | null;
}

/**
 * 把 Top N 选中事件补齐代表 raw_item 的 canonical_url + 补全后 content + source（组 G 5.2）。
 *
 * - canonical_url 供摘要降级回退到 URL（原有职责）。
 * - content/source 经 `representative_raw_item_id` 载入 source-content-enrichment 补全后的正文与来源，
 *   透传 `EventForDigest`（headlineOnlyEvent/digestEvent 已把二者拼进 prompt）——**只改 forDigest 签名不接此加载即静默
 *   空转**（EventForDigest content/source 恒 undefined、摘要退化仅标题），故加载在此一并取回。
 */
async function loadRepresentativeFields(
  dbh: DbLike,
  eventIds: readonly string[],
): Promise<Map<string, RepresentativeFields>> {
  const map = new Map<string, RepresentativeFields>();
  if (eventIds.length === 0) return map;
  // 经 representative_raw_item_id 回指代表 raw_item。
  const events = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      repId: aiNewsEvents.representativeRawItemId,
    })
    .from(aiNewsEvents)
    .where(inArray(aiNewsEvents.eventId, eventIds as string[]));

  const repIds = events
    .map((e) => e.repId)
    .filter((x): x is bigint => x !== null);
  const fieldsByRawId = new Map<string, RepresentativeFields>();
  if (repIds.length > 0) {
    const raws = await dbh
      .select({
        id: rawItems.id,
        canonicalUrl: rawItems.canonicalUrl,
        content: rawItems.content,
        source: rawItems.source,
      })
      .from(rawItems)
      .where(inArray(rawItems.id, repIds));
    for (const r of raws) {
      fieldsByRawId.set(r.id.toString(), {
        canonicalUrl: r.canonicalUrl,
        content: r.content,
        source: r.source,
      });
    }
  }
  for (const e of events) {
    const fields =
      e.repId !== null ? fieldsByRawId.get(e.repId.toString()) : undefined;
    map.set(e.eventId, {
      canonicalUrl: fields?.canonicalUrl ?? null,
      content: fields?.content ?? null,
      source: fields?.source ?? null,
    });
  }
  return map;
}

/**
 * best-effort 诊断（组 G 7.1，可观测）：统计被 `is_ai_related` fail-closed 闸门（非 true = false
 * 或 NULL）排除的要闻/新品数。**仅日志、绝不影响 outcome/熔断**——调用方须 try/catch 包裹。
 *
 * 口径为**粗粒度近似**（非精确复刻 selectTopN / selectProductCandidates 全部谓词，避免谓词漂移
 * 维护陷阱）：
 * - 要闻：候选窗口内（should_push + published_at 闭区间 + importance≥下限 + 非 tombstone）但
 *   `is_ai_related IS NOT TRUE` 者——「其余谓词满足、仅因 AI 闸门被排除」的近似量（不含 per-channel
 *   投递态，略偏宽，作调参信号足够）。
 * - 新品：非 merge_conflict、非占位名、但 `is_ai_related IS NOT TRUE` 的产品（近似候选池被闸门排除量，
 *   不含 per-channel「从未 success」判定）。
 */
async function countAiGatedOut(
  dbh: DbLike,
  now: Date,
): Promise<{ events: number; products: number }> {
  const lowerBound = startOfDayInTimeZone(now, env.FIRST_SEEN_WINDOW_DAYS - 1);
  const [ev] = await dbh
    .select({ n: sql<number>`count(*)::int` })
    .from(aiNewsEvents)
    .where(
      and(
        eq(aiNewsEvents.shouldPush, true),
        gte(aiNewsEvents.publishedAt, lowerBound),
        lte(aiNewsEvents.publishedAt, now),
        gte(aiNewsEvents.importanceScore, String(env.IMPORTANCE_FLOOR)),
        isNull(aiNewsEvents.mergedInto),
        sql`${aiNewsEvents.isAiRelated} IS NOT TRUE`,
      ),
    );
  const [pr] = await dbh
    .select({ n: sql<number>`count(*)::int` })
    .from(aiProducts)
    .where(
      and(
        isNull(sql`${aiProducts.metadata} -> 'merge_conflict'`),
        ne(aiProducts.name, UNNAMED_PRODUCT_NAME),
        sql`${aiProducts.isAiRelated} IS NOT TRUE`,
      ),
    );
  return { events: ev?.n ?? 0, products: pr?.n ?? 0 };
}

/**
 * 跑一次完整每日工作流（纯顺序）。
 *
 * 全程包在 acquireDigestLock（finally 释放）内，保证某 push_date 全局单例。
 * 未抢到锁 → 立即返回 outcome='skipped-locked'，不发任何消息。
 *
 * @param options 注入点（now / db / 各阶段 mock / sender / 锁 / 告警 / 阈值）。
 */
export async function runDailyWorkflow(
  options: RunDailyWorkflowOptions = {},
): Promise<RunDailyWorkflowResult> {
  const now = options.now ?? new Date();
  const dbh = options.dbh ?? defaultDb;
  const alert = options.alert ?? defaultAlert;
  const abortRatio = options.abortRatio ?? env.DEGRADE_ABORT_RATIO;
  // run-event 发射（Phase A0，design D3/D4）：缺省 no-op；run(ctx) 包装注入 ctx.emit。
  const emit = options.emit ?? (() => {});
  const pushDate = getPushDate(now);

  // 全局单例锁：某 push_date 只允许一个实例跑（崩溃靠 TTL + finally 释放，design D5/D6）。
  // **TTL 须覆盖含多通道并发分发的最坏时长**（feishu-push 5.4 / telegram-push「日报任务全局单例」）：
  // 采集多源 + 逐条 LLM 判断 + 逐条摘要 + 向 Telegram 与飞书**并发**分发。并发分发使两通道增量
  // 有界（非串行叠加），相比 P1 单通道只增有限量；配合看门狗按 TTL/3 续租，长任务不会中途失锁。
  // 未注入 lock 选项（生产）时显式给一个覆盖该最坏时长的 TTL（取代 lock.ts 的 15min 默认）；
  // 注入 lock 选项（测试）时按注入值，保持用例对 TTL 的精确控制。
  const lockOptions: AcquireLockOptions =
    options.lock ?? { ttlMs: DEFAULT_DIGEST_LOCK_TTL_MS };
  const lock = await acquireDigestLock(pushDate, lockOptions);
  if (lock === null) {
    console.error(`[pipeline] 锁: push_date=${pushDate} 未抢到单例锁，本实例放弃`);
    emit('outcome.skipped-locked', { pushDate });
    return {
      outcome: 'skipped-locked',
      pushDate,
      collectedCount: 0,
      newsProcessableCount: 0,
      judge: { processed: 0, degraded: 0 },
      digest: { processed: 0, degraded: 0 },
      topNCount: 0,
      alerted: false,
    };
  }

  try {
    console.error(`[pipeline] 锁: push_date=${pushDate} 已获取单例锁`);
    // ── 阶段 1：采集（多源 Promise.allSettled 并发）+ 入库（源内幂等）。
    //    arXiv 增量游标接线（at-least-once，source-collectors / design D3）：arXiv **只在日报链采**
    //    （非实时，不在告警链）。注入固定回溯窗口游标（now − 7d 作 OAI-PMH `from`）使日报每轮按
    //    回溯窗口增量采集而非每轮全量或固定一点；无漏窗 + crash-safe 由「固定窗口重叠 + store 层
    //    UNIQUE(source, source_item_id) 幂等」共同保障（见 arxiv-cursor.ts）。仅当调用方未自带 arxiv
    //    采集选项（测试可注入桩/自带游标）时注入默认游标，不覆盖测试注入。
    emit('stage.collect');
    const collectOptions = withDefaultArxivCursor(options.collect);
    const collected = await collectAndStore({ ...collectOptions, dbh });
    const collectedCount = collected.items.length;
    console.error(`[pipeline] 采集: 返回 ${collectedCount} 条`);

    // ── 阶段 2：去重塌缩。处理库内**所有**未塌缩的可处理 raw_items（collapseUncollapsedRawItems，
    //    按 collapsed 标记驱动、幂等）：每条塌缩后置 collapsed=true，source_count 恰好贡献一次，
    //    崩溃补塌缩安全；不再依赖脆弱的 store.insertedIds（Wave2a / Codex C1）。
    emit('stage.dedup');
    const outcomes = await collapseUncollapsedRawItems(dbh);
    // **新闻类可处理条目数**（feishu-push 5.7 / daily-intel-pipeline MODIFIED）：
    // collapseUncollapsedRawItems 的查询层已排除 raw_type product/paper，故其 outcomes 只含
    // **新闻类** raw_items；其中 unprocessable=false 即「能塌缩进新闻事件」（含塌缩进既有新闻事件）。
    // 这与 store.processableCount（统计全部条目含 product/paper 的通用「可入库」口径）语义不同——
    // 系统级「新闻真空」告警必须用**新闻类**分母，否则「仅 arXiv 返回 paper、新闻源全空」时
    // paper 会被 store 口径计入而掩盖新闻真空使告警失灵。
    const newsProcessableCount = outcomes.filter((o) => !o.unprocessable).length;
    console.error(
      `[pipeline] 塌缩: 处理 ${outcomes.length} 条未塌缩新闻类 raw_items → 新闻类可处理 ${newsProcessableCount} 条`,
    );

    // 系统级故障告警以采集/规范化层为准（非 judge 分母，design D8），**仅日报链套用**：
    // ①采集返回 0（registry 全部源失败）或 ②采集 > 0 但新闻类可处理数 = 0（全部新闻条目 unprocessable，
    // 或仅有 product/paper 非新闻条目）→ 告警。全命中既有新闻事件的正常无新闻日 newsProcessableCount>0、不告警。
    const sysFailure = classifySystemFailure({
      collectedCount,
      newsProcessableCount,
    });
    let alerted = false;
    if (sysFailure.alert) {
      console.error(`[pipeline] 告警: 系统级故障 kind=${sysFailure.kind}`);
      await alert(`系统级故障：${sysFailure.reason}`, {
        // 按 kind 分键：no-collection 与 all-unprocessable 是两种故障，同日各响一次。
        dedupKey: `system-failure:${sysFailure.kind}`,
        kind: sysFailure.kind,
        collectedCount,
        newsProcessableCount,
      });
      alerted = true;
    }

    // ── 阶段 2.4（best-effort、可观测）：按源陈旧度检测（add-per-source-staleness-alert，design D1/D4）。
    //    **位置钉死**：紧接系统级故障告警块之后、judge/digest 熔断 throw **之前**——保证熔断日 / 无候选
    //    早退日照常检测（陈旧度与今日有无新闻正交，design 理由②）。此刻本轮采集已完成：健康源的
    //    max(fetched_at) 已刷新为本次运行、死源仍停在旧值——同时抓「抛错静默死」与「返回 0 静默死」。
    //    **只借 countAiGatedOut 的 try/catch 隔离范式、不借其位置**（它在两个 throw 之后、约 line 759，
    //    放那儿熔断日不检测）。注入工作流 now（与 push_date 同源，定「now − 阈值天数」边界）+ dbh（复用
    //    锁内单实例）；发现 ≥1 陈旧源 → 调一次 alert 列出每源 source + lastFetched（或「从未产出」）+ 已零
    //    新增天数，无陈旧源不调（不发「一切正常」噪音，design D4）。
    //    **best-effort 隔离**：任何异常仅记日志、绝不向上抛、不进 judge/digest 熔断分母、不影响 outcome/推送
    //    （与既有 enrichment/countAiGatedOut/KB best-effort 阶段同纪律）。
    const detectStale = options.staleness ?? detectStaleSources;
    try {
      const staleSources = await detectStale({ now }, dbh);
      if (staleSources.length > 0) {
        const lines = staleSources
          .map((s) =>
            s.lastFetched === null
              ? `- ${s.source}：从未产出`
              : `- ${s.source}：最近入库 ${s.lastFetched.toISOString()}，已零新增 ${s.staleDays} 天`,
          )
          .join('\n');
        console.error(
          `[pipeline] 告警: 检测到 ${staleSources.length} 个陈旧源（长期零新增）`,
        );
        // 单键：本判定每天只跑一次（日报链内），一条消息已列出全部陈旧源。
        // 与 `source-health:<source>` 不同——那是【单源采集失败】的即时告警，天然按源分键。
        await alert(
          `按源陈旧度告警：${staleSources.length} 个源长期零新增\n${lines}`,
          { dedupKey: 'source-staleness', staleSources },
        );
      } else {
        console.error('[pipeline] 陈旧度: 全部待监控源新鲜，无陈旧告警');
      }
    } catch (error) {
      // 防御性隔离：陈旧度检测任何异常（查询 / 判定）仅记日志，绝不向上抛、不进熔断分母、不影响 outcome。
      console.error(
        '[pipeline] 陈旧度检测阶段异常（已隔离，不影响 outcome/推送、不进熔断分母）',
        error,
      );
    }

    // ── 阶段 2.5：语义去重（P3 第三/四层 + 确定性合并，spec「语义去重仅作用于日报链新闻事件」/ design D3）。
    //    **位置约束**：collapse 之后、value-judge 之前——合并必在 push **之前**完成（跨天幂等前提：
    //    存活者通常为前日已 push 的较早事件，push 候选「从未以该 channel success」据此跳过、同事件次日不重推），
    //    且被吞 tombstone 须在 value-judge 候选 SELECT 前置就位才不会被复活评分（tombstone 排除已由组 4.7 收口）。
    //    **仅日报链调用**：实时告警链（alert-scan.ts）恒走硬去重快路径、不调本阶段（6.3）。
    //    **SEMANTIC_DEDUP_ENABLED 开关**：为 'off' 时整阶段跳过，退回纯硬去重态、其余阶段照常（spec「开关关闭退回硬去重」）。
    //    **降级安全 + 不进熔断分母**：semanticMergeEvents 内部逐事件 catch（embedding/检索/LLM judge/合并冲突
    //    一律「不合并」、保留独立、不抛断），故本编排对语义阶段不构造 StageDegrade、不传 stageShouldAbort、
    //    绝不进 DEGRADE_ABORT_RATIO 分母（熔断分母仍只含 judge + digest 两阶段，语义层独立）；统计仅记日志（可观测）。
    let semanticResult: SemanticMergeResult | undefined;
    if (env.SEMANTIC_DEDUP_ENABLED === 'on') {
      // 嵌入顺序须「先嵌本轮新事件」（保今日新事件本轮即可作查询对象，spec「嵌入顺序」）：把本轮 collapse
      // 可处理 outcomes 的 dedup_key 解析为「仍 embedding IS NULL 且非 tombstone」的事件 id 集传入。
      // collapse outcomes 不直接给 event_id（仅 dedup_key），故经 dedup_key 反查；空集时 bootstrap 退化为
      // 纯 first_seen_at 升序（仍正确，只是不保证本轮新事件优先嵌入）。
      const thisRoundDedupKeys = [
        ...new Set(
          outcomes
            .filter((o) => !o.unprocessable && o.dedupKey !== null)
            .map((o) => o.dedupKey as string),
        ),
      ];
      let thisRoundEventIds: string[] = [];
      if (thisRoundDedupKeys.length > 0) {
        const rows = await dbh
          .select({ eventId: aiNewsEvents.eventId })
          .from(aiNewsEvents)
          .where(
            and(
              inArray(aiNewsEvents.dedupKey, thisRoundDedupKeys),
              isNull(aiNewsEvents.embedding),
              isNull(aiNewsEvents.mergedInto),
            ),
          );
        thisRoundEventIds = rows.map((r) => r.eventId);
      }
      semanticResult = await semanticMergeEvents(
        {
          now,
          ...options.semantic,
          ...(thisRoundEventIds.length > 0 ? { thisRoundEventIds } : {}),
        },
        dbh,
      );
      console.error(
        `[pipeline] 语义去重: 处理 ${semanticResult.processed} 条, ` +
          `高相似合并 ${semanticResult.highAutoMerged} 条, LLM 确认合并 ${semanticResult.llmConfirmedMerged} 条, ` +
          `LLM 不合并 ${semanticResult.llmNotMerged} 条, 护栏否决 ${semanticResult.vetoedByGuard} 条, 异常跳过 ${semanticResult.skippedError} 条, ` +
          `embedding(候选 ${semanticResult.embedding.candidates}/嵌入 ${semanticResult.embedding.embedded}/失败 ${semanticResult.embedding.failed})（不计入熔断）`,
      );
    } else {
      console.error('[pipeline] 语义去重: SEMANTIC_DEDUP_ENABLED=off，跳过语义层（退回纯硬去重）');
    }

    // ── 阶段 2.6：正文补全（source-content-enrichment，spec / design D1）——链序钉死
    //    「塌缩 → 语义合并 → 补全 → 判分」：**语义合并之后**（只富化存活代表、不对随即 tombstone 者
    //    浪费抓取；语义合并判维持仅标题、有意取舍见 design D1）、**Value Judge 之前**（judge 与摘要都
    //    需正文 grounding，补全先行才能一次 grounding 两者）。工作集与 scoreUnscoredEvents 判分集同口径
    //    （importance_score IS NULL AND merged_into IS NULL，空 content + 可抓 URL）。
    //    **补全默认串行 best-effort**：每条以 COLLECTOR_FETCH_TIMEOUT_MS 为上限、逐条 try/catch 隔离
    //    （enrichCandidateContent 内部实现），量级数十条可接受；整体在 digest 锁内、watchdog 续租使延迟
    //    有界非致命。**整阶段 try/catch 永不向上抛、不进熔断分母**（沿用回填/产品/KB 失败不进熔断的既有
    //    先例；熔断分母仍只含 judge + digest 两阶段）；补全失败 content 仍空时判分/摘要按各自仅标题回退。
    let enrichResult: EnrichContentResult | undefined;
    try {
      enrichResult = await enrichCandidateContent(dbh, options.enrich);
      console.error(
        `[pipeline] 正文补全: 命中 ${enrichResult.hit} 条, 失败 ${enrichResult.fail} 条` +
          `（失败含被 SSRF 守卫拒绝数；best-effort、逐条隔离、不计入熔断）`,
      );
    } catch (error) {
      // 防御性兜底：enrichCandidateContent 内部已逐条 try/catch、整阶段不抛；此处再兜一层（如工作集
      // SELECT 异常），任何异常仅记日志、不抛断、不进熔断分母、不影响判分/摘要 outcome。
      console.error(
        `[pipeline] 正文补全阶段异常（已隔离，不影响判分/摘要 outcome、不进熔断分母）`,
        error,
      );
    }

    // ── 阶段 3：Value Judge 逐条（只送判未评分事件）。单条降级整批继续（G3 内已容错）。
    emit('stage.score');
    const judgeResult = await scoreUnscoredEvents(options.judge, dbh);
    const judgeStage: StageDegrade = {
      processed: judgeResult.judged, // 分母 = 本轮送判（未评分）事件数。
      degraded: judgeResult.degradedCount,
    };
    console.error(
      `[pipeline] Value Judge: 送判 ${judgeStage.processed} 条, 降级 ${judgeStage.degraded} 条`,
    );
    // judge 阶段独立熔断：分母 > 0 且降级率严格 > 阈值 → 中止 + 告警，不推残缺日报。
    if (stageShouldAbort(judgeStage, abortRatio)) {
      const rate = stageDegradeRate(judgeStage)!;
      console.error(
        `[pipeline] 熔断: Value Judge 降级率超阈值，中止流水线`,
      );
      // 必须 await：紧接着 throw，不等则告警是个游离 Promise、job 已失败、投递零完成保证。
      await alert(
        `Value Judge 阶段降级率 ${(rate * 100).toFixed(1)}% 超阈值（${(abortRatio * 100).toFixed(0)}%），中止本次流水线。`,
        { dedupKey: 'degrade-abort:value-judge', ...judgeStage },
      );
      throw new WorkflowAbortError('value-judge', rate);
    }
    // 注意：judge 分母 = 0 时 stageShouldAbort 返回 false——**不中止**，直接进 Top N，
    // 已评分的常青事件仍可入选并推送（禁止误判「今日无候选」）。

    // ── 阶段 3.5：发布时间回填（published-at-inference，daily spec / design D2/D4）。
    // **必在 Value Judge 之后、Top N 之前**：对「should_push=true 且 published_at IS NULL」的收窄
    // 候选域，逐条经 Redis per-event 锁 → AI 推断 → CAS 回填（受 PUBLISHED_AT_INFERENCE_MAX_PER_RUN
    // 上限 + first_seen_at 超窗剪枝约束）。能补的补、补不出（AI 判不出）的保持 NULL 由 Top N 时效闸排除。
    // **绝不计入降级率熔断**（daily spec「每日定时单队列顺序编排」/ design D2）：回填的「判不出/失败」
    // 是预期高比例的安全失败方向，绝不构造 StageDegrade、绝不传 stageShouldAbort/stageDegradeRate、
    // 绝不进 DEGRADE_ABORT_RATIO 分母——熔断分母仍只含 judgeStage / digestStage 两阶段。回填统计仅
    // 记日志（可观测），失败降级不抛断、不阻塞后续阶段（backfillPublishedAt 内部已逐事件 catch 降级）。
    const backfillStats = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: env.FIRST_SEEN_WINDOW_DAYS,
      now,
      dbh,
      // exactOptionalPropertyTypes：仅在显式注入时透传，避免传 undefined 给「可选非 undefined」字段。
      ...(options.publishedAtInfer ? { infer: options.publishedAtInfer } : {}),
      ...(options.publishedAtLock ? { lock: options.publishedAtLock } : {}),
      logError: (message, detail) =>
        console.error(`[pipeline][published-at-inference] ${message}`, detail),
    });
    console.error(
      `[pipeline] 发布时间回填: 尝试 ${backfillStats.attempted} 条, 回填 ${backfillStats.backfilled} 条, ` +
        `判不出 ${backfillStats.undetermined} 条, 失败 ${backfillStats.failed} 条（不计入熔断）`,
    );

    // ── 阶段 4：Top N 选择（程序确定性，不交给 LLM）。统一日报模型 Model B：选一份 channel-blind
    // Top N，候选窗口排除「已投递给所有已配置通道」者（还差任一通道就留在名单、由各通道 per-channel
    // 跨天补发）。故先解析「已配置通道集」传入 selectTopN（同一份 channelSenders 在阶段 6 复用分发）。
    emit('stage.select');
    const channelSenders = resolveChannelSenders(options);
    const topN = await selectTopN(
      { now, channels: channelSenders.map((c) => c.channel) },
      dbh,
    );
    console.error(
      `[pipeline] Top N: 入选 ${topN.length} 条（已配置通道：${channelSenders
        .map((c) => c.channel)
        .join(', ')}）`,
    );

    // ── 阶段 5：中文一句话要点（headline）逐条（轻量路径，design D1）。分母 = Top N。
    //    日报 digest 只产/写 headline_zh，不再产 summary_zh（后者改由 KB 入库阶段回写，design D2）。
    //    单条降级回退/剔除（headlineOnlyEvent 内已处理），绝不推半截。
    emit('stage.digest');
    const repFields = await loadRepresentativeFields(
      dbh,
      topN.map((e) => e.eventId),
    );
    let digestDegraded = 0; // 本轮**实际送 headline 生成**中失败降级的条数（不含已缓存跳过者）。
    let digestProcessed = 0; // 本轮实际送 headline 生成（headline_zh IS NULL）数，仅供逐条日志/可观测。
    let digestSkipped = 0; // 已有 headline_zh、跳过 headlineOnlyEvent 的条数（仅可观测）。
    const pushable: SelectedEvent[] = [];
    // 逐条进度：先数出本轮真正要送 headline 生成的条数（未缓存者）作分母 M（仅日志用）。
    const toSummarizeCount = topN.filter((e) => e.headlineZh === null).length;
    let digestStep = 0;
    for (const ev of topN) {
      // 已生成守卫（design D1）：已有 headline_zh（非 null，如 P0/告警链同产两者）→ 跳过
      // headlineOnlyEvent，直接用既有 headline_zh 计入 pushable，避免重复 LLM 调用 / 覆盖旧产物为降级回退。
      if (ev.headlineZh !== null) {
        digestSkipped += 1;
        pushable.push({
          eventId: ev.eventId,
          representativeTitle: ev.representativeTitle,
          // 库内既有 summary_zh（P0/告警链已产则非空，否则 null → message 层回退 headline）。
          summaryZh: ev.summaryZh,
          headlineZh: ev.headlineZh,
          canonicalUrl: repFields.get(ev.eventId)?.canonicalUrl ?? null,
          publishedAt: ev.publishedAt,
          rankScore: ev.rankScore,
        });
        continue;
      }
      digestProcessed += 1;
      digestStep += 1;
      console.error(
        `[digest] headline ${digestStep}/${toSummarizeCount}（event=${ev.eventId.slice(0, 8)}）`,
      );
      const fields = repFields.get(ev.eventId);
      const forDigest: EventForDigest = {
        eventId: ev.eventId,
        representativeTitle: ev.representativeTitle,
        canonicalUrl: fields?.canonicalUrl ?? null,
        // 补全后正文 + 来源（组 G 5.2 grounding）：headlineOnlyEvent 拼进 prompt；补全失败仍空时
        // buildPrompt 只在非空时拼入、触发无正文防幻觉护栏（组 D）。
        content: fields?.content ?? null,
        source: fields?.source ?? null,
      };
      const outcome = await headlineOnlyEvent(forDigest, options.digest, dbh);
      if (outcome.degraded) digestDegraded += 1;
      if (outcome.status === 'dropped') {
        // 无任何可展示文本 → 剔除出当日日报（绝不推半截）。
        continue;
      }
      // headline（headline_zh 已落库）或 fallback（用 representative_title/URL 回退）
      // 均可推送；dispatcher 优先读 summary_zh，无则用 headline / 展示标题（见 message 渲染）。
      // fallback 时若 representativeTitle 为空，headlineOnlyEvent 已返回 canonical_url 兜底
      // fallbackText；用它覆盖展示标题，避免 message 渲染「(无标题)」。
      const representativeTitle =
        outcome.status === 'fallback'
          ? outcome.fallbackText
          : ev.representativeTitle;
      // 轻量路径 headline 仅 'headline'（成功）变体有；fallback（降级）置 null 走渲染回退链。
      // 必须按 status 收窄，直取 outcome.headlineZh 会因 fallback 变体无此字段 tsc 失败。
      const headlineZh =
        outcome.status === 'headline' ? outcome.headlineZh : null;
      pushable.push({
        eventId: ev.eventId,
        representativeTitle,
        // 日报 digest 不再产 summary_zh（改由 KB 入库回写）；取库内既有值：P0/告警链已产则非空，
        // 否则 null → message 层回退 headline，无回归。
        summaryZh: ev.summaryZh,
        headlineZh,
        canonicalUrl: repFields.get(ev.eventId)?.canonicalUrl ?? null,
        publishedAt: ev.publishedAt,
        rankScore: ev.rankScore,
      });
    }
    if (digestSkipped > 0) {
      console.error(`[digest] 跳过已生成 headline ${digestSkipped} 条`);
    }
    console.error(
      `[pipeline] headline: 送生成 ${digestProcessed} 条（跳过已生成 ${digestSkipped} 条）, 降级 ${digestDegraded} 条, 熔断分母（Top N）${topN.length}`,
    );
    const digestStage: StageDegrade = {
      // digest 阶段熔断分母 = 进入 headline 生成的事件数（Top N，含已缓存跳过者），与 spec/design D4 一致。
      // 降级分子 = 本轮实际送 headline 生成中失败的条数。如此「7 缓存 + 1 新失败」= 1/8 < 阈值不误熔断。
      processed: topN.length,
      degraded: digestDegraded,
    };
    // 摘要阶段独立熔断：分母 > 0 且降级率严格 > 阈值 → 中止 + 告警。
    // 与 judge 各自独立判定——摘要的少量失败绝不被 judge 大分母稀释（D8）。
    if (stageShouldAbort(digestStage, abortRatio)) {
      const rate = stageDegradeRate(digestStage)!;
      console.error(`[pipeline] 熔断: 中文摘要降级率超阈值，中止流水线`);
      // 必须 await：理由同上（紧接着 throw）。
      await alert(
        `中文摘要阶段降级率 ${(rate * 100).toFixed(1)}% 超阈值（${(abortRatio * 100).toFixed(0)}%），中止本次流水线。`,
        { dedupKey: 'degrade-abort:digest', ...digestStage },
      );
      throw new WorkflowAbortError('digest', rate);
    }

    // ── 阶段 5.5：产品段（design D1/D5/D6）——新闻链之后、早退判断之前，在日报锁内执行。
    //    **位置约束**：必在 judge(:326)/digest 熔断 throw **之后**——熔断日整条日报（含新品段）当日
    //    不推、次日 cron 补（design 风险节），故产品段拿不到熔断累加变量、天然不进熔断分母。
    //    P1（塌缩）/P2（候选）均**永不向上抛**（异常转空段+告警），「产品失败不拖垮新闻」由这两个
    //    薄包装保证。productsByChannel **算一次、贯穿早退判断与 dispatch**（dispatch 不重算）。
    //
    //    步骤 P1：产品塌缩一次（channel-blind）。**必在 channel 展开之前只跑一次**——产品塌缩单实例
    //    承载（顺序处理避免同批竞态），若随 per-channel 并发跑 N 次会违反单实例假设。
    await collapseProductsOnce(dbh);
    //    步骤 P1.5：产品中文化一次（channel-blind，design D3）。**必在塌缩之后、per-channel 候选之前**：
    //    中文化候选 = 各 channel 推送候选精确并集（复用 selectProductCandidates 取 product_id 并集）；
    //    UPDATE 中文列后，下方 selectProductsForChannelSafe 再调 selectProductCandidates 读到中文列。
    //    **永不向上抛**（对称 collapseProductsOnce）：中文化失败不进熔断分母、不中止流水线、要闻段不受影响；
    //    整步失败规模异常由 digestPendingProducts 内部 alert 单独告警（系统故障可观测）。
    await digestPendingProducts(
      dbh,
      channelSenders.map((c) => c.channel),
      alert,
    );
    //    步骤 P2：per-channel 产品候选。候选是纯 SELECT 无写竞态、塌缩已在上面单次完成，故可并发。
    //    每 channel 候选包 try/catch（selectProductsForChannelSafe 内），失败 → 该 channel 空新品段。
    const productEntries = await Promise.all(
      channelSenders.map(
        async ({ channel }): Promise<[Channel, SelectedEvent[]]> => [
          channel,
          await selectProductsForChannelSafe(channel, dbh),
        ],
      ),
    );
    const productsByChannel = new Map<Channel, SelectedEvent[]>(productEntries);
    console.error(
      `[pipeline] 产品段: ${channelSenders
        .map((c) => `${c.channel}=${(productsByChannel.get(c.channel) ?? []).length}`)
        .join(', ')}`,
    );

    // ── 可观测（组 G 7.1）：AI 闸门过滤计数（best-effort、仅日志、绝不影响 outcome/熔断）。
    //    暴露被 is_ai_related（false 或 NULL）fail-closed 排除的要闻/新品数，供闸门过/欠触发调参。
    //    整块 try/catch，任何异常仅记日志、不抛断。
    try {
      const gated = await countAiGatedOut(dbh, now);
      console.error(
        `[pipeline] AI 闸门过滤（is_ai_related 非 true 被 fail-closed 排除，仅可观测）：` +
          `要闻约 ${gated.events} 条、新品约 ${gated.products} 条`,
      );
    } catch (error) {
      console.error('[pipeline] AI 闸门过滤计数失败（已隔离，不影响 outcome）', error);
    }

    // ── 阶段 5.6：要闻段↔新品段跨段去重抑制（确定性兜底，design D3/D4）。
    //    位置：productsByChannel 之后、早退判断之前。同一项目既在要闻段又在新品段时，从要闻段
    //    剔除该事件、保留新品段（Show HN/Launch HN 等本质是产品，新品段是其正确归属、带官网链接与
    //    中文简介）。对齐键 = 产品归一三键组（canonical_domain/github_repo/product_hunt_slug），复用
    //    extractProductMergeKeys 两侧一致提取——纯程序确定性键，绝不经 LLM。
    //
    //    (a) 事件侧键**现提取**：对每个 pushable 事件用 repFields.get(eventId)?.canonicalUrl 调
    //        extractProductMergeKeys({url}) 提三键（事件侧只传 url，product_hunt_slug 分支不触发，
    //        github.com 域被该函数置 null、改由 github_repo 精确对齐）。事件侧键**不做 PLATFORM_HOSTS
    //        擦洗**（原样输出，安全性来自下方产品域集排平台 host，见 daily-intel spec）。
    const eventsWithKeys: EventWithKeys[] = pushable.map((event) => {
      const url = repFields.get(event.eventId)?.canonicalUrl ?? null;
      const keys = extractProductMergeKeys({ url });
      return { event, keys };
    });

    //    (b) 产品侧键**无需现提取**：直接读全通道候选携带的**存储三键**（productMergeKeys，由
    //        selectProductCandidates 从 ai_products 存储字段填入），构全通道并集三键集合（满足
    //        Model B channel-blind：只要任一通道会推该产品就剔对应要闻）。**域集 MUST 用命名常量
    //        PLATFORM_HOSTS 排除全部平台 host**——无 website 的 Show HN/PH 产品其 canonical_domain
    //        落成平台 host（producthunt.com/gitlab.com/npmjs.com…），不排除会致该平台 host 的要闻被
    //        mass 误抑制（design D3 一类缺陷）。repos/slugs 不排（走精确键、无平台 host 误抑制问题）。
    const productDomains = new Set<string>();
    const productRepos = new Set<string>();
    const productSlugs = new Set<string>();
    for (const products of productsByChannel.values()) {
      for (const p of products) {
        const k = p.productMergeKeys;
        if (!k) continue; // 事件侧候选不带此字段；理论上产品候选恒带，防御性跳过。
        if (k.canonicalDomain !== null && !PLATFORM_HOSTS.has(k.canonicalDomain)) {
          productDomains.add(k.canonicalDomain);
        }
        if (k.githubRepo !== null) productRepos.add(k.githubRepo);
        if (k.productHuntSlug !== null) productSlugs.add(k.productHuntSlug);
      }
    }

    //    (c) 抑制得 pushableDeduped；后续**早退判断与 dispatch 全改用它**（被剔事件不进 dispatch 的
    //        computePendingSet 入参 → 不写 event push_record → 保留跨天候选资格，次日不再被产品覆盖
    //        即回要闻段，无永久漏推）。
    const { kept: pushableDeduped, suppressedEventIds } = suppressEventsInProducts(
      eventsWithKeys,
      { domains: productDomains, repos: productRepos, slugs: productSlugs },
    );
    if (suppressedEventIds.length > 0) {
      console.error(
        `[pipeline] 跨段去重: 从要闻段抑制 ${suppressedEventIds.length} 条（同项目已在新品段）：` +
          suppressedEventIds.map((id) => id.slice(0, 8)).join(', '),
      );
    }

    // ── 阶段 5.7：实践锦囊段（add-ai-blogger-experience-mining，design D6）——产品段之后、早退判断之前，
    //    在日报锁内执行（搭 daily-digest:{push_date} 锁便车，不新增 queue/cron/独立锁）。三段顺序钉死：
    //      ① runExperienceMiningOnce（channel-blind 单跑：提炼 + 写 ai_experiences，每批只跑一次）
    //      ② runExperienceKbIngestion（channel-blind KB 沉淀，**必在早退之前**——防 KB stranding：
    //         经验入 KB 不以已推送为前提，push-empty 与 KB-empty 是不同集合，放早退之后会漏沉淀新 ≥70 卡片）
    //      ③ per-channel selectExperiencesForChannel 展开推送候选
    //    提炼/KB 沉淀**每批只跑一次**（不 per-channel 重复），失败隔离永不向上抛（不拖垮日报）——
    //    runExperienceMiningOnce / runExperienceKbIngestion 内部已逐条隔离、整步永不抛，此处直接调用。
    //
    //    步骤① 提炼一次（channel-blind）。
    const experienceMiningResult = await runExperienceMiningOnce(
      { ...options.experienceMining },
      dbh,
    );
    console.error(
      `[pipeline] 实践锦囊提炼: 候选 ${experienceMiningResult.candidates} 条, 提炼写库 ${experienceMiningResult.mined} 条, ` +
        `提炼降级 ${experienceMiningResult.miningFailed} 条, 写库失败 ${experienceMiningResult.storeFailed} 条（失败隔离、不计入熔断）`,
    );
    //    步骤② KB 沉淀一次（channel-blind，**早退之前**）。now 注入使 eventDate NULL 回退当日 pushDate 与 push 同源。
    const experienceKbResult = await runExperienceKbIngestion(
      { now, ...options.experienceKb },
      dbh,
    );
    console.error(
      `[pipeline] 实践锦囊 KB 沉淀: 候选 ${experienceKbResult.candidates} 条, 入库 ${experienceKbResult.ingested} 条, ` +
        `认领跳过 ${experienceKbResult.skippedClaimed} 条, 写入失败 ${experienceKbResult.storeFailed} 条（失败隔离、不计入熔断）`,
    );
    //    步骤③ per-channel 推送候选（纯 SELECT 无写竞态，可并发；提炼/KB 已在上面单次完成）。
    //    selectExperiencesForChannel 内已含 long_term_value >= KB_ADMISSION_FLOOR + recency 窗口 +
    //    「从未以该 channel success」anti-join + Top N 排序（组 D 实现，此处只调用不重写谓词）。
    const experienceEntries = await Promise.all(
      channelSenders.map(
        async ({ channel }): Promise<[Channel, SelectedEvent[]]> => [
          channel,
          await selectExperiencesForChannel(channel, dbh, {
            now,
            ...options.experienceSelect,
          }),
        ],
      ),
    );
    const experiencesByChannel = new Map<Channel, SelectedEvent[]>(
      experienceEntries,
    );
    console.error(
      `[pipeline] 实践锦囊段: ${channelSenders
        .map((c) => `${c.channel}=${(experiencesByChannel.get(c.channel) ?? []).length}`)
        .join(', ')}`,
    );

    // ── 阶段 6：多通道推送（向所有已配置通道并发分发，单消息原子 + push_records 幂等，G6）。
    //    早退（三元，design D6 命门）：新闻 Top N（**抑制后** pushableDeduped）空 **∧** 所有 channel
    //    的产品候选皆空 **∧** 所有 channel 的经验候选皆空才不推；任一段非空都不早退（防纯经验日漏推——
    //    无新闻无产品但有高价值经验时仍须推实践锦囊）。仅部分段空时仍推非空段（各 dispatch 内逐 channel 再判）。
    emit('stage.push');
    if (
      pushableDeduped.length === 0 &&
      [...productsByChannel.values()].every((p) => p.length === 0) &&
      [...experiencesByChannel.values()].every((x) => x.length === 0)
    ) {
      // 新闻 Top N 空（摘要分母 = 0 或全被剔除）且所有 channel 产品候选、经验候选亦空 → 无可推，正常
      // 结束（不告警、不中止）。仅部分段空不在此早退（落到下方逐 channel dispatch 推非空段）。
      console.error(`[pipeline] 推送: 新闻、产品与经验候选皆空 → skipped-no-candidates`);
      emit('outcome.skipped-no-candidates', { pushDate });
      return {
        outcome: 'skipped-no-candidates',
        pushDate,
        collectedCount,
        newsProcessableCount,
        judge: judgeStage,
        digest: digestStage,
        topNCount: topN.length,
        alerted,
        publishedAtBackfill: backfillStats,
        ...(enrichResult ? { enrichment: enrichResult } : {}),
        ...(semanticResult ? { semantic: semanticResult } : {}),
        experienceMining: experienceMiningResult,
        experienceKb: experienceKbResult,
      };
    }

    // 防丢锁双发（Codex C3 消费端）：dispatch 前核对仍真正持有锁。看门狗发现锁被抢/过期
    // 会置租约已失 → isHeld() 返 false。此时**绝不**再发送（否则与抢锁的第二实例双发）。
    // 但绝不能返回成功的 'skipped-no-candidates'（BullMQ 不重试 → 把「租约已失」误标「无候选」，
    // 当日 Top N 漏发到次日）。改为告警 + 抛错使整 job 重试：重试会重新 acquireDigestLock（单例锁
    // 保证不双发）+ 待发集合 = 今日 Top N MINUS 今日已 success（已发不重发、未发补发），故幂等安全。
    if (!lock.isHeld()) {
      console.error(
        `[pipeline] 租约已失（锁被抢占/过期），中止本次以触发重试，避免静默漏发`,
      );
      // 必须 await：理由同上（紧接着 throw）。
      await alert(`日报推送前租约已失（锁被抢占/过期），中止本次并触发重试。`, {
        dedupKey: 'digest-lease-lost',
        pushDate,
        topNCount: topN.length,
      });
      throw new Error(
        `digest lease lost: push_date=${pushDate} 推送前租约已失，抛错使 BullMQ 同日重试，避免静默漏发。`,
      );
    }

    // 向**所有已配置通道并发分发**（daily-intel-pipeline / feishu-push）。channelSenders 已在阶段 4
    // 解析（与 selectTopN 候选共用同一通道集）。各通道走 dispatcher 的**双段**状态机
    // dispatchDailyDigest（要闻段 = pushableDeduped〔跨段抑制后〕，新品段 = productsByChannel.get(channel)；
    // 待发集合各按 per-channel 跨天「从未 success」判定）——一条「AI Radar 每日情报」含要闻 + 新品两段、各自幂等。
    console.error(
      `[pipeline] 推送: 待发要闻 ${pushableDeduped.length} 条（跨段抑制后），向 ${channelSenders.length} 个通道并发分发：` +
        channelSenders.map((c) => c.channel).join(', '),
    );

    // **并发分发 + 单通道失败隔离**（Promise.allSettled）：某通道发送失败（dispatch.outcome
    // ='failed' 或 dispatch 自身抛错）只记录该 channel 的 failed、绝不拖垮另一通道——另一通道
    // 照常完成推送。全部 settle 后再统一汇总（成功通道已写 success，失败通道已写 failed）。
    // 产品段 productsByChannel 在阶段 5.5 **算一次**，此处直接复用 .get(channel)、不重算。
    //
    // 每通道分发**两条独立消息**：① 日报双段（要闻 + 新品，dispatchDailyDigest）；② 实践锦囊
    // （经验候选，dispatchDigest + targetType='experience'，与 event/product/alert/weekly 各自独立
    // 幂等命名空间、互不挤占）。任一条失败 → 该 channel 视为失败、整 job 抛错触发重试（重试时
    // computePendingSet 排除已 success 条目、只补未发，幂等安全；experience 候选 anti-join 同理跨天/同日不重推）。
    const settled = await Promise.allSettled(
      channelSenders.map(async ({ channel, sender }): Promise<ChannelDispatch> => {
        const daily = await dispatchDailyDigest(
          pushableDeduped,
          productsByChannel.get(channel) ?? [],
          { now, sender, channel },
          dbh,
        );
        // 实践锦囊单段推送（experience 候选可能为空 → dispatchDigest 返回 'skipped'、不发消息）。
        const experience = await dispatchDigest(
          experiencesByChannel.get(channel) ?? [],
          { now, sender, channel, targetType: TARGET_TYPE.experience },
          dbh,
        );
        return { channel, dispatch: daily, experience };
      }),
    );

    const failedChannels: string[] = [];
    let anySent = false;
    settled.forEach((res, idx) => {
      const channel = channelSenders[idx]!.channel;
      if (res.status === 'fulfilled') {
        const { dispatch, experience } = res.value;
        console.error(
          `[pipeline] 推送[${channel}]: 日报 outcome=${dispatch.outcome}, 实践锦囊 outcome=${experience.outcome}`,
        );
        // 任一段 failed → 该 channel failed；任一段 sent → 该 channel 有实发（anySent）。
        if (dispatch.outcome === 'failed' || experience.outcome === 'failed') {
          failedChannels.push(channel);
        }
        if (dispatch.outcome === 'sent' || experience.outcome === 'sent') {
          anySent = true;
        }
      } else {
        // dispatch 抛错（如渲染/DB 异常）：该通道视为失败、隔离，不拖垮另一通道。
        const reason =
          res.reason instanceof Error ? res.reason.message : String(res.reason);
        console.error(`[pipeline] 推送[${channel}]: 异常隔离 ${reason}`);
        failedChannels.push(channel);
      }
    });

    // 任一通道失败 → 整 job 失败（抛错）使 BullMQ 同 push_date 重试。重试时：成功通道的待发
    // 集合 = 今日 Top N MINUS 该 channel 今日已 success（已发不重发，幂等安全）；失败通道的
    // failed 条目重新纳入该 channel 待发集合重发（对齐 telegram-push「failed 下次重试」+ D5/D6）。
    // **分发失败由「单通道隔离 + failed 重试」承载，不计入 judge/摘要熔断分母**（已在前面分别熔断）。
    if (failedChannels.length > 0) {
      throw new Error(
        `digest dispatch failed: push_date=${pushDate} 通道 [${failedChannels.join(', ')}] ` +
          `发送失败（已置 failed），其余通道已完成；抛错使 BullMQ 同日重试失败通道。`,
      );
    }

    // ── 阶段 7：知识库入库（P3 KB 层，spec「知识库准入闸只入精选」/ design D7，6.2）。
    //    **位置约束**：必在 push **成功之后**（无 failedChannels 才到此）——候选 = 当日 `push_records.status
    //    ='success'` 且 `merged_into IS NULL`（非 tombstone）的 event（runKbIngestion 内部据 now→push_date
    //    选候选）。对齐 config 流水线 `Push → KB Ingestion` 顺序，控成本（只入已推送高价值事件）。
    //    **永不向上抛 + 不进熔断分母**：KB 阶段失败绝不污染既有 outcome（已 pushed）/不触发既有熔断/不重试整 job
    //    （push 已 success，整 job 抛错会致 BullMQ 重跑日报、徒增重复 push 风险）。故整段包 try/catch：
    //    runKbIngestion 内部已逐条隔离（Agent/embed/写入失败跳过该条、认领状态感知幂等），此处再兜一层
    //    防御性 catch（如选候选 SELECT 异常），任何异常仅记日志、不抛断、不影响 outcome（语义/KB 层独立于熔断）。
    emit('stage.kb');
    let kbResult: KbIngestionResult | undefined;
    try {
      kbResult = await runKbIngestion({ now, ...options.kb }, dbh);
      console.error(
        `[pipeline] 知识库入库: 候选 ${kbResult.candidates} 条, Agent 成功 ${kbResult.agentOk}/失败 ${kbResult.agentFailed}, ` +
          `准入闸拦下 ${kbResult.gatedOut} 条, 入库 ${kbResult.ingested} 条, ` +
          `认领跳过 ${kbResult.skippedClaimed} 条, 写入失败 ${kbResult.storeFailed} 条（不计入熔断、不阻塞 outcome）`,
      );
    } catch (error) {
      // 防御性兜底：KB 阶段任何未被内部隔离的异常都不向上抛、不污染已成功的 push outcome。
      console.error(
        `[pipeline] 知识库入库阶段异常（已隔离，不影响日报推送 outcome）`,
        error,
      );
    }

    const finalOutcome: WorkflowOutcome = anySent ? 'pushed' : 'skipped-no-candidates';
    emit('outcome.' + finalOutcome, { pushDate });
    return {
      // 所有通道均非 failed：有任一 'sent' → pushed；否则（全 skipped，如各通道今日已 success）
      // → skipped-no-candidates。
      outcome: finalOutcome,
      pushDate,
      collectedCount,
      newsProcessableCount,
      judge: judgeStage,
      digest: digestStage,
      topNCount: topN.length,
      alerted,
      publishedAtBackfill: backfillStats,
      ...(enrichResult ? { enrichment: enrichResult } : {}),
      ...(semanticResult ? { semantic: semanticResult } : {}),
      ...(kbResult ? { kb: kbResult } : {}),
      experienceMining: experienceMiningResult,
      experienceKb: experienceKbResult,
    };
  } finally {
    await lock.release();
  }
}

/**
 * 薄 run(ctx) 包装（Phase A0，design D2/D4）：把 driver 无关的 RunContext 映射到 runDailyWorkflow
 * 核心的运维子集（emit + 可选 now，其余 DI 走生产默认），委托核心；抛错时 emit 一条 run.failed 终态
 * 后 RE-THROW 原错误（run(ctx) 仍 reject → BullMQ job 失败可重试，守 worker.ts 整 job 重试外壳）。
 * ctx.trigger 恒为 'digest'（design D9），A0 不 switch。现有集成测试 / smoke 仍直调
 * runDailyWorkflow(options) 注入 mock，不受影响（核心签名仅新增可选 emit）。
 */
export async function run(
  ctx: RunContext,
  // ponytail: 测试缝——默认委托生产核心；单测注入抛错桩验证 run.failed emit + re-throw 契约（2.2）。
  //           worker/生产调 run(ctx) 单参走默认核心。DI 仍留 options、不进 ctx（design D2）。
  core: typeof runDailyWorkflow = runDailyWorkflow,
): Promise<RunDailyWorkflowResult> {
  const input = (ctx.input ?? {}) as { now?: Date };
  try {
    return await core({
      emit: ctx.emit,
      // 生产装配的运维告警出口（这里是真正的注入点——worker.ts 调的是 run(ctx)，自身不拼 options）。
      // 不注入则回落 consoleAlertSink：告警只进 stderr、没人会被叫醒。
      alert: buildOpsAlertSink(),
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (err) {
    ctx.emit('run.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * 给日报采集选项注入默认 arXiv 增量游标（at-least-once 接线，source-collectors / design D3）。
 *
 * 仅当调用方**未**自带 arxiv 采集选项时注入固定回溯窗口游标（`createLookbackArxivCursorStore`，
 * 见 arxiv-cursor.ts）——使日报每轮按「近 7 天回溯窗口」增量采集 arXiv（非每轮全量、非固定一点），
 * 无漏窗 + crash-safe 由「窗口重叠 + UNIQUE(source, source_item_id) 幂等」保障，无需持久化游标。
 *
 * 不覆盖调用方注入：测试注入 `collect.arxiv`（自带游标/桩）或 `collect.collectors.arxiv`（mock
 * collector）时原样保留，保证用例对采集行为的精确控制。arXiv 只在日报链注入（实时告警链不采 arXiv）。
 */
function withDefaultArxivCursor(
  collect: CollectAllOptions | undefined,
): CollectAllOptions {
  const base = collect ?? {};
  // 调用方已注入 arxiv 采集选项（含其自带 cursor）→ 原样保留，不覆盖。
  if (base.arxiv !== undefined) return base;
  return { ...base, arxiv: { cursor: createLookbackArxivCursorStore() } };
}

/** 单通道分发结果（供 Promise.allSettled 汇总）。汇总读日报双段 dispatch.outcome + 实践锦囊 experience.outcome。 */
interface ChannelDispatch {
  channel: Channel;
  /** 日报双段（要闻 + 新品）分发结果。 */
  dispatch: DailyDispatchResult;
  /** 实践锦囊单段（experience）分发结果（候选空时 outcome='skipped'）。 */
  experience: DispatchResult;
}

/**
 * 解析「已配置通道集 + 各通道 sender」（feishu-push 5.3 / daily-intel-pipeline）。
 *
 * 通道集：默认按 env 计算——恒含 telegram（必配）；isFeishuEnabled() 为真时加 feishu。
 * 可由 options.channels 覆盖（测试用，无需真实 FEISHU env）。
 * 各通道 sender：优先 options.senders[channel]；telegram 兼容 options.sender；
 * 否则按 env 构造真实 sender（telegram→grammY、feishu→webhook）。
 */
function resolveChannelSenders(
  options: RunDailyWorkflowOptions,
): Array<{ channel: Channel; sender: MessageSender }> {
  const channels: Channel[] = options.channels
    ? [...options.channels]
    : isFeishuEnabled()
      ? [CHANNEL.telegram, CHANNEL.feishu]
      : [CHANNEL.telegram];

  return channels.map((channel) => {
    const injected = options.senders?.[channel];
    if (injected) return { channel, sender: injected };
    if (channel === CHANNEL.telegram) {
      return { channel, sender: options.sender ?? createTelegramSender() };
    }
    // channel === 'feishu'：按 env 构造真实 webhook sender（仅在 enabled 时才会走到此处）。
    return { channel, sender: createFeishuSender() };
  });
}
