/**
 * Model Radar 价格 curation 批准核心（add-model-radar-price-curation-approval，design D5，group F）。
 *
 * `applyReview(token, decidedBy)` = money-path 唯一落库入口，也是整个 `curation/**` 中**唯一**被 eslint
 * 豁免、允许 import 事实 writer（`_recordPriceChangeTx`）的文件（design D1）。其余 curation 文件禁 import。
 *
 * money-path 红线（design D5）：
 * - **主事务**：`claimReview`（CAS 认领、传已开 tx，RETURNING id + 行上冻结值）→ 0 行（已决/重放/过期）→ noop；
 *   非空 → 锁 plan 校验 `current_price/currency === 冻结 old_value/currency`（不等 = 基线漂移 → 抛出）→
 *   `_recordPriceChangeTx`（同事务、传**冻结**候选/provenance）→ **按真实 outcome 判定**：成功唯一可达 =
 *   `appended`；`history-conflict`/任何非 `appended` → 抛出（`noop-*` 在此路径不可达，一并按非成功处理即安全）。
 * - money 值/币种/provenance **只从冻结行读**（`claimReview` 返回），绝不从入站 token/decidedBy 之外取。
 * - **成功路径不碰 `mr_review_flag`、不刷 child `last_checked`、不 markChecked**——价格 freshness 已由
 *   `_recordPriceChangeTx` 刷的 `mr_plans.last_checked` 覆盖；整页指纹 flag 交人 dispose、未策展同页事实由
 *   staleness 兜底（markChecked = resolveFlag + 刷全 child，会塌缩整页 flag + 假刷未复核 child，禁用）。
 * - 提交**后**才 best-effort `publishSnapshotInvalidation`（`_recordPriceChangeTx` 只在 tx 内写、无 public
 *   wrapper 的 after-commit rebuild）——此调用**不得**使已成功的批准转失败（仿 public wrapper 视失败非致命）。
 * - **任何失败**（throw）→ 主事务回滚（CAS 认领一并回滚 → 行回 pending）→ **独立事务**（传顶层 db，非已回滚
 *   的 tx 句柄）`markApplyFailed(id)`（基线漂移对称 `markSuperseded(id)`），键 `WHERE id=? AND status='pending'`；
 *   0 行则不动 + 记日志。flag **不 resolve** → 经 staleness 重浮现。
 * - 不在此调 `answerCallbackQuery`（那是 callback handler 职责）；只返回 discriminated 结果供其映射反馈文案。
 * - 日志**只记 review id / plan id**，绝不记 token/candidate（token 脱敏）。
 */
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { mrPlans } from '../../db/schema.js';
import { _recordPriceChangeTx } from '../ingest/record-price-change.js';
import { publishSnapshotInvalidation } from '../snapshot/invalidation.js';
import {
  claimReview,
  markApplyFailed,
  markSuperseded,
} from './price-review-store.js';
import { sameMoney } from './money.js';

/** db 句柄类型（drizzle 实例，须支持 transaction）。 */
type DbLike = typeof defaultDb;

/** 批准结果（discriminated；callback handler 据此映射 answerCallbackQuery 文案）。 */
export type ApplyReviewResult =
  /** 真落库一次（outcome=appended）；提交后已尽力触发快照失效。 */
  | { kind: 'applied'; reviewId: string; planId: string; oldValue: string | null; newValue: string }
  /** CAS 0 行（已决/重放/过期）→ 幂等 no-op、未落库。 */
  | { kind: 'noop' }
  /** 现价≠冻结 old（基线漂移）→ 未落库、独立事务已置 superseded。 */
  | { kind: 'baseline-drift'; reviewId: string }
  /** 写入未生效或抛错 → 未落库、独立事务已置 apply_failed。 */
  | { kind: 'failed'; reviewId: string; reason: string };

/** 基线漂移哨兵（携带认领 id，供回滚后独立事务按 id 置 superseded）。 */
class BaselineDriftError extends Error {
  constructor(readonly reviewId: string) {
    super('baseline drift');
    this.name = 'BaselineDriftError';
  }
}

/** 落库失败哨兵（携带认领 id + 原因，供回滚后独立事务按 id 置 apply_failed）。 */
class ApplyFailedError extends Error {
  constructor(readonly reviewId: string, reason: string) {
    super(reason);
    this.name = 'ApplyFailedError';
  }
}

/**
 * 批准落库（design D5）。见文件头红线。money 值/币种/provenance 只从 `claimReview` 返回的冻结行读。
 *
 * @param token 一次性令牌（调用方须已校验定长/字符集 + 鉴权）。
 * @param decidedBy 批准人标识（写 decided_by 审计）。
 * @param dbh db 句柄（默认全局 db；独立收敛事务用**顶层 db** 而非主 tx 句柄）。
 */
export async function applyReview(
  token: string,
  decidedBy: string,
  dbh: DbLike = defaultDb,
): Promise<ApplyReviewResult> {
  let claimedId: string | undefined;
  let applied:
    | { planId: string; oldValue: string | null; newValue: string }
    | undefined;

  try {
    const kind = await dbh.transaction(async (tx) => {
      // ① CAS 认领（传已开 tx，使认领与落库同事务：失败回滚连认领一并回滚，行留 pending）。
      const claimed = await claimReview(token, decidedBy, tx);
      if (!claimed) return 'noop' as const; // 0 行（已决/重放/过期）→ 幂等 no-op（提交无害，CAS 影响 0 行）。
      claimedId = claimed.id;

      // ② 锁 plan 校验基线：current_price/currency 必须等于行上冻结 old_value/currency（不等 = 漂移 → 抛出回滚）。
      const lockedRows = await tx
        .select({ currentPrice: mrPlans.currentPrice, currency: mrPlans.currency })
        .from(mrPlans)
        .where(eq(mrPlans.id, claimed.planId))
        .for('update');
      const plan = lockedRows[0];
      if (!plan) {
        // plan 不存在（建行是 upsertPlan 职责）——非漂移，按落库失败处置。
        throw new ApplyFailedError(claimed.id, `plan 不存在（id=${claimed.planId}）`);
      }
      if (
        !sameMoney(
          plan.currentPrice,
          plan.currency,
          claimed.oldValue,
          claimed.currency,
        )
      ) {
        throw new BaselineDriftError(claimed.id); // 基线漂移：ratio-gate 前提失效 → 回滚 → superseded。
      }

      // ③ 同事务落库（传**冻结**候选/provenance）。candidateValue/currency 为 nullable DB 列——gate=prefill
      // 保证非 null，但显式运行时校验移除 `as string` 谎言：null 则 apply_failed（与 writer Zod 抛错同路径）。
      if (claimed.candidateValue == null || claimed.currency == null) {
        throw new ApplyFailedError(
          claimed.id,
          `冻结行 candidateValue/currency 为 null（review=${claimed.id}）`,
        );
      }
      const outcome = await _recordPriceChangeTx(tx, {
        planId: claimed.planId,
        newValue: claimed.candidateValue,
        currency: claimed.currency,
        provenance: {
          sourceUrl: claimed.sourceUrl,
          sourceConfidence: claimed.sourceConfidence,
        },
      });
      // ④ 按真实 outcome 判定：基线校验已保证进写入时是真变更，成功唯一可达 = appended；其余（含 history-conflict）= 失败。
      if (outcome.outcome !== 'appended') {
        throw new ApplyFailedError(
          claimed.id,
          `recordPriceChange 未生效（outcome=${outcome.outcome}）`,
        );
      }
      applied = {
        planId: claimed.planId,
        oldValue: outcome.oldValue,
        newValue: outcome.newValue,
      };
      // ⑤ 成功路径不碰 mr_review_flag、不刷 child last_checked、不 markChecked（见文件头红线）。
      return 'applied' as const;
    });

    if (kind === 'noop') return { kind: 'noop' };

    // ⑥ 主事务已提交：best-effort 触发快照失效（不得使已成功的批准转失败；publish 内部已 never-throw，仍兜底 catch）。
    try {
      await publishSnapshotInvalidation();
    } catch (err) {
      console.error(
        `[mr-curation] applyReview 快照失效失败（best-effort，批准仍成功）review=${claimedId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      kind: 'applied',
      reviewId: claimedId!,
      planId: applied!.planId,
      oldValue: applied!.oldValue,
      newValue: applied!.newValue,
    };
  } catch (err) {
    // 主事务已回滚（CAS 认领一并回滚 → 行回 pending）。独立事务用**顶层 db**（非已回滚的主 tx 句柄）收敛状态。
    // ponytail: commit-ack-loss 天花板——非 2PC 下若主事务已提交（价已落库）但驱动在 ack 时抛错，
    // 会走到这里置 apply_failed 并回 `failed`（用户见"失败"而价其实已录）。可接受：无跨资源 2PC，
    // 且经周期快照 rebuild + staleness 自愈（价已在 mr_plans，下轮可见）；要强一致须上 2PC/outbox，不值当。
    if (err instanceof BaselineDriftError) {
      const n = await markSuperseded(err.reviewId, decidedBy, dbh);
      if (n === 0) {
        console.error(
          `[mr-curation] applyReview 基线漂移置 superseded 命中 0 行（已被并发处置）review=${err.reviewId}`,
        );
      }
      return { kind: 'baseline-drift', reviewId: err.reviewId };
    }
    if (err instanceof ApplyFailedError) {
      const n = await markApplyFailed(err.reviewId, decidedBy, dbh);
      if (n === 0) {
        console.error(
          `[mr-curation] applyReview 置 apply_failed 命中 0 行（已被并发处置）review=${err.reviewId}`,
        );
      }
      console.error(
        `[mr-curation] applyReview 落库失败 review=${err.reviewId}: ${err.message}`,
      );
      return { kind: 'failed', reviewId: err.reviewId, reason: err.message };
    }
    // 认领后其他抛错（writer 内 Zod / DB 异常）：有认领 id 则按落库失败置 apply_failed；无 id（认领前基础设施错）则上抛。
    if (claimedId !== undefined) {
      const n = await markApplyFailed(claimedId, decidedBy, dbh);
      if (n === 0) {
        console.error(
          `[mr-curation] applyReview 置 apply_failed 命中 0 行（已被并发处置）review=${claimedId}`,
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[mr-curation] applyReview 落库异常 review=${claimedId}: ${reason}`);
      return { kind: 'failed', reviewId: claimedId, reason };
    }
    throw err; // 认领未发生（基础设施错），无 review 行可标，上抛交调用方处理。
  }
}
