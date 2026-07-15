/**
 * sitemap 增量采集器（add-tier1-ai-sources，任务 4.1–4.4，design D3 / spec「sitemap 增量采集」）。
 *
 * 配置驱动（env.SITEMAP_SOURCES，每项 `{sitemapUrl, pathPrefix, vendor}`，首期 Anthropic News）：
 * 接入「无原生 RSS、但有 sitemap.xml 且文章页 SSR 含 og: 标签」的一手 lab 新闻源。
 * **本提案唯一需要 per-article HTML 抓取的源**（其余源全部内联提供 title+content）。
 *
 * 采集流程（spec / design D3）：
 *   ① fetch sitemap.xml，**正则**先 match 每个 `<url>...</url>` 块、再块内取 `<loc>`/`<lastmod>`
 *      （同 arxiv.ts「先 match 块、再块内取子标签」范式，防缺 lastmod 的 url 错位配对；不引入 cheerio）；
 *   ② 对每个 loc 先 `c = normalizeUrl(loc)`（**用 normalizeUrl 而非裸 `new URL(loc)`**——normalizeUrl
 *      内部 try/catch、对相对/非 http/畸形 loc 返 null 不抛，统一 A-4 与 F-5 的抛错路径为一个 null 门）：
 *      `c===null` 跳过；否则 `new URL(c).pathname.startsWith(pathPrefix)`（在已规范化绝对 URL 上取
 *      pathname、不会抛；`startsWith` 非裸 `includes`，防 query-string/fragment 里含 pathPrefix 的误匹配）
 *      且 lastmod 在近 FIRST_SEEN_WINDOW_DAYS 天窗内（lastmod 缺失/NaN → **保守跳过该 URL**，M-4）
 *      且 `c` 不在「DB 已见集」（M-D，去重键 = canonical_url = c）三条同时满足才纳入候选；
 *   ③ 对每个窗内未见 URL fetch 文章 HTML，**正则**取 `og:title`→title、`og:description`→content；
 *      `og:title` 缺失回退 URL slug 派生（绝不空 title）；**og:title 与 og:description 同缺 → 跳过该篇
 *      不发射**（M-1，防 slug-title + null-content 退化垃圾进日报候选）；
 *   ④ 映射 `source='sitemap'`、`metadata={vendor, feed_url, lastmod}`、`url=文章URL(c)`、
 *      **`publishedAt=null`**（M-C：lastmod 不进 published_at、走既有 published-at-inference；lastmod 仅
 *      入 metadata 作 inference hint + 窗口 diff 粗筛）、`rawType='news'`、
 *      `source_item_id`=（`c` 已非 null；`c.length>255` → `contentHash(title,content)`；否则 `c`，F-6）。
 *
 * 增量语义（M-D，无游标 → DB 已见集 + best-effort 窗口；显式声明）：
 * - sitemap **无 arXiv 式游标**。per-article fetch **前**查「DB 已见集」
 *   （`SELECT canonical_url FROM raw_items WHERE source='sitemap'`），跳过已入库 URL → 同一文章
 *   **只 fetch HTML 一次**（消除每轮重复抓取）。窗口（FIRST_SEEN_WINDOW_DAYS）仅作候选粗筛。
 * - 本机制是 **best-effort 窗口快照 + DB 去重、非 at-least-once 增量**：「是否已采」的事实交还 DB
 *   （符合「DB 控状态」第一架构原则），不纯依赖时间窗。窗口默认应显著大于最坏调度间隔以降跳窗漏采概率。
 * - **first-fetch-wins**：按 canonical_url 跳过 + store `ON CONFLICT DO NOTHING` ⇒ 文章首次入库后其
 *   og:title/og:description/lastmod 后续被官方更新将**永不重抓**；对近 immutable 的 news 本期接受。
 * - **去重键为何是 canonical_url（非 source_item_id）**：去重 MUST 在 per-article fetch **前**完成
 *   （以避免重复 fetch），故去重键只能是「fetch 前就能从 URL 单独算出的稳定值」。`canonical_url =
 *   normalizeUrl(loc)` 满足（纯 URL 函数）；`source_item_id` 在 `len>255` 时折叠为
 *   `contentHash(title,content)`、依赖 fetch 后才有的 og 内容，fetch 前无法复算，故**不可**用作去重键。
 * - **已见集查询失败语义（F-4，MUST）**：DB 不可达/查询超时时 MUST 让整源失败（抛出由编排层
 *   `allSettled` 隔离），**MUST NOT 降级为空已见集**（否则窗内 URL 全被当未见 → per-article HTML
 *   全量重抓风暴，违背 M-D「只 fetch 一次」）。
 *
 * 可观测契约（M-A，防站点改版静默归零）：每源记 `loc_count`/`path_match_count`/
 * `window_candidate_count`/`emitted_count`。sitemap 返回 2xx 但 **`loc_count=0`**（非 XML/结构变更/
 * 正则全失配）MUST `logError` 并 **throw 使整源失败**（编排层 perSource.ok=false 计入告警），
 * **绝不**记「成功 0 条」；仅 `loc_count>0 && window_candidate_count=0` 才视作正常「无窗内新文」。
 * 这把「per-article og 退化（不崩）」与「URL 发现阶段整源归零（须告警）」两种退化区分开。
 *
 * 限量与隔离：仅 fetch 窗内未见 URL；每篇 fetch + 整源调用经 `withRetry`；单篇失败 try/catch 跳过该篇
 * （记日志）、不拖垮该源；整源失败抛出由编排层 `allSettled` 隔离。
 *
 * 依赖注入：`fetchText`（sitemap XML）、`fetchArticle`（文章 HTML）、`querySeenCanonicalUrls`
 * （DB 已见集查询）、`sources`（SITEMAP_SOURCES override）、`now`、`sleep` 均可注入，使单测不触网/不连库。
 */
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { rawItems } from '../db/schema.js';
import { env, type SitemapSourceConfig } from '../config/env.js';
import { normalizeUrl } from '../dedup/normalize.js';
import {
  contentHash,
  defaultLogError,
  stripUnsafeChars,
  withRetry,
  type CollectedItem,
  type LogError,
} from './types.js';

type DbLike = typeof defaultDb;

const MS_PER_DAY = 86_400_000;

/** raw_items.source_item_id 列长上界（varchar(255)，schema.ts）；超界 store 阶段 INSERT 会抛、不被隔离。 */
const SOURCE_ITEM_ID_MAX_LEN = 255;

/**
 * sitemap/文章 body 字节上限（5MB）。两重防护：
 * ① 防 OOM（异常超大响应吃满内存）；
 * ② 防 ReDoS——配合下方正则加界，挡住把超大 body 喂进 `[\s\S]*?` 类回溯正则二次方卡死
 *    （实测 0.5MB 未闭合标签 → 8s）。content-length 可能缺失/撒谎，故读后再按 text.length 复判。
 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** og: meta content 内容字符上界（正则加界，同上防回溯）；真 og 内容 ~数百字符，10k 远够。 */
const MAX_OG_CONTENT_CHARS = 10_000;

/**
 * 页面发布日的合理下限（常量 `2015-01-01` UTC 零点）。早于此的提取值判越界置 null。
 * 与 now 上界一道把「提取到明显不合理的年份」变干净失败（宁可漏，绝不把老/错日期当发布日）。
 */
const MIN_PUBLISHED_MS = Date.UTC(2015, 0, 1);

/**
 * `</h1>` 之后「紧邻元素文本」的有界扫描窗口（字符）。真实结构里日期元素紧跟 h1、几十字符内即达，
 * 4KB 远够；有界 slice 是 ReDoS 防护的一环——锚定正则只在此小串上跑，绝不跨整张 5MB HTML。
 */
const H1_ADJACENT_SCAN_CHARS = 4096;

/** 英文月份缩写 → 0..11（`Date.UTC` 的 month 口径）；非月份缩写（如 `Xyz`）查不到 → 提取失败。 */
const MONTH_ABBR: Readonly<Record<string, number>> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * 已知**全站样板** `og:description` 集合（精确匹配 trim 后全文）。命中即视同缺失（`content=null`）。
 * 见 spec「③ 全站样板 og:description 视同缺失」：Anthropic News 实测 14 篇最新文章中 6 篇逐字相同此串，
 * 落进 content 会构造性击穿三道下游护栏（摘要防幻觉 / 正文补全工作集 / 语义合并灰区），比无正文更糟。
 * 串用**实体解码后**的形态（og content 经 decodeXmlEntities 才到判定，故 `that's` 用真撇号）。
 */
const SITE_BOILERPLATE_DESCRIPTIONS: ReadonlySet<string> = new Set([
  "Anthropic is an AI safety and research company that's working to build reliable, interpretable, and steerable AI systems.",
]);

/**
 * 是否为已知全站样板 og:description（精确匹配 trim 后全文）。
 * **导出**：`content-enrichment.ts` 的正文补全阶段共享同一判定（单一定义、两处引用），
 * 防两份样板集漂移致「采集器视同缺失、补全阶段又当有效正文」的口径不一致。
 */
export function isSiteBoilerplate(desc: string): boolean {
  return SITE_BOILERPLATE_DESCRIPTIONS.has(desc.trim());
}

/** sitemap XML 文本抓取契约（默认 global fetch + 超时；可注入 mock）。 */
export type FetchTextFn = (url: string) => Promise<string>;

/** 文章页 HTML 文本抓取契约（默认 global fetch + 超时；可注入 mock）。 */
export type FetchArticleFn = (url: string) => Promise<string>;

/**
 * 「DB 已见集」查询契约（默认查 raw_items 的 sitemap 行 canonical_url；可注入 mock 免连库）。
 * **失败（DB 不可达/超时）MUST 抛出**——由 collectSitemaps 让整源失败、绝不降级空集（F-4）。
 */
export type QuerySeenCanonicalUrlsFn = (source: string) => Promise<Set<string>>;

export interface SitemapCollectorOptions {
  /** 注入的 sitemap 源配置（override env.SITEMAP_SOURCES，便于单测钉死）。 */
  sources?: readonly SitemapSourceConfig[] | undefined;
  /** 注入的 sitemap XML 抓取实现，默认 global fetch + 超时。 */
  fetchText?: FetchTextFn | undefined;
  /** 注入的文章 HTML 抓取实现，默认 global fetch + 超时。 */
  fetchArticle?: FetchArticleFn | undefined;
  /** 注入的「已见集」查询实现，默认查 raw_items（drizzle）。 */
  querySeenCanonicalUrls?: QuerySeenCanonicalUrlsFn | undefined;
  /** 注入 db 或事务句柄（默认全局 db）；仅默认 querySeenCanonicalUrls 用。 */
  dbh?: DbLike | undefined;
  /** 时间窗天数（lastmod 候选粗筛下界），默认 env.FIRST_SEEN_WINDOW_DAYS。 */
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

/**
 * 默认 sitemap XML 抓取：2xx 校验 + content-type 含 `xml` 闸 + body 5MB 上限。
 * content-type 闸（要求含 xml：text/xml、application/xml、*+xml）连同 body 上限挡住把
 * JSON/二进制/错误页当 XML 喂进回溯正则（ReDoS 防护 + 防误把非 sitemap 当 sitemap 扫）。
 */
export const defaultFetchText: FetchTextFn = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ai-radar (sitemap incremental collector)' },
    signal: AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`sitemap ${res.status} ${res.statusText} for ${url}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('xml')) {
    throw new Error(`sitemap content-type 非 XML（${contentType || '缺失'}）for ${url}`);
  }
  // content-length 先粗筛（可能缺失/撒谎，故读后再按 text.length 复判）。
  const cl = Number(res.headers.get('content-length') ?? 0);
  if (cl > MAX_BODY_BYTES) {
    throw new Error(`sitemap body content-length ${cl} 超 ${MAX_BODY_BYTES} 字节上限 for ${url}`);
  }
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error(`sitemap body 超 ${MAX_BODY_BYTES} 字节上限 for ${url}`);
  }
  return text;
};

/**
 * 默认文章 HTML 抓取：2xx 校验 + content-type 含 `html` 闸 + body 5MB 上限。
 * 同 defaultFetchText 的 ReDoS/OOM 防护；content-type 要求含 html，挡住把非 HTML 喂进 og: 提取正则。
 */
export const defaultFetchArticle: FetchArticleFn = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ai-radar (sitemap incremental collector)' },
    signal: AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`sitemap article ${res.status} ${res.statusText} for ${url}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('html')) {
    throw new Error(`sitemap article content-type 非 HTML（${contentType || '缺失'}）for ${url}`);
  }
  const cl = Number(res.headers.get('content-length') ?? 0);
  if (cl > MAX_BODY_BYTES) {
    throw new Error(
      `sitemap article body content-length ${cl} 超 ${MAX_BODY_BYTES} 字节上限 for ${url}`,
    );
  }
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error(`sitemap article body 超 ${MAX_BODY_BYTES} 字节上限 for ${url}`);
  }
  return text;
};

/**
 * 默认「已见集」查询（M-D）：`SELECT canonical_url FROM raw_items WHERE source='sitemap'`。
 * 照 store.ts 的 db/drizzle 范式（collectors/ 层已有 store.ts 访问 db 的先例）。
 *
 * 说明（F-2/F-3 本期接受属性）：
 * - `WHERE source='sitemap'` 走 `(source, source_item_id)` 唯一索引的 source 前缀做范围扫定位 sitemap 行；
 *   `canonical_url`（无索引 text 列）投影须回表（非 index-only），返回行数随累计无界增长——
 *   Anthropic 量级（百级）安全，本期**不**为 canonical_url 单列加索引（守「无 schema 迁移」）。
 * - 仅取非 null 的 canonical_url（畸形 loc 在过滤阶段已跳过、不入库，已见集自然不含 NULL）。
 * - **查询失败 MUST 抛出**（不在此 catch）：交由 collectSitemaps 让整源失败、绝不降级空集（F-4）。
 */
function makeDefaultQuerySeen(dbh: DbLike): QuerySeenCanonicalUrlsFn {
  return async (source) => {
    const rows = await dbh
      .select({ canonicalUrl: rawItems.canonicalUrl })
      .from(rawItems)
      .where(sql`${rawItems.source} = ${source} AND ${rawItems.canonicalUrl} IS NOT NULL`);
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.canonicalUrl) seen.add(row.canonicalUrl);
    }
    return seen;
  };
}

/** 解析出的单条 sitemap 条目（loc 必有；lastmod 可空——缺失时过滤阶段保守跳过）。 */
export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

/** 安全把码点转字符并剔除危险码点：非有限/越界（>0x10FFFF）/NUL·C0 控制符/lone surrogate → 空串，绝不抛。
 * NUL 会让 Postgres text INSERT 失败（store 阶段不被 allSettled 隔离、中止整批）；lone surrogate 破坏下游 JSON.stringify。 */
function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  // 剔 NUL/C0 控制字符（保留 tab/LF/CR）：防 NUL 致 Postgres text INSERT 失败（store 阶段不被 allSettled 隔离、中止整批）。
  if (cp === 0 || (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d)) return '';
  // 剔代理区码点（lone surrogate）：防破坏下游 JSON.stringify。
  if (cp >= 0xd800 && cp <= 0xdfff) return '';
  try { return String.fromCodePoint(cp); } catch { return ''; }
}

/**
 * 解码 XML/HTML 实体。**顺序敏感**：先数字字符引用（`&#x..;`/`&#..;`）、再命名实体、`&amp;` 最后。
 * `&amp;` 必须最后解码，否则会把 `&amp;#x27;` 先变 `&#x27;` 再被数字实体规则误二次解码成 `'`（双解码 bug）。
 * 末尾 stripUnsafeChars 统一剔危险码点：覆盖实体路径 + og content 里的**原始**字节（防绕过 safeFromCodePoint）。
 */
function decodeXmlEntities(s: string): string {
  const decoded = s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // 必须最后，避免把 &amp;#x27; 误双解码。
  return stripUnsafeChars(decoded);
}

/** 在一个 `<url>` 块内取首个 `<loc>`/`<lastmod>`（命名空间前缀宽松，子标签缺失返 null）。
 * 用「开标签单标签有界匹配 + 找闭合 + slice」而非整段 lazy 捕获，防块内未闭合子标签的二次方回溯（ReDoS）。 */
function firstChildTag(blockXml: string, tag: string): string | null {
  const tagLower = tag.toLowerCase();
  let from = 0;
  // indexOf 线性：无 '>' 立即 bail，杜绝开标签 [^>]* scan-to-EOF 的二次方回溯。
  while (true) {
    const lt = blockXml.indexOf('<', from);
    if (lt === -1) return null;
    const gt = blockXml.indexOf('>', lt);
    if (gt === -1) return null;
    const inner = blockXml.slice(lt + 1, gt); // < 与 > 之间（单标签内）
    const nm = /^([\w-]+:)?([\w-]+)/.exec(inner); // 捕获：[1]=命名空间前缀(可选) [2]=本地名
    // 只匹配**无命名空间前缀**的标准 sitemap 标签（<loc>/<lastmod>）。
    // `!nm[1]` 排除扩展命名空间标签（如 Google 图片扩展 `<image:loc>`、`<video:loc>`、`<news:...>`）——
    // 否则块内 `<image:loc>` 在 `<loc>` 之前会被误当页面 URL、fetch 图片而非文章（Bugbot #3）。
    if (nm && !nm[1] && nm[2]!.toLowerCase() === tagLower && inner[0] !== '/') {
      const contentStart = gt + 1;
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
      const cm = closeRe.exec(blockXml.slice(contentStart));
      if (!cm) return null;
      return decodeXmlEntities(blockXml.slice(contentStart, contentStart + cm.index).trim());
    }
    from = gt + 1;
  }
}

/**
 * 解析 sitemap XML（同 arxiv.ts 范式：**先切每个 `<url>...</url>` 块、再块内取 `<loc>`/`<lastmod>`**）。
 * 先切块再取子标签可防「缺 lastmod 的 url 与下一个 url 的 lastmod 错位配对」（不能两条独立全局正则各扫）。
 * 命名空间前缀（如 `<image:loc>`）由 firstChildTag 的 `(?:[\w-]+:)?` 宽松匹配；但块级只匹配根 `<url>`。
 *
 * **块切分用 indexOf 线性扫描（非 lazy 捕获正则）**：旧实现的整-xml lazy 捕获正则
 * `<url[^>]*>([\s\S]{0,100000}?)</url>` 对未闭合 `<url>` 的畸形大 body 仍二次方回溯（实测 1MB→29s、
 * 2MB→60s，在 5MB body 上限内即可卡死 worker，ReDoS）。indexOf 对未闭合块立即 break、不重复 scan-to-EOF，
 * 杜绝该回溯（实测 5MB→7ms）。firstChildTag 现仅在已切出的小块上跑、安全，故保留正则。
 */
export function parseSitemap(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  let pos = 0;
  while (true) {
    const open = xml.indexOf('<url', pos);
    if (open === -1) break;
    // 区分 <url>/<url ...> 与 <urlset> 等：'<url' 后须是标签名边界字符。
    const after = xml[open + 4];
    if (after !== '>' && after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r' && after !== '/') {
      pos = open + 4;
      continue;
    }
    const openTagEnd = xml.indexOf('>', open);
    if (openTagEnd === -1) break;
    const close = xml.indexOf('</url>', openTagEnd);
    if (close === -1) break; // 无闭合 → 停止（不重复扫到 EOF）。
    const block = xml.slice(openTagEnd + 1, close);
    const loc = firstChildTag(block, 'loc');
    if (loc) entries.push({ loc, lastmod: firstChildTag(block, 'lastmod') });
    pos = close + 6; // 越过 '</url>'。
  }
  return entries;
}

/**
 * og: meta 标签的属性顺序宽松匹配（property 在前 / content 在前两种顺序；单双引号均可；命名空间无关）。
 * **逐标签匹配防跨标签回溯**：用 indexOf 线性逐个切出单个 `<meta ...>` 标签串（无 '>' 立即 bail，
 * 杜绝开标签 scan-to-EOF 二次方），再在该单标签串内分别查 `property=`/`content=`。这样 content 的
 * `[\s\S]*?` 捕获被限制在单标签内、绝不会跨越前一个 meta（如 `<meta property="og:type" content="article" />`）
 * 回溯误匹配出 `article" />…<meta content="` 一类跨标签垃圾（原双正则 content-first 分支的 bug）。
 */
export function extractOgTag(html: string, property: string): string | null {
  const prop = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // 转义 og:title 里的特殊字符（无，但稳妥）。
  const propRe = new RegExp(`\\bproperty\\s*=\\s*["']${prop}["']`, 'i');
  // `[\s\S]{0,MAX_OG_CONTENT_CHARS}?` 加界（非裸 `[\s\S]*?`）：防回溯；在单标签串内提取，输入小、有界。
  const contentRe = new RegExp(
    `\\bcontent\\s*=\\s*["']([\\s\\S]{0,${MAX_OG_CONTENT_CHARS}}?)["']`,
    'i',
  );
  let from = 0;
  while (true) {
    const lt = html.indexOf('<meta', from);
    if (lt === -1) return null;
    const gt = html.indexOf('>', lt);
    if (gt === -1) return null; // 无 '>' → 线性 bail，杜绝 <meta[^>]* 二次方
    const tag = html.slice(lt, gt + 1);
    from = gt + 1;
    const boundary = html[lt + 5]; // '<meta' 后须标签名边界（防 <metafoo）
    if (boundary !== undefined && !/[\s/>]/.test(boundary)) continue;
    if (!propRe.test(tag)) continue;
    const cm = contentRe.exec(tag);
    if (cm) {
      // FIX-5：trim+decode 后为空串 → 返 null（使 M-1 双缺 guard 对 content="" 也触发，不发空内容退化条目）。
      const v = decodeXmlEntities(cm[1]!.trim());
      return v.length > 0 ? v : null;
    }
  }
}

/**
 * 由文章 URL 派生 slug 标题（og:title 缺失时的回退，绝不留空 title）。
 * 取规范化 URL 的最后一个非空 path 段，把 `-`/`_` 折成空格、词首大写；派生不出则回退整 URL。
 */
export function deriveTitleFromUrl(canonicalUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(canonicalUrl).pathname;
  } catch {
    return canonicalUrl;
  }
  const segments = pathname.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last) return canonicalUrl;
  const decoded = (() => {
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  })();
  // 剔 decodeURIComponent 解出的原始 NUL/C0 控制符/lone surrogate（如 %00/%07/%EF%BF%BF 经解码成原始字节）：
  // 此回退路径不经 decodeXmlEntities→stripUnsafeChars，原始危险字符会直进 title→store INSERT 致中止整批。
  const cleaned = stripUnsafeChars(decoded);
  const words = cleaned
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // slug 全为危险/分隔字符 → 回退 canonicalUrl（来自 normalizeUrl、含 %00 字面非原始 NUL，安全）。
  if (words.length === 0) return canonicalUrl;
  return words
    .split(' ')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * 定位一个**真** `<h1` 开标签起点（`indexOf` 线性，从 `from` 起）；无则 -1。
 * 边界校验（`<h1` 后须为 `>`/空白/`/`）排除 `<h10>`/`<h1foo>`；沿用本采集器 `indexOf` 切块范式（防 ReDoS）。
 * 大小写敏感（同 parseSitemap 的 `<url`、extractOgTag 的 `<meta`）——`<H1>` 判 0 个 h1 → 干净失败置 null。
 */
function findH1TagStart(html: string, from: number): number {
  let pos = from;
  while (true) {
    const i = html.indexOf('<h1', pos);
    if (i === -1) return -1;
    const b = html[i + 3];
    if (b === '>' || b === ' ' || b === '\t' || b === '\n' || b === '\r' || b === '/') return i;
    pos = i + 3; // 非标签边界（<h10>/<h1x）：跳过继续找。
  }
}

/**
 * 取 `</h1>` 之后**紧邻第一个元素**的文本内容（跳过前导标签与空白，取到下一个 `<` 为止）。
 * 真实结构 `<h1>…</h1><div class="body-3 agate">Jun 30, 2026</div>` → 剥掉那一个 `<div…>` 标签、
 * 返回其内文本 `Jun 30, 2026`。有界 slice + `indexOf` 线性（不用 `[\s\S]*?` 跨整张 HTML，防 ReDoS）。
 */
function h1AdjacentText(slice: string): string | null {
  let i = 0;
  while (i < slice.length) {
    const c = slice[i]!;
    if (c === '<') {
      const gt = slice.indexOf('>', i);
      if (gt === -1) return null; // 未闭合标签 → 干净失败（线性 bail）。
      i = gt + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i += 1;
      continue;
    }
    const lt = slice.indexOf('<', i); // 文本起点 → 下一个 '<' 为止即该元素文本。
    return lt === -1 ? slice.slice(i) : slice.slice(i, lt);
  }
  return null;
}

/**
 * 从文章 HTML **确定性提取**真实发布日 → `published_at`（见 spec「时效正确性 ②」）。任何失败 → `null`（干净失败）。
 *
 * - **锚定 = 「文档有且仅有一个 `<h1>`」**（`indexOf` 计数：找第一个、再找第二个；第二个存在 ⇒ >1 ⇒ null）。
 *   **不**以「og:title 文本相等」作锚（实测仅 18/30，会丢 40% 有日期的页面）。
 * - 取唯一 h1 的**紧邻元素文本**，**整串全匹配** `^\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*$`（如 `Nov 2, 2023`）。
 *   整串（非子串）：`Updated Jan 5, 2024` / `By Jane · Mar 2, 2025 · 5 min` 一律不中（把「提取到错的」变「什么都没提取到」）。
 * - **`Date.UTC(y, m, d)` 显式构造 UTC 零点**（不用 `new Date(str)`——V8 按运行时本地时区解析非 ISO 串致边界漂）。
 * - 校验：日历有效（拒 `Feb 30` 类越月回绕）且 `2015-01-01 <= d <= now`；越界 → null。
 * - ReDoS：`<h1` 定位与计数用 `indexOf`；锚定正则只在**有界**紧邻文本小串上跑，绝不跨整张 5MB HTML。
 */
export function extractPublishedAt(html: string, nowMs: number): Date | null {
  const first = findH1TagStart(html, 0);
  if (first === -1) return null; // 0 个 h1 → 干净失败。
  if (findH1TagStart(html, first + 3) !== -1) return null; // >1 个 h1 → 干净失败（站点加了 nav/卡片 h1）。

  const closeIdx = html.indexOf('</h1>', first + 3);
  if (closeIdx === -1) return null; // 唯一 h1 但无闭合 → 干净失败。
  const afterH1 = closeIdx + 5; // 越过 '</h1>'。
  const text = h1AdjacentText(html.slice(afterH1, afterH1 + H1_ADJACENT_SCAN_CHARS));
  if (text === null) return null;

  const m = /^\s*([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s*$/.exec(text);
  if (!m) return null; // 整串不匹配（含额外文本 / 格式不符）→ 干净失败。
  const month = MONTH_ABBR[m[1]!];
  if (month === undefined) return null; // 形如 `Xyz` 匹配了字符类但非真月份。
  const day = Number(m[2]);
  const year = Number(m[3]);
  const ms = Date.UTC(year, month, day);
  const d = new Date(ms);
  // 日历有效性（拒 Feb 30 / Nov 31 类越月回绕——Date.UTC 会静默进位到下月）。
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  if (ms < MIN_PUBLISHED_MS || ms > nowMs) return null; // 越界（过老 / 未来）→ 干净失败。
  return d;
}

/** 计算时间窗下界（now 往前 windowDays 天）；lastmod >= 此下界才算窗内。 */
function windowLowerBoundMs(now: Date, windowDays: number): number {
  return now.getTime() - windowDays * MS_PER_DAY;
}

/**
 * lastmod 是否在窗内 `[lowerBound, now]`：缺失/解析为 NaN → false（保守跳过，M-4）；
 * 解析为有效时间且在 `[lowerBoundMs, nowMs]` 闭区间内 → true。
 * FIX-8：加上界 nowMs——未来 lastmod（站点错填/时钟漂移）不入窗，防误采。
 */
function isLastmodInWindow(
  lastmod: string | null,
  lowerBoundMs: number,
  nowMs: number,
): boolean {
  if (!lastmod) return false; // 缺失：无法判定是否窗内，保守跳过（M-4）。
  const t = new Date(lastmod).getTime();
  if (Number.isNaN(t)) return false; // 解析 NaN：同上保守跳过。
  return t >= lowerBoundMs && t <= nowMs; // 未来 lastmod 不入窗（上界守卫）。
}

/**
 * 采集单个 sitemap 配置源 → 统一结构（窗内未见文章的 og: 提取条目）。
 *
 * 失败语义（spec）：
 * - sitemap fetch 失败（超时/非 2xx）经 withRetry 重试耗尽后抛出 → 整源失败（由 collectSitemaps 冒泡）。
 * - sitemap 2xx 但 `loc_count=0`（结构变更/正则全失配）→ logError + **throw**（M-A 防静默归零）。
 * - 已见集查询失败 → 抛出（F-4，整源失败、不降级空集）。
 * - 单篇文章 fetch 失败 → try/catch 跳过该篇 + 记日志，不拖垮该源。
 */
async function collectOneSitemap(
  config: SitemapSourceConfig,
  ctx: {
    fetchText: FetchTextFn;
    fetchArticle: FetchArticleFn;
    querySeenCanonicalUrls: QuerySeenCanonicalUrlsFn;
    lowerBoundMs: number;
    nowMs: number;
    maxAttempts: number | undefined;
    baseDelayMs: number | undefined;
    logError: LogError;
    sleep: ((ms: number) => Promise<void>) | undefined;
  },
): Promise<CollectedItem[]> {
  const { sitemapUrl, pathPrefix, vendor } = config;
  const retryOpts = {
    maxAttempts: ctx.maxAttempts,
    baseDelayMs: ctx.baseDelayMs,
    logError: ctx.logError,
    sleep: ctx.sleep,
  };

  // ── ① fetch + 解析 sitemap（整源调用经 withRetry；失败抛出由编排层隔离）。
  const xml = await withRetry(() => ctx.fetchText(sitemapUrl), {
    ...retryOpts,
    label: `sitemap:${vendor}`,
  });
  const entries = parseSitemap(xml);
  const locCount = entries.length;

  // ── M-A：2xx 但 loc_count=0（站点改版/正则失配）判源失败，**绝不**记「成功 0 条」。
  if (locCount === 0) {
    ctx.logError(
      `sitemap[${vendor}] 返回 2xx 但解析出 0 个 <loc>（站点结构变更/正则失配），判源失败（防静默归零）`,
      { sitemapUrl, pathPrefix },
    );
    throw new Error(
      `sitemap[${vendor}] loc_count=0：${sitemapUrl} 返回 2xx 但未解析出任何 <loc>，判源失败`,
    );
  }

  // FIX-7（SSRF 防护）：sitemap 自身 host，用于约束文章 URL 信任边界 = 仅同 host/子域。
  const sitemapHost = (() => {
    try {
      return new URL(sitemapUrl).hostname;
    } catch {
      return null;
    }
  })();

  // ── ② 路径前缀 + 窗口粗筛（path_match_count 仅作可观测）。
  let pathMatchCount = 0;
  const pathWindowCandidates: { canonical: string; lastmod: string | null }[] = [];
  for (const entry of entries) {
    // 用 normalizeUrl（内部 try/catch，相对/非 http/畸形返 null），绝不裸 `new URL(loc)`（相对 loc 抛 TypeError）。
    const c = normalizeUrl(entry.loc);
    if (c === null) continue; // 畸形/非 http/相对 loc：过滤阶段跳过、不发射（F-5/A-4）。
    // 在已规范化绝对 URL 上取 pathname（不会抛）；startsWith 非 includes（防 query-string/fragment 误匹配，G-6）。
    let pathname: string;
    try {
      pathname = new URL(c).pathname;
    } catch {
      continue; // 理论上 c 已是合法绝对 URL，不会到此；保守跳过。
    }
    if (!pathname.startsWith(pathPrefix)) continue;
    pathMatchCount += 1;
    // FIX-7（SSRF 防护）+ Bugbot #2：文章 host 必须与 sitemap host 同注册域（apex 与 www 视同站、含子域），
    // 否则跳过该 loc。剥前导 `www.` 后比对，使 sitemap 在 `www.x.com` 时 apex `x.com` 的文章也可采（反之亦然）；
    // 仍拒内网/元数据 host（169.254.169.254）、后缀仿冒（x.com.evil.com）、近似域（evilx.com）。
    // 信任边界 = sitemap 被攻陷/MITM 时不致 fetch 任意内网/外部 host。
    const cHost = new URL(c).hostname;
    const sBase = sitemapHost === null ? null : sitemapHost.replace(/^www\./, '');
    const aBase = cHost.replace(/^www\./, '');
    if (sBase === null || (aBase !== sBase && !aBase.endsWith('.' + sBase))) {
      ctx.logError(
        `sitemap[${vendor}] 文章 host (${cHost}) 非 sitemap 注册域 (${sBase}) 或其子域，跳过（SSRF 防护）`,
        { url: c },
      );
      continue;
    }
    if (!isLastmodInWindow(entry.lastmod, ctx.lowerBoundMs, ctx.nowMs)) continue; // 窗外 / lastmod 缺失·NaN / 未来 跳过（M-4 + FIX-8）。
    pathWindowCandidates.push({ canonical: c, lastmod: entry.lastmod });
  }

  // ── M-D：per-article fetch **前**查 DB 已见集；查询失败抛出（F-4，整源失败、不降级空集）。
  // 仅当存在路径+窗口候选时才查（无候选则无需连库）。
  let seen: Set<string> = new Set();
  if (pathWindowCandidates.length > 0) {
    // 注意：querySeenCanonicalUrls 失败时**不** catch——让其冒泡，由本函数→collectSitemaps→allSettled 隔离。
    seen = await ctx.querySeenCanonicalUrls('sitemap');
  }

  // 去重键 = canonical_url（候选侧 = normalizeUrl(loc) = c）。已见即跳过、**不**重复 fetch HTML。
  const windowCandidates = pathWindowCandidates.filter((cand) => !seen.has(cand.canonical));
  const windowCandidateCount = windowCandidates.length;

  // ── ③ 对每个窗内未见 URL fetch HTML、提 og:，映射；单篇失败跳过不拖垮该源。
  const items: CollectedItem[] = [];
  let dateExtractedCount = 0; // 成功页面提取到发布日的篇数（可观测契约；下一子片支路 1 由 DB 复算，此处入日志）。
  for (const cand of windowCandidates) {
    try {
      const html = await withRetry(() => ctx.fetchArticle(cand.canonical), {
        ...retryOpts,
        label: `sitemap-article:${vendor}`,
      });
      const ogTitle = extractOgTag(html, 'og:title');
      const ogDescription = extractOgTag(html, 'og:description');

      // M-1：og:title 与 og:description 同缺 → 跳过该篇、不发射退化条目（slug-title + null-content）。
      if (ogTitle === null && ogDescription === null) {
        ctx.logError(
          `sitemap[${vendor}] 文章页 og:title 与 og:description 同缺，跳过该篇不发射（非标准文章页/已改版）`,
          { url: cand.canonical },
        );
        continue;
      }

      // og:title 缺失但有 og:description → URL slug 派生回退（绝不空 title）。
      const title =
        ogTitle && ogTitle.length > 0 ? ogTitle : deriveTitleFromUrl(cand.canonical);
      // ② 全站样板 og:description 视同缺失（content=null），条目照常发射（仅 content 空）。
      // **顺序 MUST**：样板判定在上面 M-1「og 双缺跳过」之后作用于 og:description——反序会把
      // 「缺 og:title + 样板 og:description」从「发 slug-title 条目」翻成「整篇跳过」（未授权的行为变化）。
      const content =
        ogDescription !== null && isSiteBoilerplate(ogDescription) ? null : ogDescription;

      // ① published_at 由页面确定性提取（唯一 h1 + 紧邻元素整串日期）；失败→null（干净失败）。
      // 时区口径用 ctx.nowMs（采集器现有取时方式），越界/提取失败一律置 null。
      const publishedAt = extractPublishedAt(html, ctx.nowMs);
      if (publishedAt !== null) dateExtractedCount += 1;

      // ④ source_item_id（F-6）：c 已非 null；c.length>255 → contentHash(title,content)（既有函数），否则 c。
      const sourceItemId =
        cand.canonical.length > SOURCE_ITEM_ID_MAX_LEN
          ? contentHash(title, content)
          : cand.canonical;

      items.push({
        source: 'sitemap',
        sourceItemId,
        url: cand.canonical, // 文章 URL（=已规范化 canonical，store 会再算 canonical_url 等值）。
        title,
        content,
        // 时效正确性①/②：published_at 由 per-article 页面确定性提取（extractPublishedAt）产出；
        // 提取失败→null（干净失败，本源不回落 AI 推断）。lastmod 绝不进 published_at（仅入 metadata）。
        publishedAt,
        rawType: 'news',
        metadata: { vendor, feed_url: sitemapUrl, lastmod: cand.lastmod },
      });
    } catch (error) {
      // 单篇 fetch 失败（重试耗尽）：跳过该篇、记日志，该源其余文章照常采集（不拖垮该源）。
      ctx.logError(
        `sitemap[${vendor}] 单篇文章 fetch 失败（跳过该篇，不拖垮该源）：${cand.canonical}`,
        error,
      );
      continue;
    }
  }

  const emittedCount = items.length;
  const dateMissingCount = emittedCount - dateExtractedCount;
  // 可观测计数器（M-A + 时效正确性可观测契约）：loc_count>0 && window_candidate_count=0 是正常「无窗内新文」；
  // date_extracted_count/date_missing_count 供下一子片（支路 1 提取归零告警）观测（该支路判据用 DB 复算）。
  ctx.logError(
    `sitemap[${vendor}] 计数：loc_count=${locCount} path_match_count=${pathMatchCount} ` +
      `window_candidate_count=${windowCandidateCount} emitted_count=${emittedCount} ` +
      `date_extracted_count=${dateExtractedCount} date_missing_count=${dateMissingCount}`,
    { sitemapUrl, pathPrefix },
  );

  return items;
}

/**
 * 采集全部配置的 sitemap 源 → 统一结构（先落 raw_items 由编排层入库）。
 *
 * **P2 单配置源（仅 Anthropic）**：整 `sitemap` source 经编排层 allSettled 计 ok。任一配置源失败
 * （sitemap fetch 失败 / loc_count=0 / 已见集查询失败）→ 本函数抛出 → 整源 ok=false（机制成立）。
 *
 * **多配置源的部分失败隔离（F-7）留待第二个 sitemap lab**：本期单源不需要；多配置时须采集器内部做
 * per-config 聚合（坏配置记失败信号但不 throw、好配置照常 emit，同 RSS 多 feed 隔离范式）。本期为
 * 「P2 整源失败语义成立」保持「任一配置源失败即整源抛出」，不提前实现 per-config 隔离。
 */
export async function collectSitemaps(
  options: SitemapCollectorOptions = {},
): Promise<CollectedItem[]> {
  const sources = options.sources ?? env.SITEMAP_SOURCES;
  const fetchText = options.fetchText ?? defaultFetchText;
  const fetchArticle = options.fetchArticle ?? defaultFetchArticle;
  const dbh = options.dbh ?? defaultDb;
  const querySeenCanonicalUrls =
    options.querySeenCanonicalUrls ?? makeDefaultQuerySeen(dbh);
  const windowDays = options.windowDays ?? env.FIRST_SEEN_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const logError = options.logError ?? defaultLogError;
  const lowerBoundMs = windowLowerBoundMs(now, windowDays);
  const nowMs = now.getTime(); // FIX-8：窗口上界（未来 lastmod 不入窗）。

  const items: CollectedItem[] = [];
  for (const config of sources) {
    const sourceItems = await collectOneSitemap(config, {
      fetchText,
      fetchArticle,
      querySeenCanonicalUrls,
      lowerBoundMs,
      nowMs,
      maxAttempts: options.maxAttempts,
      baseDelayMs: options.baseDelayMs,
      logError,
      sleep: options.sleep,
    });
    items.push(...sourceItems);
  }
  return items;
}
