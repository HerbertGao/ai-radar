/**
 * 产品中文化落库（capability: product-chinese-digest，design D2/D3）。
 *
 * 关键不变量（绝不可违背）：
 * - 写中文列必须 `UPDATE ai_products ... WHERE product_id = ?`，`set` 中**仅含**
 *   name_zh / tagline_zh；禁止 `INSERT ... ON CONFLICT` 模板；禁止覆盖塌缩/合并/状态列
 *   （name / canonical_domain / github_repo / product_hunt_slug / metadata / merge_conflict /
 *   first_seen_at / last_seen_at / last_pushed_at / representative_raw_item_id）。
 * - 只在 Agent 输出经 Zod 校验通过后才落库（两列同一次原子 UPDATE，绝不存在「name_zh 填而
 *   tagline_zh NULL」的半截态）；绝不写未校验或半截输出。
 * - 中文化**只产展示文本、绝不参与确定性状态判定**（should_push / 推送幂等 / 塌缩合并由
 *   程序 + DB）。
 *
 * 边界：本模块只负责「校验通过 → 落库」的单条写入；候选并集 / 永不向上抛 / 失败告警 /
 *   逐个调用 summarizeProduct 由 pipeline 编排层实现（design D3，**编排契约不同规格**）。
 */
import { eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { aiProducts } from '../../db/schema.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入 / 集成测。 */
type DbLike = typeof defaultDb;

/**
 * 写 name_zh + tagline_zh + is_ai_related：
 * `UPDATE ai_products SET name_zh = COALESCE(name_zh, ?), tagline_zh = COALESCE(tagline_zh, ?),
 *  is_ai_related = ? WHERE product_id = ?`。
 *
 * set 中**仅含** name_zh / tagline_zh / is_ai_related，绝不触碰塌缩/合并/状态列；绝不用
 * INSERT ... ON CONFLICT。仅在中文化 + AI 判定输出经 Zod 校验通过后调用（nameZh / taglineZh
 * 须为已校验非空值，isAiRelated 为已校验布尔）。
 *
 * **COALESCE 保留既有译名（design D5 陷阱二）**：判定工作集以 `is_ai_related IS NULL` 纳入，
 * 迁移前已中文化（name_zh 非空、is_ai_related NULL）产品会被重跑一次同调用补判 is_ai_related；
 * 用 `COALESCE(既有, 新值)` 仅当当前为 NULL 时写译名，绝不用新译名覆盖既有非空译名（避免补判
 * 抖动展示文本）。is_ai_related 本轮首次落库、直接写（此前恒 NULL）。
 *
 * @param dbh          可注入 db 或事务句柄（默认全局 db）。
 * @param productId    ai_products.product_id（UPDATE 的定位键）。
 * @param nameZh       经校验的中文译名（仅当既有为 NULL 时落库）。
 * @param taglineZh    经校验的一句话中文简介（仅当既有为 NULL 时落库）。
 * @param isAiRelated  经校验的 AI 相关性布尔（落 ai_products.is_ai_related，闸门读取）。
 */
export async function updateProductZh(
  dbh: DbLike,
  productId: string,
  nameZh: string,
  taglineZh: string,
  isAiRelated: boolean,
): Promise<void> {
  await dbh
    .update(aiProducts)
    .set({
      nameZh: sql`COALESCE(${aiProducts.nameZh}, ${nameZh})`,
      taglineZh: sql`COALESCE(${aiProducts.taglineZh}, ${taglineZh})`,
      isAiRelated,
    })
    .where(eq(aiProducts.productId, productId));
}
