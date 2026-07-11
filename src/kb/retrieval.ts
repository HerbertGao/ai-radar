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
import { db as defaultDb } from '../db/index.js';
import { env } from '../config/env.js';
import { embedTexts, type EmbedTextsOptions } from '../dedup/embedding.js';
import { searchKbCore, type KbSearchResult } from './retrieval-core.js';

// KB 检索结果类型定义现落在 env-clean 核心（retrieval-core.ts）；此处 re-export 保 A2 消费方 import 路径不变。
export type { KbSearchResult };

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** searchKb 可注入选项：透传给 embedTexts（embedManyFn / maxAttempts / logError）+ topK。 */
export interface SearchKbOptions extends EmbedTextsOptions {
  /** top-k（缺省 env.KB_SEARCH_TOP_K；核内归一化到 [1,50] 整数）。 */
  topK?: number;
}

/**
 * 知识库事件域语义检索（只读、确定性）——**薄封装**，委托 env-clean 核心 `searchKbCore`。
 *
 * 本入口保留三条 env-dirty 值 import（`db/index` / `config/env` / `dedup/embedding`），供 worker 环境
 * （CLI `kb:search` / 集成测，已有全局 env）使用；MCP 纯查询进程改走 `retrieval-core.ts` env-clean 核心。
 * 职责=把 `db` / `env.KB_SEARCH_TOP_K` / `embedTexts`（含注入桩）作实参喂给核心：
 * - 非有限 `topK`（NaN/Infinity/未传）经 `Number.isFinite` 回落 `env.KB_SEARCH_TOP_K`；核内再二次归一化到 [1,50]。
 * - `embed` 闭包委托 `embedTexts(texts, options)`（复用 `env.EMBEDDING_MODEL`，守 D7 同模型 cosine 可比）。
 *
 * @param query   查询串（纯空白经 trim 判定为空 → 核内短路返回 []，不调 embed）。
 * @param options topK / embedTexts 透传选项（embedManyFn 注入桩、logError）。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 */
export async function searchKb(
  query: string,
  options: SearchKbOptions = {},
  dbh: DbLike = defaultDb,
): Promise<KbSearchResult[]> {
  // 入口层 env 兜底：非有限 topK 回落 env 默认（核内对有限值再归一化到 [1,50]）。
  const requestedTopK = Number.isFinite(options.topK)
    ? (options.topK as number)
    : env.KB_SEARCH_TOP_K;

  return searchKbCore({
    query,
    topK: requestedTopK,
    dbh,
    embed: (texts) => embedTexts(texts, options),
    ...(options.logError ? { logError: options.logError } : {}),
  });
}
