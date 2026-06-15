/**
 * 知识库一次性历史回填（ops 工具，复用前向入库路径）。
 *
 * 背景：`runKbIngestion`（src/kb/index.ts）按设计是**前向、按天**的——候选 = 当日（`push_date=今日`）
 * 推送成功且非 tombstone 的事件。它没有历史回填路径。本驱动用于把**既有历史数据**也灌入本地表知识库：
 * 枚举历史上「曾推送成功」的全部 `push_date`，**逐日复用 `runKbIngestion`**（把 `now` 设为该自然日），
 * 完全走与日报链相同的「KB Agent → 准入闸 ≥70 → embedding → 状态感知认领 + 两表原子入库」。
 *
 * 关键性质：
 * - **幂等**：复用 `runKbIngestion` 的状态感知认领（`UNIQUE(target_type,target_id,kb_provider)` +
 *   `ON CONFLICT DO UPDATE WHERE status<>'success'`），同一事件已 `success` 即跳过；可安全重复跑。
 * - **不推送**：仅写 `kb_documents`/`kb_ingestion_records`，不触发任何 Telegram/飞书推送。
 * - **降级隔离**：单条 Agent/embed/写入失败被 `runKbIngestion` 内部隔离，不中止整批。
 *
 * 仅作一次性运维执行（`npm run kb:backfill`，见 backfill-main.ts），不挂入任何调度链。
 */
import { and, asc, eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { pushRecords } from '../db/schema.js';
import { TARGET_TYPE, type TargetType } from '../push/targets.js';
import {
  runKbIngestion,
  type RunKbIngestionOptions,
  type KbIngestionResult,
} from './index.js';

type DbLike = typeof defaultDb;

export interface RunKbBackfillOptions {
  /** 透传给每个 push_date 的 `runKbIngestion`（`now`/`targetType` 由本驱动按各历史日注入，不可外覆）。 */
  ingestion?: Omit<RunKbIngestionOptions, 'now' | 'targetType'>;
  /** 目标实体类型，默认 'event'（本期仅事件入库，与前向一致）。 */
  targetType?: TargetType;
  /** 注入 `runKbIngestion`（测试桩）；默认真实实现。 */
  ingestFn?: (
    options: RunKbIngestionOptions,
    dbh: DbLike,
  ) => Promise<KbIngestionResult>;
  /** 信息/进度日志 sink，默认 console.error（非静默）。 */
  log?: (message: string) => void;
}

export interface KbBackfillResult {
  /** 回填覆盖的历史 push_date 数。 */
  pushDates: number;
  /** 每个 push_date 的入库结果（按日升序）。 */
  perDate: Array<{ pushDate: string; result: KbIngestionResult }>;
  /** 跨全部历史日的累计统计（各字段按日求和）。 */
  totals: KbIngestionResult;
}

/**
 * 把历史 `push_date`（`YYYY-MM-DD`）映射到落在该自然日的参考时刻：取该日 **12:00（Asia/Shanghai=UTC+8）**，
 * 即 `04:00:00Z`，使 `runKbIngestion` 内 `getPushDate(now)` 还原为同一 `push_date`。
 *
 * 安全性：中国时区无 DST、恒为 UTC+8，故 `12:00 China == 04:00 UTC` 始终成立，回填日历不偏移。
 */
function middayUtcForPushDate(pushDate: string): Date {
  return new Date(`${pushDate}T04:00:00.000Z`);
}

const RESULT_KEYS: (keyof KbIngestionResult)[] = [
  'candidates',
  'agentOk',
  'agentFailed',
  'gatedOut',
  'ingested',
  'skippedClaimed',
  'storeFailed',
];

/**
 * 跑一次知识库历史回填：枚举历史 push success 日，逐日复用 `runKbIngestion`。
 *
 * @param options 注入点（每日 ingestion 选项 / targetType / ingestFn 桩 / 日志）。
 * @param dbh db 句柄（默认全局 db）。
 */
export async function runKbBackfill(
  options: RunKbBackfillOptions = {},
  dbh: DbLike = defaultDb,
): Promise<KbBackfillResult> {
  const targetType = options.targetType ?? TARGET_TYPE.event;
  const ingest = options.ingestFn ?? runKbIngestion;
  const log = options.log ?? ((m) => console.error(`[kb-backfill] ${m}`));

  // 历史上「曾推送成功」的全部 push_date（升序）。逐日复用前向入库（幂等：已 success 跳过）。
  const dateRows = await dbh
    .selectDistinct({ pushDate: pushRecords.pushDate })
    .from(pushRecords)
    .where(
      and(
        eq(pushRecords.targetType, targetType),
        eq(pushRecords.status, 'success'),
      ),
    )
    .orderBy(asc(pushRecords.pushDate));

  log(
    `发现 ${dateRows.length} 个历史 push_date（${targetType} success），逐日回填（复用前向入库、幂等）…`,
  );

  const perDate: KbBackfillResult['perDate'] = [];
  const totals: KbIngestionResult = {
    candidates: 0,
    agentOk: 0,
    agentFailed: 0,
    gatedOut: 0,
    ingested: 0,
    skippedClaimed: 0,
    storeFailed: 0,
  };

  for (const { pushDate } of dateRows) {
    const now = middayUtcForPushDate(pushDate);
    const result = await ingest({ ...options.ingestion, now, targetType }, dbh);
    perDate.push({ pushDate, result });
    for (const k of RESULT_KEYS) totals[k] += result[k];
    log(
      `${pushDate}: 候选 ${result.candidates}、入库 ${result.ingested}、闸下 ${result.gatedOut}、` +
        `已存跳过 ${result.skippedClaimed}、Agent失败 ${result.agentFailed}、写失败 ${result.storeFailed}`,
    );
  }

  log(
    `回填完成：${dateRows.length} 日 | 累计 候选 ${totals.candidates}、入库 ${totals.ingested}、` +
      `闸下 ${totals.gatedOut}、已存跳过 ${totals.skippedClaimed}、Agent失败 ${totals.agentFailed}、写失败 ${totals.storeFailed}`,
  );
  return { pushDates: dateRows.length, perDate, totals };
}
