/**
 * 按源采集陈旧度检测（add-per-source-staleness-alert，design D2/D5）。
 *
 * 对每个**待监控源**，用一次确定性 DB 聚合查 `raw_items` 按 `source` 的 `max(fetched_at)`，
 * 程序侧与「参考时刻 − 该源阈值天数」比较，判定该源是否「连续超阈值零新增」：
 *   - 结果集缺席该源（从未产出任何行、`max` 为 NULL）→ 陈旧（staleDays=null）；
 *   - `max(fetched_at)` 早于 `now − 阈值天数` → 陈旧（staleDays=已零新增整天数）；
 *   - 否则新鲜（不返回）。
 *
 * 判定 **100% 确定性 DB 聚合 + 程序比较，绝不调用任何 LLM**（关键不变量 / spec）。
 * 本模块只做「发现并返回陈旧源」；组装告警文案 + 调 AlertSink + 接入日报工作流由编排层（组 B）负责。
 *
 * 监控源全集取自 collector registry（`buildRegistry().map(e=>e.source)`，去重）使新增源自动纳入，
 * 但**剔除结构性停用源**（list 型配置为空使 collector 恒返回 []：`RSS_FEEDS` 空的 `rss`、`BLOGGER_FEEDS`
 * 空的 `blogger`、`SITEMAP_SOURCES` 空的 `sitemap`）——这类源 `max(fetched_at)` 恒 NULL、会被「从未产出→
 * 陈旧」判为每日永久误报，而按源阈值对 NULL 无效（NULL 绕过天数比较），故必须在**源集合层**排除而非靠阈值（design D2）。
 */
import { inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { rawItems } from '../db/schema.js';
import { buildRegistry } from '../collectors/index.js';
import { env, type Env } from '../config/env.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入 / 集成测（对齐 store.ts / mr staleness.ts）。 */
type DbLike = typeof defaultDb;

/** 一天的毫秒数（阈值比较单位为天）。 */
const DAY_MS = 86_400_000;

/** 单个陈旧源的判定结果（仅陈旧源出现在 detectStaleSources 的返回里）。 */
export interface StaleSource {
  /** 源名（如实取自 registry / raw_items.source）。 */
  source: string;
  /** 该源最近入库时间；从未产出（结果集缺席）时为 null。 */
  lastFetched: Date | null;
  /** 已连续零新增的整天数；从未产出（lastFetched=null）时为 null。 */
  staleDays: number | null;
}

/** 按源聚合查询的单行结果（source + 该源 max(fetched_at)）。 */
export interface SourceMaxRow {
  source: string;
  lastFetched: Date | null;
}

export interface DetectStaleSourcesParams {
  /** 参考时刻（由工作流注入，与 push_date 同源；决定「now − 阈值天数」边界）。 */
  now: Date;
  /** 待监控源（默认 registry 去重后剔除结构性停用源）。 */
  sources?: string[] | undefined;
  /** 按源覆盖阈值 Map<source, days>（默认 env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES）。 */
  thresholds?: Map<string, number> | undefined;
  /** 全局默认阈值天数（默认 env.SOURCE_STALENESS_ALERT_DAYS）。 */
  defaultDays?: number | undefined;
}

/**
 * 待监控源全集：`buildRegistry().map(e=>e.source)` 去重，再剔除结构性停用源
 * （feeds 为空使 collector 恒返回 0 条的 `rss`/`blogger`，design D2）。
 * 只读 registry 的 `source`（不触发 collect()、不触网）；新增 collector 自动纳入。
 *
 * @param e 已校验 env（默认全局 env；测试可注入局部 env 以模拟不同 feeds 配置）。
 */
export function defaultMonitoredSources(e: Env = env): string[] {
  const deduped = [...new Set(buildRegistry().map((entry) => entry.source))];
  return deduped.filter((source) => {
    // 结构性停用：list 型配置为空 → 该源 collector 迭代 0 条配置、恒返回 [] → max(fetched_at) 恒 NULL
    // → 会被「从未产出→陈旧」每日永久误报，且按源阈值对 NULL 无效（NULL 绕过天数比较），故排除。
    // 「配了却 0 行」（真失效）由配置非空区分——仍留在监控集、正常判陈旧告警。
    // 三个 list 驱动源（rss/blogger/sitemap）各有独立空配置开关；其余源无此类「空配置即恒不产出」开关，恒纳入。
    if (source === 'rss' && e.RSS_FEEDS.length === 0) return false;
    if (source === 'blogger' && e.BLOGGER_FEEDS.length === 0) return false;
    if (source === 'sitemap' && e.SITEMAP_SOURCES.length === 0) return false;
    return true;
  });
}

/** 取某源的阈值天数：在 overrides 里用其覆盖值，否则用全局默认（spec「未覆盖用默认 / 已覆盖用覆盖」）。 */
export function resolveThreshold(
  source: string,
  thresholds: Map<string, number>,
  defaultDays: number,
): number {
  return thresholds.get(source) ?? defaultDays;
}

/**
 * 纯判定函数（不触 DB、不触 LLM）：给定按源聚合的 max(fetched_at) 行集，返回陈旧源列表。
 * 从查询中拆出便于单测「注入 mock 查询结果」直接断言判定逻辑（超阈值 / 阈值内 / 缺席 NULL 三态）。
 *
 * @param rows      按源聚合查询结果（缺席某待监控源 = 该源从未产出 → NULL → 陈旧）。
 * @param sources   待监控源（去重后逐源判定；重复项经 Set 收敛）。
 * @param now       参考时刻。
 * @param thresholds 按源覆盖阈值（默认取 env）。
 * @param defaultDays 全局默认阈值天数（默认取 env）。
 */
export function judgeStaleSources(
  rows: readonly SourceMaxRow[],
  sources: readonly string[],
  now: Date,
  thresholds: Map<string, number> = env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES,
  defaultDays: number = env.SOURCE_STALENESS_ALERT_DAYS,
): StaleSource[] {
  const lastBySource = new Map<string, Date | null>();
  for (const row of rows) lastBySource.set(row.source, row.lastFetched);

  const stale: StaleSource[] = [];
  for (const source of new Set(sources)) {
    const thresholdDays = resolveThreshold(source, thresholds, defaultDays);
    // 结果集缺席（.has 为 false）或聚合值 NULL → 从未产出 → 陈旧（staleDays=null，绕过天数比较）。
    const lastFetched = lastBySource.has(source) ? lastBySource.get(source)! : null;
    if (lastFetched === null) {
      stale.push({ source, lastFetched: null, staleDays: null });
      continue;
    }
    const cutoff = new Date(now.getTime() - thresholdDays * DAY_MS);
    if (lastFetched < cutoff) {
      const staleDays = Math.floor((now.getTime() - lastFetched.getTime()) / DAY_MS);
      stale.push({ source, lastFetched, staleDays });
    }
  }
  return stale;
}

/** pg timestamptz 一般已由 node-postgres 解析为 Date；防御性兼容字符串/其它形态。 */
function coerceDate(value: unknown): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value as string);
}

/**
 * 按源陈旧度检测（design D2/D5）：一次聚合查询 + 纯判定，返回**仅含陈旧源**的列表。
 *
 * @param params.now         参考时刻（必填，工作流注入）。
 * @param params.sources     待监控源（默认 registry 去重剔除结构性停用源）。
 * @param params.thresholds  按源覆盖阈值（默认 env）。
 * @param params.defaultDays 全局默认阈值天数（默认 env）。
 * @param dbh                db 实例或事务句柄（默认全局 db；单测注入桩、集成测注入真实库）。
 */
export async function detectStaleSources(
  params: DetectStaleSourcesParams,
  dbh: DbLike = defaultDb,
): Promise<StaleSource[]> {
  const sources = params.sources ?? defaultMonitoredSources();
  const thresholds = params.thresholds ?? env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES;
  const defaultDays = params.defaultDays ?? env.SOURCE_STALENESS_ALERT_DAYS;
  // 无待监控源（如本部署 feeds 全空、registry 空）→ 不查库、无陈旧源。
  if (sources.length === 0) return [];

  // 按源聚合 max(fetched_at)：SELECT source, max(fetched_at) FROM raw_items
  //   WHERE source = ANY($sources) GROUP BY source（design D2）。纯只读、无 LLM。
  const rows = await dbh
    .select({
      source: rawItems.source,
      lastFetched: sql<Date | null>`max(${rawItems.fetchedAt})`,
    })
    .from(rawItems)
    .where(inArray(rawItems.source, [...new Set(sources)]))
    .groupBy(rawItems.source);

  const normalized: SourceMaxRow[] = rows.map((row) => ({
    source: row.source,
    lastFetched: coerceDate(row.lastFetched),
  }));
  return judgeStaleSources(normalized, sources, params.now, thresholds, defaultDays);
}
