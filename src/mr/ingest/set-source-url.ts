/**
 * Model Radar URL-drift agent（add-model-radar-browser-url-drift-agent，design D2/D-B1/D-M4）——
 * `mr_source.source_url` 的**授权写入口** setSourceUrl。
 *
 * **仅 `src/mr/curation/approve.ts` 可 import、受 eslint `no-restricted-imports` 守卫**（design D9）：
 * 抓取链 / propose 侧结构上不可 import 本入口（curation block 的 ingest 通配禁令 + scrape 两块的
 * set-source-url 专项禁令锁死）；写 `mr_source.source_url` 是 approve 侧
 * `applyUrlDriftReview` 的专属权限。
 *
 * 与 `setPlanAvailability`（upsert.ts）自开事务范式**不同**：本入口**接受已开事务 `tx`**——
 * approve 侧「claim + setSourceUrl」须同事务原子（失败一律抛 → 回滚整个 claim 事务、status='approved' 不落库）。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { mrPlanSources, mrPlans, mrSource } from '../../db/schema.js';
import { assertUrlAllowed } from '../scrape/ssrf-guard.js';
import { MR_SOURCE_DOMAIN_ALLOWLIST } from '../scrape/allowlist.js';
import { resolveFlag } from '../write/flag.js';

/** db 句柄类型（drizzle 实例，用于派生事务句柄类型）。 */
type DbLike = typeof defaultDb;
/** 事务句柄类型（DbLike.transaction 回调入参）：本入口只在调用方已开的 tx 内工作。 */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

/**
 * old-URL CAS 命中 0 行哨兵（design D-M4）：源 URL 已被并发信号替换 → 同 tx 内抛、回滚整个 claim 事务，
 * stale token 绝不覆盖已更新的 URL。approve.ts import 本类做 catch 分流（→ reason:'stale-url'）。
 */
export class StaleUrlError extends Error {
  constructor() {
    super('stale-url: old-URL CAS 命中 0 行（源 URL 已被并发信号替换）');
    this.name = 'StaleUrlError';
  }
}

/**
 * 授权改 `mr_source.source_url`（design D2「事务范式」+ D-B1 + D-M4）。在传入 tx 内、
 * `assertUrlAllowed(newUrl)` 之后依序：
 * ① old-URL CAS `UPDATE mr_source SET source_url=newUrl, last_checked=now() WHERE id=sourceId AND source_url=oldUrl`
 *    ——0 行 → `throw new StaleUrlError()`（回滚）；撞 UNIQUE(vendor_id, source_url) → DB 抛（调用方 catch → url-conflict）；
 * ② mr_plans 同事务对齐 `UPDATE mr_plans SET source_url=newUrl WHERE source_url=oldUrl AND id IN
 *    (SELECT plan_id FROM mr_plan_sources WHERE source_id=sourceId)`——维持 plan.source_url ↔ mr_source.source_url
 *    对齐契约（schema.ts:692）；非官方聚合关联（plan.source_url≠oldUrl）不碰；
 * ③ `resolveFlag(tx, target, {expectedOpenedAt})`（generation-aware）——命中 0 行（generation 不匹配）
 *    **容忍、不抛、不回滚**（old-URL CAS 已命中说明 URL 未变、候选合法；较新 flag 有意留 pending 交下轮）。
 *
 * **成功不返回值（void）；失败一律抛**（StaleUrlError / SsrfBlockedError / URL 唯一冲突 DB 错），
 * 由调用方 `applyUrlDriftReview` catch 分流。
 *
 * @param sourceId mr_source PK。
 * @param newUrl 候选新 URL（先过 assertUrlAllowed）。
 * @param oldUrl approve 侧传入的 frozen old_url（CAS 基线）。
 * @param _decidedBy 批准人标识（审计口径；本入口不落 decided_by 列——mr_source 无此列、resolveFlag 不收，
 *   故签名保留位以对齐 approve 传参但函数体不用；写 decided_by 是 claimUrlDriftReview（store）的职责）。
 * @param tx 已开事务句柄（不自开事务）。
 * @param expectedOpenedAt frozen flag_opened_at（generation token，属 resolveFlag 的 opts）。
 */
export async function setSourceUrl(
  sourceId: string,
  newUrl: string,
  oldUrl: string,
  _decidedBy: string,
  tx: TxLike,
  expectedOpenedAt: string,
): Promise<void> {
  // 全局 allowlist / SSRF 再校验（抛 SsrfBlockedError → 调用方按 reason 分流；不校验 vendor-scoping）。
  assertUrlAllowed(newUrl, MR_SOURCE_DOMAIN_ALLOWLIST);

  // ① old-URL CAS：仅 source_url=oldUrl 才改。0 行 = 源 URL 已被并发信号替换 → StaleUrlError 回滚。
  //    撞同 vendor 另一 source 的 UNIQUE(vendor_id, source_url) → DB 抛（调用方 catch → url-conflict），不在此 catch。
  const casRows = await tx
    .update(mrSource)
    .set({ sourceUrl: newUrl, lastChecked: sql`now()` })
    .where(and(eq(mrSource.id, sourceId), eq(mrSource.sourceUrl, oldUrl)))
    .returning({ id: mrSource.id });
  if (casRows.length === 0) throw new StaleUrlError();

  // ② mr_plans 同事务对齐：以本 source 为 canonical 源（plan.source_url=oldUrl）的 plan 一并迁到 newUrl。
  await tx
    .update(mrPlans)
    .set({ sourceUrl: newUrl })
    .where(
      and(
        eq(mrPlans.sourceUrl, oldUrl),
        inArray(
          mrPlans.id,
          tx
            .select({ planId: mrPlanSources.planId })
            .from(mrPlanSources)
            .where(eq(mrPlanSources.sourceId, sourceId)),
        ),
      ),
    );

  // ③ generation-aware resolveFlag：expectedOpenedAt 属 opts（第 3 参），不塞 target。
  //    0 行（generation 不匹配）容忍、不抛——与 old-URL CAS 0 行抛 StaleUrlError 语义相反（design D-M4）。
  await resolveFlag(
    tx,
    { targetType: 'source', targetId: sourceId },
    { expectedOpenedAt },
  );
}
