/**
 * 知识库语义检索测量 CLI（add-kb-retrieval-baseline，组 A / design D4/D5）—— `npm run kb:search -- "查询串" [topK]`。
 *
 * baseline 的**测量界面**：调 searchKb 打印带分 top-k，供实测「单跳 cosine 够不够、还是败在跨文档实体串联（多跳）」，
 * 据以决定要不要建 SAG。跑在 **worker 环境**（可正常 import config/env，已有 LLM/embedding 凭据）——
 * **不进 MCP 纯查询进程**（那里故意只需 DATABASE_URL；KB 语义检索需 embedding 凭据，MCP 暴露延到 A3 读服务，D4）。
 *
 * 输出纪律：结构化结果（artifact）走 stdout；日志/观测走 stderr。
 * - 逐查观测（query / top-k 文档 / cosine 分布 / entities）由 searchKb 内部记 stderr（D5）。
 * - **语料级覆盖计数**（searchableTotal / null / tombstoneExcluded）query 无关、**每次运行只算一次**（非每查，D5）
 *   ——供人工按**解读非对称规则**扣除三个压低召回的混淆项后判读。
 *
 * 退出码：完成 → 0；参数缺失 → 2；抛错 → 1。
 */
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { aiNewsEvents, kbDocuments } from '../db/schema.js';
import { searchKb } from './retrieval.js';

/**
 * 语料级事件域只读覆盖计数（每次运行算一次，非每查）：
 * - searchableTotal：target_type='event' AND embedding IS NOT NULL（可参与检索的事件行）。
 * - null：target_type='event' AND embedding IS NULL（入库 embed 失败降级、暂不可检索）。
 * - tombstoneExcluded：上述有 embedding 的行中、其 ai_news_events.merged_into 非空（被 D8 反连接排除的已塌缩事件）。
 */
async function computeCoverage(): Promise<{
  searchableTotal: number;
  null: number;
  tombstoneExcluded: number;
}> {
  const [row] = await db
    .select({
      searchableTotal: sql<number>`count(*) FILTER (WHERE ${kbDocuments.embedding} IS NOT NULL)`,
      nullCount: sql<number>`count(*) FILTER (WHERE ${kbDocuments.embedding} IS NULL)`,
      tombstoneExcluded: sql<number>`count(*) FILTER (WHERE ${kbDocuments.embedding} IS NOT NULL AND EXISTS (SELECT 1 FROM ${aiNewsEvents} e WHERE e.event_id = ${kbDocuments.targetId} AND e.merged_into IS NOT NULL))`,
    })
    .from(kbDocuments)
    .where(eq(kbDocuments.targetType, 'event'));
  return {
    searchableTotal: Number(row?.searchableTotal ?? 0),
    null: Number(row?.nullCount ?? 0),
    tombstoneExcluded: Number(row?.tombstoneExcluded ?? 0),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const query = argv[0];
  const topKArg = argv[1];

  if (query === undefined || query.trim().length === 0) {
    console.error('用法: npm run kb:search -- "查询串" [topK]');
    process.exit(2);
  }

  // 非数字 topK（如 `kb:search -- "q" abc` → Number("abc")=NaN）：显式忽略并回落默认，给运维清晰提示。
  // （searchKb 原语也有 Number.isFinite 兜底；此处只为更好的 CLI 反馈，防静默用默认让人困惑。）
  let topK: number | undefined;
  if (topKArg !== undefined) {
    const parsed = Number(topKArg);
    if (Number.isFinite(parsed)) topK = parsed;
    else console.error(`[kb-search] topK 参数 "${topKArg}" 非数字，忽略、用默认。`);
  }

  // 语料级覆盖计数：每次运行只算一次（非每查），供扣除三混淆项后判读。
  const coverage = await computeCoverage();
  console.error('[kb-search] 语料覆盖（事件域）', coverage);
  console.error(
    '[kb-search] 解读非对称规则（D5）：召回受三混淆项约束——① 摘要级 embedding（只嵌标题+摘要非全文）' +
      '② NULL-embedding 覆盖缺口（bootstrap 不修 kb_documents）③ tombstone 反连接排除。' +
      '只有「高 cosine + 召回到对的文档 + 答案仍需跨文档实体串联」才是干净的「需 SAG」正信号；' +
      '一次低召回不构成「单跳够用」的证据，绝不读成「不需 SAG」。',
  );

  // 逐查观测由 searchKb 内部记 stderr；此处只把带分 top-k 结果打到 stdout 作 artifact。
  const results = await searchKb(query, topK !== undefined ? { topK } : {});
  console.log(
    JSON.stringify(
      { artifact: 'kb-search', query, topK: topK ?? null, coverage, results },
      null,
      2,
    ),
  );
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[kb-search] 失败：', err);
    process.exit(1);
  });
