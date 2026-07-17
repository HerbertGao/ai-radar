/**
 * 推荐器 v2 证据装配层（add-model-radar-recommender-rag-explanation 组 B，design D3 / spec「证据装配」段）。
 *
 * **纯读、注入式、绝不阻塞也绝不挂起**：三子源（KB 命中 / 价格变更 / 待复核）各自 fail-open（抛错 ⇒ 空数组 + 日志），
 * 整体以 `EVIDENCE_ASSEMBLY_TIMEOUT_MS` deadline 兜住挂起（embed 无 abort、DB 查询无时限）——超时按全失败三空处理。
 *
 * env-clean（design D4 / 组 D 钉子测试）：**绝不值 import** `config/env`、`agents/llm-client`、`db/index`——
 * `dbh`/`embed`/`log` 全经 `deps` 注入，db 句柄类型经 `import type` 从 `searchKbCore` 参数取（运行期擦除）。
 * 只调用检索核心 `searchKbCore`、不改其语义/参数/签名。
 */
import { and, gte, inArray } from 'drizzle-orm';
import { mrPriceHistory } from '../../db/schema.js';
import { searchKbCore, type KbEmbed, type SearchKbCoreParams } from '../../kb/retrieval-core.js';
import type { RankedCandidate, RecommendEvidence } from './schema.js';

/** db 句柄类型：从 `searchKbCore` 参数取（= `typeof db`），零值 import `db/index`（env-clean）；既喂 searchKbCore 又跑价格 SQL。 */
type DbLike = SearchKbCoreParams['dbh'];

/** 结构化日志 sink（best-effort；抛错绝不影响装配返回值，design D6）。与 `searchKbCore` 的 `logError` 同形。 */
export type EvidenceLog = (message: string, detail?: unknown) => void;

export interface AssembleEvidenceDeps {
  dbh: DbLike;
  embed: KbEmbed;
  log: EvidenceLog;
}

/** 余弦地板（模块常量）：searchKbCore 无阈值恒 top-k，无地板则低相关命中混进 prompt（design D3；待抽样窗校准）。 */
const EVIDENCE_COSINE_FLOOR = 0.6;
/** KB 查询候选数（排序后前 N 条候选取 KB 证据）。 */
const EVIDENCE_KB_CANDIDATE_LIMIT = 3;
/** 每候选 KB top-k。 */
const EVIDENCE_KB_TOP_K = 3;
/** 价格变更回看窗（模块常量、非 env）。解释层（explain-llm）复用同一 SOT（白名单框架数值 + prompt 段）。 */
export const PRICE_CHANGE_WINDOW_DAYS = 30;
/** 装配整体 deadline（模块常量）：race 只弃置不取消底层调用，挂起的 embed/DB 迟到结果丢弃（design D3）。 */
const EVIDENCE_ASSEMBLY_TIMEOUT_MS = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** best-effort 日志：sink 自身抛错绝不影响装配返回值（design D6）。解释层（explain-llm）复用同一实现。 */
export function safeLog(log: EvidenceLog, message: string, detail?: unknown): void {
  try {
    log(message, detail);
  } catch {
    /* 绝不传播优先于必须记录 */
  }
}

/**
 * `sourceUrls` 首个合法 http(s) 项（同守卫③ URL 闸口径）：仅 http/https 放行、拒 userinfo（`@` 形态），
 * 通过后只返回解析后的 `href`（内嵌 CR/LF/tab 由 WHATWG 解析归一）；非字符串数组 ⇒ null。
 */
function firstValidHttpUrl(sourceUrls: unknown): string | null {
  if (!Array.isArray(sourceUrls)) return null;
  for (const item of sourceUrls) {
    if (typeof item !== 'string') continue;
    try {
      const u = new URL(item);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '') {
        return u.href;
      }
    } catch {
      /* 非合法 URL，跳过 */
    }
  }
  return null;
}

/** 待复核派生：从 `candidates[].reasons`（kind='pending_review'）取候选名，与 verdict 同源、零 SQL（spec）。 */
function derivePendingReview(candidates: RankedCandidate[]): string[] {
  return candidates
    .filter((c) => c.reasons.some((r) => r.kind === 'pending_review'))
    .map((c) => c.name);
}

/** 跨候选按 docId 去重、保最高 cosine（结果与处理顺序无关：只留每 docId 的最大 cosine）。 */
function dedupByDocId(hits: RecommendEvidence['kbHits']): RecommendEvidence['kbHits'] {
  const best = new Map<string, RecommendEvidence['kbHits'][number]>();
  for (const hit of hits) {
    const prev = best.get(hit.docId);
    if (!prev || hit.cosine > prev.cosine) best.set(hit.docId, hit);
  }
  return [...best.values()];
}

/** KB 子源（fail-open）：前 N 候选以「vendorName + name」查 searchKbCore、过地板、映射、跨候选 docId 去重。 */
async function assembleKbHits(
  candidates: RankedCandidate[],
  deps: AssembleEvidenceDeps,
): Promise<RecommendEvidence['kbHits']> {
  try {
    const top = candidates.slice(0, EVIDENCE_KB_CANDIDATE_LIMIT);
    const perCandidate = await Promise.all(
      top.map(async (c) => {
        const results = await searchKbCore({
          query: `${c.vendorName} ${c.name}`,
          topK: EVIDENCE_KB_TOP_K,
          dbh: deps.dbh,
          embed: deps.embed,
        });
        return results
          .filter((r) => r.cosineSim >= EVIDENCE_COSINE_FLOOR)
          .map((r) => ({
            docId: r.id,
            planId: c.planId,
            title: r.kbTitle ?? '(无标题)',
            url: firstValidHttpUrl(r.sourceUrls),
            cosine: r.cosineSim,
          }));
      }),
    );
    return dedupByDocId(perCandidate.flat());
  } catch (error) {
    safeLog(deps.log, 'evidence.kbHits failed', { error: String(error) });
    return [];
  }
}

/** 价格变更子源（fail-open）：近窗内全部候选 plan 的 mr_price_history 行；vendorName/planName 取自对应 candidate。 */
async function assemblePriceChanges(
  candidates: RankedCandidate[],
  deps: AssembleEvidenceDeps,
): Promise<RecommendEvidence['priceChanges']> {
  try {
    if (candidates.length === 0) return [];
    const byPlan = new Map(candidates.map((c) => [c.planId, c]));
    const planIds = [...byPlan.keys()];
    const cutoff = new Date(Date.now() - PRICE_CHANGE_WINDOW_DAYS * DAY_MS);

    const rows = await deps.dbh
      .select({
        planId: mrPriceHistory.planId,
        oldValue: mrPriceHistory.oldValue,
        newValue: mrPriceHistory.newValue,
        currency: mrPriceHistory.currency,
        changedAt: mrPriceHistory.changedAt,
      })
      .from(mrPriceHistory)
      // SQL 推下窗口 + 候选集；JS 侧同 cutoff 复过一遍（窗口边界的确定性判据、单测经 mock dbh 可测）。
      .where(and(inArray(mrPriceHistory.planId, planIds), gte(mrPriceHistory.changedAt, cutoff)));

    const cutoffMs = cutoff.getTime();
    return rows.flatMap((r) => {
      if (r.changedAt.getTime() < cutoffMs) return [];
      const c = byPlan.get(r.planId);
      if (!c) return [];
      return [
        {
          planId: r.planId,
          vendorName: c.vendorName,
          planName: c.name,
          from: r.oldValue,
          to: r.newValue,
          currency: r.currency,
          changedAt: r.changedAt.toISOString().slice(0, 10), // UTC 口径、只到日（spec）
        },
      ];
    });
  } catch (error) {
    safeLog(deps.log, 'evidence.priceChanges failed', { error: String(error) });
    return [];
  }
}

/**
 * 证据装配：三子源各自 fail-open + 整体 deadline 兜挂起。返回三数组恒非 undefined（三空 = 装配过但无证据）。
 * @param candidates 推荐器输出序（已核升序、未核殿后）；KB 取前 N、价格/待复核取全部。
 * @param deps 注入的 `{ dbh, embed, log }`（env-clean：无 env 兜底、无全局 provider 构造）。
 */
export async function assembleEvidence(
  candidates: RankedCandidate[],
  deps: AssembleEvidenceDeps,
): Promise<RecommendEvidence> {
  const empty: RecommendEvidence = { kbHits: [], priceChanges: [], pendingReview: [] };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RecommendEvidence>((resolve) => {
    timer = setTimeout(() => {
      safeLog(deps.log, 'evidence assembly timeout', { timeoutMs: EVIDENCE_ASSEMBLY_TIMEOUT_MS });
      resolve(empty); // 超时按全失败三空处理（spec）：挂起的 embed/DB 不得拖住请求。
    }, EVIDENCE_ASSEMBLY_TIMEOUT_MS);
  });

  const assembly = (async (): Promise<RecommendEvidence> => {
    const pendingReview = derivePendingReview(candidates); // 同步派生、不会失败。
    const [kbHits, priceChanges] = await Promise.all([
      assembleKbHits(candidates, deps),
      assemblePriceChanges(candidates, deps),
    ]);
    return { kbHits, priceChanges, pendingReview };
  })();

  try {
    return await Promise.race([assembly, timeout]);
  } finally {
    clearTimeout(timer); // race 落地即清理，未触发的 deadline 计时器不驻留（迟到的 assembly 结果自然丢弃）。
  }
}
