/**
 * 产品段零件（product-discovery，合并进日报后的「新品段」实现）。
 *
 * 产品发现**已合并进日报链**：日报消息内含「要闻段 + 新品段」，由 run-daily-workflow 在新闻链
 * 之后、早退判断之前调用本文件的两步零件（design D1/D6）。本文件**不再有独立 BullMQ 调度**
 * （队列/worker/cron/独立锁/runProductDigest 已移除）——产品段搭日报单例锁 `daily-digest:{push_date}`
 * 便车执行。本文件仅保留三个供日报 import 的导出：
 *   ① selectProductCandidates —— 程序规则选某 channel 当日产品候选（非 LLM）
 *   ② collapseProductsOnce —— channel-blind 塌缩一次（永不抛错）
 *   ③ selectProductsForChannelSafe —— per-channel 候选安全包装（失败降级空段）
 *
 * 关键不变量（绝不可违背，spec product-discovery）：
 * - 幂等四元组 `target_type='product'`、`target_id=product_id`、`channel`、`push_date`
 *   （push_date 取 Asia/Shanghai，与事件日报 push_date **时区口径同源**）。
 *   与事件日报（`target_type='event'`）各自独立命名空间，互不挤占。
 * - **跨天不重推候选窗口**：候选必须满足「该 product_id 从未被任何 push_date 以该 channel
 *   `success` 推送过」——否则产品因 PH 持续上榜、last_seen 天天刷新会每天以新 push_date 重新
 *   入选、UNIQUE 四元组每天不冲突 → 天天重推同一产品。「同日不重复」由 UNIQUE 兜底，「跨天
 *   一产品一生只推一次」由本候选窗口兜底，两层叠加不可删其一。
 * - **排除 merge_conflict**：被标记 merge_conflict 的产品（同一真实产品散为多个 product_id）
 *   其多行各自满足「从未 success」会被各推一次，违反「一产品一生一次」；故排除出候选，直到
 *   P3 跨行合并解决（宁可暂不推，也不重复推）。
 * - **候选查询必须在产品塌缩之后执行**：确保 merge_conflict 标记对候选可见（日报链顺序：
 *   collapseProductsOnce 在 channel 展开之前先跑、候选随后）。
 * - 推送名单**由程序规则决定，禁止由 LLM 决定最终推送名单**。
 *
 * 文件归属边界：本文件只引用 collectors / product-collapse / targets 已导出函数与 schema，
 * 不重写其逻辑、不改 schema；产品候选查询在本文件用程序条件表达。
 */
import { and, eq, isNull, notExists, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiProducts, pushRecords } from '../db/schema.js';
import { env } from '../config/env.js';
import { collapseUncollapsedProductRawItems } from '../collectors/product-collapse.js';
import type { SelectedEvent } from '../selection/top-n.js';
import { TARGET_TYPE, type Channel } from '../push/targets.js';

type DbLike = typeof defaultDb;

// ──────────────────────────────────────────────────────────────────────────
// 候选查询：程序规则选当日推送产品（非 LLM 定名单）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 选当日某 channel 的产品推送候选（程序规则，**非 LLM**）。
 *
 * 候选条件（全在 SQL 层用程序条件表达）：
 * - **排除 merge_conflict**：`metadata->'merge_conflict' IS NULL`（被标记冲突的多行各自满足
 *   「从未 success」会被各推一次，违反「一产品一生一次」，排除直到 P3 跨行合并解决）。
 * - **跨天不重推候选窗口**：`NOT EXISTS(push_records success for this product_id on the target
 *   channel on any push_date)`——「从未以该 channel success」而非「今天未 success」（跨天/跨次
 *   不重推；按目标 channel 分别判定，同一产品可分别进入 telegram 与 feishu 候选）。
 *
 * 「同日不重复」由 dispatcher 的待发集合「今日该 channel success 排除」+ UNIQUE 四元组兜底，
 * 本查询只管「跨天从未 success」与「排除冲突」。名单由程序定、不交 LLM。
 *
 * @param channel 目标分发通道（候选「从未以该 channel success」按 channel 分别判定）。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 * @param limit   取前 N 条（默认 env.TOP_N，与日报同口径）；按 last_seen_at DESC 优先近期上榜。
 */
export async function selectProductCandidates(
  channel: Channel,
  dbh: DbLike = defaultDb,
  limit: number = env.TOP_N,
): Promise<SelectedEvent[]> {
  // 「从未以该 channel success」相关子查询（跨天/跨次不重推）；target_type='product'、
  // target_id=product_id（product_id 与 push_records.target_id 同为 VARCHAR(128)，类型相容）。
  const neverSuccessfullyPushed = notExists(
    dbh
      .select({ one: sql`1` })
      .from(pushRecords)
      .where(
        and(
          eq(pushRecords.targetType, TARGET_TYPE.product),
          eq(pushRecords.targetId, aiProducts.productId),
          eq(pushRecords.channel, channel),
          eq(pushRecords.status, 'success'),
        ),
      ),
  );

  const rows = await dbh
    .select({
      productId: aiProducts.productId,
      name: aiProducts.name,
      // 链接来源：ai_products 无 url 列，仅 canonical_domain（裸域，product-collapse 写入端
      // 规范化为无 scheme/path）。映射 canonicalUrl = 'https://' + canonical_domain（见下）。
      canonicalDomain: aiProducts.canonicalDomain,
      lastSeenAt: aiProducts.lastSeenAt,
    })
    .from(aiProducts)
    .where(
      and(
        // 排除 merge_conflict：metadata->'merge_conflict' 不存在（NULL）即未冲突。
        // product-collapse 用 `metadata || {merge_conflict:{...}}` 标记，故以 JSON 路径判存在。
        isNull(sql`${aiProducts.metadata} -> 'merge_conflict'`),
        neverSuccessfullyPushed,
      ),
    )
    // 近期上榜优先（确定性 tiebreaker：product_id ASC），取前 limit 条。
    .orderBy(sql`${aiProducts.lastSeenAt} DESC NULLS LAST`, aiProducts.productId)
    .limit(limit);

  // 映射为 dispatcher 输入视图（SelectedEvent 复用，eventId=product_id、标题=产品名）。
  // dispatcher/message 渲染只用 eventId/标题/摘要/链接——产品无 headline/summary，置 null
  // 走渲染回退（仅标题）。target_id=product_id 在 dispatcher 内由 e.eventId 承载。
  return rows.map((r) => {
    // canonical_domain 为裸域或 host:port → 'https://' + domain。extractCanonicalDomain 用
    // new URL(url).host 提取，host 合法可含端口（如 example.com:8080），故不能用 `:` 一刀切。
    // 用 URL 试构造校验：保留合法带端口域，仍挡 scheme/path/凭据/空白等畸形 → 降级 null
    // （绝不产生 https://https://… 或坏链接）；domain NULL/空 也降级 null → 渲染回退纯产品名。
    const d = r.canonicalDomain;
    let canonicalUrl: string | null = null;
    if (d && !/\s/.test(d) && !d.includes('://')) {
      try {
        const u = new URL(`https://${d}`);
        // host === d 保证 d 是纯 host（裸域或 host:port），含 path/凭据等畸形则不等 → 降级 null。
        if (u.host === d && u.pathname === '/' && !u.search && !u.hash) {
          canonicalUrl = `https://${d}`;
        }
      } catch {
        /* 畸形 → 保持 null */
      }
    }
    return {
      eventId: r.productId,
      representativeTitle: r.name,
      summaryZh: null,
      headlineZh: null,
      canonicalUrl,
      publishedAt: null,
      rankScore: 0,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 产品段两步零件（供日报 run-daily 调用，design D1）：
//   ① collapseProductsOnce —— channel-blind 塌缩一次（永不抛错）
//   ② selectProductsForChannelSafe —— per-channel 候选（失败降级空段）
// 两步不打包成「含 collapse 的 per-channel 函数」：塌缩单实例承载、候选才 per-channel。
// ──────────────────────────────────────────────────────────────────────────

/**
 * 产品塌缩一次（channel-blind，design D1 步骤 P1）。
 *
 * 薄包装 `collapseUncollapsedProductRawItems`（import 自 `src/collectors/product-collapse.ts`），
 * 任何异常 → 记错误/告警、视为「本次未塌缩」、**绝不向上抛**（产品失败不拖垮新闻）。
 *
 * **必须在 channel 展开之前只调一次**：产品塌缩由单实例承载（product-collapse.ts:272，内部
 * `SELECT ... FOR UPDATE` + product_id 升序防死锁、假设不被并发调用），若随 per-channel 并发
 * 跑 N 次会违反单实例假设产生同批竞态。
 *
 * **前置约束**：依赖调用方持 `daily-digest:{push_date}` 全局单例锁保证
 * `collapseUncollapsedProductRawItems` 单实例假设（product-collapse.ts 顺序处理/FOR UPDATE）；
 * 任何新调用方须持同一锁或等价单例保证，否则两实例争抢同批未塌缩 raw_items。
 *
 * @param dbh 可注入 db 或事务句柄（默认全局 db）。
 */
export async function collapseProductsOnce(dbh: DbLike = defaultDb): Promise<void> {
  try {
    await collapseUncollapsedProductRawItems(dbh);
  } catch (e) {
    console.error('[product-segment] 塌缩失败，降级（视为本次未塌缩，不拖垮新闻）', e);
  }
}

/**
 * 安全取某 channel 的产品候选（design D1 步骤 P2 的 per-channel 安全包装）。
 *
 * 包 try/catch 调 `selectProductCandidates(channel, dbh)`；失败 → 记告警、返回空段、**绝不向上抛**
 * （该 channel 新品段降级为空，不拖垮新闻 / 不拖垮其余 channel）。供 run-daily 在 per-channel
 * 循环里调，组装 `Map<Channel, SelectedEvent[]>`（design D6 的 productsByChannel）。
 *
 * @param channel 目标分发通道（候选「从未以该 channel success」按 channel 分别判定）。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 */
export async function selectProductsForChannelSafe(
  channel: Channel,
  dbh: DbLike = defaultDb,
): Promise<SelectedEvent[]> {
  try {
    return await selectProductCandidates(channel, dbh);
  } catch (e) {
    console.error(`[product-segment] 候选查询失败[${channel}]，降级空新品段`, e);
    return [];
  }
}

