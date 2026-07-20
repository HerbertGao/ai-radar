/**
 * Model Radar browser 档 URL drift 待批记录 store（add-model-radar-browser-url-drift-agent，design D2/D5）。
 *
 * `mr_url_drift_review` 行 = 「一条冻结的候选 URL + 一次性能力令牌」跨「agent 检测 → 人批准」异步间隙的载体。
 * 本文件是**纯 store 原语**（与 `price-review-store.ts` 逐字节对称）：只开/认领/终结待批记录，**绝不** import
 * `setSourceUrl` 等事实 writer（改 `mr_source.source_url` 是 group approve.ts 的唯一豁免）。
 *
 * money-path 红线（与价格路径同范式）：
 * - `openUrlDriftReviewOrSupersede` 在**单事务**内锁既有 pending → **未过期且同候选**（`candidate_url` 字面相同）
 *   no-op（不重复发卡）/ **不同候选 或 已过期** 置旧 `superseded` + 插新 pending。**禁**用裸
 *   `INSERT … ON CONFLICT DO NOTHING` 当唯一机制（会吞掉真·不同的新候选，且过期同候选会永久卡死该 source）；
 *   偏唯一索引 `(source_id) WHERE status='pending'` 仅并发兜底。
 * - `token` 由 CSPRNG `randomBytes(16)`（真 128-bit）；`extracted_at` 由 DB `now()`（列 defaultNow）。
 * - `flag_opened_at` 开卡时由调用方冻结传入（当前 source flag 的 `opened_at::text`）——approve 侧 `resolveFlag`
 *   用作 `expectedOpenedAt` generation token、防旧复核 resolve 掉卡片签发后新打的 flag（design D-M4）。
 * - 过期判定用 **DB 单时钟**（`extracted_at <= now() - make_interval(hours => $ttl)`，`ttl` 走绑定参数、
 *   非字面拼接），防应用时钟偏移改变有效期窗口。
 * - `claimUrlDriftReview` CAS 谓词含有效期，闭合"泄漏令牌长期可用"窗口；RETURNING 冻结值供批准落库
 *   （绝不从入站取 URL）——**MUST 含 `flag_opened_at`**（approve step ③ `setSourceUrl` 的 `expectedOpenedAt`
 *   取 `claimed.flagOpenedAt`，漏列则 D-M4 generation 守卫静默失效）。
 * - 写 `mr_url_drift_review`（openReview/supersede）发 SQL 前过 `mrUrlDriftReviewWriteSchema`（status/confidence
 *   枚举闸 + token 定长 hex + 关键非空串）；CAS 只改常量 status 可免。
 */
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { mrUrlDriftReview } from '../../db/schema.js';
import { mrUrlDriftReviewWriteSchema } from '../../db/mr-schema.zod.js';
import { env } from '../../config/env.js';

/** db 句柄类型（drizzle 实例）。 */
type DbLike = typeof defaultDb;
/** 事务句柄类型（DbLike.transaction 回调入参）。 */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

const STATUS_PENDING = 'pending';
const STATUS_APPROVED = 'approved';
const STATUS_SUPERSEDED = 'superseded';
const STATUS_APPLY_FAILED = 'apply_failed';

/** 开待批记录入参（候选 URL / confidence / reason / frozen provenance 均将冻结在行上）。 */
export interface OpenUrlDriftReviewInput {
  sourceId: string;
  /** 本轮 drift lane 的 run_id（= BullMQ job 稳定 id）——作 `mr_url_drift_metric.run_id` 回填 join key。 */
  runId: string;
  /** 开卡时 source 的现 URL 快照（批准时 old-URL CAS 校验现 URL 未漂移）。 */
  oldUrl: string;
  /** agent 输出的候选 URL（propose 侧已过 schema refine + assertUrlAllowed 二次校验）。 */
  candidateUrl: string;
  /** 置信度（过 Zod 枚举闸 low/medium/high）。 */
  confidence: string;
  /** agent 给出的 drift 推断理由（frozen；非入 schema 闸）。 */
  reason: string;
  /** 开卡时从当前 source flag 的 `opened_at::text` 冻结读入（frozen generation token，design D-M4）。 */
  flagOpenedAt: string;
}

export type OpenUrlDriftReviewOutcome =
  /** 已有未过期同候选 pending → 不重复开记录/不重复发卡。 */
  | { outcome: 'noop' }
  /** 无既有 pending → 新开一条 pending（发新卡）。 */
  | { outcome: 'opened'; reviewId: string; token: string }
  /** 既有 pending 为不同候选或已过期 → 置旧 superseded 并插新 pending（发新卡）。 */
  | {
      outcome: 'superseded-and-opened';
      reviewId: string;
      token: string;
      supersededId: string;
    };

/**
 * 开待批记录 / supersede-重开（design D2/D5）。**单事务**锁既有 pending：
 * 未过期且同候选（`candidate_url` 字面相同）→ no-op；不同候选 或 已过期 → 置旧 `superseded` + 插新 pending
 *（新令牌/新 extracted_at）。
 *
 * @param input 候选 + frozen provenance（将冻结在行上）。
 * @param dbh db 句柄（默认全局 db，须支持 transaction）。
 */
export async function openUrlDriftReviewOrSupersede(
  input: OpenUrlDriftReviewInput,
  dbh: DbLike = defaultDb,
): Promise<OpenUrlDriftReviewOutcome> {
  // 令牌由 randomBytes(16) → 32 hex；extracted_at 不由 app 写（列 defaultNow）。
  const token = randomBytes(16).toString('hex');
  // 写前过 Zod 闸（status/confidence 枚举 + token 定长 hex + 关键非空串合法性唯一防线）。
  const gated = mrUrlDriftReviewWriteSchema.parse({
    status: STATUS_PENDING,
    confidence: input.confidence,
    token,
    source_id: input.sourceId,
    run_id: input.runId,
    old_url: input.oldUrl,
    candidate_url: input.candidateUrl,
    flag_opened_at: input.flagOpenedAt,
  });
  const ttlHours = env.MR_URL_DRIFT_TTL_HOURS;

  return dbh.transaction(async (tx) => {
    // 锁既有 pending（偏唯一索引保证至多一条）；expired 由 DB 单时钟算出（ttl 绑定参数、非字面拼接）。
    const existing = (
      await tx
        .select({
          id: mrUrlDriftReview.id,
          candidateUrl: mrUrlDriftReview.candidateUrl,
          expired: sql<boolean>`${mrUrlDriftReview.extractedAt} <= now() - make_interval(hours => ${ttlHours})`,
        })
        .from(mrUrlDriftReview)
        .where(
          and(
            eq(mrUrlDriftReview.sourceId, input.sourceId),
            eq(mrUrlDriftReview.status, STATUS_PENDING),
          ),
        )
        .for('update')
    )[0];

    let supersededId: string | undefined;
    if (existing) {
      // 同候选 = candidate_url 字面相同（spec：未过期同候选 no-op）。
      const isSame = existing.candidateUrl === input.candidateUrl;
      // 未过期且同候选 → no-op（不重复发卡）。绝不对「不同候选 / 过期同候选」no-op（前者吞新候选、后者永久卡死）。
      if (isSame && !existing.expired) {
        return { outcome: 'noop' as const };
      }
      // 不同候选 或 已过期 → 置旧行 superseded（键 id，行锁已持）。
      await tx
        .update(mrUrlDriftReview)
        .set({ status: STATUS_SUPERSEDED, decidedAt: sql`now()` })
        .where(eq(mrUrlDriftReview.id, existing.id));
      supersededId = existing.id;
    }

    // 插新 pending：新 CSPRNG 令牌、extracted_at 由列 defaultNow()（DB now()）。裸 INSERT——
    // 偏唯一索引仅并发兜底（两 proposer 同插则唯一冲突抛出，交 BullMQ 重试），不当唯一机制用。
    const inserted = (
      await tx
        .insert(mrUrlDriftReview)
        .values({
          sourceId: input.sourceId,
          runId: input.runId,
          oldUrl: input.oldUrl,
          candidateUrl: input.candidateUrl,
          confidence: gated.confidence,
          reason: input.reason,
          flagOpenedAt: input.flagOpenedAt,
          token,
          status: STATUS_PENDING,
        })
        .returning({ id: mrUrlDriftReview.id, token: mrUrlDriftReview.token })
    )[0];
    if (!inserted) {
      // INSERT … RETURNING 恒返一行；空 = 驱动/桩异常，fail-closed 抛出（绝不返回无 token 的成功）。
      throw new Error('openUrlDriftReviewOrSupersede: INSERT RETURNING 为空');
    }

    if (supersededId !== undefined) {
      return {
        outcome: 'superseded-and-opened' as const,
        reviewId: inserted.id,
        token: inserted.token,
        supersededId,
      };
    }
    return {
      outcome: 'opened' as const,
      reviewId: inserted.id,
      token: inserted.token,
    };
  });
}

/** 认领返回的行上**冻结值**（批准落库只用这些，绝不从入站取 URL/provenance）。 */
export interface ClaimedUrlDriftReview {
  id: string;
  sourceId: string;
  oldUrl: string;
  candidateUrl: string;
  /** frozen flag generation token——approve step ③ setSourceUrl 的 expectedOpenedAt（design D-M4）。 */
  flagOpenedAt: string;
}

/**
 * CAS 认领（design D2/D5）——`WHERE token=? AND status='pending' AND extracted_at > now()-make_interval(hours=>$ttl)`。
 * 有效期谓词用 DB 单时钟、ttl 绑定参数（非字面拼接）。0 行（已决/重放/过期）→ 返回 null（幂等 no-op）。
 * 非空 → 置 `approved` 并 RETURNING 行上冻结值供批准落库（**MUST 含 `flag_opened_at`**——step ③
 * `setSourceUrl` 的 `expectedOpenedAt` 取 `claimed.flagOpenedAt`）。
 *
 * 接 `DbLike | TxLike`（单语句 CAS）：group approve.ts `applyUrlDriftReview` 在其主事务内传入已开 tx，使认领与
 * 落库同事务（失败回滚连认领一并回滚，行留 pending，再由独立事务 markUrlDriftApplyFailed）。
 *
 * @param token 一次性令牌（调用方须已校验定长/字符集）。
 * @param decidedBy 批准人标识（写 decided_by 审计）。
 * @param dbh db/tx 句柄（默认全局 db）。
 */
export async function claimUrlDriftReview(
  token: string,
  decidedBy: string,
  dbh: DbLike | TxLike = defaultDb,
): Promise<ClaimedUrlDriftReview | null> {
  const ttlHours = env.MR_URL_DRIFT_TTL_HOURS;
  const rows = await dbh
    .update(mrUrlDriftReview)
    // CAS 只改常量 status（+ 审计字段）→ 免 Zod（无有限值列取自外部）。
    .set({ status: STATUS_APPROVED, decidedAt: sql`now()`, decidedBy })
    .where(
      and(
        eq(mrUrlDriftReview.token, token),
        eq(mrUrlDriftReview.status, STATUS_PENDING),
        sql`${mrUrlDriftReview.extractedAt} > now() - make_interval(hours => ${ttlHours})`,
      ),
    )
    .returning({
      id: mrUrlDriftReview.id,
      sourceId: mrUrlDriftReview.sourceId,
      oldUrl: mrUrlDriftReview.oldUrl,
      candidateUrl: mrUrlDriftReview.candidateUrl,
      flagOpenedAt: mrUrlDriftReview.flagOpenedAt,
    });
  return rows[0] ?? null;
}

/**
 * 置 `superseded`（propose 侧发新卡标旧行路径，design D2）——**独立事务**、键 `WHERE id=? AND status='pending'`
 *（键 id 非 source/status：防并发 proposer 已 supersede 该行后误标）。0 行则不动、返回 0（调用方记日志）。
 * `decidedBy` 接受 `string | null`（system-triggered supersede 传 `null`）。
 *
 * ponytail: 单 UPDATE 即原子独立事务；调用方须传顶层 db（非已回滚的主 tx 句柄）以获真独立。
 */
export async function markUrlDriftSuperseded(
  id: string,
  decidedBy: string | null,
  dbh: DbLike = defaultDb,
): Promise<number> {
  const rows = await dbh
    .update(mrUrlDriftReview)
    .set({ status: STATUS_SUPERSEDED, decidedAt: sql`now()`, decidedBy })
    .where(and(eq(mrUrlDriftReview.id, id), eq(mrUrlDriftReview.status, STATUS_PENDING)))
    .returning({ id: mrUrlDriftReview.id });
  return rows.length;
}

/**
 * 置 `apply_failed`（approve 侧落库失败路径，design D2）——**独立事务**、键 `WHERE id=? AND status='pending'`。
 * 0 行则不动、返回 0（调用方记日志）。apply_failed 非 pending → 偏索引放行新候选、经 staleness 重浮现。
 *
 * **签名与价格路径 `markApplyFailed(id, decidedBy, dbh)` 逐字对称**——`apply_failure_kind` 列已删（design D-B3），
 * 第三参 kind 一并去掉；失败原因经日志记完整 `reason` 字符串、不落库 kind 列。
 *
 * ponytail: 单 UPDATE 即原子独立事务；调用方须传顶层 db（非已回滚的主 tx 句柄）以获真独立。
 */
export async function markUrlDriftApplyFailed(
  id: string,
  decidedBy: string | null,
  dbh: DbLike = defaultDb,
): Promise<number> {
  const rows = await dbh
    .update(mrUrlDriftReview)
    .set({ status: STATUS_APPLY_FAILED, decidedAt: sql`now()`, decidedBy })
    .where(and(eq(mrUrlDriftReview.id, id), eq(mrUrlDriftReview.status, STATUS_PENDING)))
    .returning({ id: mrUrlDriftReview.id });
  return rows.length;
}
