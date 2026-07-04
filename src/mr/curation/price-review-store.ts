/**
 * Model Radar 价格 curation 待批记录 store（add-model-radar-price-curation-approval，design D2/D3/D5，group E）。
 *
 * `mr_price_review` 行 = 「一条冻结的候选事实 + 一次性能力令牌」跨「检测→人批准」异步间隙的载体。
 * 本文件是**纯 store 原语**：只开/认领/终结待批记录，**绝不** import `recordPriceChange` 等事实 writer
 * （落库是 group F `approve.ts` 的唯一豁免）。
 *
 * money-path 红线：
 * - `openReviewOrSupersede` 在**单事务**内锁既有 pending → **未过期且同候选** no-op（不重复发卡）/
 *   **不同候选 或 已过期** 置旧 `superseded` + 插新 pending。**禁**用裸 `INSERT … ON CONFLICT DO NOTHING`
 *   当唯一机制（会吞掉真·不同的新候选，且过期同候选会永久卡死该 plan）；偏唯一索引仅并发兜底。
 * - `token` 由 CSPRNG `randomBytes(16)`（真 128-bit）；`extracted_at` 由 DB `now()`（列 defaultNow）。
 * - 过期判定用 **DB 单时钟**（`extracted_at <= now() - make_interval(hours => $ttl)`，`ttl` 走绑定参数、
 *   非字面拼接），防应用时钟偏移改变有效期窗口。
 * - `claimReview` CAS 谓词含有效期，闭合"泄漏令牌长期可用"窗口；RETURNING 冻结值供批准落库（绝不从入站取金额）。
 * - 写 `mr_price_review`（openReview/supersede）发 SQL 前过 `mrPriceReviewWriteSchema`（status/currency/
 *   source_confidence 枚举闸）；CAS 只改常量 status 可免。
 */
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { mrPriceReview } from '../../db/schema.js';
import { mrPriceReviewWriteSchema } from '../../db/mr-schema.zod.js';
import { env } from '../../config/env.js';
import { sameMoney } from './money.js';

/** db 句柄类型（drizzle 实例）。 */
type DbLike = typeof defaultDb;
/** 事务句柄类型（DbLike.transaction 回调入参）。 */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

const STATUS_PENDING = 'pending';
const STATUS_APPROVED = 'approved';
const STATUS_SUPERSEDED = 'superseded';
const STATUS_APPLY_FAILED = 'apply_failed';

/** numeric(12,2) 列写入归一：drizzle numeric 收 string；NULL 直传。 */
function toNumericOrNull(v: string | number | null): string | null {
  return v == null ? null : String(v);
}

/** 开待批记录入参（候选值/币种/现价快照/provenance 均将冻结在行上）。 */
export interface OpenReviewInput {
  planId: string;
  /** 开记录时的 `current_price` 快照（基线；批准时校验现价未漂移）。 */
  oldValue: string | number | null;
  /** 待落的候选值（propose 侧仅在候选异于现价时调用；escalate 无值卡走别处不经本入口）。 */
  candidateValue: string | number | null;
  /** 币种（过 Zod 枚举闸；nullable 容 NULL 基线）。 */
  currency: string | null;
  sourceUrl: string;
  /** 过 Zod 枚举闸（gate 已保证官方 provenance 才带值）。 */
  sourceConfidence: string;
}

export type OpenReviewOutcome =
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
 * 未过期且同候选 → no-op；不同候选 或 已过期 → 置旧 `superseded` + 插新 pending（新令牌/新 extracted_at）。
 *
 * @param input 候选 + provenance（将冻结在行上）。
 * @param dbh db 句柄（默认全局 db，须支持 transaction）。
 */
export async function openReviewOrSupersede(
  input: OpenReviewInput,
  dbh: DbLike = defaultDb,
): Promise<OpenReviewOutcome> {
  // 写前过 Zod 枚举闸（status/currency/source_confidence 有限值列合法性唯一防线）。
  const gated = mrPriceReviewWriteSchema.parse({
    status: STATUS_PENDING,
    currency: input.currency,
    source_confidence: input.sourceConfidence,
  });
  const ttlHours = env.MR_PRICE_REVIEW_TTL_HOURS;

  return dbh.transaction(async (tx) => {
    // 锁既有 pending（偏唯一索引保证至多一条）；expired 由 DB 单时钟算出（ttl 绑定参数、非字面拼接）。
    const existing = (
      await tx
        .select({
          id: mrPriceReview.id,
          candidateValue: mrPriceReview.candidateValue,
          currency: mrPriceReview.currency,
          expired: sql<boolean>`${mrPriceReview.extractedAt} <= now() - make_interval(hours => ${ttlHours})`,
        })
        .from(mrPriceReview)
        .where(
          and(
            eq(mrPriceReview.planId, input.planId),
            eq(mrPriceReview.status, STATUS_PENDING),
          ),
        )
        .for('update')
    )[0];

    let supersededId: string | undefined;
    if (existing) {
      const isSame = sameMoney(
        existing.candidateValue,
        existing.currency,
        input.candidateValue,
        gated.currency,
      );
      // 未过期且同候选 → no-op（不重复发卡）。绝不对「不同候选 / 过期同候选」no-op（前者吞新价、后者永久卡死）。
      if (isSame && !existing.expired) {
        return { outcome: 'noop' as const };
      }
      // 不同候选 或 已过期 → 置旧行 superseded（键 id，行锁已持）。
      await tx
        .update(mrPriceReview)
        .set({ status: STATUS_SUPERSEDED, decidedAt: sql`now()` })
        .where(eq(mrPriceReview.id, existing.id));
      supersededId = existing.id;
    }

    // 插新 pending：新 CSPRNG 令牌、extracted_at 由列 defaultNow()（DB now()）。裸 INSERT——
    // 偏唯一索引仅并发兜底（两 proposer 同插则唯一冲突抛出，交 BullMQ 重试），不当唯一机制用。
    const token = randomBytes(16).toString('hex');
    const inserted = (
      await tx
        .insert(mrPriceReview)
        .values({
          planId: input.planId,
          oldValue: toNumericOrNull(input.oldValue),
          candidateValue: toNumericOrNull(input.candidateValue),
          currency: gated.currency,
          sourceUrl: input.sourceUrl,
          sourceConfidence: gated.source_confidence,
          token,
          status: STATUS_PENDING,
        })
        .returning({ id: mrPriceReview.id, token: mrPriceReview.token })
    )[0];
    if (!inserted) {
      // INSERT … RETURNING 恒返一行；空 = 驱动/桩异常，fail-closed 抛出（绝不返回无 token 的成功）。
      throw new Error('openReviewOrSupersede: INSERT RETURNING 为空');
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

/** 认领返回的行上**冻结值**（批准落库只用这些，绝不从入站取金额/币种/provenance）。 */
export interface ClaimedReview {
  id: string;
  planId: string;
  oldValue: string | null;
  candidateValue: string | null;
  currency: string | null;
  sourceUrl: string;
  sourceConfidence: string;
}

/**
 * CAS 认领（design D3/D5）——`WHERE token=? AND status='pending' AND extracted_at > now()-make_interval(hours=>$ttl)`。
 * 有效期谓词用 DB 单时钟、ttl 绑定参数（非字面拼接）。0 行（已决/重放/过期）→ 返回 null（幂等 no-op）。
 * 非空 → 置 `approved` 并 RETURNING 行上冻结值供批准落库。
 *
 * 接 `DbLike | TxLike`（单语句 CAS）：group F `applyReview` 在其主事务内传入已开 tx，使认领与落库同事务
 * （失败回滚连认领一并回滚，行留 pending，再由独立事务 markApplyFailed）。
 *
 * @param token 一次性令牌（调用方须已校验定长/字符集）。
 * @param decidedBy 批准人标识（写 decided_by 审计）。
 * @param dbh db/tx 句柄（默认全局 db）。
 */
export async function claimReview(
  token: string,
  decidedBy: string,
  dbh: DbLike | TxLike = defaultDb,
): Promise<ClaimedReview | null> {
  const ttlHours = env.MR_PRICE_REVIEW_TTL_HOURS;
  const rows = await dbh
    .update(mrPriceReview)
    // CAS 只改常量 status（+ 审计字段）→ 免 Zod（无有限值列取自外部）。
    .set({ status: STATUS_APPROVED, decidedAt: sql`now()`, decidedBy })
    .where(
      and(
        eq(mrPriceReview.token, token),
        eq(mrPriceReview.status, STATUS_PENDING),
        sql`${mrPriceReview.extractedAt} > now() - make_interval(hours => ${ttlHours})`,
      ),
    )
    .returning({
      id: mrPriceReview.id,
      planId: mrPriceReview.planId,
      oldValue: mrPriceReview.oldValue,
      candidateValue: mrPriceReview.candidateValue,
      currency: mrPriceReview.currency,
      sourceUrl: mrPriceReview.sourceUrl,
      sourceConfidence: mrPriceReview.sourceConfidence,
    });
  return rows[0] ?? null;
}

/**
 * 置 `superseded`（基线漂移路径，design D5）——**独立事务**、键 `WHERE id=? AND status='pending'`
 * （键 id 非 plan/status：防并发 proposer 已 supersede 该行后误标）。0 行则不动、返回 0（调用方记日志）。
 *
 * ponytail: 单 UPDATE 即原子独立事务；调用方须传顶层 db（非已回滚的主 tx 句柄）以获真独立。
 */
export async function markSuperseded(
  id: string,
  decidedBy: string | null,
  dbh: DbLike = defaultDb,
): Promise<number> {
  const rows = await dbh
    .update(mrPriceReview)
    .set({ status: STATUS_SUPERSEDED, decidedAt: sql`now()`, decidedBy })
    .where(and(eq(mrPriceReview.id, id), eq(mrPriceReview.status, STATUS_PENDING)))
    .returning({ id: mrPriceReview.id });
  return rows.length;
}

/**
 * 置 `apply_failed`（落库失败路径，design D5）——**独立事务**、键 `WHERE id=? AND status='pending'`。
 * 0 行则不动、返回 0（调用方记日志）。apply_failed 非 pending → 偏索引放行新候选、经 staleness 重浮现。
 *
 * ponytail: 单 UPDATE 即原子独立事务；调用方须传顶层 db（非已回滚的主 tx 句柄）以获真独立。
 */
export async function markApplyFailed(
  id: string,
  decidedBy: string | null,
  dbh: DbLike = defaultDb,
): Promise<number> {
  const rows = await dbh
    .update(mrPriceReview)
    .set({ status: STATUS_APPLY_FAILED, decidedAt: sql`now()`, decidedBy })
    .where(and(eq(mrPriceReview.id, id), eq(mrPriceReview.status, STATUS_PENDING)))
    .returning({ id: mrPriceReview.id });
  return rows.length;
}
