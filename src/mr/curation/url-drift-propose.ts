/**
 * Model Radar browser 档 URL drift proposer（add-model-radar-browser-url-drift-agent，design D5/D6/D7，task 6.1）。
 *
 * **受 eslint `no-restricted-imports` 守卫、禁 import `src/mr/write/**` + `src/mr/ingest/**`（含
 * `set-source-url.ts`），见 design D9**——落 `mr_source.source_url` 是 approve.ts 调 `setSourceUrl` 的专属
 * 权限；propose 侧只：列 pending 的 `target_type='source'` flag → 过滤 browser 档 → reason-gate（仅 blocked/stale
 * 桶调 agent）→ `detectUrlDrift`（单次 generateObject、不抓候选 URL）→ `openUrlDriftReviewOrSupersede`（store
 * 原语）→ 发卡。落库只发生在人一键批准时（approve.ts）。
 *
 * 回路（design D6）：
 * 1. 列 pending 的 `target_type='source'` flag（browser scrape 打的 blocked / staleness 打的陈旧标）。
 * 2. **reason-gate（m2）**：子串匹配开发者写死常量分桶——含「登录墙/拦截页」→ blocked、含「长期未核对」→ stale；
 *    `changed`（内容变、URL 仍可达）及任何未匹配 → skip（fail-closed、不空烧 LLM）。
 * 3. 逐源：仅处理 `fetch_strategy='browser'`（http/manual 跳过）。
 * 4. `vendorDomainSet(vendorId)` 反查该 vendor allowlist 域集 → `detectUrlDrift`（注入钉定模型句柄）。
 * 5. `escalate` → log-only（m4，不写候选行、不额外计 metric、不推卡）；`candidate` 达阈值 → `assertUrlAllowed`
 *    二次校验（防注入）→ `openUrlDriftReviewOrSupersede`（记 run_id + 冻结 flag_opened_at）→ 发 Telegram 一键卡。
 *
 * metric（DD2/task 10.2）：入口回填所有 `adopted IS NULL` 且对应 run 已全部 decided 的历史 metric 行；尾部
 * upsert 本轮 `{run_id, total_candidates=(count(*) 从持久候选行重算), adopted:null, ran_at}`（`ON CONFLICT(run_id)
 * DO UPDATE`、幂等）。
 *
 * ponytail: per-source try/catch 隔离失败（仿 `propose.ts`）——单源失败只记日志不拖垮整批；批级重试靠
 * url-drift-queue 的 BullMQ attempts。
 */
import { eq, sql } from 'drizzle-orm';
import { createOpenAI } from '@ai-sdk/openai';
import { db as defaultDb } from '../../db/index.js';
import { env } from '../../config/env.js';
import { mrSource } from '../../db/schema.js';
import { listPendingFlags, type PendingFlag } from '../freshness/dispose.js';
import {
  detectUrlDrift,
  confidenceRank,
  normalizeUrl,
  URL_DRIFT_MODEL,
  type DetectUrlDriftInput,
  type UrlDriftAgentOutput,
} from '../scrape/url-drift-agent.js';
import { vendorDomainSet } from '../scrape/vendor-domains.js';
import { assertUrlAllowed } from '../scrape/ssrf-guard.js';
import { MR_SOURCE_DOMAIN_ALLOWLIST } from '../scrape/allowlist.js';
import { openUrlDriftReviewOrSupersede, markUrlDriftSuperseded } from './url-drift-store.js';
import { buildUrlDriftCardText, buildUrlDriftTelegramCard } from './card.js';
import { MAX_MESSAGE_LENGTH } from '../../push/message.js';
import type { CurationNotify } from './propose.js';

type DbLike = typeof defaultDb;

/** 逐源处理的分类结果（可观测计数）。 */
type SourceOutcome = 'carded' | 'noop' | 'escalated' | 'skipped';

export interface RunUrlDriftCurationOptions {
  /** 出站发卡回调（必传——接线侧从真实 Telegram sender 装配，测试注入 spy）。 */
  notify: CurationNotify;
  /** 本轮 run_id（= BullMQ job 稳定 id、跨 attempts 不变；metric 回填 join key，design D7）。 */
  runId: string;
  dbh?: DbLike;
  /** drift 检测函数（默认 `detectUrlDrift`；测试注入桩免真实 LLM）。 */
  detectFn?: (input: DetectUrlDriftInput) => Promise<UrlDriftAgentOutput>;
}

export interface RunUrlDriftCurationResult {
  /** pending 源 flag 总数。 */
  total: number;
  /** 开记录 + 发新卡的源数。 */
  carded: number;
  /** 同 pending 同候选 → 不重复发卡的源数。 */
  noop: number;
  /** agent 主动 escalate（log-only）的源数。 */
  escalated: number;
  /** 非 browser / reason-gate 未匹配 / 低置信 → 无卡的源数。 */
  skipped: number;
  /** per-source 异常（已记日志、不改事实）。 */
  errors: number;
}

/**
 * reason-gate 分桶（m2，design 风险节）——子串匹配抓取链写死的开发者常量：
 * - `fingerprint.ts` blocked-page reason（含「登录墙」/「拦截页」）→ `blocked`；
 * - `staleness.ts` source 级陈旧 reason（含「长期未核对」）→ `stale`；
 * - `changed`（内容变、URL 仍可达、多半价格变非 URL drift）及任何未匹配 → `null`（skip、不空烧 LLM）。
 */
function classifyReason(reason: string): 'blocked' | 'stale' | null {
  if (reason.includes('登录墙') || reason.includes('拦截页')) return 'blocked';
  if (reason.includes('长期未核对')) return 'stale';
  return null;
}

/**
 * 跑一轮 URL drift proposer（design D6）。逐 pending 源 flag 处理，per-source 隔离失败。
 * **不落任何事实**——只开待批记录 + 发卡；落 `mr_source.source_url` 在人批准时（approve.ts）。
 */
export async function runUrlDriftCuration(
  options: RunUrlDriftCurationOptions,
): Promise<RunUrlDriftCurationResult> {
  const dbh = options.dbh ?? defaultDb;
  const detectFn = options.detectFn ?? detectUrlDrift;

  // 入口：回填所有 `adopted IS NULL` 且对应 run 已全部 decided（无未过期 pending）的历史 metric 行
  // （DD2/task 10.2——**非 LIMIT 1**：只回填最近一行会让旧行永不再被检查、engagement 监控名存实亡）。
  await backfillAdoptedMetrics(dbh);

  // 内存构造钉定模型句柄（URL_DRIFT_MODEL、不触网、凭据注入；agent + eval 共用同一 dated snapshot）。
  const provider = createOpenAI({ apiKey: env.LLM_API_KEY, baseURL: env.LLM_BASE_URL });
  const model = provider(URL_DRIFT_MODEL);

  const flags = await listPendingFlags(dbh, { targetType: 'source' });
  const result: RunUrlDriftCurationResult = {
    total: flags.length,
    carded: 0,
    noop: 0,
    escalated: 0,
    skipped: 0,
    errors: 0,
  };

  for (const flag of flags) {
    try {
      const outcome = await proposeForSource(
        dbh,
        flag,
        model,
        detectFn,
        options.notify,
        options.runId,
      );
      result[outcome] += 1;
    } catch (err) {
      // per-source 隔离：只记通用原因 + source id（不泄拓扑），不改事实。批级重试靠 BullMQ attempts。
      result.errors += 1;
      console.error(
        `[mr-url-drift] 源处理失败（已跳过，不改事实）source=${flag.targetId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 尾部：upsert 本轮 metric 行（total_candidates 从持久候选行重算、adopted 留 null 待下轮回填；幂等）。
  await upsertRunMetric(dbh, options.runId);
  return result;
}

/**
 * 处理单个 flagged browser 源：reason-gate → 反查 vendor 域集 → agent → 达阈开卡 + 发卡。
 * 返回分类 outcome（不抛，异常由上层隔离）。**assertUrlAllowed 二次校验失败会抛**（理论不应发生、防注入
 * 的防御纵深）→ 上层 per-source catch 计 error、不写候选行。
 */
async function proposeForSource(
  dbh: DbLike,
  flag: PendingFlag,
  model: DetectUrlDriftInput['model'],
  detectFn: (input: DetectUrlDriftInput) => Promise<UrlDriftAgentOutput>,
  notify: CurationNotify,
  runId: string,
): Promise<SourceOutcome> {
  // reason-gate（m2）：null reason / changed / 未匹配 → fail-closed skip、不空烧 LLM。
  if (flag.reason == null || classifyReason(flag.reason) === null) return 'skipped';
  const reason = flag.reason;

  // 载入源行——仅处理 browser 档（http/manual 跳过）。
  const source = (
    await dbh
      .select({
        id: mrSource.id,
        sourceUrl: mrSource.sourceUrl,
        vendorId: mrSource.vendorId,
        fetchStrategy: mrSource.fetchStrategy,
      })
      .from(mrSource)
      .where(eq(mrSource.id, flag.targetId))
  )[0];
  if (!source || source.fetchStrategy !== 'browser') return 'skipped';

  // 反查该 vendor 的 allowlist 域集（注入 agent prompt + 输出 schema refine，C4 调和 design D5）。
  const domains = await vendorDomainSet(source.vendorId, dbh);

  // 单次 generateObject——判断 URL 是否 drift + 输出候选（candidate）或升级（escalate）。
  const output = await detectFn({
    source: {
      id: source.id,
      sourceUrl: source.sourceUrl,
      vendorId: source.vendorId,
      fetchStrategy: source.fetchStrategy,
    },
    reason,
    vendorDomainSet: domains,
    model,
  });

  // escalate → log-only（m4）：不写候选行、不额外计 metric、不推卡（借 staleness pending flag 自然重浮现）。
  if (output.kind === 'escalate') {
    console.error(
      `[mr-url-drift] agent escalate（log-only、不写候选行）source=${source.id} escalate_reason=${output.escalate_reason}`,
    );
    return 'escalated';
  }

  // candidate 低于置信度阈值 → 记日志跳过（不发卡）。
  if (confidenceRank(output.confidence) < confidenceRank(env.MR_URL_DRIFT_CONFIDENCE_THRESHOLD)) {
    console.error(
      `[mr-url-drift] 候选置信度低于阈值、跳过 source=${source.id} confidence=${output.confidence}`,
    );
    return 'skipped';
  }

  // 达阈值：先规范化候选（剥 fragment / 统一 host case + default port，见 normalizeUrl 注释）——store 去重键、
  // mr_source 唯一约束、no-op 判定与最终落库值全用此 canonical 形，防大小写/端口/fragment 变体逃过去重与 23505。
  const candidateUrl = normalizeUrl(output.candidate_url);

  // 卡片装配长度守卫（见 buildUrlDriftCardText JSDoc：装配后文本长度、保守取原文）：超 MAX_MESSAGE_LENGTH → 跳过不发
  //（否则钉定模型下同候选每轮复现成死循环）；真实定价 URL 远短于限、绝不误跳。token 不进正文、此处不需 token。
  const cardText = buildUrlDriftCardText({
    oldUrl: source.sourceUrl,
    candidateUrl,
    confidence: output.confidence,
    reason: output.reason,
  });
  if (cardText.length > MAX_MESSAGE_LENGTH) {
    console.error(
      `[mr-url-drift] 卡片文本过长（${cardText.length} > ${MAX_MESSAGE_LENGTH}）、跳过 source=${source.id}`,
    );
    return 'skipped';
  }

  // assertUrlAllowed 二次校验（SSRF/全局 allowlist，防 prompt injection）——对 canonical 形（即落库值）断言；越界即抛 SsrfBlockedError。
  assertUrlAllowed(candidateUrl, MR_SOURCE_DOMAIN_ALLOWLIST);

  // 开待批记录（记 run_id + 冻结 flag_opened_at 自该 source flag 的 opened_at）；同 pending 同候选 → noop。
  const opened = await openUrlDriftReviewOrSupersede(
    {
      sourceId: source.id,
      runId,
      oldUrl: source.sourceUrl,
      candidateUrl,
      confidence: output.confidence,
      reason: output.reason,
      flagOpenedAt: flag.openedAtText,
    },
    dbh,
  );
  if (opened.outcome === 'noop') return 'noop';

  // opened / superseded-and-opened → 新令牌 → 发新卡。
  try {
    await notify.telegram(
      buildUrlDriftTelegramCard({
        oldUrl: source.sourceUrl,
        candidateUrl,
        confidence: output.confidence,
        reason: output.reason,
        token: opened.token,
      }),
    );
  } catch (err) {
    // Telegram 发卡失败（重试耗尽）：刚开的未过期 pending 会令下轮「同候选未过期」no-op → 72h 无卡。
    // 置该 review superseded（顶层 db；系统触发无审批人 → decidedBy=null）令下轮重新开卡，再上抛原始
    // Telegram 错误交 per-source 隔离计为 error（非静默 carded）。补偿 supersede 自身失败须单独 catch+log，
    // 绝不掩盖原始 Telegram 错误（否则原因丢失 + review 仍 pending）。
    try {
      await markUrlDriftSuperseded(opened.reviewId, null, dbh);
    } catch (supersedeErr) {
      console.error(
        `[mr-url-drift] 发卡失败后补偿 supersede 也失败（review 仍 pending，待下轮/TTL 兜底）review=${opened.reviewId}`,
        supersedeErr instanceof Error ? supersedeErr.message : String(supersedeErr),
      );
    }
    throw err;
  }
  return 'carded';
}

/**
 * 回填历史 metric 行的 `adopted`（DD2/task 10.2 / design D7）：一条 UPDATE 回填**所有** `adopted IS NULL`
 * 且对应 run 已全部 decided（无未过期 pending）的行——**非 `LIMIT 1`**（只回填最近一行会让旧行永不再被检查）。
 * pending 计数限「未过期」（`extracted_at > now()-TTL`），防 expired-but-not-superseded 行永久阻塞回填。
 */
async function backfillAdoptedMetrics(dbh: DbLike): Promise<void> {
  const ttlHours = env.MR_URL_DRIFT_TTL_HOURS;
  await dbh.execute(sql`
    UPDATE mr_url_drift_metric m SET adopted = sub.adopted
    FROM (
      SELECT m2.run_id,
        (SELECT count(*) FROM mr_url_drift_review WHERE run_id = m2.run_id AND status = 'approved') AS adopted,
        (SELECT count(*) FROM mr_url_drift_review WHERE run_id = m2.run_id AND status = 'pending'
           AND extracted_at > now() - make_interval(hours => ${ttlHours})) AS pend
      FROM mr_url_drift_metric m2
      WHERE m2.adopted IS NULL
    ) sub
    WHERE m.run_id = sub.run_id AND sub.pend = 0
  `);
}

/**
 * upsert 本轮 metric 行（DD2/task 10.2）：`total_candidates` = `count(*) FROM mr_url_drift_review WHERE
 * run_id = $runId`（从持久候选行重算、非 in-memory carded 计数器 → crash+retry 幂等）；`adopted` 留 null
 * 待下轮回填（写 0 则 `WHERE adopted IS NULL` 永不命中）。`ON CONFLICT(run_id) DO UPDATE` **不碰 adopted**
 *（同 run 重放不覆盖已回填值）、只重算 total_candidates + 刷 ran_at。
 */
async function upsertRunMetric(dbh: DbLike, runId: string): Promise<void> {
  await dbh.execute(sql`
    INSERT INTO mr_url_drift_metric (run_id, total_candidates, adopted, ran_at)
    VALUES (
      ${runId},
      (SELECT count(*) FROM mr_url_drift_review WHERE run_id = ${runId}),
      NULL,
      now()
    )
    ON CONFLICT (run_id) DO UPDATE SET
      total_candidates = (SELECT count(*) FROM mr_url_drift_review WHERE run_id = ${runId}),
      ran_at = now()
  `);
}
