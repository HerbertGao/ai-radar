/**
 * 知识库读侧语义检索 **env-clean 核心**（add-conversational-rag 组 A / design D7 / spec「search_kb」task 4.1）。
 *
 * 与 A2 `searchKb`（`retrieval.ts`）**共享 KNN 逻辑**（不再宣称「复用不重建」）——把三条会 eager-parseEnv 的
 * **值 import** 全部剥离，使 MCP 纯查询进程（仅 `DATABASE_URL`）可 `await import` 本模块而**不**触全局 parseEnv：
 * - `config/env`：`topK` 由入参（不读 `env.KB_SEARCH_TOP_K`）。
 * - `dedup/embedding`：`embed` 由入参注入（本模块不建 embedding provider）。
 * - `db/index`：`dbh` **必填**、db 类型走 `import type`（运行期擦除，绝不 `= defaultDb` 触 `db/index.ts:14`→`config/env` 的全局 parseEnv）。
 *
 * 只读 / 事件域 / tombstone 反连接 / top-k 双向归一化 / 空查询短路等不变量与 `retrieval.ts` 逐条一致
 * （原语内保证，非仅入口层）；`retrieval.ts` 的 `searchKb` 现为薄封装、委托本核心。
 */
import { sql } from 'drizzle-orm';
import { aiNewsEvents, kbDocuments } from '../db/schema.js';
// env-clean（design D7）：仅 `type DbLike = typeof defaultDb` 用 → `import type`（verbatimModuleSyntax 下运行期擦除），
// 绝不值 import `db/index.js`（那会经 `db/index.ts:14` 触发 `config/env` 全局 parseEnv、崩纯查询进程）。
import type { db as defaultDb } from '../db/index.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测（类型经 `import type` 引入、运行期无副作用）。 */
type DbLike = typeof defaultDb;

/** 注入的 env-clean embed：给定文本批 → 等长同序向量。MCP 侧注入真实 env-clean embed 变体、测试注入桩（不触网）。 */
export type KbEmbed = (texts: string[]) => Promise<number[][]>;

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

/** env-clean 检索核心入参（`topK`/`dbh`/`embed` 全显式注入，无 env 兜底）。 */
export interface SearchKbCoreParams {
  /** 查询串（纯空白经 trim 判定为空 → 短路返回 []，不调 embed）。 */
  query: string;
  /** 已解析的 top-k（调用方给定；核内仍归一化到 [1,50] 整数、非有限回落有界，绝不省略 LIMIT 静默全表扫描）。 */
  topK: number;
  /** 必填 db 句柄（绝不留 `= defaultDb` 默认——那会触 db/index→config/env 全局 parseEnv）。 */
  dbh: DbLike;
  /** 注入的 env-clean embed（真实变体 or 测试桩）。 */
  embed: KbEmbed;
  /** 错误/观测日志 sink，默认 console.error。 */
  logError?: (message: string, detail: unknown) => void;
}

/**
 * 把查询向量序列化为 pgvector 字面量字符串 `[v1,v2,...]`（作参数化占位符绑定、`::vector` 转型）。
 * 与 semantic-search.ts / schema.ts vector customType toDriver 同口径。非有限值让 DB 报错优于静默替换。
 */
function toPgVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * 知识库事件域语义检索 env-clean 核心（只读、确定性）。
 *
 * @param params 见 SearchKbCoreParams（query / topK / dbh 必填、embed 注入、logError 可选）。
 */
export async function searchKbCore(params: SearchKbCoreParams): Promise<KbSearchResult[]> {
  const { query, dbh, embed } = params;
  const requestedTopK = params.topK;
  const logError =
    params.logError ??
    ((message: string, detail: unknown) =>
      console.error(`[kb-retrieval] ${message}`, detail));

  // 空/纯空白查询短路：不发起 embedding（embed 桩只挡空数组、不挡纯空白，纯空白会嵌成退化向量）。
  if (query.trim().length === 0) return [];

  // top-k 双向归一化到 [1,50] 整数（原语内，非仅入口层——防直调绕过 Zod 产生非法 LIMIT）。
  // 非有限 topK（NaN/Infinity）→ 回落有界上限：否则 Math.trunc(NaN)=NaN 穿过 clamp，drizzle 见非 `>=0`
  // 数会省略 LIMIT 子句 → 静默无界全表扫描（此守卫勿删）。入口层（retrieval.ts）另有 env 默认兜底。
  const topK = Number.isFinite(requestedTopK)
    ? Math.max(1, Math.min(Math.trunc(requestedTopK), TOP_K_MAX))
    : TOP_K_MAX;
  if (topK !== requestedTopK) {
    logError('topK 越界，已归一化到 [1,50] 整数', {
      requested: requestedTopK,
      normalized: topK,
    });
  }

  // 查询向量化（注入的 env-clean embed；守 D7 同模型 cosine 可比不变量由调用方选同一 EMBEDDING_MODEL 保证）。
  const [queryVec] = await embed([query]);
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
