/**
 * 实时重大发布告警高频工作流（realtime-alerts，design D6）。
 *
 * 一个**独立于 runDailyWorkflow** 的高频轻量工作流（独立 BullMQ 调度入口，频率 env 可配，
 * 默认 4-59/15，15 分钟节奏）。纯顺序确定性流：
 *   采集（**只跑实时新闻源 {rss, hacker_news, github, sitemap}**，排除 arXiv 非实时 / PH 配额受限；
 *     sitemap 的稳态每轮成本 = 1 次 sitemap.xml GET + 1 次已见集查询——已见集去重在 per-article
 *     fetch 之前 + first-fetch-wins，见 collectors/index.ts 的 REALTIME_NEWS_SOURCES 注释）
 *   → 入库 → 去重塌缩
 *   → 对未评分事件评分（与日报链共用 scoreUnscoredEvents，含并发原子 claim 防双评分）
 *   → **评分后**判告警闸 `importance_score IS NOT NULL AND is_ai_related = true AND >= 阈值`
 *     （阈值默认 85，env 可配，纯程序判定；AI 闸 fail-closed，见 alert-gate.ts 共享构造器）
 *   → 对达阈值且「从未以该 channel success 告警过」的事件推送告警
 *
 * 关键不变量（绝不可违背，realtime-alerts / design D6）：
 * - **判定必在评分后**：importance_score 评分前为 NULL（`NULL >= 85` 恒假），阈值判定查 SQL
 *   `importance_score IS NOT NULL AND >= 阈值`——评分阶段已先于本判定执行，绝不以 NULL 误判。
 * - **候选时效闸键于 `published_at`（绝不基于 `first_seen_at`）**：候选窗口为闭区间
 *   `lowerBound <= published_at <= now`——下界 `gte(published_at, lowerBound)` 拦超窗老文（lowerBound
 *   与日报候选同源 startOfDayInTimeZone，防冷启动/新增源把历史老文误当重大发布刷屏），上界
 *   `lte(published_at, now)` 拦确定性来源（RSS/GitHub）与 AI 的任何未来值（未来值 `>= 下界` 恒真会
 *   绕过下界闸被当重大发布告警，故上界绝不可省）。`published_at` 为 NULL 者经 AI 推断回填、仍 NULL
 *   则被时效闸自然排除（Drizzle gte/lte 对 NULL 返回假）。`windowDays=0`（不限窗口）旁路**只免下界**
 *   gte，**不免** NULL 排除与未来上界——旁路时候选条件退化为 `published_at IS NOT NULL AND
 *   published_at <= now`（须显式 isNotNull + lte，否则旧 NULL/未来事件会绕过修复刷屏）。单次扫描
 *   上限取序按 `published_at DESC`（取最新发布）。`first_seen_at` 语义不变（仍记首次抓取，供调试/
 *   僵尸 claim 回收），**不再**用于告警时效过滤。
 * - **非 LLM 决定**：是否告警完全由程序阈值决定，禁止 LLM 参与。
 * - **不做语义去重 / 不做 KB 入库**（add-semantic-dedup-and-store-hardening 6.3，spec「语义去重仅作用于
 *   日报链新闻事件」）：本高频链恒走硬去重快路径，**绝不**调 semanticMergeEvents（embedding/LLM 二次
 *   判断/事件合并）或 runKbIngestion——语义层与 KB 入库**仅日报链**执行。日报链合并产生的 tombstone
 *   仍存于库，故 selectAlertCandidates 仍须排除 `merged_into IS NOT NULL`（已加，组 4.7），但本链不**产生**合并。
 * - **高频链路不套用日报「全源 0」系统级告警**：高频轮询全源 0 / 空轮是常态，本工作流**不调**
 *   classifySystemFailure（否则每天数十次误告警刷屏，见 daily-intel-pipeline）。**但「不做全源 0
 *   告警」不蕴含「不做源级健康告警」**（p0-alert-lane C1.3 / design D11②）：两条判据不同（前者判
 *   「整轮全挂」，后者判「某一个源结构性失败」）——本链与日报链都消费 perSource，对 ok=false 的
 *   结构性失败发 dedupKey='source-health:<source>' 告警（共用同一个判定与同一个 dedupKey，见阶段 1）。
 * - **独立四元组**：`target_type='alert'`、`target_id=event_id`、`push_date=触发当日(Asia/Shanghai)`，
 *   与日报 `event` 互不挤占（日报已推同一事件不吞掉告警）。
 * - **一生一次去重**：候选「该 event_id 从未以该 channel success 告警过」管跨天；
 *   `UNIQUE(alert,event_id,channel,push_date)` 兜底同日并发（dispatcher 状态机承载）。
 * - **独立单例锁** `alert:{event_id}`（per-event，覆盖该事件向所有通道的分发）：job 级短时持有 + TTL/finally 释放（锁键无时间，
 *   无 TTL 且崩溃未释放会永久死锁该事件告警，故释放语义不可省）。
 * - **failed 告警跨天可重试**：一生一次约束的是 `success` 唯一；failed 当日按 dispatcher 置 failed，
 *   事件仍「从未 success 告警」满足候选窗口，新 push_date 可重试。
 * - **状态机复用**：告警推送复用 dispatcher 同一「待发→pending→原子送达→success/failed」状态机
 *   （含 headline 缺失回退链——告警事件可能尚无中文摘要），仅 target_type/channel 口径不同。
 */
import { and, desc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, pushRecords, rawItems } from '../db/schema.js';
import {
  env,
  isFeishuEnabled,
  alertMinPublishedAt,
  ALERT_JUDGE_MAX_PER_RUN,
} from '../config/env.js';
import { digestEvent } from '../agents/digest/persistence.js';
import type { SummarizeOptions } from '../agents/digest/index.js';
import {
  collectSources,
  REALTIME_NEWS_SOURCES,
  storeCollectedItems,
  type CollectAllOptions,
} from '../collectors/index.js';
import { collapseUncollapsedRawItems } from '../dedup/collapse.js';
import {
  scoreUnscoredEvents,
  type ScoreEventsOptions,
} from '../agents/value-judge/score-events.js';
import {
  dispatchDigest,
  type MessageSender,
} from '../push/dispatcher.js';
import { createTelegramSender } from '../push/telegram.js';
import { createFeishuSender } from '../push/feishu.js';
import { CHANNEL, TARGET_TYPE, type Channel } from '../push/targets.js';
import type { SelectedEvent } from '../selection/top-n.js';
import { getPushDate, startOfDayInTimeZone } from '../push/push-date.js';
import { acquireAlertLock, type AcquireAlertLockOptions } from './alert-lock.js';
import { alertGatePredicate } from './alert-gate.js';
import {
  buildOpsAlertSink,
  consoleAlertSink,
  type AlertSink,
} from './ops-alert-sink.js';
import { isBenignRateLimit } from './source-health.js';
import { backfillPublishedAt } from '../agents/published-at-inference/backfill.js';
import type { InferPublishedAtOptions } from '../agents/published-at-inference/index.js';
import type { RunContext } from './run-context.js';

type DbLike = typeof defaultDb;

/** 告警 sink（仅用于运行期可观测日志；高频链路**不**做日报式系统级告警）。 */
export type AlertLogSink = (message: string, detail?: unknown) => void;

const defaultLog: AlertLogSink = (message, detail) =>
  console.error(`[alert-scan] ${message}`, detail ?? '');

export interface RunAlertScanOptions {
  /** 参考时刻，决定 push_date（告警触发当日，Asia/Shanghai）（默认当前时刻）。 */
  now?: Date;
  /** 注入 db 或事务句柄（默认全局 db）。 */
  dbh?: DbLike;
  /** 采集层选项（注入 mock collector）。仅作用于实时新闻源子集。 */
  collect?: CollectAllOptions;
  /** Value Judge 评分阶段选项（注入 mock generateObject、reclaimMs 等）。 */
  judge?: ScoreEventsOptions;
  /** 告警阈值覆盖（默认 env.ALERT_IMPORTANCE_THRESHOLD）。 */
  threshold?: number;
  /** 候选时间窗口（天数，默认 env.ALERT_FIRST_SEEN_WINDOW_DAYS=3）。0 表示不限。 */
  windowDays?: number;
  /** 单次 scan 最多发送条数（默认 env.ALERT_MAX_PER_SCAN=5），防 Telegram rate limit。 */
  maxPerScan?: number;
  /**
   * 覆盖「已配置通道集」（测试用）。默认按 env：恒含 telegram，isFeishuEnabled() 为真加 feishu。
   */
  channels?: readonly Channel[];
  /** 各通道发送器显式注入（测试注入 mock）；否则按 env 构造真实 sender。 */
  senders?: Partial<Record<Channel, MessageSender>>;
  /** 告警单例锁选项（注入 mock Redis / TTL）。 */
  lock?: AcquireAlertLockOptions;
  /**
   * 中文摘要打磨注入：对入选候选缺中文标题/摘要者跑 digestEvent 时的 SummarizeOptions
   * （注入 mock generateObjectFn / maxAttempts / logError）。缺省用真实摘要 Agent；测试注入桩避免真实 LLM。
   */
  digest?: SummarizeOptions;
  /** 运行期日志 sink（默认 console.error）。 */
  log?: AlertLogSink;
  /**
   * 运维告警出口（源级健康告警，p0-alert-lane C1.3 / design D11②）：对本轮 perSource.ok=false 的
   * 结构性失败发 dedupKey='source-health:<source>' 告警。未注入回落 stderr 的 consoleAlertSink
   * （不静默）；**生产由本文件的 run(ctx) 包装注入 buildOpsAlertSink**（与日报链
   * run-daily-workflow.ts 的 run() 同型）——只加字段不接线等于把注入口留给测试自己填。
   */
  alert?: AlertSink;
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
   * run-event 发射钩子（Phase A0，design D3/D4）：阶段进入 / 逐 channel 结局时经它发一条粗粒度事件；
   * **缺省 no-op**。由薄 run(ctx) 包装注入 ctx.emit；直调核心的测试不传则静默。DI 仍留 options（design D2）。
   */
  emit?: RunContext['emit'];
}

/** 单条告警的发送结果。 */
export interface AlertDispatchOutcome {
  eventId: string;
  channel: Channel;
  /** 'sent' 已告警 / 'failed' 发送失败（跨天可重试）/ 'skipped-locked' 未抢到单例锁 /
   *  'skipped' 待发为空（同日已 success 或并发 UNIQUE 兜底）。 */
  outcome: 'sent' | 'failed' | 'skipped-locked' | 'skipped';
}

/** 高频告警工作流结果（供 worker / 可观测 / 测试断言）。 */
export interface RunAlertScanResult {
  pushDate: string;
  /** 实时新闻源采集返回条数（不含 arXiv/PH，那两源本链路不采）。 */
  collectedCount: number;
  /** 本轮评分阶段实际送判数（claim 成功）。 */
  judged: number;
  /** 评分后达阈值且「从未以该 channel success 告警」的候选事件数（去重后、按事件计）。 */
  alertCandidateCount: number;
  /** 各通道各事件的告警发送结果。 */
  dispatched: AlertDispatchOutcome[];
}

/** 评分后达阈值告警候选的最小视图（供拼告警消息 + 渲染回退链 + P0 可观测）。 */
interface AlertCandidate {
  eventId: string;
  representativeTitle: string | null;
  summaryZh: string | null;
  headlineZh: string | null;
  publishedAt: Date | null;
  canonicalUrl: string | null;
  /** 代表 raw_item 正文/来源：仅供补摘要 grounding（与日报同源），非渲染字段。 */
  content: string | null;
  source: string | null;
  /** 命中阈值的 importance_score（供 P0 质量可观测抽检；numeric 列解析为 number）。 */
  importanceScore: number | null;
}

/**
 * 查「评分后达阈值且从未以任一通道 success 告警过」的候选事件（realtime-alerts 一生一次）。
 *
 * 条件（全在 SQL 程序层，无 LLM）：
 *   告警闸（alertGatePredicate 共享构造器）：importance_score IS NOT NULL（判定必在评分后，NULL
 *     不误判）AND is_ai_related = true（AI 闸 fail-closed，false/NULL 一律排除，不含 should_push）
 *     AND importance_score >= 阈值
 *   AND NOT EXISTS (push_records WHERE target_type='alert' AND target_id=event_id
 *                     AND status='success')   ← 任一通道从未 success 告警（channel-agnostic）
 *   AND 时效闸（闭区间）：windowDays>0 → lowerBound <= published_at <= now（下界隐含非 NULL）；
 *       windowDays=0 旁路 → published_at IS NOT NULL AND published_at <= now（只免下界 gte、不免
 *       NULL 排除与未来上界）。键于 published_at（非 first_seen_at）、上界拦未来值、NULL 即排除。
 *
 * **统一模型（Model B）**：选题与通道解耦——channel-agnostic 选出「该告警的事件」，再由 runAlertScan
 * 同份发放给所有已配置通道（通道只负责投递上游统一选好的信息）。跨天去重靠「从未 success（任一通道）」
 * 候选窗口；同日并发由 `UNIQUE(alert,event_id,channel,push_date)` 兜底（dispatcher 状态机）。
 * canonical_url 经 representative_raw_item_id 回指 raw_items（供告警消息渲染原文链接）。
 */
export async function selectAlertCandidates(
  threshold: number,
  dbh: DbLike = defaultDb,
  channels: readonly Channel[] = [CHANNEL.telegram],
  now: Date = new Date(),
  windowDays: number = env.ALERT_FIRST_SEEN_WINDOW_DAYS,
  maxCandidates: number = env.ALERT_MAX_PER_SCAN,
  // 首次启用发布时间基线水位（守 policy-push-timeliness）：非 null 时叠加候选谓词
  // published_at >= 此基线。缺省经 alertMinPublishedAt() 从 env 解析一次（未设/空串 opt-out → null）。
  minPublishedAt: Date | null = alertMinPublishedAt(),
): Promise<AlertCandidate[]> {
  const cfgChannels = channels.length > 0 ? channels : [CHANNEL.telegram];
  // Model B + 各通道可靠补发：候选 = 「尚未 alert-success 投递给**所有**已配置通道」——已 alert-success
  // 的 distinct 通道数 < 配置通道数（还差任一通道）。失败通道使事件留在统一名单、由 dispatcher 按
  // per-channel 跨天补发该通道告警；一旦所有通道都 alert-success → 移出（不再重选、一生一次）。
  const alertedChannelCount = sql<number>`(
    select count(distinct ${pushRecords.channel})
    from ${pushRecords}
    where ${pushRecords.targetType} = ${TARGET_TYPE.alert}
      and ${pushRecords.targetId} = ${aiNewsEvents.eventId}
      and ${pushRecords.status} = 'success'
      and ${pushRecords.channel} in (${sql.join(
        cfgChannels.map((c) => sql`${c}`),
        sql`, `,
      )})
  )`;
  const notAlertedToAllChannels = sql`${alertedChannelCount} < ${cfgChannels.length}`;

  // 时效闸下界：键于 published_at（非 first_seen_at），与日报候选窗口同源（startOfDayInTimeZone），
  // 防冷启动/新增源把历史老文（first_seen_at=今天但 published_at 旧）误当重大发布刷屏。
  // windowDays=0 表示不限窗口（向后兼容旧行为，不推荐）；>0 时仅选 published_at 在近 N 天内的事件。
  const lowerBound = windowDays > 0 ? startOfDayInTimeZone(now, windowDays - 1) : null;

  const rows = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      representativeTitle: aiNewsEvents.representativeTitle,
      summaryZh: aiNewsEvents.summaryZh,
      headlineZh: aiNewsEvents.headlineZh,
      publishedAt: aiNewsEvents.publishedAt,
      importanceScore: aiNewsEvents.importanceScore,
      // canonical_url 经 representative_raw_item_id LEFT JOIN 回指 raw_items（采集期 normalizeUrl
      // 已去 utm/ref 等追踪参数）。**LEFT JOIN（非 INNER）**：representative_raw_item_id 为 NULL 或
      // 对应 raw_item 已被塌缩删除时，此列为 NULL 但事件仍留候选（消息无链接、不报错）——绝不因回指
      // 失败丢候选造成漏告警（漏告警比无链接更糟）。
      canonicalUrl: rawItems.canonicalUrl,
      // 代表 raw_item 正文 + 来源：供入选候选补摘要时 grounding（与日报 loadRepresentativeFields
      // 同源）。缺此则告警链生成无正文的 title-only 摘要并持久化，被日报「已摘要守卫」复用 → 降级
      // 日报对该 P0 事件的摘要质量；同经 LEFT JOIN 取，NULL 时防幻觉护栏照旧、不报错。
      content: rawItems.content,
      source: rawItems.source,
    })
    .from(aiNewsEvents)
    .leftJoin(rawItems, eq(aiNewsEvents.representativeRawItemId, rawItems.id))
    .where(
      and(
        // 告警闸（共享构造器，p0-alert-lane A3）：已评分（NULL 不误判）∧ is_ai_related=true
        // （fail-closed，false/NULL 一律排除）∧ importance>=阈值。与回填域（backfill.ts scopePredicate
        // alert 分支）同调同一构造器——回填域 == 告警闸的共享谓词段，结构上杜绝漂移（design D3）。
        alertGatePredicate(threshold),
        // P3 tombstone 排除（合并核心闭环）：不对已被日报链合并掉的死 event_id 告警（spec「tombstone
        // 对所有下游消费者不可见」）。注：告警链不调语义合并，但日报链合并的 tombstone 仍存于库中。
        isNull(aiNewsEvents.mergedInto),
        notAlertedToAllChannels,
        // 时效闸下界（闭区间下半）：windowDays>0 → published_at >= lowerBound（gte 对 NULL 返回假，
        // 隐含排除 NULL）；windowDays=0 旁路 → 只免下界 gte，但仍须 isNotNull(published_at) 排除
        // NULL（旁路不免 NULL 排除，否则旧/未推断成功的 NULL 事件会绕过修复刷屏）。
        lowerBound !== null
          ? gte(aiNewsEvents.publishedAt, lowerBound)
          : isNotNull(aiNewsEvents.publishedAt),
        // 时效闸上界（恒含，任何 windowDays 都加）：published_at <= now 拦确定性来源（RSS/GitHub）与
        // AI 的任何未来值（未来值 `>= 下界` 恒真会绕过下界闸被当重大发布告警，故上界绝不可省）。
        lte(aiNewsEvents.publishedAt, now),
        // 首次启用发布时间基线水位（守 policy-push-timeliness）：非 null 时叠加
        // published_at >= 基线——与时效下界同为 published_at 上的 gte，DB 自然取 max（有效下界 =
        // max(时效下界, 基线)）。只告警启用后发布的新闻，启用前发布的存量（无论何时被评分、无论后加了
        // 哪个通道）一律排除。谓词在 published_at、不写任何 push_records 假记录；未设（null）则不加。
        minPublishedAt !== null ? gte(aiNewsEvents.publishedAt, minPublishedAt) : undefined,
      ),
    )
    // 单次扫描上限：优先最新发布事件（published_at DESC），超出 maxCandidates 的下轮补发。
    .orderBy(desc(aiNewsEvents.publishedAt))
    .limit(maxCandidates);

  return rows.map((r) => ({
    eventId: r.eventId,
    representativeTitle: r.representativeTitle,
    summaryZh: r.summaryZh,
    headlineZh: r.headlineZh,
    publishedAt: r.publishedAt,
    // numeric 列经 drizzle 返回 string；解析成 number 供 P0 可观测（NULL 已被 isNotNull 谓词排除）。
    importanceScore: r.importanceScore !== null ? Number(r.importanceScore) : null,
    // LEFT JOIN 回指的规范化原文链接（无回指 / raw_item 已删 → NULL，渲染无链接、不报错）。
    canonicalUrl: r.canonicalUrl,
    content: r.content,
    source: r.source,
  }));
}

/** 把告警候选映射为 dispatcher 输入的 SelectedEvent（headline 缺失走 dispatcher 渲染回退链）。 */
function toSelectedEvent(c: AlertCandidate): SelectedEvent {
  return {
    eventId: c.eventId,
    representativeTitle: c.representativeTitle,
    summaryZh: c.summaryZh,
    headlineZh: c.headlineZh,
    canonicalUrl: c.canonicalUrl,
    publishedAt: c.publishedAt,
    rankScore: 0, // 告警不排序；占位。
  };
}

/**
 * 解析「已配置通道集 + 各通道 sender」（同 run-daily-workflow，告警链复用同一通道集口径）。
 */
function resolveChannelSenders(
  options: RunAlertScanOptions,
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
      return { channel, sender: createTelegramSender() };
    }
    return { channel, sender: createFeishuSender() };
  });
}

/**
 * 跑一次实时告警高频扫描（纯顺序）。
 *
 * @param options 注入点（now / db / collect mock / judge mock / threshold / channels / senders / lock / log / alert）。
 */
export async function runAlertScan(
  options: RunAlertScanOptions = {},
): Promise<RunAlertScanResult> {
  const now = options.now ?? new Date();
  const dbh = options.dbh ?? defaultDb;
  const log = options.log ?? defaultLog;
  // 源级健康告警出口（C1.3）：未注入回落 stderr 的 consoleAlertSink（不静默）；生产由 run(ctx) 注入。
  const alert = options.alert ?? consoleAlertSink;
  const threshold = options.threshold ?? env.ALERT_IMPORTANCE_THRESHOLD;
  const windowDays = options.windowDays ?? env.ALERT_FIRST_SEEN_WINDOW_DAYS;
  const maxPerScan = options.maxPerScan ?? env.ALERT_MAX_PER_SCAN;
  // run-event 发射（Phase A0）：缺省 no-op；run(ctx) 包装注入 ctx.emit。
  const emit = options.emit ?? (() => {});
  const pushDate = getPushDate(now);

  // ── 阶段 1：采集（**只跑实时新闻源 {rss, hacker_news, github, sitemap}**，排除 arXiv/PH）+ 入库。
  // 高频链路全源 0 / 空轮是常态：**不**调 classifySystemFailure 做系统级告警（防刷屏）。
  // sitemap 进本子集（p0-alert-lane 阶段 C）买到的是采集延迟（≤24h → ≤20min）、不是告警资格；
  // 其成本形状被增量语义摊薄：已见集去重在 per-article fetch **之前** + first-fetch-wins ⇒
  // 稳态每轮 = 1 次 sitemap.xml GET + 1 次已见集查询（见 collectors/index.ts）。
  emit('stage.collect');
  const collected = await collectSources(REALTIME_NEWS_SOURCES, {
    ...options.collect,
  });
  const collectedCount = collected.items.length;
  await storeCollectedItems(collected.items, { dbh });
  log(`实时源采集: 返回 ${collectedCount} 条（仅 ${REALTIME_NEWS_SOURCES.join('/')}）`);

  // ── 源级健康告警（p0-alert-lane C1.3 / design D11②，与日报链 run-daily-workflow.ts 的消费循环
  //    **同一个判定与同一个 dedupKey**）：对本轮 perSource.ok=false 的**结构性失败**（sitemap 的
  //    loc_count=0 → 整源 throw 即典型）发 dedupKey='source-health:<source>'（per-source，多源同时
  //    坏不塌成一条）。良性限流豁免经共享谓词 isBenignRateLimit（arXiv/PH 的 429 退避是设计内背压，
  //    不告警——共享防两链判定静默漂移）。限频由 createOpsAlertSink 内部的 push_records 唯一约束承载
  //    （仅 status='success' 行算「今天已告过」：本链每天 72–96 轮，首个 success 轮后其余轮跳过；
  //    发送失败置 failed 不占名额、可重试——跨进程、跨重启、跨两条链共用同一判据，非进程内状态）。
  //    **日报链那一份不可删**：整条车道的回滚路径是 ALERT_SCAN_ENABLED=false，只留本链则一回滚
  //    唯一的告警出口随之消失；共用 dedupKey ⇒ 两条链经同一唯一键自动互相去重、不双响。
  for (const [source, ps] of Object.entries(collected.perSource)) {
    if (ps && ps.ok === false && !isBenignRateLimit(ps.error)) {
      log(`告警: 采集源失败 source=${source}`);
      await alert(`采集源失败：${source}`, {
        dedupKey: `source-health:${source}`,
        source,
        error: ps.error, // sink 沿 cause 链摘要真正的故障原因。
      });
    }
  }

  // ── 阶段 2：去重塌缩（与日报链共用 collapseUncollapsedRawItems，按 collapsed 标记驱动、幂等）。
  emit('stage.dedup');
  await collapseUncollapsedRawItems(dbh);

  // ── 阶段 3：对未评分事件评分（与日报链共用，含并发原子 claim 防双评分）。
  //    评分必在阈值判定**之前**：保证下一步判定时 importance_score 已写（不 NULL 误判）。
  //    **判分预算（p0-alert-lane A5.2 / design D11）**：告警链是高频车道，判分 MUST 有界——每轮最多
  //    判 ALERT_JUDGE_MAX_PER_RUN 条（N × (F + A×L + W) < cron 周期，env.ts superRefine 启动期强制），
  //    余量下一轮续判（超预算事件从未被 claim，见 score-events.ts 候选 SELECT 注释）。显式值放 spread
  //    之【后】：将来某个 judge 注入体若带 maxPerRun，预算恒胜、车道不会静默回到无界（前瞻性防御——
  //    spread 只复制自有属性，今日注入体不含该键时反序也不会覆盖成 undefined）。
  //    日报链（run-daily-workflow.ts）**不传** ⇒ 保持全量无界，两个理由缺一不可：① 一天一次，无界是
  //    它的正确形态；② 它是本链 first_seen_at DESC 取序不饿死老事件的唯一依据——老的未评分事件过
  //    不了下方告警闸的时效地板（判了也不告警、花预算是纯浪费），由无界的日报链在 ≤24h 内排空。
  emit('stage.score');
  const judgeResult = await scoreUnscoredEvents(
    { ...options.judge, maxPerRun: ALERT_JUDGE_MAX_PER_RUN },
    dbh,
  );
  log(
    `评分: 送判 ${judgeResult.judged} 条, 降级 ${judgeResult.degradedCount} 条, claim 跳过 ${judgeResult.claimSkipped} 条` +
      `, 正文补全命中 ${judgeResult.enrichHit} / 失败 ${judgeResult.enrichFail}` +
      `, 判分预算 ${judgeResult.candidateCount}/${ALERT_JUDGE_MAX_PER_RUN}` +
      (judgeResult.budgetExhausted ? '（触顶，余量下轮续判）' : ''),
  );
  // 触顶结构化可观测（A5.3）：经既有 emit 通道发射 p0.judge_budget（不新建通道、不改 p0.observed
  // 既有 schema、绝不静默截断）。budgetExhausted = 候选 SELECT（LIMIT N+1）取回行数 > N；
  // candidateCount = 本轮实际处理条数（≤ N）。被挡下的事件 importance_score 仍 NULL、留在工作集。
  emit('p0.judge_budget', {
    budgetExhausted: judgeResult.budgetExhausted,
    candidateCount: judgeResult.candidateCount,
  });

  // ── 阶段 3.5：发布时间回填（published-at-inference，realtime-alerts spec / design D2/D4）。
  // **必在 selectAlertCandidates 之前**：对「评分后达阈值（importance_score 非 NULL 且 >= threshold）
  // 且 published_at IS NULL」的事件，逐条经 Redis per-event 锁 → AI 推断 → CAS 回填（受
  // PUBLISHED_AT_INFERENCE_MAX_PER_RUN 上限 + first_seen_at 超窗剪枝约束）。与日报链回填经 1.4 CAS
  // （UPDATE ... WHERE published_at IS NULL）+ 1.5 Redis 锁（published-at-infer:{event_id}）并发安全。
  // 高频告警链**无降级率熔断阶段**，回填的「判不出/失败」天然不影响任何熔断；失败降级不抛断、不阻塞
  // 后续阶段（backfillPublishedAt 内部已逐事件 catch 降级）。
  const backfillStats = await backfillPublishedAt({
    scope: { kind: 'alert', threshold },
    windowDays,
    now,
    dbh,
    // exactOptionalPropertyTypes：仅在显式注入时透传，避免传 undefined 给「可选非 undefined」字段。
    ...(options.publishedAtInfer ? { infer: options.publishedAtInfer } : {}),
    ...(options.publishedAtLock ? { lock: options.publishedAtLock } : {}),
    logError: (message, detail) =>
      log(`[published-at-inference] ${message}`, detail),
  });
  log(
    `发布时间回填: 尝试 ${backfillStats.attempted} 条, 回填 ${backfillStats.backfilled} 条, ` +
      `判不出 ${backfillStats.undetermined} 条, 失败 ${backfillStats.failed} 条`,
  );

  // ── 阶段 4：评分**后**判阈值 + 推送告警（纯程序阈值，非 LLM 决定）。
  // **统一模型（Model B）**：channel-agnostic 选一次告警事件，每个事件**同份发放给所有已配置通道**
  // （通道只负责投递上游统一选好的信息，不参与选题）。
  const channelSenders = resolveChannelSenders(options);
  const dispatched: AlertDispatchOutcome[] = [];
  // 逐项结局（design D4，逐 channel/candidate、无 run 级 rollup）：push 到 dispatched 的同时 emit 一条
  // outcome.channel。语义等价于原 dispatched.push，dispatched 内容零改（parity）。
  const record = (o: AlertDispatchOutcome): void => {
    dispatched.push(o);
    emit('outcome.channel', { channel: o.channel, eventId: o.eventId, result: o.outcome });
  };

  // channel-agnostic 候选：达阈值 + 近 windowDays 天内首见 + 未全通道 success（一生一次、跨天去重）。
  // maxPerScan 限单次条数（first_seen_at DESC 取最新），超出者下轮补发，防 Telegram rate limit 刷屏。
  emit('stage.select');
  const candidates = await selectAlertCandidates(
    threshold,
    dbh,
    channelSenders.map((c) => c.channel),
    now,
    windowDays,
    maxPerScan,
  );
  log(
    `告警候选: ${candidates.length} 条达阈值(>=${threshold})且从未 success 告警，` +
      `发放给 ${channelSenders.length} 个通道（${channelSenders.map((c) => c.channel).join(', ')}）` +
      `（窗口 ${windowDays}天，单次上限 ${maxPerScan} 条）`,
  );

  // ── 中文摘要打磨：对入选候选（≤ maxPerScan，极少）中缺中文标题/摘要者，
  // 复用日报摘要 Agent 的 digestEvent（per-event summarizeEvent + 持久化），使告警渲染 headline_zh 为中文
  // 而非原始英文标题；持久化供该事件后进日报被「已摘要守卫」(run-daily-workflow) 复用、不重复摘要。
  // **逐条 try/catch 隔离**：摘要生成或持久化失败仅降为 dispatcher 的 headline 回退链（headline_zh →
  // summary_zh 截断 → representative_title → 仅标题），绝不报错或漏告警（摘要是打磨、非告警前提）。
  // 不 emit 新 stage（保持 collect/dedup/score/select/push 五阶段序列不变）。
  for (const candidate of candidates) {
    if (candidate.headlineZh !== null && candidate.summaryZh !== null) continue;
    try {
      const outcome = await digestEvent(
        {
          eventId: candidate.eventId,
          representativeTitle: candidate.representativeTitle,
          canonicalUrl: candidate.canonicalUrl,
          // grounding（与日报 loadRepresentativeFields 同源）：喂正文 + 来源，避免生成 title-only
          // 摘要被日报「已摘要守卫」复用而降级日报摘要质量；缺失仍走防幻觉护栏、不报错。
          // 正文补全已折进上面的评分阶段（scoreUnscoredEvents 内联补全）——告警链与日报链同口径补全，
          // 空正文候选在评分阶段即被补全写回 raw_items.content，此处 grounding 随之受益。
          content: candidate.content,
          source: candidate.source,
        },
        options.digest,
        dbh,
      );
      if (outcome.status === 'summarized') {
        // 就地更新候选，使随后 dispatch 渲染取到中文 headline/summary（digestEvent 已落库持久化）。
        candidate.headlineZh = outcome.headlineZh;
        candidate.summaryZh = outcome.summaryZh;
      }
    } catch (error) {
      // 摘要生成/持久化失败：逐条隔离、不漏告警——保持原候选，dispatch 走 headline 回退链。
      const reason = error instanceof Error ? error.message : String(error);
      log(`告警摘要降级[${candidate.eventId}]: ${reason}（走 headline 回退链，不漏告警）`);
    }
  }

  emit('stage.push');
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    // 逐条间隔 1s：Telegram 对单聊天约 1msg/s 限速，避免连续快速发送被 rate limit → failed → 重试刷屏。
    if (i > 0) await new Promise((res) => setTimeout(res, 1000));
    // 独立单例锁 `alert:{event_id}`（per-event，覆盖该事件的多通道分发）：防两并发 alert-scan
    // 实例对同一告警事件重复分发（UNIQUE 挡不住并发双读双发）。job 级短时持有 + TTL/finally
    // 释放（锁键无时间，释放不可省）。未抢到 → 另一实例在发该事件，本实例跳过（不重复）。
    const lock = await acquireAlertLock(candidate.eventId, options.lock);
    if (lock === null) {
      log(`告警跳过[${candidate.eventId}]: 未抢到单例锁`);
      for (const { channel } of channelSenders) {
        record({ eventId: candidate.eventId, channel, outcome: 'skipped-locked' });
      }
      continue;
    }
    try {
      // 同份发放给所有已配置通道：各通道复用 dispatcher 同一状态机（target_type='alert'、按事件
      // 单独成名单），各通道 computePendingSet + UNIQUE 同日幂等独立；渲染走 message.ts 的 headline
      // 回退链（headline_zh → summary_zh 截断 → representative_title → 仅标题），无摘要不报错/不漏告警。
      // 单通道发送失败隔离（各自 try/catch），不拖垮该事件的其余通道。
      for (const { channel, sender } of channelSenders) {
        try {
          const result = await dispatchDigest(
            [toSelectedEvent(candidate)],
            { now, sender, channel, targetType: TARGET_TYPE.alert },
            dbh,
          );
          record({
            eventId: candidate.eventId,
            channel,
            outcome: result.outcome === 'sent' ? 'sent'
              : result.outcome === 'failed' ? 'failed'
              : 'skipped',
          });
          log(`告警[${channel}][${candidate.eventId}]: outcome=${result.outcome}`);
        } catch (error) {
          // dispatch 自身抛错（如渲染/DB 异常）：记为 failed（跨天可重试），隔离不拖垮其余通道。
          const reason = error instanceof Error ? error.message : String(error);
          log(`告警[${channel}][${candidate.eventId}]: 异常隔离 ${reason}`, error);
          record({ eventId: candidate.eventId, channel, outcome: 'failed' });
        }
      }
    } finally {
      await lock.release();
    }
  }

  // ── P0 质量可观测：每次扫描完成后经 emit（RunContext seam → pino）结构化记录本次
  // 告警计数 N、各命中 importance_score + event_id、以及通道集，供人工抽检精确/召回与噪音率。
  // 纯确定性旁路——不 LLM 判质量、不额外推送、不改判定/不阻塞（emit 缺省 no-op；run(ctx) 注入 ctx.emit）。
  emit('p0.observed', {
    count: candidates.length,
    channels: channelSenders.map((c) => c.channel),
    hits: candidates.map((c) => ({
      eventId: c.eventId,
      importanceScore: c.importanceScore,
    })),
  });
  log(
    `P0 可观测: 告警 ${candidates.length} 条，命中 importance=[${candidates
      .map((c) => c.importanceScore)
      .join(', ')}]，通道 ${channelSenders.map((c) => c.channel).join('/')}`,
  );

  return {
    pushDate,
    collectedCount,
    judged: judgeResult.judged,
    alertCandidateCount: candidates.length,
    dispatched,
  };
}

/**
 * 薄 run(ctx) 包装（Phase A0，design D2/D4）：把 RunContext 映射到 runAlertScan 核心的运维子集
 * （emit + 可选 now，其余 DI 走生产默认），委托核心；抛错时 emit 一条 run.failed 后 RE-THROW 原错误
 * （run(ctx) 仍 reject → BullMQ job 失败可重试）。ctx.trigger 恒为 'alert-scan'（design D9）。
 * 现有集成测试仍直调 runAlertScan(options) 注入 mock，不受影响。
 */
export async function run(
  ctx: RunContext,
  // ponytail: 测试缝——默认委托生产核心；单测注入抛错桩验证 run.failed emit + re-throw 契约。
  core: typeof runAlertScan = runAlertScan,
): Promise<RunAlertScanResult> {
  const input = (ctx.input ?? {}) as { now?: Date };
  try {
    return await core({
      emit: ctx.emit,
      // 生产装配的运维告警出口（源级健康告警，p0-alert-lane C1.3）：与日报链 run(ctx) 同型
      // （run-daily-workflow.ts run()）。不注入则核心回落 consoleAlertSink：告警只进 stderr、
      // 没人会被叫醒。用 buildOpsAlertSink（自发现并懒构造生产通道——首次真告警才装配，桩核心
      // 单测不触发真实发送器构造）而非裸 createOpsAlertSink（后者需预构造 senders map）。
      // `now` 与工作流同源：sink 用它算 push_date（告警当日限频键），防注入 now 的运行（回补/
      // 演练）里工作流与告警行的日期口径分裂。
      alert: buildOpsAlertSink(undefined, input.now ? () => input.now! : undefined),
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (err) {
    ctx.emit('run.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
