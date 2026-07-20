/**
 * Model Radar URL-drift agent（add-model-radar-browser-url-drift-agent，design D5）——
 * vendor 域集合反查 helper。
 *
 * `vendorDomainSet(vendorId)` 由「该 vendor 的 mr_source.source_url → host → 保守后缀匹配
 * MR_SOURCE_DOMAIN_ALLOWLIST」反查得到该 vendor 的 allowlist 域集合（最小化信息、不暴露 allowlist 全表），
 * 注入 agent prompt + agent 输出 schema 的 candidate_url refine 校验（C4 调和：候选 host MUST 在此集内）。
 * `vendorOf(sourceId)` 单行反查 vendor_id，供 approve step ② `vendorDomainSet(vendorOf(sourceId))` vendor-scope 再校验（design D-M5）。
 */
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { mrSource } from '../../db/schema.js';
import { MR_SOURCE_DOMAIN_ALLOWLIST } from './allowlist.js';

/** db 句柄类型（drizzle 实例）。 */
type DbLike = typeof defaultDb;
/** 事务句柄类型（DbLike.transaction 回调入参）：approve step ② 在同事务内反查（design D-M5）。 */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

/**
 * 反查 source 的 vendor_id（单行）。缺行 → null。
 * @param sourceId mr_source PK。
 * @param dbh db 实例或已开事务句柄（approve step ② 传同事务 tx）。
 */
export async function vendorOf(
  sourceId: string,
  dbh: DbLike | TxLike = defaultDb,
): Promise<string | null> {
  const rows = await dbh
    .select({ vendorId: mrSource.vendorId })
    .from(mrSource)
    .where(eq(mrSource.id, sourceId))
    .limit(1);
  return rows[0]?.vendorId ?? null;
}

/**
 * 反查该 vendor 的 allowlist 域集合（design D5「反查算法」）：
 * ① `SELECT source_url FROM mr_source WHERE vendor_id=$vendorId`（参数化、防 SQL injection）；
 * ② 对每个 source_url `try { new URL(url).hostname } catch { 跳过 + 记日志 }`（防单个 malformed sibling
 *    URL 毒化整个 vendor 域集合）；
 * ③ 对每个 host 收集匹配的 allowlist 域名 `MR_SOURCE_DOMAIN_ALLOWLIST.filter(d => host===d || host.endsWith('.'+d))`
 *    （**不**调 isHostAllowlisted——它只返 boolean、本步骤需匹配字符串本身；收 registrable domain 如
 *    `www.kimi.com` → `kimi.com`，**不**加 raw host、否则 schema refine 会拒 `kimi.com/...` 候选）；
 * ④ Set 去重、返回 `[...s]`。空 source vendor → `[]`（agent 必然 escalate、fail-closed）。
 *
 * @param vendorId mr_vendors PK。
 * @param dbh db 实例或已开事务句柄。
 * @returns 匹配的 registrable domain 数组（readonly，与 MR_SOURCE_DOMAIN_ALLOWLIST 同型，design D-B2）。
 */
export async function vendorDomainSet(
  vendorId: string,
  dbh: DbLike | TxLike = defaultDb,
): Promise<readonly string[]> {
  const rows = await dbh
    .select({ sourceUrl: mrSource.sourceUrl })
    .from(mrSource)
    .where(eq(mrSource.vendorId, vendorId));

  const domains = new Set<string>();
  for (const { sourceUrl } of rows) {
    let host: string;
    try {
      host = new URL(sourceUrl).hostname;
    } catch {
      // malformed sibling source URL：跳过该行、不毒化整个 vendor 域集合（design D5 ②）。
      console.warn(
        `[vendor-domains] vendor ${vendorId} 的 source_url 无法解析 hostname，已跳过该行`,
      );
      continue;
    }
    for (const domain of MR_SOURCE_DOMAIN_ALLOWLIST) {
      if (host === domain || host.endsWith(`.${domain}`)) domains.add(domain);
    }
  }
  return [...domains];
}
