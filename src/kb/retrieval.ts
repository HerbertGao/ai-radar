/**
 * 知识库读侧语义检索原语（add-kb-retrieval-baseline，组 A / spec「知识库语义检索原语」+ design D2/D6/D7/D8/D9）。
 *
 * 职责：给定查询串 → 与 `kb_documents.embedding` 同一 embedding 模型向量化（复用 env.EMBEDDING_MODEL，
 * 守 D7 cosine 可比不变量）→ 对 `kb_documents` 中 `target_type='event'` 的行做**精确 cosine KNN**
 * （`cosine_sim = 1 - (embedding <=> $q::vector)`，复用 semantic-search.ts 的 `<=>` / toPgVectorLiteral 范式）
 * → 返回按 cosine 降序、截断 top-k 的诚实带分结果。确定性（非 LLM 判定命中）。
 *
 * 不变量（逐条守住）：
 * - **只读**：全程只 SELECT，绝不 INSERT/UPDATE/DELETE 任何域库（守 D6 读写分离迁移边界）。
 * - **事件域**（D9）：只检索 `target_type='event'`；经验卡（experience）不在本能力范围。
 * - **tombstone 不可见**（D8）：`kb_documents` 无 merged_into；事件入库后可被语义合并塌缩为 tombstone。
 *   以**事件域只读反连接**排除 `ai_news_events.merged_into` 非空的事件（对齐 search_ai_events 同口径）。
 *   缺行安全缺省（include-on-missing）：某事件行若无对应 ai_news_events 行，NOT EXISTS 为真 → 仍可检索。
 * - **不可检索行排除**：`embedding IS NULL` 的行不参与检索、不进结果、不报错。
 * - **序列化安全**：`kb_documents.id` 为 bigint，须 `String(id)`（防 JSON.stringify 崩，仿 store.ts:193）。
 * - **top-k 双向归一化**（D3）：在原语内 `Math.max(1, Math.min(Math.trunc(topK), 50))`——非仅 CLI 参数层，
 *   防任何直调方（含将来 A3、绕 Zod）传 0/负/小数产生 `LIMIT 0`/负/非整错，或超上限全表输出。越界归一不抛、记一条日志。
 * - **空/纯空白查询短路**：`query.trim().length === 0` → 直接返回 `[]`、**不调 embedTexts**（后者只挡空数组、
 *   不挡纯空白，纯空白会嵌成退化向量）。空 KB / 全 NULL embedding → `[]`、不报错。
 *
 * 多跳缺口可观测（D5）：每次检索经可注入 logError（默认 console.error）以结构化 stderr 记录逐查免费字段
 * `{query, results:[{docId, kbTitle, cosineSim, entities}], scoreStats, returned}`——**只逐查、不含语料级 COUNT**
 * （保原语=单条 KNN；语料级覆盖计数由测量 CLI search-cli.ts 每次运行算一次）。纯旁路、不改返回、不写库。
 */
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, kbDocuments } from '../db/schema.js';
import { env } from '../config/env.js';
import { embedTexts, type EmbedTextsOptions } from '../dedup/embedding.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** top-k 归一化上限：防超大 topK 触发巨量 seq-scan 输出（D3）。 */
const TOP_K_MAX = 50;

/** 一条带分检索结果（id 为字符串，保 JSON 序列化安全）。 */
export interface KbSearchResult {
  /** kb_documents.id（bigint → 字符串，防 JSON 崩，仿 store.ts:193）。 */
  id: string;
  kbTitle: string | null;
  summaryZh: string | null;
  /** jsonb（结构不定），原样返回。 */
  entities: unknown;
  /** jsonb（结构不定），原样返回。 */
  sourceUrls: unknown;
  /** date 列，drizzle 返回 YYYY-MM-DD 字符串。 */
  eventDate: string | null;
  longTermValue: number | null;
  /** 余弦相似度 `1 - (embedding <=> $q)`。 */
  cosineSim: number;
}

/** searchKb 可注入选项：透传给 embedTexts（embedManyFn / maxAttempts / logError）+ topK。 */
export interface SearchKbOptions extends EmbedTextsOptions {
  /** top-k（缺省 env.KB_SEARCH_TOP_K；原语内归一化到 [1,50] 整数）。 */
  topK?: number;
}

/**
 * 把查询向量序列化为 pgvector 字面量字符串 `[v1,v2,...]`（作参数化占位符绑定、`::vector` 转型）。
 * 与 semantic-search.ts / schema.ts vector customType toDriver 同口径。非有限值让 DB 报错优于静默替换。
 */
function toPgVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * 知识库事件域语义检索（只读、确定性）。
 *
 * @param query   查询串（纯空白经 trim 判定为空 → 短路返回 []，不调 embed）。
 * @param options topK / embedTexts 透传选项（embedManyFn 注入桩、logError）。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 */
export async function searchKb(
  query: string,
  options: SearchKbOptions = {},
  dbh: DbLike = defaultDb,
): Promise<KbSearchResult[]> {
  const logError =
    options.logError ??
    ((message: string, detail: unknown) =>
      console.error(`[kb-retrieval] ${message}`, detail));

  // 空/纯空白查询短路：不发起 embedding（embedTexts 只挡空数组、不挡纯空白，纯空白会嵌成退化向量）。
  if (query.trim().length === 0) return [];

  // top-k 双向归一化到 [1,50] 整数（原语内，非仅 CLI 层——防直调绕过 Zod 产生非法 LIMIT）。
  // 非有限 topK（NaN/Infinity/null）经 Number.isFinite 兜底回落 env 默认：否则 Math.trunc(NaN)=NaN，
  // drizzle 见非 `>=0` 数会省略 LIMIT 子句 → 静默无界全表扫描（此守卫勿删）。
  const requestedTopK = Number.isFinite(options.topK)
    ? (options.topK as number)
    : env.KB_SEARCH_TOP_K;
  const topK = Math.max(1, Math.min(Math.trunc(requestedTopK), TOP_K_MAX));
  if (topK !== requestedTopK) {
    logError('topK 越界，已归一化到 [1,50] 整数', {
      requested: requestedTopK,
      normalized: topK,
    });
  }

  // 查询向量化（复用 env.EMBEDDING_MODEL，守 D7 同模型 cosine 可比不变量）。
  const [queryVec] = await embedTexts([query], options);
  if (!queryVec || queryVec.length === 0) return [];

  const queryLiteral = toPgVectorLiteral(queryVec);
  // 余弦距离 distance = embedding <=> $q::vector；queryLiteral 作占位符绑定（参数化，禁字符串拼 SQL）。
  const distanceExpr = sql<number>`(${kbDocuments.embedding} <=> ${queryLiteral}::vector)`;

  // D8 谓词：事件域 + 有 embedding + tombstone 事件域只读反连接排除；取序 `<=> $q, id`（id 消并列任意序）。
  const rows = await dbh
    .select({
      id: kbDocuments.id,
      kbTitle: kbDocuments.kbTitle,
      summaryZh: kbDocuments.summaryZh,
      entities: kbDocuments.entities,
      sourceUrls: kbDocuments.sourceUrls,
      eventDate: kbDocuments.eventDate,
      longTermValue: kbDocuments.longTermValue,
      cosineSim: sql<number>`1 - ${distanceExpr}`,
    })
    .from(kbDocuments)
    .where(
      sql`${kbDocuments.targetType} = 'event'
        AND ${kbDocuments.embedding} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${aiNewsEvents} e
          WHERE e.event_id = ${kbDocuments.targetId}
            AND e.merged_into IS NOT NULL
        )`,
    )
    .orderBy(distanceExpr, kbDocuments.id)
    .limit(topK);

  const results: KbSearchResult[] = rows.map((r) => ({
    id: String(r.id), // bigint → string（防 JSON.stringify 崩，仿 store.ts:193）。
    kbTitle: r.kbTitle,
    summaryZh: r.summaryZh,
    entities: r.entities,
    sourceUrls: r.sourceUrls,
    eventDate: r.eventDate,
    longTermValue: r.longTermValue,
    cosineSim: Number(r.cosineSim),
  }));

  logRetrievalObservability(query, results, logError);
  return results;
}

/**
 * 多跳缺口可观测（D5）：结构化 stderr 逐查记录——只逐查免费字段，不含语料级 COUNT（保原语=单条 KNN）。
 * 纯旁路观测（非 LLM 判质量、不改返回、不写库）。
 */
function logRetrievalObservability(
  query: string,
  results: readonly KbSearchResult[],
  logError: (message: string, detail: unknown) => void,
): void {
  const sims = results.map((r) => r.cosineSim);
  const scoreStats =
    sims.length > 0
      ? {
          max: Math.max(...sims),
          min: Math.min(...sims),
          mean: sims.reduce((a, b) => a + b, 0) / sims.length,
        }
      : { max: null, min: null, mean: null };
  logError('检索可观测记录', {
    query,
    results: results.map((r) => ({
      docId: r.id,
      kbTitle: r.kbTitle,
      cosineSim: r.cosineSim,
      entities: r.entities,
    })),
    scoreStats,
    returned: results.length,
  });
}
