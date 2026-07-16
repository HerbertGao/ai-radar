/**
 * Value Judge 接入流水线（任务 6.1 / 6.2，value-judge-agent MODIFIED）。
 *
 * 把 P0 的 seed 落库脚手架替换为：对去重塌缩后的**真实事件**逐条调用 `judgeRawItem`，
 * 按 ./mapping.ts 的字段名映射写入 ai_news_events 的 *_score 列与 should_push。
 *
 * 关键不变量（spec「Agent 输出落库往返」/ design D1/D8，逐条照抄到此守住）：
 * - 写分必须 `UPDATE ai_news_events ... WHERE event_id = ?`，`set` 中**仅含**
 *   *_score / should_push / is_ai_related 列；禁止 `INSERT ... ON CONFLICT` 模板，禁止在 set 带
 *   event_id / representative_raw_item_id / representative_title / first_seen_at /
 *   published_at——否则覆盖塌缩首建的身份/排序列致 Top N 静默退化
 *   （P0 已删的 persistEventScores 全列覆盖式 set 是反面模板）。
 * - judge 阶段**只处理尚未评分的事件**（`importance_score IS NULL`，含本轮塌缩新建
 *   与此前降级未评分者）；已评分事件跳过不重判——避免重复 LLM 调用、避免覆盖旧分。
 * - judgeRawItem 已含重试 + Zod 校验 + 降级抛 ValueJudgeFailureError；单条降级 →
 *   跳过 + 记日志 + degraded_count++，整批继续，**绝不写未校验数据**。
 *
 * 熔断（降级率阈值判断）本身归编排组（G7）：本模块只产出 degraded_count 与逐条容错，
 * 不在此处中止整批。
 */
import { and, desc, eq, isNull, or, lt, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { aiNewsEvents, rawItems } from '../../db/schema.js';
import { env } from '../../config/env.js';
import {
  EMPTY_CONTENT,
  enrichRawItemContent,
  type EnrichContentOptions,
} from '../../pipeline/content-enrichment.js';
import { mapOutputToEventScores } from './mapping.js';
import {
  judgeRawItem,
  ValueJudgeFailureError,
  type JudgeOptions,
} from './index.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/**
 * 一条待评分事件的最小视图。judge 的 prompt 输入由代表标题 + 补全后正文 + 来源构成
 * （content/source 经 representative_raw_item_id left join raw_items 载入，供 grounding；
 * 补全失败 content 仍空时如实回退仅标题，见 value-judge-agent「须以正文与来源 grounding」）。
 */
interface UnscoredEvent {
  eventId: string;
  representativeTitle: string | null;
  content: string | null;
  source: string | null;
  /** 代表 raw_item 主键（left join，可空——无代表或 raw_item 缺失时 null）；补全入参。 */
  rawItemId: bigint | null;
  /** 代表 raw_item 的规范化 URL / 原始 URL（补全目标；优先 canonical）。 */
  canonicalUrl: string | null;
  url: string | null;
  /**
   * content 是否为空/纯空白——**投影列**（与补全写回复用同一侧 SQL 谓词 `content IS NULL OR content !~ '\S'`）。
   * **绝不可在 TS 里 `trim()` 判空**：`content = ' '`（NBSP）时 TS 判空 → 白抓一次 HTTP，而写回侧 SQL `!~ '\S'`
   * 为假 → 命中 0 行 → 打出与事实相反的「已被并发填充」日志。投影列使选取与写回同一侧、同一谓词。
   */
  isEmpty: boolean;
}

/** 批量评分结果（供编排组做阶段熔断：分母 = scored + degraded = 本轮**实际送判**数）。 */
export interface ScoreEventsResult {
  /**
   * 本轮**实际送判**（claim 成功、送 LLM）的事件数 = 阶段熔断分母。
   * **不含** claim 被他人抢走/未过期而跳过者（claimSkipped）——那些事件由对方链路评分，
   * 不属于本链路的「送判」，计入分母会污染降级率（claim 跳过非降级）。
   */
  judged: number;
  /** 成功写分的事件数。 */
  scored: number;
  /** 单条降级（judge 失败）被跳过、未写库的事件数。 */
  degradedCount: number;
  /**
   * 因并发 claim 未抢到（已被另一链路 claim 且未过 T）而跳过的事件数（非降级、不计入熔断分母）。
   * 供可观测：两链路并发时本链路跳过对方正在评分的事件。
   */
  claimSkipped: number;
  /** 内联正文补全成功（拿到可用正文）的事件数。 */
  enrichHit: number;
  /**
   * 内联正文补全失败的事件数（网络 / 非 2xx / 非 HTML / 超限 / 超时 / og 缺失 / 命中全站样板 / 被 SSRF 守卫拒绝）。
   * 绝不计入 `degradedCount`（熔断分母仍只含 judge、digest 两阶段）——补全失败照常 fail-open 送判仅标题。
   */
  enrichFail: number;
  /**
   * 判分预算触顶信号（p0-alert-lane A5.3 / design D11）：`maxPerRun` 给出且候选 SELECT（`LIMIT N+1`）
   * 取回行数 > N 时为 true——单靠 `LIMIT N` 无法区分「恰好 N 条」与「超过 N 条」，第 N+1 行只作
   * 信号、不 claim 不判分。未传预算（日报链全量）恒为 false。由 alert-scan.ts 读取后经其既有
   * emit 通道发射 `p0.judge_budget`——**绝不**给本模块加 emit（那是新建通道）。
   */
  budgetExhausted: boolean;
  /** 本轮实际进入处理循环的候选条数（给预算时 ≤ maxPerRun；无预算 = 全量候选数）。 */
  candidateCount: number;
}

export interface ScoreEventsOptions {
  /** 透传给 judgeRawItem 的选项（如注入 mock generateObjectFn、maxAttempts）。 */
  judge?: JudgeOptions;
  /**
   * 内联正文补全的选项（注入 fetchImpl/resolve 桩使测试不触网）。补全折进判分入口后，其可注入性必须随
   * 能力一起下沉到这里——两条判分链（日报 / 告警）都经本字段注入无网桩（`RunAlertScanOptions.judge` 已是
   * 现成通道），**绝不为任一条链另开平行的 enrich 字段**。
   */
  enrich?: EnrichContentOptions;
  /** 错误日志 sink，默认 console.error；便于测试断言降级被记录（非静默）。 */
  logError?: (message: string, detail: unknown) => void;
  /**
   * 并发评分原子 claim 的回收阈值 T（毫秒，默认 env.JUDGE_CLAIM_RECLAIM_MS）。
   * 一个被 claim 但 *_score 仍 NULL 的事件，停留超过 T 即视为僵尸 claim（崩溃/超时遗留），
   * 可被本链路重新 claim 重评。env 已校验 `T > F + A×L + W`（见 config/env.ts superRefine）；
   * 测试可注入小值快速验证「claim 后崩溃经 T 重评」。
   */
  reclaimMs?: number;
  /**
   * 每轮判分工作预算（p0-alert-lane A5.1 / design D11，只有告警高频链显式传入）：给出时候选
   * SELECT 加确定性取序 + `LIMIT maxPerRun + 1`（+1 仅作触顶信号，只处理前 maxPerRun 条）：
   *
   *   ORDER BY first_seen_at DESC NULLS LAST, event_id DESC   LIMIT maxPerRun + 1
   *
   * **🔴 默认值 MUST 为 undefined（＝无 ORDER BY、无 LIMIT、全量），MUST NOT 写成
   * `options.maxPerRun ?? N`**：日报链（run-daily-workflow.ts）不传本项 ⇒ 必须保持全量无界。
   * 「日报链无界」承载两个理由、缺一不可：
   *   ① 一天一次，无界是它的正确形态；
   *   ② 它是告警链 `first_seen_at DESC` 取序**不饿死老事件**的唯一依据——老的未评分事件过不了
   *      告警闸的时效地板（判了也不告警，告警链花预算在它们身上是纯浪费），它们由无界的日报链
   *      在 ≤24h 内排空。把 N 写成缺省值 ⇒ 日报链每天只判 N 条 ⇒ 要闻段枯竭 + 该论证当场坍塌
   *      ⇒ 老事件永久积压；且条数 ≤ N 的 fixture 在两条链上行为逐字相同 ⇒ 测试恒绿、看不见。
   */
  maxPerRun?: number;
}

/**
 * 一次 claim 尝试的结果。`claimed` 携带 **claim 凭据 `claimToken`**（`judge_claimed_at::text`，微秒完整）——
 * 供 `releaseJudgeClaim` 做属主校验：只释放**自己那一次** claim，绝不误清并发链路（合法回收本事件后）的活 claim。
 */
export type ClaimResult =
  | { status: 'claimed'; claimToken: string }
  | { status: 'skipped' };

/**
 * 对单个事件做并发评分原子 claim（送 LLM 前的确定性闸，design D6 / daily-intel「降级逐条容错」）。
 *
 * `UPDATE ai_news_events SET judge_claimed_at = now()
 *    WHERE event_id = ?
 *      AND importance_score IS NULL                                  -- 只 claim 未评分者
 *      AND (judge_claimed_at IS NULL OR judge_claimed_at < now() - interval 'T ms')  -- 含超时回收
 *  RETURNING event_id`
 *
 * 语义（绝不可违背）：
 * - **只有 RETURNING 返回该行的链路（claim 成功）才送 LLM 评分**；另一并发链路的同一 UPDATE
 *   不满足 `judge_claimed_at IS NULL OR ... < now()-T`（已被对方写过且未过期）→ 0 行返回 → 跳过。
 *   claim 降低跨链路重复判分的**概率**（DNS 挂起/进程冻结可越过 T 误回收）；「一事件只被评一次分」的
 *   真正兜底是下方写分 CAS（`importance_score IS NULL`）+ 属主校验 release，而非本 claim。
 * - **超时回收**：claim 条件含 `OR judge_claimed_at < now()-T`——claim 后崩溃（judge_claimed_at
 *   非空但 *_score 仍 NULL）的僵尸 claim 经 T 后被重新 claim，不致永久漏评。
 * - `importance_score IS NULL` 与塌缩首建无分态一致（各 *_score 同生同灭），评分成功写分后该事件
 *   不再满足 claim 条件（已有分）——claim 随写分自然失效，无需显式释放。
 *
 * 回收阈值 `T` 由 env 校验满足 `T > F + A×L + W`（F=COLLECTOR_FETCH_TIMEOUT_MS 补全抓取、
 * A=JUDGE_MAX_ATTEMPTS、L=LLM_TIMEOUT_MS、W=JUDGE_WRITE_BUDGET_MS）--使正在合法补全/评分/写分
 * （停留 < F+A×L+W）的事件恒不会存活到 `now()-T`、不被另一链路误回收双评分。
 *
 * @returns `{status:'claimed', claimToken}`（本链路抢到、应送 LLM）/ `{status:'skipped'}`（已被他人 claim
 *   且未过期、或已评分/tombstone）。**claimToken MUST 以 `::text` 往返**——`judgeClaimedAt` 未声明
 *   `mode:'string'`（drizzle 默认 `mode:'date'`）⇒ 取 JS `Date` 会截到毫秒，而 `now()` 写入 timestamptz
 *   是微秒（生产 99.87% 行带非零微秒位）⇒ 属主比较恒不命中、release 永久 no-op。
 */
export async function claimEventForJudging(
  eventId: string,
  reclaimMs: number,
  dbh: DbLike = defaultDb,
): Promise<ClaimResult> {
  // now() - interval 'N milliseconds'：用参数化毫秒数，避免拼接；DB 端时钟统一口径（防进程钟漂）。
  const reclaimCutoff = sql`now() - (${reclaimMs}::double precision * interval '1 millisecond')`;
  const claimed = await dbh
    .update(aiNewsEvents)
    .set({ judgeClaimedAt: sql`now()` })
    .where(
      and(
        eq(aiNewsEvents.eventId, eventId),
        isNull(aiNewsEvents.importanceScore),
        // P3 tombstone 排除（合并核心闭环）：claim CAS 自身 WHERE 必须加 `merged_into IS NULL`——
        // 告警链 scoreUnscoredEvents 不持日报锁，SELECT→claim 分离，间隙日报合并可把本事件置 tombstone
        // （TOCTOU）。仅 SELECT 收口不充分；谓词落 claim CAS 才使「tombstone 绝不被 claim/复活」成立。
        isNull(aiNewsEvents.mergedInto),
        or(
          isNull(aiNewsEvents.judgeClaimedAt),
          lt(aiNewsEvents.judgeClaimedAt, reclaimCutoff),
        ),
      ),
    )
    // claim 凭据以 `::text` 回传（微秒完整、同会话往返无损）；MUST NOT 用 .returning({judgeClaimedAt}) 拿 JS Date。
    .returning({ claimToken: sql<string>`${aiNewsEvents.judgeClaimedAt}::text` });

  return claimed.length > 0
    ? { status: 'claimed', claimToken: claimed[0]!.claimToken }
    : { status: 'skipped' };
}

/**
 * 释放某事件的评分 claim（清 `judge_claimed_at`，仅当仍未评分**且这一次 claim 是自己写的**时）——评分
 * 失败/降级后即时调用，使下一轮可立即重判，而非等回收阈值 `T`（claim 的超时回收本为「崩溃/超时」兜底；
 * **已处理的评分失败应主动释放 claim**，否则该事件白白被锁 `T` 时长、也挡住并发链路评分）。
 *
 * **属主校验（`judge_claimed_at = claimToken`）绝不可省**：两链路交错下，A claim E → A 补全 DNS 挂起超 `T`
 * → D 合法回收 E（写入新 claim）并开始判分 → A 的 LLM 随后失败 → A 调 release(E)。若不校验属主，A 会清掉
 * **D 的活 claim**（此刻 `importance_score IS NULL` 仍为真），下一 tick 第三个 claimer 与 D 并发判同一条、
 * 再发一次补全 + LLM——写 CAS 保住数据正确，坏的是成本。属主校验使 A 的 release 命中 0 行（良性 no-op）。
 *
 * `WHERE importance_score IS NULL` 守卫：只清「claim 了但没评成功」的，绝不误清已评分事件的痕迹。
 * 释放尽力而为：调用方应吞掉其异常（事件仍会在 `T` 后被超时回收兜底，不致永久漏评）。
 *
 * @param claimToken `claimEventForJudging` 回传的 `judge_claimed_at::text` 凭据（微秒完整）。
 */
export async function releaseJudgeClaim(
  eventId: string,
  claimToken: string,
  dbh: DbLike = defaultDb,
): Promise<void> {
  await dbh
    .update(aiNewsEvents)
    .set({ judgeClaimedAt: null })
    .where(
      and(
        eq(aiNewsEvents.eventId, eventId),
        isNull(aiNewsEvents.importanceScore),
        // 属主校验：只释放自己那一次 claim（PG 侧把凭据解析回 timestamptz、逐微秒相等）。
        sql`${aiNewsEvents.judgeClaimedAt} = ${claimToken}::timestamptz`,
      ),
    );
}

/**
 * 对所有「尚未评分」的真实事件逐条评分并写分。
 *
 * 流程：
 * 1. 查 `importance_score IS NULL` 的事件（本轮塌缩新建 + 此前降级未评分者）；
 *    告警链传 `maxPerRun` 时按确定性取序 `LIMIT maxPerRun + 1` 只处理前 maxPerRun 条
 *    （日报链不传、保持全量，见 ScoreEventsOptions.maxPerRun 注释）。
 * 2. 逐条调用 judgeRawItem（代表标题作 prompt 输入）。
 * 3. 成功 → 按 mapping 映射后 `UPDATE ... WHERE event_id = ?`，set 仅含 *_score + should_push。
 * 4. 单条降级（ValueJudgeFailureError）→ 跳过 + 记日志 + degradedCount++，整批继续。
 *
 * @param dbh 可注入 db 或事务句柄（默认全局 db）。
 */
export async function scoreUnscoredEvents(
  options: ScoreEventsOptions = {},
  dbh: DbLike = defaultDb,
): Promise<ScoreEventsResult> {
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[value-judge] ${message}`, detail));
  // logError 包装：注入的 logError 可能抛错（stderr 断裂等），吞掉以防中断整批评分或腐蚀降级计数。
  const safeLogError = (message: string, detail: unknown) => {
    try {
      logError(message, detail);
    } catch {
      // logError 抛错不拖垮整批。
    }
  };
  const reclaimMs = options.reclaimMs ?? env.JUDGE_CLAIM_RECLAIM_MS;

  const maxPerRun = options.maxPerRun;

  // 候选集：尚未评分的事件（importance_score IS NULL 即「未被本 Agent 写过分」）。
  // 这是**候选**而非「已 claim 必送判」——每条送 LLM 前还要逐条原子 claim（claimEventForJudging）；
  // 仅 claim 成功者送判，未抢到（被另一链路 claim 且未过 T）的跳过（claimSkipped++、不计入熔断分母）。
  // 防并发双评分：日报链与告警高频链可能同时 SELECT 到同一未评分事件，靠 claim 而非 SELECT 去重。
  const candidateQuery = dbh
    .select({
      eventId: aiNewsEvents.eventId,
      representativeTitle: aiNewsEvents.representativeTitle,
      // 补全后正文 + 来源（left join，经 representative_raw_item_id）：judge 以此 grounding。
      // left join 而非 inner——representative_raw_item_id 可空或 raw_item 缺失时仍保留事件（content 回退 null）。
      content: rawItems.content,
      source: rawItems.source,
      // 补全入参（同一个 left join 扩取，不新增查询）：代表 raw_item 主键 + 可抓 URL。
      rawItemId: rawItems.id,
      canonicalUrl: rawItems.canonicalUrl,
      url: rawItems.url,
      // 空判定**投影列**（不进 WHERE--候选要判所有未评分事件、不只空正文的）：复用 content-enrichment
      // 的 `EMPTY_CONTENT`（与补全写回同一 SQL 对象、一字不差），杜绝 TS `trim()` 分叉（NBSP 时判空->白抓、写回 0 行）。
      isEmpty: EMPTY_CONTENT,
    })
    .from(aiNewsEvents)
    .leftJoin(
      rawItems,
      eq(aiNewsEvents.representativeRawItemId, rawItems.id),
    )
    // P3 tombstone 排除（合并核心闭环）：候选 SELECT 加 `merged_into IS NULL`——被吞 tombstone（评分
    // 前 importance_score 为 NULL）若不排除会被 value-judge 重新选中评分「复活」、进而被 Top N 选中独立
    // 推送，使合并比不合并更糟（spec「tombstone 对所有下游消费者不可见」）。claim/评分写 CAS 另各自加。
    .where(and(isNull(aiNewsEvents.importanceScore), isNull(aiNewsEvents.mergedInto)));

  // 判分预算（p0-alert-lane A5.1/A5.4 / design D11）——**仅在 maxPerRun 给出时**加确定性取序 + LIMIT，
  // 形态唯一：`ORDER BY first_seen_at DESC NULLS LAST, event_id DESC LIMIT maxPerRun + 1`。
  // - **ORDER BY 不可省**：只加 LIMIT 时 PG 返回**任意** N 行（哪 N 条被判每轮随物理扫描序漂移）。
  // - **NULLS LAST 不可省**：first_seen_at 可空（schema 无 .notNull()）而 PG `ORDER BY x DESC` 默认
  //   NULLS FIRST ⇒ 一行 NULL 即恒排第一、每轮吃掉一个名额且永不老化（工作集无时间剪枝）——静默的
  //   永久饥饿。仓内他处均已写 DESC NULLS LAST（experience-chain.ts）。
  // - **event_id 不可省**：同一轮采集入库的事件 first_seen_at 常见同秒，单列排序仍是部分序。
  // - **LIMIT 取 maxPerRun + 1**：第 N+1 行只作触顶信号（budgetExhausted），不 claim 不判分——预算界
  //   天然落在 claim 之【前】，超预算事件从未被 claim，下一轮即刻可取（若落在 claim 之后要等满
  //   JUDGE_CLAIM_RECLAIM_MS 才被回收）。不做墙钟 deadline 变体 ⇒ 无飞行中止、无需释放 claim。
  // - **「不加 LIMIT、循环内数到 N 就 break」不等效、MUST NOT 用**：全量无序 SELECT 的物理扫描序
  //   轮间稳定 ⇒ 排头的 N 条毒事件（判分恒失败 → 释放 claim → 仍 NULL → 下轮又排头）每轮吃满预算，
  //   其后健康事件永久饿死（工作集无时间剪枝，毒事件永不老化出局）。
  const fetched: UnscoredEvent[] =
    maxPerRun === undefined
      ? await candidateQuery
      : await candidateQuery
          .orderBy(
            sql`${aiNewsEvents.firstSeenAt} DESC NULLS LAST`,
            desc(aiNewsEvents.eventId),
          )
          .limit(maxPerRun + 1);
  const budgetExhausted = maxPerRun !== undefined && fetched.length > maxPerRun;
  // 只处理前 maxPerRun 条（无预算 = 全量）：被预算挡在本轮外的事件 importance_score 仍为 NULL ⇒
  // 留在工作集里、下一轮继续——预算只裁单轮工作量，不丢事件、不改「一事件只评一次分」。
  const events = maxPerRun !== undefined ? fetched.slice(0, maxPerRun) : fetched;

  let scored = 0;
  let degradedCount = 0;
  let judged = 0;
  let claimSkipped = 0;
  let enrichHit = 0;
  let enrichFail = 0;

  for (const [index, event] of events.entries()) {
    // 送 LLM 前原子 claim：仅抢到者送判。未抢到 → 该事件正被另一链路评分（或刚被评完），跳过。
    const claim = await claimEventForJudging(event.eventId, reclaimMs, dbh);
    if (claim.status === 'skipped') {
      claimSkipped += 1;
      continue;
    }
    const { claimToken } = claim;
    judged += 1;
    // 逐条评分进度（轻量，一条一行）：N 次 LLM 调用中间无日志看不出进度。
    console.error(
      `[value-judge] 评分 ${index + 1}/${events.length}（event=${event.eventId.slice(0, 8)}）`,
    );

    // 补全折进判分入口：claim 成功【之后】、judge【之前】。空正文（isEmpty 投影列，**非** TS trim）
    // 且有代表 raw_item + 可抓 URL → 补全，并把返回正文【显式送入本次判分】（禁止沿用 SELECT 的旧空值）。
    // **fail-open**：补全失败/跳过照常送 LLM（仅标题输入），绝不 continue 跳过——否则一次抓取失败让它永不评分。
    let judgeContent = event.content;
    const enrichTarget = event.canonicalUrl ?? event.url;
    if (event.isEmpty && event.rawItemId != null && enrichTarget) {
      try {
        const enriched = await enrichRawItemContent(
          { rawItemId: event.rawItemId, target: enrichTarget },
          dbh,
          options.enrich,
        );
        if (enriched.status === 'hit') enrichHit += 1;
        else enrichFail += 1;
        judgeContent = enriched.content ?? event.content;
      } catch (enrichErr) {
        // 纵深防御：enrichRawItemContent 契约「绝不抛出」，但万一（注入的 logError 抛错、未来编辑引入新抛点）
        // 仍兜住 fail-open--补全异常照常送判（仅标题），绝不中断整批。
        enrichFail += 1;
        safeLogError(`事件 ${event.eventId} 正文补全异常（fail-open 仅标题判分）`, enrichErr);
      }
    }

    try {
      const output = await judgeRawItem(
        {
          // 代表标题为塌缩首建写入的原始 title（NOT NULL 期望，但列可空，兜底空串）。
          title: event.representativeTitle ?? '',
          // 补全后正文 + 来源（补全失败/跳过时 judgeContent 仍空 → 如实回退仅标题——buildPrompt 只在非空时拼入）。
          content: judgeContent,
          source: event.source,
        },
        options.judge,
      );

      const scoreColumns = mapOutputToEventScores(output);

      // 关键不变量：UPDATE ... WHERE event_id = ?，set 仅含 *_score / should_push / is_ai_related。
      // 绝不带身份/代表/排序列，绝不用 INSERT ON CONFLICT。
      // 写 CAS 两道结构保证（命中 0 行 = 无害空写、跳过、下面按因区分）：
      // - `importance_score IS NULL`：**永不覆写**——「一事件只评一次分」是结构保证、不是概率保证。
      //   claim + 属主校验只降低重复判分的概率；真正兜底靠此 CAS：DNS 解析（不受 AbortSignal 约束）、
      //   进程长 STW、容器冻结/迁移都能越过时间阈值让两路并发判同一条，此 CAS 保住数据不被二次覆写。
      // - `merged_into IS NULL`：claim 成功后、评分写前仍存在链内二次 TOCTOU（日报合并可在此间隙置 tombstone）。
      const updated = await dbh
        .update(aiNewsEvents)
        .set({
          importanceScore: scoreColumns.importanceScore,
          noveltyScore: scoreColumns.noveltyScore,
          developerRelevanceScore: scoreColumns.developerRelevanceScore,
          hypeRiskScore: scoreColumns.hypeRiskScore,
          shouldPush: scoreColumns.shouldPush,
          // is_ai_related 落库（不再丢弃）：要闻段 selectTopN 据此 fail-closed 闸门过滤。
          isAiRelated: scoreColumns.isAiRelated,
        })
        .where(
          and(
            eq(aiNewsEvents.eventId, event.eventId),
            isNull(aiNewsEvents.importanceScore),
            isNull(aiNewsEvents.mergedInto),
          ),
        )
        .returning({ eventId: aiNewsEvents.eventId });

      if (updated.length === 0) {
        // 评分写命中 0 行：**区分两因**（回读一次现状）——不计 scored、不计降级、不稀释熔断分母（judged--）。
        judged -= 1;
        const [row] = await dbh
          .select({
            mergedInto: aiNewsEvents.mergedInto,
            importanceScore: aiNewsEvents.importanceScore,
          })
          .from(aiNewsEvents)
          .where(eq(aiNewsEvents.eventId, event.eventId))
          .limit(1);
        if (row && row.mergedInto != null) {
          // ① claim 后被并发日报合并置 tombstone（链内二次 TOCTOU）——正确排除。释放本次 claim（纵深清理；
          //    候选 SELECT 的 `merged_into IS NULL` 已永久排除它）。
          await releaseJudgeClaim(event.eventId, claimToken, dbh).catch((releaseErr: unknown) =>
            safeLogError(
              `事件 ${event.eventId} 评分写命中 0 行（已 tombstone）释放 claim 失败（候选已排除，无副作用）`,
              releaseErr,
            ),
          );
          safeLogError(
            `事件 ${event.eventId} 评分写命中 0 行（claim 后被并发合并置 tombstone）：跳过，不计入 scored/熔断分母`,
            null,
          );
        } else if (row && row.importanceScore != null) {
          // ② importance_score 已非空：**误回收被写 CAS 兜住**（另一路径已合法评分、本次未覆写）。这是应当
          //    被看见的异常、不是常态——记 WARN。不释放 claim（importance_score 非空使 release 亦为 no-op）。
          safeLogError(
            `WARN 事件 ${event.eventId} 评分写命中 0 行：importance_score 已非空（误回收被写 CAS 兜住、未覆写）`,
            null,
          );
        } else {
          // ③ 既非 tombstone 也非已评分（不应发生）——记录以便排查。
          safeLogError(
            `事件 ${event.eventId} 评分写命中 0 行（既非 tombstone 也非已评分，异常）`,
            null,
          );
        }
        continue;
      }

      scored += 1;
    } catch (error) {
      // 评分失败（降级或写库异常）：**立即释放 claim**（清 judge_claimed_at），使下一轮可即时
      // 重判，而非白等回收阈值 T（Bugbot #2）。释放尽力而为——失败不再拖垮整批（事件仍会在 T
      // 后被超时回收兜底，不致永久漏评）。
      await releaseJudgeClaim(event.eventId, claimToken, dbh).catch((releaseErr: unknown) =>
        safeLogError(
          `事件 ${event.eventId} 释放 judge claim 失败（将由超时回收 T 兜底）`,
          releaseErr,
        ),
      );
      if (error instanceof ValueJudgeFailureError) {
        // 单条降级：跳过 + 记日志 + 计数，整批继续，不写未校验数据。
        degradedCount += 1;
        safeLogError(
          `事件 ${event.eventId} 价值判断降级（跳过，不写库，已释放 claim）`,
          error,
        );
        continue;
      }
      // 非降级类错误（如 DB 写入失败）不应被吞——同样计入降级并记录，但不中断整批，
      // 让编排组据 degradedCount 决定是否熔断。
      degradedCount += 1;
      safeLogError(`事件 ${event.eventId} 评分写库异常（跳过，已释放 claim）`, error);
    }
  }

  // judged = 本链路实际 claim 成功并送判的数（熔断分母）；claimSkipped 不计入分母（非降级）。
  // enrichHit/enrichFail 供每条调用链各自日志暴露（补全失败不计入 degradedCount）。
  // budgetExhausted/candidateCount 供告警链经其既有 emit 通道发 p0.judge_budget（绝不静默截断）。
  return {
    judged,
    scored,
    degradedCount,
    claimSkipped,
    enrichHit,
    enrichFail,
    budgetExhausted,
    candidateCount: events.length,
  };
}
