/**
 * Show HN 产品采集器（source-collectors / design D1–D7）。
 *
 * 经 **Hacker News Algolia Search API**（`https://hn.algolia.com/api/v1/search_by_date`，无鉴权）
 * 拉「Show HN」帖作**产品发现源**，映射为 `source='show_hn'`、`rawType='product'` 的 `CollectedItem`，
 * 先落 `raw_items` 由编排层入库 → 紧接同链产品塌缩（product-collapse）。
 *
 * 不变量（spec source-collectors / product-discovery / design D1–D7）：
 * - **两道确定性闸（采集期，非语义判断）**：① 时间窗 `created_at_i > {近 FIRST_SEEN_WINDOW_DAYS 天下界}`
 *   （**仅采集期控量**——产品选品按 last_seen_at、不经 published_at 时效窗）；② 众投质量闸
 *   `points >= SHOW_HN_MIN_POINTS`。两条件均**在 `numericFilters` 串内由 API 侧过滤**（逗号 = AND）——
 *   points **绝不放客户端过滤**（否则 hitsPerPage 上限会先按时间截断再滤、漏掉窗内高赞帖）。运算符 `>`/`>=`
 *   经 `URLSearchParams` 自动编码（裸 `>` 致 400）；逗号 AND 分隔符 Algolia 服务端解码 `%2C` 回逗号、AND 仍生效。
 * - **独立 `source='show_hn'`**（design D2，禁止复用 `hacker_news`）：与 Firebase HN（rawType='post'）
 *   不共用 `(source, source_item_id)` 命名空间，避免 `ON CONFLICT DO NOTHING` 先插入者胜。
 * - **publishedAt 单位 + `>0` 守卫**（design D3）：`created_at_i` 是**秒**，正数才 `new Date(created_at_i*1000)`，
 *   否则 null——0/负/缺失/非数均 null（`new Date(0)`=1970 是合法 Date、不被 NaN 守卫挡，比 hacker-news.ts toDate 更严）。
 * - **title 剥 `Show HN` 前缀**（design D3）：剥 `Show HN` 后接 `:`/`-`/`–`/`—` 及空白（大小写不敏感），
 *   剥后为空则回退原 title（`CollectedItem.title` NOT NULL，绝不留空）。
 * - **三归一键全空跳过**（design D3，单一口径）：经叶子纯模块 `product-keys.ts` 的 `extractProductMergeKeys`
 *   以 `{url, metadata}` 判定，三键全空（覆盖 url 空/非 http、`github.com/owner` org 页）即记日志跳过不发射。
 *   **刻意 import `product-keys` 而非 `product-collapse`**——后者顶层 `import { db }` 会让纯采集器传递拉入 PG 连接池。
 * - 外部调用经 `withRetry`（有限重试 + 错误日志）；整源失败抛出由编排层 `Promise.allSettled` 隔离。
 *   points 绝对阈值致某轮返回空属预期、不告警。
 *
 * 依赖注入：`fetchJson`（默认 global fetch + 超时）、`now`、`sleep` 可注入，使单测不触网。
 */
import { env } from '../config/env.js';
import { extractProductMergeKeys } from './product-keys.js';
import {
  defaultLogError,
  withRetry,
  type CollectedItem,
  type LogError,
} from './types.js';

/** HN Algolia「按时间倒序」搜索端点（无鉴权）。 */
const ALGOLIA_SEARCH_BY_DATE_URL = 'https://hn.algolia.com/api/v1/search_by_date';

const SECONDS_PER_DAY = 86400;

/** Algolia 返回的单条 hit 的最小视图（注入桩据此构造；字段名由真实响应 fixture 固化）。 */
export interface ShowHnHit {
  /** HN item id（稳定非空）→ source_item_id。 */
  objectID?: string | number | null;
  /** 帖标题（含 `Show HN:` 前缀，映射时剥除）。 */
  title?: string | null;
  /** 帖提交 URL（产品官网 / github repo）→ url、提归一键的来源。 */
  url?: string | null;
  /** 创建时间（**秒** epoch），正数才转 Date。 */
  created_at_i?: number | null;
  /** HN 众投点数（采集期质量闸；透传 metadata）。 */
  points?: number | null;
  /** 评论数（透传 metadata）。 */
  num_comments?: number | null;
  /** 提交者（透传 metadata）。 */
  author?: string | null;
}

/** 抓取任意 JSON 的依赖契约（默认 global fetch + 超时；可注入 mock）。 */
export type FetchJsonFn = (url: string) => Promise<unknown>;

export interface ShowHnCollectorOptions {
  /** 注入的 JSON 抓取实现，默认 global fetch + 超时。 */
  fetchJson?: FetchJsonFn | undefined;
  /** 单轮采集上限（hitsPerPage），默认 env.SHOW_HN_MAX_PER_RUN。 */
  maxPerRun?: number | undefined;
  /** 众投质量闸（points >= 此值），默认 env.SHOW_HN_MIN_POINTS。 */
  minPoints?: number | undefined;
  /** 时间窗天数（created_at_i 下界），默认 env.FIRST_SEEN_WINDOW_DAYS。 */
  windowDays?: number | undefined;
  /** 参考时刻（算时间窗下界），默认当前时刻。 */
  now?: Date | undefined;
  /** 每次外部调用最大重试次数。 */
  maxAttempts?: number | undefined;
  /** 重试基础退避毫秒。 */
  baseDelayMs?: number | undefined;
  /** 错误日志 sink。 */
  logError?: LogError | undefined;
  /** 注入 sleep（测试免等待）。 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultFetchJson: FetchJsonFn = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HN Algolia ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
};

/** `created_at_i`（秒）正数才转 Date，否则 null（0/负/缺失/非数均 null，防落 1970）。 */
function toPublishedAt(createdAtI: number | null | undefined): Date | null {
  if (typeof createdAtI !== 'number' || !Number.isFinite(createdAtI) || createdAtI <= 0) {
    return null;
  }
  return new Date(createdAtI * 1000);
}

/** `Show HN` + `:`/`-`/`–`/`—` + 空白 前缀（大小写不敏感）。 */
const SHOW_HN_PREFIX_RE = /^\s*show\s+hn\s*[:\-–—]\s*/i;

/**
 * 剥除 `Show HN` 前缀作产品名；剥后为空串则回退原 title（NOT NULL 绝不留空）。
 * 覆盖 `Show HN:` / `Show HN -` / `Show HN –` / `Show HN —` 及大小写变体。
 */
export function stripShowHnPrefix(rawTitle: string): string {
  const stripped = rawTitle.replace(SHOW_HN_PREFIX_RE, '').trim();
  return stripped.length > 0 ? stripped : rawTitle;
}

/**
 * 把一条 Algolia hit 映射为统一结构（**不**做跳过判定，跳过由 collectShowHn 据三键全空决定）。
 * - source='show_hn'、rawType='product'、source_item_id=String(objectID)。
 * - title 剥 `Show HN` 前缀（剥后空回退原 title）。
 * - publishedAt：created_at_i 正数才 Date（秒→毫秒），否则 null。
 * - metadata 透传 points / num_comments / author / hn_object_id。
 */
export function mapShowHnHit(hit: ShowHnHit): CollectedItem {
  const sourceItemId = String(hit.objectID ?? '');
  const rawTitle = (hit.title ?? '').trim();
  const url = hit.url?.trim() || null;

  const metadata: Record<string, unknown> = {
    points: hit.points ?? null,
    num_comments: hit.num_comments ?? null,
    author: hit.author?.trim() || null,
    hn_object_id: sourceItemId,
  };

  return {
    source: 'show_hn',
    sourceItemId,
    url,
    title: stripShowHnPrefix(rawTitle),
    content: null,
    publishedAt: toPublishedAt(hit.created_at_i),
    rawType: 'product',
    metadata,
  };
}

/** 从 Algolia body 安全提取 hits 数组（结构异常时返回空数组，不抛）。 */
function extractHits(body: unknown): ShowHnHit[] {
  const hits = (body as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) return [];
  const out: ShowHnHit[] = [];
  for (const h of hits) {
    if (h && typeof h === 'object') out.push(h as ShowHnHit);
  }
  return out;
}

/** 构造 Algolia search_by_date 查询 URL（numericFilters 两条件 AND，运算符经 URLSearchParams 编码）。 */
function buildSearchUrl(lowerBoundSec: number, minPoints: number, hitsPerPage: number): string {
  const params = new URLSearchParams({
    tags: 'show_hn',
    // 时间窗下界 + 众投质量闸两条件以逗号 AND；points 须在 numericFilters 串内（非客户端过滤）。
    numericFilters: `created_at_i>${lowerBoundSec},points>=${minPoints}`,
    hitsPerPage: String(hitsPerPage),
  });
  return `${ALGOLIA_SEARCH_BY_DATE_URL}?${params.toString()}`;
}

/**
 * 采集近窗内、points 达阈值的 Show HN → 统一结构（先落 raw_items 由编排层入库）。
 *
 * 三键全空者跳过不发射（记日志）。整源调用失败（超时 / 非 2xx / 解析错）经 withRetry 重试耗尽后抛出，
 * 由编排层 `Promise.allSettled` 隔离、不拖垮整批。points 阈值致某轮返回空属正常、不告警。
 */
export async function collectShowHn(
  options: ShowHnCollectorOptions = {},
): Promise<CollectedItem[]> {
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const maxPerRun = options.maxPerRun ?? env.SHOW_HN_MAX_PER_RUN;
  const minPoints = options.minPoints ?? env.SHOW_HN_MIN_POINTS;
  const windowDays = options.windowDays ?? env.FIRST_SEEN_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const logError = options.logError ?? defaultLogError;

  const lowerBoundSec = Math.floor(now.getTime() / 1000) - windowDays * SECONDS_PER_DAY;
  const url = buildSearchUrl(lowerBoundSec, minPoints, maxPerRun);

  const body = await withRetry(() => fetchJson(url), {
    maxAttempts: options.maxAttempts,
    baseDelayMs: options.baseDelayMs,
    logError,
    sleep: options.sleep,
    label: 'show_hn:algolia',
  });

  const items: CollectedItem[] = [];
  for (const hit of extractHits(body)) {
    const item = mapShowHnHit(hit);
    // 跳过判据（单一口径，复用塌缩提键纯函数）：三归一键全空即记日志跳过不发射。
    const keys = extractProductMergeKeys({ url: item.url, metadata: item.metadata });
    if (
      keys.canonicalDomain === null &&
      keys.githubRepo === null &&
      keys.productHuntSlug === null
    ) {
      logError('show_hn 三归一键全空，跳过不发射（url 空/非 http 或 github.com/owner org 页）', {
        objectID: item.sourceItemId,
        url: item.url,
      });
      continue;
    }
    items.push(item);
  }
  return items;
}
